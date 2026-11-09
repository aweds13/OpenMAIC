import { describe, expect, it, vi } from 'vitest';

import {
  createXqAiLogClient,
  turnSummary,
  XQ_AI_LOG_ENDPOINT,
  type XqAiLogEntry,
} from '@/lib/learning/xq-ai-log-client';

/**
 * 对话日志浏览器客户端的判据。
 *
 * 这一层的失败方式不是崩溃，是**把没读到的说成没有**：一份空的
 * 对话日志看起来像「他从来没用过 AI」。所以最重的一条是
 * 「读失败与空列表分开」。
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(responses: Response[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : String(input),
      method: init?.method ?? 'GET',
    });
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error('unexpected extra fetch');
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ENTRY = {
  eventId: 'evt-1',
  occurredAt: '2026-11-08T02:00:00.000Z',
  stageId: 'stage-A',
  sceneId: 'scene-p1',
  questionId: 'q3',
  hintSubtype: 'instrumental',
  stem: '下面哪个说法是对的？',
  generations: 1,
  turns: [
    {
      recordId: 'rec-1',
      runtimeSessionId: 'chat:stage-A:l:s1',
      generation: 1,
      createdAt: '2026-11-08T02:00:01.000Z',
      role: 'user',
      text: '这里的 final 是什么意思？',
      truncated: false,
    },
    {
      recordId: 'rec-2',
      runtimeSessionId: 'chat:stage-A:l:s1',
      generation: 1,
      createdAt: '2026-11-08T02:00:02.000Z',
      role: 'assistant',
      text: 'final 表示只能赋值一次。',
      truncated: false,
    },
  ],
};

describe('xq ai log client', () => {
  it('★ 读回来一条提问与它的轮次', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { entries: [ENTRY] })]);
    const client = createXqAiLogClient({ fetchImpl });

    const result = await client.read();

    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].questionId).toBe('q3');
    expect(result.entries[0].turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(calls[0].url).toBe(XQ_AI_LOG_ENDPOINT);
    expect(calls[0].method).toBe('GET');
  });

  it('★ 读失败与「没有记录」分开 —— 空日志最容易被误读成「他没用过 AI」', async () => {
    const warn = vi.fn();
    const { fetchImpl } = fakeFetch([jsonResponse(500, { error: { code: 'XQ_AI_LOG_FAILED' } })]);
    const client = createXqAiLogClient({ fetchImpl, logFailure: warn });

    const result = await client.read();

    // ok:false 是「没读到」；ok:true + 空数组才是「确实没有」。
    expect(result.ok).toBe(false);
    expect(result.entries).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('★ 200 但不是 JSON 仍是「没读到」', async () => {
    const warn = vi.fn();
    const { fetchImpl } = fakeFetch([
      new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]);
    const client = createXqAiLogClient({ fetchImpl, logFailure: warn });

    const result = await client.read();

    expect(result.ok).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('★ 网络层抛错也回 ok:false，不冒泡', async () => {
    const warn = vi.fn();
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const client = createXqAiLogClient({ fetchImpl, logFailure: warn });

    await expect(client.read()).resolves.toMatchObject({ ok: false, entries: [] });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('★ 缺身份的条目整条丢，缺标注的回空串', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, {
        entries: [
          ENTRY,
          { ...ENTRY, eventId: '' }, // 没有 eventId ⇒ 丢
          { ...ENTRY, eventId: 'evt-2', stageId: undefined }, // 没有 stageId ⇒ 丢
          { ...ENTRY, eventId: 'evt-3', occurredAt: '' }, // 没有时间 ⇒ 丢
          {
            // 只有身份，标注全缺 ⇒ 保留，空串
            eventId: 'evt-4',
            occurredAt: '2026-11-08T03:00:00.000Z',
            stageId: 'stage-A',
            sceneId: 'scene-p2',
            questionId: 'q1',
          },
        ],
      }),
    ]);
    const client = createXqAiLogClient({ fetchImpl });

    const result = await client.read();

    expect(result.entries.map((entry) => entry.eventId)).toEqual(['evt-1', 'evt-4']);
    expect(result.entries[1].hintSubtype).toBe('');
    expect(result.entries[1].stem).toBe('');
    expect(result.entries[1].turns).toEqual([]);
    expect(result.entries[1].generations).toBe(0);
  });

  it('★ 坏轮次整条丢，不产出半个轮次', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(200, {
        entries: [
          {
            ...ENTRY,
            turns: [
              ENTRY.turns[0],
              { ...ENTRY.turns[1], recordId: '' }, // 没有 recordId ⇒ 丢
              { ...ENTRY.turns[1], text: undefined }, // 没有正文 ⇒ 丢
              { ...ENTRY.turns[1], recordId: 'rec-9', role: undefined }, // role 缺 ⇒ 保留但空串
            ],
          },
        ],
      }),
    ]);
    const client = createXqAiLogClient({ fetchImpl });

    const result = await client.read();

    expect(result.entries[0].turns.map((turn) => turn.recordId)).toEqual(['rec-1', 'rec-9']);
    expect(result.entries[0].turns[1].role).toBe('');
  });

  it('★ 带 day 与 limit 时拼进查询串', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { entries: [] })]);
    const client = createXqAiLogClient({ fetchImpl });

    await client.read({ day: '2026-11-08', limit: 5 });

    expect(calls[0].url).toBe(`${XQ_AI_LOG_ENDPOINT}?day=2026-11-08&limit=5`);
  });

  it('空 day 与非法 limit 不拼进查询串', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(200, { entries: [] }),
      jsonResponse(200, { entries: [] }),
    ]);
    const client = createXqAiLogClient({ fetchImpl });

    await client.read({ day: '' });
    await client.read({ limit: Number.NaN });

    expect(calls[0].url).toBe(XQ_AI_LOG_ENDPOINT);
    expect(calls[1].url).toBe(XQ_AI_LOG_ENDPOINT);
  });

  it('★ 一条提问配不到对话时 turnSummary 说「没配上」，不是「配上了但是空的」', () => {
    const entry: XqAiLogEntry = {
      eventId: 'evt-1',
      occurredAt: '2026-11-08T02:00:00.000Z',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q3',
      hintSubtype: 'executive',
      stem: '',
      generations: 0,
      turns: [],
    };

    expect(turnSummary(entry)).toEqual({ answered: false, userTurns: 0, assistantTurns: 0 });

    const withTurns: XqAiLogEntry = { ...entry, turns: ENTRY.turns };
    expect(turnSummary(withTurns)).toEqual({
      answered: true,
      userTurns: 1,
      assistantTurns: 1,
    });
  });
});
