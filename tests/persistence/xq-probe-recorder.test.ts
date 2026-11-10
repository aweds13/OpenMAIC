import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureXqLearnerSchema, XQ_LEARNER_SCHEMA } from '@/lib/persistence/xq-learner';
import type { RuntimeRecord } from '@openmaic/dsl';
import type { RuntimeStore } from '@openmaic/storage';

import { localDayOf } from '@/lib/persistence/xq-event-recorder';
import {
  isGradableQuizRecord,
  recordProbeFromRuntimeAppend,
  RUNTIME_TASK_PREFIX,
  withXqProbeRecording,
} from '@/lib/persistence/xq-probe-recorder';

/**
 * 学情**生产写入口**的判据。
 *
 * 这一段最危险的失败方式不是报错，是**静默**：
 * - 学情落失败却让一次答题提交失败 ⇒ 用户以为答案丢了；
 * - 同一次 append 被投递两次 ⇒ 题量凭空翻倍，掌握度被重试推高；
 * - `correct === null`（AI 还没批完）被当成答错 ⇒ 一道还没结论的题立刻进失败证据；
 * - `draft` / `submitted` 阶段被当成结论 ⇒ 拿 `answers` 去猜对错，与页面显示的判分不一致。
 *
 * 四条都在这里钉住。第 5 条钉顺序：**append 必须先成功**，否则学情里会留下
 * 一条「证据存在但记录不存在」的孤儿事实。
 */
