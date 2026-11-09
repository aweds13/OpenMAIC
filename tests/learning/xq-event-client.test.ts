import { describe, expect, it, vi } from 'vitest';

import { createXqEventClient, XQ_EVENT_ENDPOINT } from '@/lib/learning/xq-event-client';

/**
 * 浏览器侧事件发送端的判据。
 *
 * 这一段防的不是报错，是**悄悄多发/少发**：
 * - 一次播放里连点三页 ⇒ 必须三条 `page_viewed`，但**只有一条** `session_started`；
 * - 三个请求同一 tick 齐发 ⇒ 不能建出两个会话；
 * - 发送失败 ⇒ 不许抛（用不了产品比少一条事件更糟），但要重试一次；
 * - 4xx ⇒ 不许重试（请求本身不对，重发只是再错一次）。
 */
describe('xq event client', () => {
  interface Call {
    url: string;
    body: Record<string, unknown>;
  }

  const fakeFetch = (
    responses: (call: Call) => { status: number; json?: unknown },
  ): {
    calls: Call[];
    fetchImpl: typeof fetch;
  } => {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const call = { url: String(input), body };
      calls.push(call);
      const answer = responses(call);
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.json ?? {},
      } as unknown as Response;
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  /** 服务端的幂等语义：`session_started` 回一个固定 id。 */
  const serverThatOpens = (sessionId = 'sess-1') =>
    fakeFetch((call) => {
      if (call.body.kind === 'session_started') {
        return { status: 201, json: { eventId: sessionId, sessionId, duplicate: false } };
      }
      return { status: 201, json: { eventId: 'e', sessionId, duplicate: false } };
    });

  it('★ 连点三页 = 三条 page_viewed + 只有一条 session_started', async () => {
    const { calls, fetchImpl } = serverThatOpens();
    const now = () => new Date('2026-11-08T02:00:00.000Z');
    const client = createXqEventClient({ fetchImpl, now });

    await client.viewPage('stage-A', 'scene-p1');
    await client.viewPage('stage-A', 'scene-p2');
    await client.viewPage('stage-A', 'scene-p3');

    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.body.kind === 'session_started')).toHaveLength(1);
    const viewed = calls.filter((call) => call.body.kind === 'page_viewed');
    expect(viewed.map((call) => call.body.sceneId)).toEqual(['scene-p1', 'scene-p2', 'scene-p3']);
    // 后续事件都挂在同一条会话上。
    expect(new Set(viewed.map((call) => call.body.sessionId))).toEqual(new Set(['sess-1']));
    expect(calls[0]!.url).toBe(XQ_EVENT_ENDPOINT);
  });

  it('★ 三个页签同一 tick 齐发也只开一个会话 —— 串行链的作用', async () => {
    const { calls, fetchImpl } = serverThatOpens();
    const client = createXqEventClient({
      fetchImpl,
      now: () => new Date('2026-11-08T02:00:00.000Z'),
    });

    await Promise.all([
      client.viewPage('stage-A', 'scene-p1'),
      client.viewPage('stage-A', 'scene-p2'),
      client.viewPage('stage-A', 'scene-p3'),
    ]);

    expect(calls.filter((call) => call.body.kind === 'session_started')).toHaveLength(1);
    expect(calls.filter((call) => call.body.kind === 'page_viewed')).toHaveLength(3);
  });

  it('★ 不同课各开一条会话 —— 同时看两门课不该共用', async () => {
    let next = 0;
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.body.kind === 'session_started') {
        next += 1;
        return { status: 201, json: { sessionId: `sess-${next}`, duplicate: false } };
      }
      return { status: 201, json: { sessionId: 'x', duplicate: false } };
    });
    const client = createXqEventClient({
      fetchImpl,
      now: () => new Date('2026-11-08T02:00:00.000Z'),
    });

    await client.viewPage('stage-A', 'scene-p1');
    await client.viewPage('stage-B', 'scene-p1');

    expect(calls.filter((call) => call.body.kind === 'session_started')).toHaveLength(2);
  });

  it('★ 5xx 重试一次，复用同一个 occurredAt —— 幂等键靠它', async () => {
    let attempts = 0;
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.body.kind === 'session_started') {
        return { status: 201, json: { sessionId: 'sess-1', duplicate: false } };
      }
      attempts += 1;
      return attempts === 1 ? { status: 500 } : { status: 201, json: { duplicate: false } };
    });
    let ticks = 0;
    const client = createXqEventClient({
      fetchImpl,
      // 每次取 now 都不同：重试若重新取，幂等键就变了。
      now: () => new Date(2026, 10, 8, 2, 0, ticks++),
    });

    const result = await client.viewPage('stage-A', 'scene-p1');
    const viewed = calls.filter((call) => call.body.kind === 'page_viewed');

    expect(result.ok).toBe(true);
    expect(viewed).toHaveLength(2);
    expect(viewed[0]!.body.occurredAt).toBe(viewed[1]!.body.occurredAt);
  });

  it('★ 失败不抛 —— 少一条事件不该让人用不了产品', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500 }));
    const warn = vi.fn();
    const client = createXqEventClient({
      fetchImpl,
      now: () => new Date('2026-11-08T02:00:00.000Z'),
      logFailure: warn,
    });

    await expect(client.viewPage('stage-A', 'scene-p1')).resolves.toMatchObject({ ok: false });
    expect(warn).toHaveBeenCalled();
  });

  it('★ 每条请求都带 keepalive —— 关标签页时普通 fetch 会被掐掉', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return {
        ok: true,
        status: 201,
        json: async () => ({ eventId: 'e-1', sessionId: 's-1', duplicate: false }),
      } as unknown as Response;
    }) as typeof fetch;
    const client = createXqEventClient({ fetchImpl });
    await client.viewPage('stage-a', 'scene-p1');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.init?.keepalive).toBe(true);
  });

  it('★ 4xx 不重试 —— 请求本身不对，重发只是再错一次', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 400 }));
    const client = createXqEventClient({
      fetchImpl,
      now: () => new Date('2026-11-08T02:00:00.000Z'),
      logFailure: () => {},
    });

    await client.viewPage('stage-A', 'scene-p1');
    expect(calls).toHaveLength(1);
  });

  it('★ 4xx 的拒绝码要带回给界面 —— 闸挡住不是「网络失败」', async () => {
    const { fetchImpl } = fakeFetch((call) =>
      call.body.kind === 'session_started'
        ? { status: 201, json: { eventId: 'ev-1', sessionId: 'ev-1', duplicate: false } }
        : { status: 409, json: { error: { code: 'ANSWER_FIRST', message: 'no' } } },
    );
    const client = createXqEventClient({
      fetchImpl,
      now: () => new Date('2026-11-08T02:00:00.000Z'),
      logFailure: () => {},
    });

    const result = await client.recordEvent({
      kind: 'hint_requested',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q1',
      occurredAt: '2026-11-08T02:00:00.000Z',
      hintSubtype: 'instrumental',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ANSWER_FIRST');
  });

  it('★ 5xx 不带码 —— 服务端自己坏了，码对它没意义', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 503 }));
    const client = createXqEventClient({
      fetchImpl,
      now: () => new Date('2026-11-08T02:00:00.000Z'),
      logFailure: () => {},
    });

    const result = await client.viewPage('stage-A', 'scene-p1');
    expect(result.ok).toBe(false);
    expect(result.code).toBeUndefined();
  });

  it('★ 结束会话后要重新开 —— 下次翻页是另一次坐下学习', async () => {
    let next = 0;
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.body.kind === 'session_started') {
        next += 1;
        return { status: 201, json: { sessionId: `sess-${next}`, duplicate: false } };
      }
      return { status: 201, json: { duplicate: false } };
    });
    const client = createXqEventClient({
      fetchImpl,
      now: () => new Date('2026-11-08T02:00:00.000Z'),
    });

    await client.viewPage('stage-A', 'scene-p1');
    await client.endSession('stage-A', 'terminated');
    await client.viewPage('stage-A', 'scene-p2');

    expect(calls.filter((call) => call.body.kind === 'session_started')).toHaveLength(2);
    const ended = calls.find((call) => call.body.kind === 'session_ended');
    expect(ended?.body.endReason).toBe('terminated');
    expect(ended?.body.sessionId).toBe('sess-1');
  });

  it('没开过会话就不发结束 —— 空会话不该被造出来', async () => {
    const { calls, fetchImpl } = serverThatOpens();
    const client = createXqEventClient({ fetchImpl });
    await client.endSession('stage-A');
    expect(calls).toHaveLength(0);
  });
});
