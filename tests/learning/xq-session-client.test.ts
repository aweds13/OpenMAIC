/**
 * 会话汇总客户端的判据。组件层只测纯逻辑（仓里没有 `@testing-library/react`）。
 */
import { describe, expect, it } from 'vitest';

import {
  XQ_SESSIONS_ENDPOINT,
  createXqSessionsClient,
  sessionSummary,
  totalActiveMs,
  type XqSessionDigestView,
} from '@/lib/learning/xq-session-client';

interface Call {
  readonly url: string;
}

function fakeFetch(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    const spec = responses[Math.min(index, responses.length - 1)] ?? { ok: true, json: {} };
    index += 1;
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      json: async () => {
        if (spec.json === undefined) throw new Error('not json');
        return spec.json;
      },
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const one: XqSessionDigestView = {
  sessionId: 's-1',
  startedAt: '2026-11-09T08:00:00.000Z',
  endedAt: '2026-11-09T08:10:00.000Z',
  endReason: 'terminated',
  seqNo: 1,
  eventCount: 5,
  pageCount: 3,
  activeMs: 600_000,
  wallMs: 600_000,
  hints: { instrumental: 1, executive: 0 },
  answers: { attempted: 1, submitted: 1 },
};

describe('createXqSessionsClient', () => {
  it('读会话汇总，原样收敛', async () => {
    const { fetchImpl, calls } = fakeFetch([{ json: { sessions: [one] } }]);
    const client = createXqSessionsClient({ fetchImpl });
    const result = await client.read({ day: '2026-11-09' });
    expect(calls[0]!.url).toBe(`${XQ_SESSIONS_ENDPOINT}?day=2026-11-09`);
    expect(result.ok).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ sessionId: 's-1', activeMs: 600_000, pageCount: 3 });
  });

  it('★ 读失败与「今天没学」分开 —— 空数组不能代表网络挂了', async () => {
    const { fetchImpl } = fakeFetch([{ ok: false, status: 500 }]);
    const failures: string[] = [];
    const client = createXqSessionsClient({ fetchImpl, logFailure: (m) => failures.push(m) });
    const result = await client.read();
    expect(result.ok).toBe(false);
    expect(result.sessions).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('500');
  });

  it('★ 缺身份的会话整条丢 —— 没有 id 的点不进去', async () => {
    const { fetchImpl } = fakeFetch([
      {
        json: {
          sessions: [
            one,
            { startedAt: '2026-11-09T09:00:00.000Z' },
            { sessionId: '', startedAt: '2026-11-09T09:00:00.000Z' },
            { sessionId: 's-3' },
          ],
        },
      },
    ]);
    const client = createXqSessionsClient({ fetchImpl });
    const result = await client.read();
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s-1']);
  });

  it('★ 没关的会话 wallMs 是 null，不是 0', async () => {
    const { fetchImpl } = fakeFetch([
      { json: { sessions: [{ ...one, endedAt: null, endReason: null, wallMs: null }] } },
    ]);
    const client = createXqSessionsClient({ fetchImpl });
    const [session] = (await client.read()).sessions;
    expect(session!.endedAt).toBeNull();
    expect(session!.wallMs).toBeNull();
  });

  it('返回体不是 JSON 时算「没读到」', async () => {
    const { fetchImpl } = fakeFetch([{ ok: true }]);
    const failures: string[] = [];
    const client = createXqSessionsClient({ fetchImpl, logFailure: (m) => failures.push(m) });
    const result = await client.read();
    expect(result.ok).toBe(false);
    expect(failures[0]).toContain('not JSON');
  });

  it('limit 乱写不发出去', async () => {
    const { fetchImpl, calls } = fakeFetch([{ json: { sessions: [] } }]);
    const client = createXqSessionsClient({ fetchImpl });
    await client.read({ limit: Number.NaN });
    expect(calls[0]!.url).toBe(XQ_SESSIONS_ENDPOINT);
  });
});

describe('sessionSummary / totalActiveMs', () => {
  it('折成分钟与页数，开着的会话标出来', () => {
    expect(sessionSummary(one)).toEqual({ minutes: 10, pages: 3, open: false });
    expect(sessionSummary({ ...one, endedAt: null })).toEqual({
      minutes: 10,
      pages: 3,
      open: true,
    });
  });

  it('★ 合计只算已结束的 —— 进行中的那个数只会越算越小', () => {
    const total = totalActiveMs([
      one,
      { ...one, sessionId: 's-2', endedAt: null, activeMs: 3_600_000 },
      { ...one, sessionId: 's-3', activeMs: 120_000 },
    ]);
    expect(total).toBe(720_000);
  });

  it('负数不该被算进去', () => {
    expect(totalActiveMs([{ ...one, activeMs: -5 }])).toBe(0);
  });
});
