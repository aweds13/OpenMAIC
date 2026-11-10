import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/persistence/xq/reviews` 的路由级判据。
 *
 * 与 `xq-events-route.test.ts` 同一套做法：真路由 + 真写入器，只把连接池换成
 * PGlite。要盖住的是「浏览器发来的那串 JSON 到排期表之间」的翻译 ——
 * 形状校验、outcome 白名单、round 必须是正整数、关不存在时 404、
 * 幂等重投 200。
 *
 * 这一条路由存在的理由同样要被钉住：**记完之后那一关不再到期**。
 * 若哪天有人把它改回「只写事件不动排期」，这里的最后一条会红。
 */

const holder = vi.hoisted(() => ({
  queryable: undefined as unknown,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: holder.queryable }),
}));

const DOCUMENT_SCENES_MIN = `CREATE TABLE IF NOT EXISTS document_stages (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at double precision NOT NULL,
    updated_at double precision NOT NULL,
    data jsonb NOT NULL
  );
  
CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id text NOT NULL,
  id text NOT NULL,
  scene_order integer,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (stage_id, id)
);
`;

/** 退休围栏读这张表；建出来让真实实现跑通（查不到 = 没退休）。 */
const OWNER_MERGES_MIN = `
CREATE TABLE IF NOT EXISTS owner_merges (
  from_owner_id text PRIMARY KEY,
  to_owner_id text NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  from_assurance text,
  moved jsonb NOT NULL DEFAULT '{}'::jsonb
);
`;

const COOKIE = 'anonymous_id=88888888-8888-4888-8888-888888888888';

const STAGE = 'stage-r1';
const SCENE = 'scene-p1';
const QUESTION = 'q1';
const CONCEPT = '类与对象';

async function bootRoute() {
  const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
  return handlePersistenceRequest;
}

function request(path: string, body: unknown, method = 'POST'): Request {
  return new Request(`http://localhost/api/persistence${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      cookie: COOKIE,
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

const reviewBody = (overrides: Record<string, unknown> = {}) => ({
  stageId: STAGE,
  sceneId: SCENE,
  questionId: QUESTION,
  concept: CONCEPT,
  round: 1,
  outcome: 'pass',
  occurredAt: '2026-11-09T02:00:00.000Z',
  ...overrides,
});

