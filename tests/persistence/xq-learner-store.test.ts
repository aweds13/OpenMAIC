import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureXqLearnerSchema, XQ_LEARNER_SCHEMA } from '@/lib/persistence/xq-learner';
import { XqLearnerStore, XqReviewRoundNotFoundError } from '@/lib/persistence/xq-learner-store';

/**
 * 写入层的判据。
 *
 * 三件事必须被钉住，因为它们都会**静默出错**：
 *
 * 1. `ingestProbeItems` 的幂等。同一条证据（同 task/stage/scene/question/asked_at）
 *    重复写入必须是 skipped 而不是插第二行 —— 否则重放一次就多算一次题量，
 *    掌握度会被自己的重试推高。
 * 2. `recomputeCellState` 用的是 `xq-mastery` 的判定，不是自己另算一套。
 *    这里只钉一个锚点（7/8 → known、lb≈0.603），细节在 xq-mastery 的测试里。
 * 3. ★ 做错要回第 1 关。这是站点行为（`/course/:courseId/wrong-book`
 *    「四关 1/3/7/15 天、做错回第 1 关」），而第一版实现把它写成了
 *    「标记当前关 + 顺延后面」，导致第 15 天那一关永远不会到期。
 */
describe('XqLearnerStore', () => {
  let db: PGlite;
  let store: XqLearnerStore;

  /**
   * xq_concept_occurrence 有一条复合外键指回 document_scenes(stage_id, id) ——
   * 那是上游 document store 的表，不属这组 DDL。建一个最小版本，
   * 只为让外键能落地（本组判据不碰 occurrence，但这张表必须在）。
   */
  const DOCUMENT_SCENES_MIN = `CREATE TABLE IF NOT EXISTS document_stages (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at double precision NOT NULL,
    updated_at double precision NOT NULL,
    data jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_scenes (
    stage_id    text NOT NULL,
    id          text NOT NULL,
    scene_order double precision,
    data        jsonb,
    PRIMARY KEY (stage_id, id)
  );`;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await db.exec(XQ_LEARNER_SCHEMA);
    // 版本 2 的两列（n_delayed / k_delayed）是 `recomputeCellState` 的写入目标 ——
    // 只跑 v1 baseline 的话，重算会报 column does not exist。
    await ensureXqLearnerSchema(db);
    store = new XqLearnerStore({ queryable: db, now: () => NOW });
  });

  /**
   * 固定的「现在」。延迟桶按 `now − asked_at` 分档，测试里必须钉住它，
   * 否则「昨天答的算不算延迟」会随真实钟表漂。
   */
  const NOW = new Date(Date.UTC(2026, 10, 20, 0, 0));

  const probe = (questionId: string, correct: boolean, minute = 0) => ({
    taskId: 'task-1',
    stageId: 'stage-A',
    sceneId: 'scene-p1',
    questionId,
    askedAt: new Date(Date.UTC(2026, 10, 8, 10, minute)),
    correct,
    source: 'manual' as const,
  });

  /**
   * 造一条「更早的失败」。
   *
   * `xq_event.session_id` 有外键指回 `xq_session`，所以先开一个会话。
   * payload 里的 `concept` 是计数口径的一部分（`coalesce(payload->>'concept','') = $4`）。
   */
  async function seedReviewFailed(at: Date): Promise<void> {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    await db.query(
      `INSERT INTO xq_session (session_id, started_at, seq_no, local_day)
       VALUES ($1::uuid, $2::timestamptz, 1, $2::date)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, at.toISOString()],
    );
    await db.query(
      `INSERT INTO xq_event
         (event_id, session_id, occurred_at, kind, stage_id, scene_id, question_id, payload)
       VALUES (gen_random_uuid(), $1::uuid, $2::timestamptz, 'review_failed',
               'stage-A', 'scene-p1', 'q1', $3::jsonb)`,
      [sessionId, at.toISOString(), JSON.stringify({ concept: 'concept-x', round: 1 })],
    );
  }

  describe('ingestProbeItems', () => {
    it('写入一批，返回真插进去的条数', async () => {
      const result = await store.ingestProbeItems([probe('q1', true, 1), probe('q2', false, 2)]);
      expect(result).toEqual({ inserted: 2, skipped: 0 });
    });

    it('同一条证据重复写入是 skipped 不是第二行', async () => {
      await store.ingestProbeItems([probe('q1', true, 1)]);
      const second = await store.ingestProbeItems([probe('q1', true, 1)]);
      expect(second).toEqual({ inserted: 0, skipped: 1 });
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM xq_probe_item`,
      );
      expect(rows[0]!.count).toBe('1');
    });

    it('同题不同天是两条独立证据', async () => {
      await store.ingestProbeItems([probe('q1', true, 1)]);
      const later = await store.ingestProbeItems([probe('q1', false, 2)]);
      expect(later.inserted).toBe(1);
    });

    it('空数组不炸', async () => {
      expect(await store.ingestProbeItems([])).toEqual({ inserted: 0, skipped: 0 });
    });
  });

  describe('recomputeCellState', () => {
    it('7/8 判 known，且置信区间与标定一致', async () => {
      await store.ingestProbeItems(
        Array.from({ length: 8 }, (_, i) => probe(`q${i + 1}`, i < 7, i)),
      );
      const verdict = await store.recomputeCellState('stage-A', 'scene-p1');
      expect(verdict.tri).toBe('known');
      expect(verdict.n).toBe(8);
      expect(verdict.k).toBe(7);
      expect(verdict.lb5).toBeCloseTo(0.603, 2);
      expect(verdict.ub95).toBeCloseTo(0.876, 2);
    });

    it('6/8 判 unknown/mixed', async () => {
      await store.ingestProbeItems(
        Array.from({ length: 8 }, (_, i) => probe(`q${i + 1}`, i < 6, i)),
      );
      const verdict = await store.recomputeCellState('stage-A', 'scene-p1');
      expect(verdict.tri).toBe('unknown');
      expect(verdict.reason).toBe('mixed');
    });

    it('没有证据的格子是 no-quiz', async () => {
      const verdict = await store.recomputeCellState('stage-A', 'scene-p9');
      expect(verdict.tri).toBe('unknown');
      expect(verdict.reason).toBe('no-quiz');
    });

    it('重算两次结果一致（缓存可整表重算）', async () => {
      await store.ingestProbeItems(
        Array.from({ length: 8 }, (_, i) => probe(`q${i + 1}`, i < 7, i)),
      );
      const first = await store.recomputeCellState('stage-A', 'scene-p1');
      const second = await store.recomputeCellState('stage-A', 'scene-p1');
      expect(second).toEqual(first);
    });

    it('★ 这一页明确不是 quiz 页时，这一格被删掉，证据还在', async () => {
      // 实测原型：`stage-GYvpbYB_aN/scene-p13` 有 8 条全对的自检证据，
      // 但那一页现在是 slide（比较运算符，order 32）—— scene id 被非 quiz 页复用了。
      await db.query(
        `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, $3, $4::jsonb)`,
        ['stage-A', 'scene-p1', 32, JSON.stringify({ type: 'slide', title: '比较运算符' })],
      );
      await store.ingestProbeItems(
        Array.from({ length: 8 }, (_, i) => probe(`q${i + 1}`, true, i)),
      );
      // 先按 quiz 页算一次，确认证据本身能判 known（证明不是「证据不够」）。
      await db.query(`DELETE FROM document_scenes WHERE stage_id = 'stage-A' AND id = 'scene-p1'`);
      expect((await store.recomputeCellState('stage-A', 'scene-p1')).tri).toBe('known');

      // 再把这一页标成 slide，重算 ⇒ 这一格必须消失。
      await db.query(
        `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, $3, $4::jsonb)`,
        ['stage-A', 'scene-p1', 32, JSON.stringify({ type: 'slide', title: '比较运算符' })],
      );
      const verdict = await store.recomputeCellState('stage-A', 'scene-p1');
      expect(verdict.tri).toBe('unknown');
      expect(verdict.reason).toBe('no-quiz');
      const cells = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM xq_cell_state WHERE stage_id = 'stage-A' AND scene_id = 'scene-p1'`,
      );
      expect(cells.rows[0]!.n).toBe('0');
      // 证据一条不少 —— 缓存删得掉，事实删不掉。
      const kept = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM xq_probe_item WHERE stage_id = 'stage-A' AND scene_id = 'scene-p1'`,
      );
      expect(kept.rows[0]!.n).toBe('8');
    });

    it('查不到这一页时不动这一格（课程被删不代表历史记录是假的）', async () => {
      await store.ingestProbeItems(
        Array.from({ length: 8 }, (_, i) => probe(`q${i + 1}`, i < 7, i)),
      );
      const verdict = await store.recomputeCellState('stage-A', 'scene-p1');
      expect(verdict.tri).toBe('known');
    });

    it('这一页明说是 quiz 时照常判', async () => {
      await db.query(
        `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, $3, $4::jsonb)`,
        ['stage-A', 'scene-p1', 1, JSON.stringify({ type: 'quiz' })],
      );
      await store.ingestProbeItems(
        Array.from({ length: 8 }, (_, i) => probe(`q${i + 1}`, i < 7, i)),
      );
      expect((await store.recomputeCellState('stage-A', 'scene-p1')).tri).toBe('known');
    });

    it('同一 scene 在两门课里互不影响（主键带 stage_id）', async () => {
      await store.ingestProbeItems([
        probe('q1', true, 1),
        probe('q2', true, 2),
        probe('q3', true, 3),
        { ...probe('q1', false, 4), stageId: 'stage-B' },
      ]);
      const a = await store.recomputeCellState('stage-A', 'scene-p1');
      const b = await store.recomputeCellState('stage-B', 'scene-p1');
      expect(a.tri).toBe('known');
      expect(b.tri).toBe('unknown');
      expect(b.reason).toBe('too-few-items');
    });
  });

  describe('错题四关', () => {
    it('排四关，间隔是 1/3/7/15 天', async () => {
      const result = await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      expect(result.rounds).toBe(4);

      // ★ 不能用 EXTRACT(DAY FROM (due_at - anchor))：那是 interval 的「日分量」，
      // +1 天减掉几毫秒会变成 0 天 23:59:59.99，日分量读出来是 0。
      // 要总天数就取 epoch 再除，然后四舍五入。
      //
      // ★ 减的是**排期锚点**（store 注入的 NOW），不是 `now()` —— 锚点改成参数之后
      // （2026-11-26），拿真实时钟去减只会得到负数。这条测试原本就因此变成过时间炸弹。
      const { rows } = await db.query<{ round: number; days: number }>(
        `SELECT round, round(EXTRACT(EPOCH FROM (due_at - $1::timestamptz)) / 86400)::int AS days
           FROM xq_review_schedule ORDER BY round`,
        [NOW.toISOString()],
      );
      expect(rows.map((r) => Number(r.round))).toEqual([1, 2, 3, 4]);
      expect(rows.map((r) => Number(r.days))).toEqual([1, 3, 7, 15]);
    });

    it('重复排期是幂等的', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      const again = await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      expect(again.rounds).toBe(0);
    });

    it('★ 做错第 1 关要回到第 1 关（四关全部重置，不是顺延到第 2 关）', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      await store.recordReviewOutcome('stage-A', 'scene-p1', 'q1', 'concept-x', 1, 'fail');

      // 30 天后看：四关应该全都到期（都重新排过），而且第 1 关是最近的。
      const due = await store.dueReviews(new Date(Date.UTC(2026, 11, 31)), 50);
      const rounds = due.map((d) => d.round).sort((a, b) => a - b);
      expect(rounds).toEqual([1, 2, 3, 4]);
      // 第 1 关的到期时间一定是四关里最早的
      const first = due.find((d) => d.round === 1)!;
      for (const other of due.filter((d) => d.round !== 1)) {
        expect(first.dueAt.getTime()).toBeLessThanOrEqual(other.dueAt.getTime());
      }
    });

    it('★ 做错之后间隔仍然是 1/3/7/15（不是被压成 1/3/7）', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      const before = await db.query<{ round: number; due_at: Date }>(
        `SELECT round, due_at FROM xq_review_schedule ORDER BY round`,
      );
      const firstDue = before.rows[0]!.due_at.getTime();

      await store.recordReviewOutcome('stage-A', 'scene-p1', 'q1', 'concept-x', 1, 'fail');
      const after = await db.query<{ round: number; due_at: Date }>(
        `SELECT round, due_at FROM xq_review_schedule ORDER BY round`,
      );

      // 从第 1 关的新到期日算起，后面三关相对它应该是 +2 / +6 / +14 天
      const base = after.rows.find((r) => Number(r.round) === 1)!.due_at.getTime();
      const days = after.rows.map((r) => Math.round((r.due_at.getTime() - base) / 86_400_000));
      expect(days).toEqual([0, 2, 6, 14]);
      // 而且第 1 关的到期日确实往后推了（不是留在原地）
      expect(base).toBeGreaterThan(firstDue);
    });

    it('★ 第二次做错起，重置阶梯整行后移（1/3/7/15 → 3/7/15/30）', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      // 排期表里没有「重置过几次」这一列 —— 计数只能来自事件。
      // 这里直接造一条更早的 `review_failed`，代表「他以前就错过这道题」。
      await seedReviewFailed(new Date(Date.UTC(2026, 10, 2)));

      await store.recordReviewOutcome(
        'stage-A',
        'scene-p1',
        'q1',
        'concept-x',
        1,
        'fail',
        new Date(Date.UTC(2026, 10, 3)),
      );

      const { rows } = await db.query<{ round: number; days: number }>(
        `SELECT round, round(EXTRACT(EPOCH FROM (due_at - now())) / 86400)::int AS days
           FROM xq_review_schedule ORDER BY round`,
      );
      // 整行后移，但行内仍严格递增 —— 「四关依次变远」这条性质没变。
      expect(rows.map((r) => Number(r.days))).toEqual([3, 7, 15, 30]);
    });

    it('★ 第三次、第 N 次做错仍用第二行，不会无限往后推', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      for (let i = 0; i < 4; i += 1) {
        await seedReviewFailed(new Date(Date.UTC(2026, 10, 2 + i)));
      }
      await store.recordReviewOutcome(
        'stage-A',
        'scene-p1',
        'q1',
        'concept-x',
        1,
        'fail',
        new Date(Date.UTC(2026, 10, 20)),
      );
      const { rows } = await db.query<{ days: number }>(
        `SELECT round(EXTRACT(EPOCH FROM (due_at - now())) / 86400)::int AS days
           FROM xq_review_schedule ORDER BY round`,
      );
      expect(rows.map((r) => Number(r.days))).toEqual([3, 7, 15, 30]);
    });

    it('★ 这一次自己的失败事件不算「以前」—— 用严格小于，不是小于等于', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      const at = new Date(Date.UTC(2026, 10, 3));
      // 与失败**同一时刻**的事件：它是这一次自己写的（`recordXqReview` 先写事件
      // 再改排期），若把它算进 `prior`，第一次失败就会用上第二行阶梯 ——
      // 一期「做错仍回 1/3/7/15」的判决会被悄悄推翻。
      await seedReviewFailed(at);

      await store.recordReviewOutcome('stage-A', 'scene-p1', 'q1', 'concept-x', 1, 'fail', at);

      const { rows } = await db.query<{ days: number }>(
        `SELECT round(EXTRACT(EPOCH FROM (due_at - now())) / 86400)::int AS days
           FROM xq_review_schedule ORDER BY round`,
      );
      expect(rows.map((r) => Number(r.days))).toEqual([1, 3, 7, 15]);
    });

    it('做对只标记那一关，不影响后面', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      await store.recordReviewOutcome('stage-A', 'scene-p1', 'q1', 'concept-x', 1, 'pass');

      const { rows } = await db.query<{ round: number; done: boolean }>(
        `SELECT round, (done_at IS NOT NULL) AS done FROM xq_review_schedule ORDER BY round`,
      );
      expect(rows.filter((r) => r.done).map((r) => Number(r.round))).toEqual([1]);
    });

    it('跳过也只标记那一关', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      await store.recordReviewOutcome('stage-A', 'scene-p1', 'q1', 'concept-x', 2, 'skip');
      const { rows } = await db.query<{ round: number; done: boolean; outcome: string | null }>(
        `SELECT round, (done_at IS NOT NULL) AS done, outcome
           FROM xq_review_schedule ORDER BY round`,
      );
      const done = rows.filter((r) => r.done);
      expect(done.map((r) => Number(r.round))).toEqual([2]);
      expect(done[0]!.outcome).toBe('skip');
    });

    it('记录一个不存在的关会抛，不是静默成功', async () => {
      await expect(
        store.recordReviewOutcome('stage-A', 'scene-p1', 'q1', 'concept-x', 3, 'pass'),
      ).rejects.toThrow(XqReviewRoundNotFoundError);
    });

    it('dueReviews 只回未完成的', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      const all = await store.dueReviews(new Date(Date.UTC(2026, 11, 31)), 50);
      expect(all).toHaveLength(4);
      await store.recordReviewOutcome('stage-A', 'scene-p1', 'q1', 'concept-x', 1, 'pass');
      const rest = await store.dueReviews(new Date(Date.UTC(2026, 11, 31)), 50);
      expect(rest).toHaveLength(3);
      expect(rest.map((d) => d.round)).not.toContain(1);
    });

    it('dueReviews 的 now 是注入的，不改系统时钟', async () => {
      await store.scheduleReviewForWrong('stage-A', 'scene-p1', 'q1', 'concept-x');
      // ★ 全部相对**锚点 NOW（2026-11-20）**算，不相对真实时钟 ——
      // 四关落在 +1 / +3 / +7 / +15 天（11-21 / 11-23 / 11-27 / 12-05）。
      // 这段原本写的是「第 12 天」「第 31 天」加绝对日期，那是按写它那天的真实
      // 时钟凑出来的；日期一过就红（实测 2026-11-26 起必红）。
      const day0 = await store.dueReviews(NOW, 50);
      expect(day0).toHaveLength(0);
      // +7 天：1/3/7 那三关到期，15 天那关还没
      const day7 = await store.dueReviews(new Date(Date.UTC(2026, 10, 27)), 50);
      expect(day7.map((d) => d.round)).toEqual([1, 2, 3]);
      // +15 天：四关全到期
      const day15 = await store.dueReviews(new Date(Date.UTC(2026, 11, 5)), 50);
      expect(day15.map((d) => d.round)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('recomputeAllCellStates', () => {
    it('按 stage 过滤', async () => {
      await store.ingestProbeItems([probe('q1', true, 1)]);
      await store.ingestProbeItems([{ ...probe('q1', true, 2), stageId: 'stage-B' }]);
      const scoped = await store.recomputeAllCellStates({ stageId: 'stage-A' });
      expect(scoped.cells).toBe(1);
      const all = await store.recomputeAllCellStates();
      expect(all.cells).toBe(2);
    });
  });
});
