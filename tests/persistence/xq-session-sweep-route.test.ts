import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import { recordXqEvent } from '@/lib/persistence/xq-event-recorder';

/**
 * 收尾器接在 `GET /xq/sessions` 上。
 *
 * 为什么接在这里而不是一条独立的 POST：**没有别的地方会来修**。
 * 这个视图是唯一一个会被打开、且正好关心「死会话」这件事的入口 ——
 * 它自己的合计就是被死会话弄坏的那一个数。
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

const OWNER_MERGES_MIN = `CREATE TABLE IF NOT EXISTS owner_merges (
    from_owner_id text NOT NULL,
    to_owner_id   text NOT NULL
  );`;

const holder = vi.hoisted(() => ({ queryable: undefined as unknown }));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: holder.queryable }),
}));

const COOKIE = 'anonymous_id=99999999-9999-4999-8999-999999999999';
const request = (): Request =>
  new Request('http://localhost/api/persistence/xq/sessions', {
    method: 'GET',
    headers: { cookie: COOKIE, origin: 'http://localhost' },
  });

let db: PGlite;

const bootRoute = async () => await import('@/app/api/persistence/[...path]/route');

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://xq-session-sweep-route-test');
  db = new PGlite();
  await db.waitReady;
  db.exec(DOCUMENT_SCENES_MIN);
  db.exec(OWNER_MERGES_MIN);
  await ensureXqLearnerSchema(db);
  holder.queryable = db;
});

const T0 = '2026-11-09T08:00:00.000Z';

async function ghostSession(): Promise<string> {
  const started = await recordXqEvent(db, {
    kind: 'session_started',
    stageId: 'stage-a',
    occurredAt: T0,
  });
  await recordXqEvent(db, {
    kind: 'page_viewed',
    stageId: 'stage-a',
    sessionId: started.sessionId,
    sceneId: 'scene-p1',
    occurredAt: '2026-11-09T08:05:00.000Z',
  });
  return started.sessionId;
}

async function openCount(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM xq_session WHERE ended_at IS NULL',
  );
  return Number(rows[0]?.n ?? 0);
}

describe('GET /xq/sessions：读顺手把死会话收掉', () => {
  it('★ 一个静默太久的会话，读一次之后就不再是「进行中」', async () => {
    await ghostSession();
    expect(await openCount()).toBe(1);
    const { GET } = await bootRoute();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await openCount()).toBe(0);
    const body = (await response.json()) as { sessions: Array<{ endedAt: string | null }> };
    // 收尾发生在**读之前**，所以这一次读出来的就已经是关掉的那一行。
    expect(body.sessions[0]?.endedAt).not.toBeNull();
  });

  it('★ 第二次读不再收（收尾本身把会话关掉了）', async () => {
    await ghostSession();
    const { GET } = await bootRoute();
    await GET(request());
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM xq_event WHERE kind = 'session_abandoned'",
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
    await GET(request());
    const again = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM xq_event WHERE kind = 'session_abandoned'",
    );
    expect(Number(again.rows[0]?.n ?? 0)).toBe(1);
  });

  it('★ 收尾抛异常也照样回 200 —— 一次收不掉不该让人看不到自己的记录', async () => {
    await ghostSession();
    // 把收尾整个换成一个会抛的实现。用 `doMock` + 重新 import，
    // 才能只影响这一次（文件顶层的 `vi.mock` 是静态的）。
    vi.doMock('@/lib/persistence/xq-session-sweeper', () => ({
      sweepStaleSessions: async () => {
        throw new Error('sweep exploded');
      },
    }));
    const { GET } = await bootRoute();
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessions: unknown[] };
    // 读照常给出那一行 —— 会话还开着（收尾没成功），但它**看得见**。
    expect(body.sessions).toHaveLength(1);
    // 那条会话仍然是进行中：收尾失败就是失败，不假装关掉了。
    expect(await openCount()).toBe(1);
    vi.doUnmock('@/lib/persistence/xq-session-sweeper');
  });
});
