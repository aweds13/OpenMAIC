import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_PG_SCHEMA } from '@openmaic/storage/runtime/pg';

const holder = vi.hoisted(() => ({ queryable: undefined as unknown }));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: holder.queryable }),
}));

/**
 * `GET /api/persistence/xq/ai-log` 的判据。
 *
 * 这一层只测**路由自己的决定**（方法、`day` 校验、限制、序列化），
 * 拼接逻辑在 `xq-ai-log.test.ts` 里。分开是为了让失败一眼看出是哪一层。
 */
describe('xq ai log route', () => {
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

  const OWNER_MERGES_MIN = `CREATE TABLE IF NOT EXISTS owner_merges (
    from_owner_id text PRIMARY KEY,
    to_owner_id   text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
  );`;

  const COOKIE = 'anonymous_id=99999999-9999-4999-8999-999999999999';

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://xq-ai-log-route-test');
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await db.exec(OWNER_MERGES_MIN);
    await db.exec(RUNTIME_PG_SCHEMA);
    const { ensureXqLearnerSchema } = await import('@/lib/persistence/xq-learner');
    await ensureXqLearnerSchema(db);
    holder.queryable = db;
  });

  const request = async (path: string, method = 'GET'): Promise<Response> => {
    const { GET, POST, PUT, DELETE } = await import('@/app/api/persistence/[...path]/route');
    const handlers: Record<string, (r: Request) => Promise<Response>> = {
      GET,
      POST,
      PUT,
      DELETE,
    };
    const handler = handlers[method];
    return handler(
      new Request(`http://localhost/api/persistence${path}`, {
        method,
        headers: { cookie: COOKIE, origin: 'http://localhost' },
      }),
    );
  };

  const seed = async (): Promise<void> => {
    const { recordXqEvent } = await import('@/lib/persistence/xq-event-recorder');
    const t0 = '2026-11-08T02:00:00.000Z';
    const started = await recordXqEvent(db, {
      kind: 'session_started',
      stageId: 'stage-A',
      occurredAt: t0,
    });
    await recordXqEvent(db, {
      kind: 'hint_requested',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q1',
      occurredAt: '2026-11-08T02:00:01.000Z',
      sessionId: started.sessionId,
      hintSubtype: 'instrumental',
      payload: { stem: '题干' },
    });
    await db.query(
      `INSERT INTO runtime_sessions (id, stage_id, learner_key, kind, status, created_at, updated_at, data)
       VALUES ('chat:stage-A:l:s1', 'stage-A', 'l', 'chat', 'active', $1, $1, '{}'::jsonb)`,
      [t0],
    );
    await db.query(
      `INSERT INTO runtime_records (id, session_id, seq, scene_id, created_at, data)
       VALUES ('rec-1', 'chat:stage-A:l:s1', 0, 'scene-p1', $1, $2::jsonb)`,
      [
        '2026-11-08T02:00:02.000Z',
        JSON.stringify({
          subAnchor: 'q1',
          payload: { kind: 'chat_message', role: 'user', content: '这里为什么要用 final？' },
        }),
      ],
    );
  };

  it('★ 回一条提问带着它的对话轮次', async () => {
    await seed();
    const response = await request('/xq/ai-log');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as {
      entries: { questionId: string; hintSubtype: string; turns: { role: string }[] }[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].questionId).toBe('q1');
    expect(body.entries[0].hintSubtype).toBe('instrumental');
    expect(body.entries[0].turns.map((turn) => turn.role)).toEqual(['user']);
  });

  it('★ 一条提问都没有时回空数组，不是 404', async () => {
    const response = await request('/xq/ai-log');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [] });
  });

  it('★ day 不成形回 400 —— 忽略它会悄悄放宽成「全部日期」', async () => {
    for (const bad of ['2026/11/08', 'yesterday', '2026-11-8']) {
      const response = await request(`/xq/ai-log?day=${encodeURIComponent(bad)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('★ 空 day 当作没给', async () => {
    await seed();
    const response = await request('/xq/ai-log?day=');
    expect(response.status).toBe(200);
  });

  it('★ limit 乱写回默认，不报错', async () => {
    await seed();
    for (const raw of ['abc', '-3', '0']) {
      const response = await request(`/xq/ai-log?limit=${raw}`);
      expect(response.status).toBe(200);
    }
  });

  it('★ 不是 GET 就 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await request('/xq/ai-log', method);
      expect(response.status).toBe(405);
    }
  });
});