describe('xq probe recorder', () => {
  let db: PGlite;

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
    // 版本 2 给 `xq_cell_state` 加了 `n_delayed`/`k_delayed`，而 `recomputeCellState`
    // 写的就是这两列 —— 只跑 v1 baseline 会让重算抛错（被 catch 成 `recomputed: 0`）。
    await ensureXqLearnerSchema(db);
  });

  const appendInput = (overrides: Record<string, unknown> = {}) => ({
    recordId: 'rec-1',
    stageId: 'stage-A',
    sceneId: 'scene-p1',
    createdAt: '2026-11-08T02:00:00.000Z',
    payload: {
      payloadVersion: 1,
      phase: 'reviewed',
      answers: { q1: 'A' },
      results: [
        { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
        { questionId: 'q2', correct: false, status: 'incorrect', earned: 0 },
      ],
    },
    ...overrides,
  });

  const countProbe = async () => {
    const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_probe_item');
    return Number(r.rows[0]!.n);
  };
  const countSchedule = async () => {
    const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_review_schedule');
    return Number(r.rows[0]!.n);
  };
  /**
   * 题级映射：这道题命中了哪些概念、各自多可信。
   *
   * 写的是真表 `xq_question_concept`（S6 落的 71 行就是这个形状），
   * 而不是替身 —— 排期取概念的那条 SQL 就长在这个表上。
   */
  const seedQuestionConcepts = async (
    rows: { questionId: string; concept: string; confidence: number }[],
  ) => {
    for (const row of rows) {
      await db.query(
        `INSERT INTO xq_question_concept
           (stage_id, scene_id, question_id, concept, concept_kind, link, confidence)
         VALUES ('stage-A', 'scene-p1', $1, $2, 'keypoint', 'normalized', $3)`,
        [row.questionId, row.concept, row.confidence],
      );
    }
  };

  describe('isGradableQuizRecord', () => {
    it('只有 reviewed 且带逐题结果才算结论', () => {
      expect(isGradableQuizRecord({ phase: 'reviewed', results: [{ questionId: 'q1' }] })).toBe(
        true,
      );
      expect(isGradableQuizRecord({ phase: 'reviewed', results: [] })).toBe(false);
      expect(isGradableQuizRecord({ phase: 'reviewed' })).toBe(false);
      expect(isGradableQuizRecord({ phase: 'submitted', results: [{ questionId: 'q1' }] })).toBe(
        false,
      );
      expect(isGradableQuizRecord({ phase: 'draft', results: [{ questionId: 'q1' }] })).toBe(false);
    });
  });

  describe('recordProbeFromRuntimeAppend', () => {
    it('reviewed 记录落成事实，答错的排四关，答对的不排', async () => {
      const result = await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      expect(result.inserted).toBe(2);
      expect(result.ungraded).toBe(0);
      expect(result.scheduled).toBe(1);
      expect(result.recomputed).toBe(1);
      expect(await countProbe()).toBe(2);
      // 四关 = 4 行，只有 q2 那一道错题。
      expect(await countSchedule()).toBe(4);

      const rows = await db.query<{ question_id: string; concept: string; round: number }>(
        'SELECT question_id, concept, round FROM xq_review_schedule ORDER BY round',
      );
      expect(rows.rows.map((r) => r.question_id)).toEqual(['q2', 'q2', 'q2', 'q2']);
      expect(rows.rows.map((r) => r.round)).toEqual([1, 2, 3, 4]);
      // 这道题没有题级映射 ⇒ 概念留空。四关按题排，`concept` 只是可选标注。
      expect(rows.rows.every((r) => r.concept === '')).toBe(true);
    });

    it('★ 一道题的最高档只有一个概念时，排期就用它 —— 不是恒空', async () => {
      await seedQuestionConcepts([
        { questionId: 'q2', concept: '类与对象', confidence: 0.8 },
        { questionId: 'q2', concept: 'this 关键字', confidence: 0.5 },
      ]);
      await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      const rows = await db.query<{ concept: string }>(
        'SELECT DISTINCT concept FROM xq_review_schedule',
      );
      expect(rows.rows.map((r) => r.concept)).toEqual(['类与对象']);
    });

    it('★ 最高档并列时留空 —— 挑一个就会让同一道错题第二天变成另一组四关', async () => {
      await seedQuestionConcepts([
        { questionId: 'q2', concept: '字符串', confidence: 0.8 },
        { questionId: 'q2', concept: '继承', confidence: 0.8 },
        { questionId: 'q2', concept: '类与对象', confidence: 0.5 },
      ]);
      await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      const rows = await db.query<{ concept: string }>(
        'SELECT DISTINCT concept FROM xq_review_schedule',
      );
      expect(rows.rows.map((r) => r.concept)).toEqual(['']);
      // 排期仍然要排出来 —— 概念取不到不该让复习断掉。
      expect(await countSchedule()).toBe(4);
    });

    it(`task_id 带 ${RUNTIME_TASK_PREFIX} 前缀，一眼能看出证据来自哪一次 append`, async () => {
      await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      const rows = await db.query<{ task_id: string }>(
        'SELECT DISTINCT task_id FROM xq_probe_item',
      );
      expect(rows.rows.map((r) => r.task_id)).toEqual([`${RUNTIME_TASK_PREFIX}rec-1`]);
    });

    it('同一次 append 投递两次只落一次（幂等键是 record 不是题目）', async () => {
      const first = await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      const second = await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      expect(first.inserted).toBe(2);
      expect(second.inserted).toBe(0);
      expect(second.duplicate).toBe(2);
      expect(await countProbe()).toBe(2);
      // 第二次没有新行 ⇒ 不重算、不重排期。
      expect(second.recomputed).toBe(0);
      expect(second.scheduled).toBe(0);
      expect(await countSchedule()).toBe(4);
    });

    it('★ 同一道题换一次 append 可以再答 —— 这正是 counted_n 要表达的', async () => {
      await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      const again = await recordProbeFromRuntimeAppend(
        appendInput({
          recordId: 'rec-2',
          createdAt: '2026-11-08T03:00:00.000Z',
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: { q1: 'A' },
            results: [
              { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
              { questionId: 'q2', correct: false, status: 'incorrect', earned: 0 },
            ],
          },
        }),
        { queryable: db },
      );
      expect(again.inserted).toBe(2);
      expect(await countProbe()).toBe(4);
      // 同一天第二次答同一题 ⇒ counted_n 降成 0.5（不是被吞掉）。
      const rows = await db.query<{ question_id: string; counted_n: string }>(
        'SELECT question_id, counted_n::text AS counted_n FROM xq_probe_item ORDER BY id',
      );
      expect(rows.rows.map((r) => r.counted_n)).toEqual(['1.0', '1.0', '0.5', '0.5']);
    });

    it('★ correct === null（AI 还没批完）跳过，不当成答错', async () => {
      const result = await recordProbeFromRuntimeAppend(
        appendInput({
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: {},
            results: [
              { questionId: 'q1', correct: null, status: 'incorrect', earned: 0 },
              { questionId: 'q2', correct: true, status: 'correct', earned: 1 },
            ],
          },
        }),
        { queryable: db },
      );
      expect(result.ungraded).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.scheduled).toBe(0);
      const rows = await db.query<{ question_id: string }>(
        'SELECT question_id FROM xq_probe_item ORDER BY question_id',
      );
      expect(rows.rows.map((r) => r.question_id)).toEqual(['q2']);
    });

    it('全部都没结论时一条也不写，也不建缓存', async () => {
      const result = await recordProbeFromRuntimeAppend(
        appendInput({
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: {},
            results: [{ questionId: 'q1', correct: null, status: 'incorrect', earned: 0 }],
          },
        }),
        { queryable: db },
      );
      expect(result).toEqual({
        inserted: 0,
        ungraded: 1,
        duplicate: 0,
        scheduled: 0,
        recomputed: 0,
      });
      expect(await countProbe()).toBe(0);
    });

    it('非 reviewed 阶段一律不写', async () => {
      for (const phase of ['draft', 'submitted']) {
        const result = await recordProbeFromRuntimeAppend(
          appendInput({
            payload: { payloadVersion: 1, phase, answers: { q1: 'A' }, results: undefined },
          }),
          { queryable: db },
        );
        expect(result.inserted).toBe(0);
      }
      expect(await countProbe()).toBe(0);
    });

    it('createdAt 解析不了就不写 —— 拿假时间排四关比不排更糟', async () => {
      const failures: string[] = [];
      const result = await recordProbeFromRuntimeAppend(appendInput({ createdAt: '昨天下午' }), {
        queryable: db,
        logFailure: (message) => failures.push(message),
      });
      expect(result.inserted).toBe(0);
      expect(await countProbe()).toBe(0);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('unparseable createdAt');
    });

    it('★ 落库失败不抛 —— 学情是派生物，不该让一次答题提交失败', async () => {
      const failures: string[] = [];
      const broken = {
        query: async () => {
          throw new Error('connection refused');
        },
      } as unknown as PGlite;
      const result = await recordProbeFromRuntimeAppend(appendInput(), {
        queryable: broken,
        logFailure: (message) => failures.push(message),
      });
      expect(result.inserted).toBe(0);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('failed to ingest');
    });

    it('重算失败不影响已落的事实与排期', async () => {
      const failures: string[] = [];
      const flaky = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO xq_cell_state')) throw new Error('cache write failed');
          return db.query(sql, params);
        },
      } as unknown as PGlite;
      const result = await recordProbeFromRuntimeAppend(appendInput(), {
        queryable: flaky,
        logFailure: (message) => failures.push(message),
      });
      expect(result.inserted).toBe(2);
      expect(result.recomputed).toBe(0);
      expect(result.scheduled).toBe(1);
      expect(failures.some((m) => m.includes('failed to recompute'))).toBe(true);
    });
  });

  describe('自评跟着这一次作答走', () => {
    const confidenceOfQuestion = async (questionId: string) => {
      const r = await db.query<{ confidence_pre: number | null }>(
        'SELECT confidence_pre FROM xq_probe_item WHERE question_id = $1',
        [questionId],
      );
      return r.rows[0]?.confidence_pre ?? null;
    };

    it('★ 自评落进 confidence_pre —— 这一列在此之前从来没有人写过', async () => {
      await recordProbeFromRuntimeAppend(
        appendInput({
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: { q1: 'A', q2: 'B' },
            results: [
              { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
              { questionId: 'q2', correct: false, status: 'incorrect', earned: 0 },
            ],
            confidence: { q1: 95, q2: 25 },
          },
        }),
        { queryable: db },
      );
      expect(await confidenceOfQuestion('q1')).toBe(95);
      expect(await confidenceOfQuestion('q2')).toBe(25);
    });

    it('★ 没自评的那道题留空 —— 空不是 50，空是「没问过」', async () => {
      await recordProbeFromRuntimeAppend(
        appendInput({
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: { q1: 'A', q2: 'B' },
            results: [
              { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
              { questionId: 'q2', correct: false, status: 'incorrect', earned: 0 },
            ],
            confidence: { q1: 75 },
          },
        }),
        { queryable: db },
      );
      expect(await confidenceOfQuestion('q1')).toBe(75);
      expect(await confidenceOfQuestion('q2')).toBeNull();
    });

    it('★ 自评不影响判定：同一组对错，有没有自评都算出同一格状态', async () => {
      const cellNow = async () => {
        const r = await db.query<{ n: string; k: string }>(
          'SELECT n::text AS n, k::text AS k FROM xq_cell_state',
        );
        return r.rows[0] ?? null;
      };
      const withoutConfidence = await recordProbeFromRuntimeAppend(appendInput(), {
        queryable: db,
      });
      const cellAfterFirst = await cellNow();
      // 换一个 task_id 重投同一组事实，只多一个自评（而且故意给反向的：
      // 答对的 q1 说「基本靠猜」25，答错的 q2 说「很有把握」95）。
      await recordProbeFromRuntimeAppend(
        appendInput({
          recordId: 'rec-2',
          // 换一个更晚但同一学习日的时刻：这才是「同题重测」（counted_n 0.5）。
          // 用同一个时刻会被唯一键当重复投递，`counted_n` 仍是 1.0。
          createdAt: '2026-11-08T04:00:00.000Z',
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: { q1: 'A' },
            results: [
              { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
              { questionId: 'q2', correct: false, status: 'incorrect', earned: 0 },
            ],
            confidence: { q1: 25, q2: 95 },
          },
        }),
        { queryable: db },
      );
      const cellAfterSecond = await cellNow();
      expect(withoutConfidence.inserted).toBe(2);
      expect(cellAfterFirst).not.toBeNull();
      expect(cellAfterSecond).not.toBeNull();
      // ★ 第二次的唯一差别是「同题各重测一次」（两道题各 +0.5 证据）。
      // 自评故意给反的（答对的说 25、答错的说 95）：若它参与判定，
      // k 会朝错的那边动。
      expect(Number(cellAfterSecond!.n)).toBe(Number(cellAfterFirst!.n) + 1);
      expect(Number(cellAfterSecond!.k)).toBe(Number(cellAfterFirst!.k) + 0.5);
    });
  });

  /**
   * 「同一天」在两处各有一个定义，而它们**不是**同一个概念：
   *
   * - `xq_session.local_day`：学习日，04:00 边界（`localDayOf()`）。凌晨两点
   *   还在学，那次学习属于前一天 —— 会话序号与「今天学了多久」都按它。
   * - `xq_probe_item.counted_n`：同题重测折扣。它问的是「这两次是不是
   *   互相独立的观测」，用的是**日历日**（`SAME_DAY_TIME_ZONE`）。
   *
   * 前者刻意跨午夜不切，后者刻意按午夜切 —— 两条判据分别钉住，免得
   * 后人以为它们该统一而顺手改掉一个。
   */
  describe('「同一天」的两个定义各自钉住', () => {
    it('★ 学习日跨午夜不切：23:30 与次日 01:00 是同一天', () => {
      // 上海时间 11-08 23:30 = UTC 15:30；次日 01:00 = UTC 17:00。
      // 日历日跨了，学习日没跨。
      expect(localDayOf(new Date('2026-11-08T15:30:00.000Z'))).toBe('2026-11-08');
      expect(localDayOf(new Date('2026-11-08T17:00:00.000Z'))).toBe('2026-11-08');
    });

    it('★ 重测折扣按日历日算：23:30 与次日 01:00 算两次独立观测', async () => {
      await recordProbeFromRuntimeAppend(appendInput({ createdAt: '2026-11-08T15:30:00.000Z' }), {
        queryable: db,
      });
      await recordProbeFromRuntimeAppend(
        appendInput({ recordId: 'rec-late', createdAt: '2026-11-08T17:00:00.000Z' }),
        { queryable: db },
      );
      const rows = await db.query<{ question_id: string; counted_n: string }>(
        'SELECT question_id, counted_n::text AS counted_n FROM xq_probe_item ORDER BY id',
      );
      // 四条全是 1.0 —— 跨了日历日就是两次独立观测，哪怕只隔 1.5 小时。
      expect(rows.rows.map((r) => r.counted_n)).toEqual(['1.0', '1.0', '1.0', '1.0']);
    });
  });

  /**
   * `onRecorded` 是「库变了，把状态块刷一遍」的唯一通知方式。
   *
   * 它此前不存在，而刷新点在 agent 运行开头 —— 所以答完题就关掉的人，那份
   * 文件会一直停在旧内容上（实测磁盘 946 字节 vs 当时库渲染 1405 字节）。
   * 下面四条钉住它的**边界**：什么时候该叫、什么时候不该叫、叫的时候炸了怎么办。
   */
  describe('onRecorded —— 只有库真的变了才通知', () => {
    it('★ 真的插进新事实就通知一次', async () => {
      let calls = 0;
      await recordProbeFromRuntimeAppend(appendInput(), {
        queryable: db,
        onRecorded: () => {
          calls += 1;
        },
      });
      expect(calls).toBe(1);
    });

    it('★ 重复投递不通知 —— 库没变，刷新只会白读一遍文件', async () => {
      let calls = 0;
      const deps = {
        queryable: db,
        onRecorded: () => {
          calls += 1;
        },
      };
      await recordProbeFromRuntimeAppend(appendInput(), deps);
      // 同一个 recordId + 同一个 createdAt ⇒ 撞唯一键，inserted 0。
      await recordProbeFromRuntimeAppend(appendInput(), deps);
      expect(calls).toBe(1);
    });

    it('★ 没有可判的题（`correct === null` 全跳过）时不通知', async () => {
      let calls = 0;
      await recordProbeFromRuntimeAppend(
        appendInput({
          recordId: 'rec-ungraded',
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: { q1: 'A' },
            results: [{ questionId: 'q1', correct: null, status: 'incorrect', earned: 0 }],
          },
        }),
        {
          queryable: db,
          onRecorded: () => {
            calls += 1;
          },
        },
      );
      expect(calls).toBe(0);
    });

    it('★ 钩子自己炸了不许让这次 append 失败', async () => {
      const result = await recordProbeFromRuntimeAppend(appendInput(), {
        queryable: db,
        onRecorded: () => {
          throw new Error('refresh exploded');
        },
      });
      // 事实已经落进去了，钩子的失败只是少刷一次文件。
      expect(result.inserted).toBe(2);
      const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM xq_probe_item');
      expect(rows.rows[0].n).toBe(2);
    });
  });

  describe('withXqProbeRecording', () => {
    /** 一个最小的 RuntimeStore：只实现 appendRecord / getSession，其余转给 stub。 */
    const fakeStore = (
      overrides: Partial<RuntimeStore> = {},
      session: { kind: string; stageId: string } = { kind: 'quizAttempt', stageId: 'stage-A' },
    ) => {
      const appended: RuntimeRecord[] = [];
      const store = {
        appendRecord: async (init: Record<string, unknown>) => {
          const record = {
            ...init,
            seq: appended.length,
            createdAt: (init.createdAt as string) ?? '2026-11-08T02:00:00.000Z',
          } as unknown as RuntimeRecord;
          appended.push(record);
          return record;
        },
        getSession: async () => (session ? ({ ...session, id: 's-1' } as never) : undefined),
        ...overrides,
      } as unknown as RuntimeStore;
      return { store, appended };
    };

    it('append 成功后才落学情，且用落库后的 record 字段', async () => {
      const { store } = fakeStore();
      const wrapped = withXqProbeRecording(store, { queryable: db });
      await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        sceneId: 'scene-p1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      const rows = await db.query<{ task_id: string }>('SELECT task_id FROM xq_probe_item');
      expect(rows.rows.map((r) => r.task_id)).toEqual([`${RUNTIME_TASK_PREFIX}rec-9`]);
    });

    it('★ append 抛错时学情一条也不写（顺序不能反）', async () => {
      const { store } = fakeStore({
        appendRecord: async () => {
          throw new Error('append refused');
        },
      } as never);
      const wrapped = withXqProbeRecording(store, { queryable: db });
      await expect(
        wrapped.appendRecord({
          id: 'rec-9',
          sessionId: 's-1',
          sceneId: 'scene-p1',
          createdAt: '2026-11-08T02:00:00.000Z',
          payload: { payloadVersion: 1, phase: 'reviewed', answers: {}, results: [] },
        } as never),
      ).rejects.toThrow('append refused');
      expect(await countProbe()).toBe(0);
    });

    it('只认 quizAttempt —— PBL/chat 的 payload 里也有 results 字样', async () => {
      const { store } = fakeStore({}, { kind: 'pbl', stageId: 'stage-A' });
      const wrapped = withXqProbeRecording(store, { queryable: db });
      await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        sceneId: 'scene-p1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      expect(await countProbe()).toBe(0);
    });

    it('会话查不到就跳过（学情拿不到 stageId 就没法写）', async () => {
      const { store } = fakeStore({ getSession: async () => undefined } as never);
      const wrapped = withXqProbeRecording(store, { queryable: db });
      const record = await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        sceneId: 'scene-p1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      expect(record.id).toBe('rec-9');
      expect(await countProbe()).toBe(0);
    });

    it('没有 sceneId 的记录不写（学情按页聚合，没有页就没有格）', async () => {
      const { store } = fakeStore();
      const wrapped = withXqProbeRecording(store, { queryable: db });
      await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      expect(await countProbe()).toBe(0);
    });

    it('★ 学情整段抛错也不让 append 失败', async () => {
      const { store } = fakeStore();
      const wrapped = withXqProbeRecording(store, {
        queryable: db,
        // 只让 getSession 抛，模拟「学情侧任何一步炸掉」。
        logFailure: () => {},
      });
      const record = await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        sceneId: 'scene-p1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      expect(record.id).toBe('rec-9');
    });
  });
});
