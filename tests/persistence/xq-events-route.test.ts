import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/persistence/xq/events` 的路由级判据。
 *
 * 这一段走的是**真路由 + 真写入器**，只把连接池换成 PGlite：判据要盖住
 * 「浏览器发来的那串 JSON 到 xq_event 之间」的所有翻译（形状校验、kind 白名单、
 * 幂等、状态码），而那一段翻译全在路由里 —— 只测写入器会漏掉它。
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

const COOKIE = 'anonymous_id=77777777-7777-4777-8777-777777777777';

async function bootRoute() {
  const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
  return handlePersistenceRequest;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/persistence/xq/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      cookie: COOKIE,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

type Handle = Awaited<ReturnType<typeof bootRoute>>;

async function openSession(handle: Handle, stageId = 'stage-s5'): Promise<string> {
  const response = await handle(
    post({ kind: 'session_started', stageId, occurredAt: '2026-11-09T02:00:00.000Z' }),
    {},
  );
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { sessionId: string };
  return payload.sessionId;
}

describe('POST /api/persistence/xq/events', () => {
  let db: PGlite;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', 'postgres://xq-events-route-test');
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await db.exec(OWNER_MERGES_MIN);
    const { ensureXqLearnerSchema } = await import('@/lib/persistence/xq-learner');
    await ensureXqLearnerSchema(db);
    holder.queryable = db;
  });

  const countEvents = async (kind: string): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM xq_event WHERE kind = $1',
      [kind],
    );
    return rows[0]!.n;
  };

  it('★ 手点三页 = 三条 page_viewed —— 判据原文要的那个数，走真路由', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);

    for (const sceneId of ['scene-p1', 'scene-p2', 'scene-p3']) {
      const response = await handle(
        post({
          kind: 'page_viewed',
          stageId: 'stage-s5',
          sceneId,
          occurredAt: `2026-11-09T02:0${sceneId.at(-1)}:00.000Z`,
          sessionId,
        }),
        {},
      );
      expect(response.status).toBe(201);
    }

    expect(await countEvents('page_viewed')).toBe(3);
    const { rows } = await db.query<{ event_n: number; scene_n: number }>(
      'SELECT event_n, scene_n FROM xq_session WHERE session_id = $1',
      [sessionId],
    );
    // 会话行还没关，event_n 只在关会话时汇总 —— 这里只钉「三页都在会话里」。
    expect(rows[0]!.event_n).toBe(0);
  });

  it('★ 同一事件重发两次，count(*) 不变 —— 幂等返回 200 而不是再落一行', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    const body = {
      kind: 'page_viewed',
      stageId: 'stage-s5',
      sceneId: 'scene-p1',
      occurredAt: '2026-11-09T02:10:00.000Z',
      sessionId,
    };

    const first = await handle(post(body), {});
    const second = await handle(post(body), {});

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ duplicate: true });
    expect(await countEvents('page_viewed')).toBe(1);
  });

  it('★ 未知 kind 当场 400 —— 拼错的 kind 不该在库里变成一个陌生事实', async () => {
    const handle = await bootRoute();
    const response = await handle(
      post({ kind: 'page_viewd', stageId: 'stage-s5', occurredAt: '2026-11-09T02:00:00.000Z' }),
      {},
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await countEvents('page_viewed')).toBe(0);
  });

  it('★ 不是 POST 就是 405 —— 事件是只追加的，没有读法', async () => {
    const handle = await bootRoute();
    const response = await handle(
      new Request('http://localhost/api/persistence/xq/events', {
        method: 'GET',
        headers: { cookie: COOKIE, origin: 'http://localhost' },
      }),
      {},
    );

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'METHOD_NOT_ALLOWED' },
    });
  });

  it('★ 结束会话走同一条路：ended_at / end_reason / event_n 一起落', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    await handle(
      post({
        kind: 'page_viewed',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        occurredAt: '2026-11-09T02:01:00.000Z',
        sessionId,
      }),
      {},
    );

    const ended = await handle(
      post({
        kind: 'session_ended',
        stageId: 'stage-s5',
        occurredAt: '2026-11-09T02:30:00.000Z',
        sessionId,
        endReason: 'terminated',
      }),
      {},
    );

    expect(ended.status).toBe(201);
    const { rows } = await db.query<{
      end_reason: string;
      ended_at: string | null;
      event_n: number;
      scene_n: number;
    }>(
      'SELECT end_reason, ended_at::text AS ended_at, event_n, scene_n FROM xq_session WHERE session_id = $1',
      [sessionId],
    );
    expect(rows[0]!.end_reason).toBe('terminated');
    expect(rows[0]!.ended_at).not.toBeNull();
    // event_n 数的是这个会话里的**全部**事件：started + page_viewed + ended。
    expect(rows[0]!.event_n).toBe(3);
    expect(rows[0]!.scene_n).toBe(1);
  });

  /**
   * ★ 提示分型从浏览器到表里是一条完整的路 —— 2026-11-10 之前它断在写入器。
   *
   * 断的时候的症状很安静：DDL 的 CHECK 要求 `hint_requested` 必带类型，
   * 而写入器的字段与列清单都没有它，于是唯一一个带方向的 kind
   * 从来没有被写进去过 —— 没有报错，只是**永远为零**。
   */
  it('★ 提示分型写得进去，且落在 hint_subtype 列上', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);

    // 提问闸：instrumental 要求同一道题上已有更早的作答痕迹。
    const attempt = await handle(
      post({
        kind: 'answer_attempted',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q1',
        occurredAt: '2026-11-09T02:19:00.000Z',
        sessionId,
      }),
      {},
    );
    expect(attempt.status).toBe(201);

    const instrumental = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q1',
        occurredAt: '2026-11-09T02:20:00.000Z',
        sessionId,
        hintSubtype: 'instrumental',
      }),
      {},
    );
    expect(instrumental.status).toBe(201);

    const executive = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q2',
        occurredAt: '2026-11-09T02:21:00.000Z',
        sessionId,
        hintSubtype: 'executive',
      }),
      {},
    );
    expect(executive.status).toBe(201);

    const { rows } = await db.query<{ hint_subtype: string }>(
      `SELECT hint_subtype FROM xq_event
        WHERE kind = 'hint_requested' ORDER BY occurred_at`,
    );
    // 两个方向必须分开落 —— 合成一个「用过提示」就再也折不出折扣。
    expect(rows.map((r) => r.hint_subtype)).toEqual(['instrumental', 'executive']);
  });

  it('★ 未知提示类型当场 400 —— 不接受一个错的方向', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    const response = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        occurredAt: '2026-11-09T02:22:00.000Z',
        sessionId,
        hintSubtype: 'hint',
      }),
      {},
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await countEvents('hint_requested')).toBe(0);
  });

  it('★ 要求提示却不说类型，400 而不是 500 —— 是请求不对，不是服务端坏了', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    const response = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        occurredAt: '2026-11-09T02:23:00.000Z',
        sessionId,
      }),
      {},
    );
    expect(response.status).toBe(400);
    expect(await countEvents('hint_requested')).toBe(0);
  });

  it('★ 带题号却不带类型，仍是 400 —— 形状先于闸，别把「少个字段」说成「先答题」', async () => {
    // 实测踩过：`hint_requested` 带题号但漏 `hintSubtype` 时，闸先跑、
    // 抛 `XqAnswerNotStartedError`，回的是 409「先答题」。学生照做去答了题，
    // 再点一次仍然 409 —— 因为真正缺的是请求里的那个字段，不是前置事件。
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    const response = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q1',
        occurredAt: '2026-11-09T02:23:00.000Z',
        sessionId,
      }),
      {},
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_FAILED');
    expect(await countEvents('hint_requested')).toBe(0);
  });

  it('★ 没先动过手就问「怎么想」，409 且一行都不写 —— 闸在写入侧，不是界面上不好点', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    const response = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q1',
        occurredAt: '2026-11-09T02:30:00.000Z',
        sessionId,
        hintSubtype: 'instrumental',
      }),
      {},
    );
    // 409 而不是 400：请求形状没错，是**顺序**不对。
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'ANSWER_FIRST' },
    });
    expect(await countEvents('hint_requested')).toBe(0);
  });

  it('★ 先答过再问就放行 —— 挡的是顺序，不是提问本身', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    const attempt = await handle(
      post({
        kind: 'answer_attempted',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q1',
        occurredAt: '2026-11-09T02:31:00.000Z',
        sessionId,
      }),
      {},
    );
    expect(attempt.status).toBe(201);

    const response = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q1',
        occurredAt: '2026-11-09T02:32:00.000Z',
        sessionId,
        hintSubtype: 'instrumental',
      }),
      {},
    );
    expect(response.status).toBe(201);
    expect(await countEvents('hint_requested')).toBe(1);
  });

  it('★ 回答在提问之后不算 —— 闸判的是先后，不是有没有', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    const attempt = await handle(
      post({
        kind: 'answer_attempted',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q1',
        occurredAt: '2026-11-09T02:41:00.000Z',
        sessionId,
      }),
      {},
    );
    expect(attempt.status).toBe(201);

    const response = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q1',
        occurredAt: '2026-11-09T02:40:00.000Z',
        sessionId,
        hintSubtype: 'instrumental',
      }),
      {},
    );
    expect(response.status).toBe(409);
    expect(await countEvents('hint_requested')).toBe(0);
  });

  it('★ executive 不受管 —— 留一个自由口子，但如实记成「要答案」', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    const response = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        questionId: 'q1',
        occurredAt: '2026-11-09T02:50:00.000Z',
        sessionId,
        hintSubtype: 'executive',
      }),
      {},
    );
    // 挡死会把学生推到搜索引擎那边 —— 那边一个事件都收不到。
    expect(response.status).toBe(201);
  });

  it('★ 页面级提问（没有题号）不受管 —— 没有「先答」的对象', async () => {
    const handle = await bootRoute();
    const sessionId = await openSession(handle);
    const response = await handle(
      post({
        kind: 'hint_requested',
        stageId: 'stage-s5',
        sceneId: 'scene-p1',
        occurredAt: '2026-11-09T02:55:00.000Z',
        sessionId,
        hintSubtype: 'instrumental',
      }),
      {},
    );
    expect(response.status).toBe(201);
  });
});