describe('POST /api/persistence/xq/reviews', () => {
  let db: PGlite;
  let sessionId: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', 'postgres://xq-reviews-route-test');
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await db.exec(OWNER_MERGES_MIN);
    const { ensureXqLearnerSchema } = await import('@/lib/persistence/xq-learner');
    await ensureXqLearnerSchema(db);
    holder.queryable = db;

    // 四关得先排上，否则这条路由只会回 404。
    const { XqLearnerStore } = await import('@/lib/persistence/xq-learner-store');
    await new XqLearnerStore({ queryable: db }).scheduleReviewForWrong(
      STAGE,
      SCENE,
      QUESTION,
      CONCEPT,
    );

    // 事件表对 xq_session 有外键 —— 真开一个会话。
    const handle = await bootRoute();
    const response = await handle(
      request('/xq/events', {
        kind: 'session_started',
        stageId: STAGE,
        occurredAt: '2026-11-08T02:00:00.000Z',
      }),
      {},
    );
    expect(response.status).toBe(201);
    sessionId = ((await response.json()) as { sessionId: string }).sessionId;
  });

  const countEvents = async (kind: string): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM xq_event WHERE kind = $1',
      [kind],
    );
    return rows[0]!.n;
  };

  const rounds = async () => {
    const { rows } = await db.query<{
      round: number;
      done_at: Date | null;
      outcome: string | null;
    }>(
      `SELECT round, done_at, outcome FROM xq_review_schedule
        WHERE stage_id = $1 AND scene_id = $2 AND question_id = $3 AND concept = $4
        ORDER BY round`,
      [STAGE, SCENE, QUESTION, CONCEPT],
    );
    return rows.map((row) => ({
      round: Number(row.round),
      done: row.done_at != null,
      outcome: row.outcome,
    }));
  };

  it('★ 答对走真路由：201 + 一条 review_passed + 这一关关掉', async () => {
    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews', reviewBody({ sessionId })), {});

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ recorded: true, duplicate: false });
    expect(await countEvents('review_passed')).toBe(1);
    expect((await rounds())[0]).toMatchObject({ round: 1, done: true, outcome: 'pass' });
  });

  it('★ 做错：写 review_failed 并把四关重排', async () => {
    const handle = await bootRoute();
    const response = await handle(
      request('/xq/reviews', reviewBody({ sessionId, outcome: 'fail' })),
      {},
    );

    expect(response.status).toBe(201);
    expect(await countEvents('review_failed')).toBe(1);
    expect((await rounds()).every((row) => !row.done && row.outcome === null)).toBe(true);
  });

  it('★ 跳过：不写事件，但这一关算做完', async () => {
    const handle = await bootRoute();
    const response = await handle(
      request('/xq/reviews', reviewBody({ sessionId, outcome: 'skip' })),
      {},
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ recorded: true, eventId: null });
    expect(await countEvents('review_passed')).toBe(0);
    expect(await countEvents('review_failed')).toBe(0);
    expect((await rounds())[0]).toMatchObject({ round: 1, done: true, outcome: 'skip' });
  });

  it('★ 重投同一请求：200 + duplicate，库里仍一条事件', async () => {
    const handle = await bootRoute();
    const body = reviewBody({ sessionId, outcome: 'fail' });

    const first = await handle(request('/xq/reviews', body), {});
    const second = await handle(request('/xq/reviews', body), {});

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ duplicate: true });
    expect(await countEvents('review_failed')).toBe(1);
  });

  it('★ 关不存在回 404 而不是 400 —— 请求形状没错，是那一关没了', async () => {
    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews', reviewBody({ sessionId, round: 9 })), {});

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'REVIEW_ROUND_NOT_FOUND' },
    });
    expect(await countEvents('review_passed')).toBe(0);
  });

  it('★ outcome 拼错当场 400，不落库', async () => {
    const handle = await bootRoute();
    const response = await handle(
      request('/xq/reviews', reviewBody({ sessionId, outcome: 'passed' })),
      {},
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await countEvents('review_passed')).toBe(0);
  });

  it('★ round 必须是正整数，1.5 与 0 都拒', async () => {
    const handle = await bootRoute();
    for (const round of [0, 1.5, '1']) {
      const response = await handle(request('/xq/reviews', reviewBody({ sessionId, round })), {});
      expect(response.status).toBe(400);
    }
  });

  it('★ 缺 sessionId 就拒 —— 事件表那一列是 NOT NULL', async () => {
    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews', reviewBody()), {});

    expect(response.status).toBe(400);
  });

  it('★ 不是 GET 也不是 POST 就 405', async () => {
    // GET 是读侧（到期队列，见 `xq-review-queue.test.ts`），POST 是写侧；
    // 这个资源只有这两半。
    const handle = await bootRoute();
    for (const method of ['PUT', 'DELETE']) {
      const response = await handle(request('/xq/reviews', null, method), {});
      expect(response.status).toBe(405);
    }
  });

  it('★ 记完之后不再出现在「今天到期的复习」里 —— 这条路由的全部理由', async () => {
    const { XqLearnerStore } = await import('@/lib/persistence/xq-learner-store');
    const store = new XqLearnerStore({ queryable: db });
    // 排期的锚点是真实 `now()`，所以要挑一个晚于第 15 天的时刻才看得见。
    const farLater = new Date(Date.now() + 40 * 24 * 3600 * 1000);
    const before = await store.dueReviews(farLater);
    expect(before.map((r) => r.round)).toContain(1);

    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews', reviewBody({ sessionId })), {});
    expect(response.status).toBe(201);

    // 答对只关掉这一关：后三关照旧排着（四关是递进的，不是一次全清）。
    const after = await store.dueReviews(farLater);
    expect(after.map((r) => r.round)).not.toContain(1);
    expect(after).toHaveLength(before.length - 1);
  });
});
