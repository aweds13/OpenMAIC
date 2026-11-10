import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import { recordXqEvent } from '@/lib/persistence/xq-event-recorder';
import { sweepStaleSessions } from '@/lib/persistence/xq-session-sweeper';

/**
 * 会话收尾器。
 *
 * 它防的是「浏览器没打招呼就消失」那四种情况：断电、崩溃、进程被杀、
 * `keepalive` 被中间层截掉。那些时候客户端不会再跑一行代码，会话在库里
 * 永远开着 —— 而 `/sessions` 的合计只累加**已结束**的会话，于是那一次
 * 学习被永久地从「今天学了多久」里抹掉。
 */

let db: PGlite;

/**
 * `xq_concept_occurrence` 对 `document_scenes` 有一条复合外键
 * `(stage_id, scene_id) → document_scenes(stage_id, id)`，而那个表属于
 * 上游 storage 包、不在本仓的迁移里 —— 所以每个学情测试都自带一份最小骨架。
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
  db.exec(DOCUMENT_SCENES_MIN);
  await ensureXqLearnerSchema(db);
});

const T0 = '2026-11-09T08:00:00.000Z';
const at = (iso: string) => new Date(iso);

async function startSession(sessionStage = 'stage-a'): Promise<string> {
  const started = await recordXqEvent(db, {
    kind: 'session_started',
    stageId: sessionStage,
    occurredAt: T0,
  });
  return started.sessionId;
}

async function view(sessionId: string, sceneId: string, occurredAt: string) {
  return recordXqEvent(db, {
    kind: 'page_viewed',
    stageId: 'stage-a',
    sessionId,
    sceneId,
    occurredAt,
  });
}

async function openSessions(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM xq_session WHERE ended_at IS NULL',
  );
  return Number(rows[0]?.n ?? 0);
}

async function abandonedCount(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM xq_event WHERE kind = 'session_abandoned'",
  );
  return Number(rows[0]?.n ?? 0);
}

describe('sweepStaleSessions：静默太久的会话要收掉', () => {
  it('★ 翻页之后静默 61 分钟就收 —— 用 60 分钟那一档', async () => {
    const sessionId = await startSession();
    await view(sessionId, 'scene-p1', '2026-11-09T08:05:00.000Z');
    expect(await openSessions()).toBe(1);

    const swept = await sweepStaleSessions(db, { now: () => at('2026-11-09T09:06:01.000Z') });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.endReason).toBe('idle_60m');
    expect(await openSessions()).toBe(0);
    expect(await abandonedCount()).toBe(1);
  });

  it('★ 静默 59 分钟不收 —— 阈值是「超过」，不是「到达」', async () => {
    const sessionId = await startSession();
    await view(sessionId, 'scene-p1', '2026-11-09T08:05:00.000Z');
    const swept = await sweepStaleSessions(db, { now: () => at('2026-11-09T09:04:00.000Z') });
    expect(swept).toHaveLength(0);
    expect(await openSessions()).toBe(1);
  });

  it('★ 刚打开还没翻页就停在 31 分钟 —— 用 30 分钟那一档', async () => {
    await startSession();
    const swept = await sweepStaleSessions(db, { now: () => at('2026-11-09T08:31:00.000Z') });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.endReason).toBe('idle_30m');
  });

  it('★ 同一刻重跑只落一条 —— 幂等键用最后一条事件的时刻，不是 now()', async () => {
    const sessionId = await startSession();
    await view(sessionId, 'scene-p1', '2026-11-09T08:05:00.000Z');
    const now = () => at('2026-11-09T09:30:00.000Z');
    const first = await sweepStaleSessions(db, { now });
    const second = await sweepStaleSessions(db, { now });
    expect(first).toHaveLength(1);
    // 第二次这个会话已经不在"开着"那批里了 —— 收尾本身把它关掉了。
    expect(second).toHaveLength(0);
    expect(await abandonedCount()).toBe(1);
  });

  it('★ 已经正常结束的会话不再被收（不许覆盖 terminated 的原因）', async () => {
    const sessionId = await startSession();
    await view(sessionId, 'scene-p1', '2026-11-09T08:05:00.000Z');
    await recordXqEvent(db, {
      kind: 'session_ended',
      stageId: 'stage-a',
      sessionId,
      occurredAt: '2026-11-09T08:10:00.000Z',
      endReason: 'terminated',
    });
    const swept = await sweepStaleSessions(db, { now: () => at('2026-11-09T12:00:00.000Z') });
    expect(swept).toHaveLength(0);
    const { rows } = await db.query<{ end_reason: string | null }>(
      'SELECT end_reason FROM xq_session WHERE session_id = $1',
      [sessionId],
    );
    expect(rows[0]?.end_reason).toBe('terminated');
  });

  it('★ stage_id 为空的会话跳过 —— 不补空串（那会写出不属于任何课的事实）', async () => {
    const sessionId = await startSession();
    // DDL 允许 stage_id 为空；直接改一条出来模拟历史数据。
    await db.query('UPDATE xq_event SET stage_id = NULL WHERE session_id = $1', [sessionId]);
    const swept = await sweepStaleSessions(db, { now: () => at('2026-11-09T12:00:00.000Z') });
    expect(swept).toHaveLength(0);
    expect(await openSessions()).toBe(1);
  });

  it('★ 收尾事件带 went 的 stage —— 读侧才归得了位', async () => {
    const sessionId = await startSession();
    await view(sessionId, 'scene-p1', '2026-11-09T08:05:00.000Z');
    await sweepStaleSessions(db, { now: () => at('2026-11-09T09:30:00.000Z') });
    const { rows } = await db.query<{ stage_id: string | null; end_reason: string | null }>(
      "SELECT e.stage_id, s.end_reason FROM xq_event e JOIN xq_session s USING (session_id) WHERE e.kind = 'session_abandoned'",
    );
    expect(rows[0]?.stage_id).toBe('stage-a');
    expect(rows[0]?.end_reason).toBe('idle_60m');
  });

  it('两条会话各自按自己最后一档判 —— 一条翻过页，一条没有', async () => {
    const a = await startSession('stage-a');
    await view(a, 'scene-p1', '2026-11-09T08:05:00.000Z');
    const b = await startSession('stage-b');
    const swept = await sweepStaleSessions(db, { now: () => at('2026-11-09T09:06:01.000Z') });
    const byId = new Map(swept.map((s) => [s.sessionId, s.endReason]));
    expect(byId.get(a)).toBe('idle_60m');
    // b 只活到 09:06 之后 66 分钟 —— 30 分钟档早就过了，但因为它的最后一条
    // 事件也是 08:00（session_started），61 分钟时它同样超了 30 分钟。
    expect(byId.get(b)).toBe('idle_30m');
  });

  it('limit 为 0 时什么都不查 —— 用来关掉这条路径', async () => {
    const sessionId = await startSession();
    await view(sessionId, 'scene-p1', '2026-11-09T08:05:00.000Z');
    const swept = await sweepStaleSessions(db, {
      now: () => at('2026-11-09T12:00:00.000Z'),
      limit: 0,
    });
    expect(swept).toHaveLength(0);
    expect(await openSessions()).toBe(1);
  });
});
