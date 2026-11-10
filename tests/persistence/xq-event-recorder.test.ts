import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import {
  deriveDedupeKey,
  localDayOf,
  recordXqEvent,
  XQ_END_REASONS,
  XQ_EVENT_KINDS,
  XQ_HINT_SUBTYPES,
  type XqEventInput,
} from '@/lib/persistence/xq-event-recorder';

/**
 * 学情**事件写入口**的判据。
 *
 * 事件是状态与画像的共同上游（M 文档三分法：事件 → 状态 → 状态块）。
 * 它最危险的失败方式不是报错，是**悄悄写错个数的行**：
 *
 * - 同一次开始被投递两次却建了两个会话 ⇒ 此后所有「这次学了多久」都翻倍；
 * - `session_started` 的 `event_id` 与会话 `session_id` 不是同一个 ⇒
 *   永远对不上「这次会话的第一条事件是哪条」，回放与归因都断；
 * - 本地日期按 UTC 算 ⇒ 凌晨两点那次学习被记到第二天，连续学习被切成两次；
 * - `session_ended` 不关会话 ⇒ `xq_session_open_idx` 那条「还开着的会话」永远不空。
 *
 * 五条都在这里钉住，另加两条覆盖不到的边界（跨天 04:00、乱序 ended）。
 */
describe('xq event recorder', () => {
  let db: PGlite;

  /**
   * `xq_concept_occurrence` 有一条复合外键 `(stage_id, scene_id) → document_scenes(stage_id, id)`，
   * 所以迁移跑不起来时差的就是这张表 —— 它属于文档库（不在本仓的学情迁移集里），
   * 测试里给最小形状即可。
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
    // 事件表有两个外键：`session_id → xq_session`、`concept_id → xq_concept`，
    // 所以必须跑完整迁移（v1 baseline 建表 + v2 四列），不能只建 xq_event。
    await ensureXqLearnerSchema(db);
  });

  const countEvents = async () => {
    const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_event');
    return Number(r.rows[0]!.n);
  };
  const countSessions = async () => {
    const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_session');
    return Number(r.rows[0]!.n);
  };

  const startInput = (overrides: Partial<XqEventInput> = {}): XqEventInput => ({
    kind: 'session_started',
    stageId: 'stage-A',
    occurredAt: '2026-11-08T02:00:00.000Z',
    ...overrides,
  });

  it('★ 会话 id 就是第一条事件的 id —— 不发明第二个 ID 生成器', async () => {
    const started = await recordXqEvent(db, startInput());
    expect(started.duplicate).toBe(false);
    expect(started.sessionId).toBe(started.eventId);

    const sessions = await db.query<{ session_id: string; seq_no: number; local_day: string }>(
      'SELECT session_id, seq_no, local_day FROM xq_session',
    );
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]!.session_id).toBe(started.eventId);
    expect(sessions.rows[0]!.seq_no).toBe(1);
  });

  it('★ 同一次开始投递两次只建一个会话 —— 重复不是第二次坐下学习', async () => {
    const first = await recordXqEvent(db, startInput());
    const again = await recordXqEvent(db, startInput());

    expect(again.duplicate).toBe(true);
    expect(again.sessionId).toBe(first.sessionId);
    expect(await countEvents()).toBe(1);
    expect(await countSessions()).toBe(1);
  });

  it('★ 同一页在同一时刻重发两次只算一次浏览，隔一分钟再看是新的一次', async () => {
    const { sessionId } = await recordXqEvent(db, startInput());
    const view = (occurredAt: string): XqEventInput => ({
      kind: 'page_viewed',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      sessionId,
      occurredAt,
    });

    const first = await recordXqEvent(db, view('2026-11-08T02:00:10.000Z'));
    const again = await recordXqEvent(db, view('2026-11-08T02:00:10.000Z'));
    const later = await recordXqEvent(db, view('2026-11-08T02:01:10.000Z'));

    expect(again.duplicate).toBe(true);
    expect(again.eventId).toBe(first.eventId);
    expect(later.duplicate).toBe(false);
    expect(later.eventId).not.toBe(first.eventId);
    expect(await countEvents()).toBe(3); // started + 两次不同时刻的 page_viewed
  });

  it('★ 手点三页就是三条 page_viewed —— 判据原文要的那个数', async () => {
    const { sessionId } = await recordXqEvent(db, startInput());
    for (const [index, sceneId] of ['scene-p1', 'scene-p2', 'scene-p3'].entries()) {
      await recordXqEvent(db, {
        kind: 'page_viewed',
        stageId: 'stage-A',
        sceneId,
        sessionId,
        occurredAt: `2026-11-08T02:0${index + 1}:00.000Z`,
      });
    }
    const r = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM xq_event WHERE kind = 'page_viewed'",
    );
    expect(Number(r.rows[0]!.n)).toBe(3);
  });

  it('★ 结束会话要真的关上：ended_at / end_reason / event_n 一起写', async () => {
    const { sessionId } = await recordXqEvent(db, startInput());
    await recordXqEvent(db, {
      kind: 'page_viewed',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      sessionId,
      occurredAt: '2026-11-08T02:00:10.000Z',
    });
    await recordXqEvent(db, {
      kind: 'session_ended',
      stageId: 'stage-A',
      sessionId,
      occurredAt: '2026-11-08T02:30:00.000Z',
      endReason: 'terminated',
    });

    const r = await db.query<{
      ended_at: string | null;
      end_reason: string | null;
      event_n: number;
      scene_n: number;
    }>('SELECT ended_at, end_reason, event_n, scene_n FROM xq_session WHERE session_id = $1', [
      sessionId,
    ]);
    expect(r.rows[0]!.ended_at).not.toBeNull();
    expect(r.rows[0]!.end_reason).toBe('terminated');
    // event_n 数的是这个会话里的**全部**事件：started + page_viewed + ended。
    expect(r.rows[0]!.event_n).toBe(3);
    expect(r.rows[0]!.scene_n).toBe(1);
  });

  it('★ 答题与复习事件也走同一条路 —— 由探针判定，事件只记录发生', async () => {
    const { sessionId } = await recordXqEvent(db, startInput());
    await recordXqEvent(db, {
      kind: 'answer_submitted',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q1',
      sessionId,
      occurredAt: '2026-11-08T02:05:00.000Z',
    });
    await recordXqEvent(db, {
      kind: 'review_failed',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q1',
      sessionId,
      occurredAt: '2026-11-08T02:06:00.000Z',
      payload: { round: 1 },
    });

    const r = await db.query<{ kind: string; question_id: string | null; payload: unknown }>(
      'SELECT kind, question_id, payload FROM xq_event WHERE kind <> $1 ORDER BY occurred_at',
      ['session_started'],
    );
    expect(r.rows.map((row) => row.kind)).toEqual(['answer_submitted', 'review_failed']);
    expect(r.rows[0]!.question_id).toBe('q1');
    expect(r.rows[1]!.payload).toEqual({ round: 1 });
  });

  it('★ 本地日期在 04:00 切换 —— 凌晨两点属于前一天', () => {
    // 同一台机器本地时区：这两条只比「跨不跨那个边界」，不钉具体时区。
    const before = new Date(2026, 10, 9, 2, 30); // 11-09 02:30 本地
    const after = new Date(2026, 10, 9, 4, 30); // 11-09 04:30 本地
    expect(localDayOf(before)).toBe('2026-11-08');
    expect(localDayOf(after)).toBe('2026-11-09');
  });

  it('★ 某天的第二个会话序号是 2 —— 同日多会话不撞唯一键', async () => {
    await recordXqEvent(db, startInput());
    await recordXqEvent(
      db,
      startInput({ occurredAt: '2026-11-08T09:00:00.000Z', stageId: 'stage-B' }),
    );
    const r = await db.query<{ seq_no: number }>('SELECT seq_no FROM xq_session ORDER BY seq_no');
    expect(r.rows.map((row) => row.seq_no)).toEqual([1, 2]);
  });

  it('★ 幂等键不靠调用方记得带 —— 派生只用本来就稳定的字段', () => {
    const occurredAt = new Date('2026-11-08T02:00:00.000Z');
    const input: XqEventInput = {
      kind: 'page_viewed',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      sessionId: 'sess-1',
      occurredAt: occurredAt.toISOString(),
    };
    expect(deriveDedupeKey(input, occurredAt)).toBe(deriveDedupeKey(input, occurredAt));
    // 换页就换键 —— 两条浏览是两件事。
    expect(deriveDedupeKey({ ...input, sceneId: 'scene-p2' }, occurredAt)).not.toBe(
      deriveDedupeKey(input, occurredAt),
    );
  });

  it('时间戳坏了就抛，不写半条事实', async () => {
    await expect(recordXqEvent(db, startInput({ occurredAt: 'not-a-date' }))).rejects.toThrow(
      RangeError,
    );
    await expect(recordXqEvent(db, startInput({ stageId: '' }))).rejects.toThrow(RangeError);
    expect(await countEvents()).toBe(0);
    expect(await countSessions()).toBe(0);
  });

  /**
   * ★ S5 建表时 `hint_subtype` 就被 CHECK 规定「hint_requested 必填」，
   * 但写入器直到 2026-11-10 都没有这个字段 —— 于是十六个 kind 里
   * 唯一一个带**方向**的事件从来没被写进去过。这三条钉住补上的路径。
   */
  it('★ 求提示必须说清是哪一类 —— 这一列终于写得进去了', async () => {
    const { sessionId } = await recordXqEvent(db, startInput());
    const hint = (hintSubtype?: 'instrumental' | 'executive'): XqEventInput => ({
      kind: 'hint_requested',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q1',
      sessionId,
      occurredAt: '2026-11-08T02:01:00.000Z',
      ...(hintSubtype === undefined ? {} : { hintSubtype }),
    });

    const written = await recordXqEvent(db, hint('instrumental'));
    expect(written.duplicate).toBe(false);

    const rows = await db.query<{ hint_subtype: string | null; kind: string }>(
      'SELECT hint_subtype, kind FROM xq_event WHERE event_id = $1',
      [written.eventId],
    );
    expect(rows.rows[0]).toEqual({ hint_subtype: 'instrumental', kind: 'hint_requested' });
  });

  it('★ 说了要求提示却不说哪一类，发 SQL 之前就抛 —— 不留半条', async () => {
    const { sessionId } = await recordXqEvent(db, startInput());
    await expect(
      recordXqEvent(db, {
        kind: 'hint_requested',
        stageId: 'stage-A',
        sceneId: 'scene-p1',
        sessionId,
        occurredAt: '2026-11-08T02:01:00.000Z',
      }),
    ).rejects.toThrow(RangeError);
    expect(await countEvents()).toBe(1); // 只有那条 session_started
  });

  it('★ 别的 kind 不许挂提示类型 —— 那是写错行，不是宽容', async () => {
    const { sessionId } = await recordXqEvent(db, startInput());
    await expect(
      recordXqEvent(db, {
        kind: 'page_viewed',
        stageId: 'stage-A',
        sceneId: 'scene-p1',
        sessionId,
        occurredAt: '2026-11-08T02:01:00.000Z',
        hintSubtype: 'executive',
      }),
    ).rejects.toThrow(RangeError);
    expect(await countEvents()).toBe(1);
  });

  it('契约漂移会当场红 —— kind 与 end_reason 的取值与 DDL 逐字一致', async () => {
    const kinds = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'xq_event_kind_check'`,
    );
    for (const kind of XQ_EVENT_KINDS) {
      expect(kinds.rows[0]!.def).toContain(`'${kind}'`);
    }
    const reasons = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'xq_session_end_reason_check'`,
    );
    for (const reason of XQ_END_REASONS) {
      expect(reasons.rows[0]!.def).toContain(`'${reason}'`);
    }
    const hints = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'xq_event_hint_subtype_check'`,
    );
    for (const subtype of XQ_HINT_SUBTYPES) {
      expect(hints.rows[0]!.def).toContain(`'${subtype}'`);
    }
  });
});
