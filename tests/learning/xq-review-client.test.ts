import { describe, expect, it } from 'vitest';

import {
  XQ_REVIEW_OUTCOMES_CLIENT,
  XQ_REVIEW_QUEUE_ENDPOINT,
  createXqReviewClient,
  groupCardsByScene,
  reviewCardKey,
} from '@/lib/learning/xq-review-client';

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function fakeFetch(responses: Array<{ ok: boolean; status: number; json?: unknown }>) {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url: String(input),
      method,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    const next = responses[index] ?? { ok: false, status: 500 };
    index += 1;
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.json ?? null,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CARD = {
  stageId: 'stage-A',
  sceneId: 'scene-p1',
  sceneTitle: '自检：Dart 语法八道题',
  questionId: 'q1',
  questionStem: 'final 和 const 有什么区别？',
  concept: '类与对象',
  round: 1,
  dueAt: '2026-11-10T05:58:49.909Z',
  mastery: null,
};

describe('xq review client', () => {
  it('读队列走 GET，且把服务端的卡片原样收敛', async () => {
    const { fetchImpl, calls } = fakeFetch([{ ok: true, status: 200, json: { reviews: [CARD] } }]);
    const client = createXqReviewClient({ fetchImpl });
    const result = await client.listDue();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(XQ_REVIEW_QUEUE_ENDPOINT);
    expect(calls[0].method).toBe('GET');
    expect(result.ok).toBe(true);
    expect(result.cards).toEqual([CARD]);
  });

  it('★ 读失败不能说成「今天没有要复习的」—— ok 要与空列表分开', async () => {
    const { fetchImpl } = fakeFetch([{ ok: false, status: 503 }]);
    const warns: string[] = [];
    const client = createXqReviewClient({ fetchImpl, logFailure: (m) => warns.push(m) });
    const result = await client.listDue();

    expect(result.ok).toBe(false);
    expect(result.cards).toEqual([]);
    expect(warns.length).toBe(1);
  });

  it('★ 缺关键字段的卡片整条丢掉，而不是显示半张', async () => {
    const { fetchImpl } = fakeFetch([
      {
        ok: true,
        status: 200,
        json: {
          reviews: [
            CARD,
            { ...CARD, stageId: '' },
            { ...CARD, questionId: undefined },
            { ...CARD, round: '1' },
            { ...CARD, dueAt: null },
            { ...CARD, sceneTitle: undefined, questionStem: undefined, concept: undefined },
          ],
        },
      },
    ]);
    const client = createXqReviewClient({ fetchImpl });
    const result = await client.listDue();

    expect(result.cards).toHaveLength(2);
    // 后一条只是缺「标注」（标题/题面/概念），它仍然是一条真的到期关。
    expect(result.cards[1].sceneTitle).toBe('');
    expect(result.cards[1].questionStem).toBe('');
    expect(result.cards[1].concept).toBe('');
  });

  it('返回体不是 JSON 时按空队列处理，不抛', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const client = createXqReviewClient({ fetchImpl });
    await expect(client.listDue()).resolves.toEqual({ ok: true, cards: [] });
  });

  it('交结果走 POST，三样结果都原样送到服务端', async () => {
    for (const outcome of XQ_REVIEW_OUTCOMES_CLIENT) {
      const { fetchImpl, calls } = fakeFetch([
        { ok: true, status: 201, json: { recorded: true, eventId: 'ev-1', duplicate: false } },
      ]);
      const client = createXqReviewClient({ fetchImpl });
      const result = await client.record({
        stageId: 'stage-A',
        sceneId: 'scene-p1',
        questionId: 'q1',
        concept: '类与对象',
        round: 1,
        outcome,
        sessionId: 'sess-1',
        occurredAt: '2026-11-10T06:00:00.000Z',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].body).toMatchObject({ outcome, sessionId: 'sess-1', round: 1 });
      expect(result).toEqual({ ok: true, duplicate: false, eventId: 'ev-1' });
    }
  });

  it('★ 交失败不自动重试 —— 重试会让 occurredAt 变，成了「他又做了一遍」', async () => {
    const { fetchImpl, calls } = fakeFetch([{ ok: false, status: 500 }]);
    const client = createXqReviewClient({ fetchImpl, logFailure: () => {} });
    const result = await client.record({
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q1',
      concept: '',
      round: 1,
      outcome: 'pass',
      sessionId: 'sess-1',
      occurredAt: '2026-11-10T06:00:00.000Z',
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ ok: false, duplicate: false, eventId: null });
  });

  it('重投（200 + duplicate）与首次（201）都能读出来', async () => {
    const { fetchImpl } = fakeFetch([
      { ok: true, status: 200, json: { recorded: true, eventId: 'ev-1', duplicate: true } },
    ]);
    const client = createXqReviewClient({ fetchImpl });
    const result = await client.record({
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q1',
      concept: '',
      round: 1,
      outcome: 'pass',
      sessionId: 'sess-1',
      occurredAt: '2026-11-10T06:00:00.000Z',
    });

    expect(result.duplicate).toBe(true);
  });

  it('skip 没有事件 id（服务端只关排期不写事实）', async () => {
    const { fetchImpl } = fakeFetch([
      { ok: true, status: 201, json: { recorded: true, eventId: null, duplicate: false } },
    ]);
    const client = createXqReviewClient({ fetchImpl });
    const result = await client.record({
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q1',
      concept: '',
      round: 1,
      outcome: 'skip',
      sessionId: 'sess-1',
      occurredAt: '2026-11-10T06:00:00.000Z',
    });

    expect(result).toEqual({ ok: true, duplicate: false, eventId: null });
  });

  it('网络层抛错时两件事都安静地失败，不抛', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createXqReviewClient({ fetchImpl: throwing, logFailure: () => {} });
    await expect(client.listDue()).resolves.toEqual({ ok: false, cards: [] });
    await expect(
      client.record({
        stageId: 'stage-A',
        sceneId: 'scene-p1',
        questionId: 'q1',
        concept: '',
        round: 1,
        outcome: 'pass',
        sessionId: 'sess-1',
        occurredAt: '2026-11-10T06:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: false, duplicate: false, eventId: null });
  });
});

describe('groupCardsByScene', () => {
  it('同一页的几关归到一组，组间保持原顺序（服务端已按 due_at 排过）', () => {
    const cards = [
      { ...CARD, stageId: 's1', sceneId: 'p1', questionId: 'q1' },
      { ...CARD, stageId: 's1', sceneId: 'p2', questionId: 'q2' },
      { ...CARD, stageId: 's1', sceneId: 'p1', questionId: 'q3' },
    ];
    const groups = groupCardsByScene(cards);

    expect(groups.map((g) => g.sceneId)).toEqual(['p1', 'p2']);
    expect(groups[0].cards.map((c) => c.questionId)).toEqual(['q1', 'q3']);
    expect(groups[1].cards).toHaveLength(1);
  });

  it('★ 跨课同名 scene id 不许并成一组（库里 234 页有 35 个 scene id 复用）', () => {
    const cards = [
      { ...CARD, stageId: 's1', sceneId: 'p1', questionId: 'q1' },
      { ...CARD, stageId: 's2', sceneId: 'p1', questionId: 'q9' },
    ];
    const groups = groupCardsByScene(cards);

    expect(groups).toHaveLength(2);
    expect(groups[0].stageId).toBe('s1');
    expect(groups[1].stageId).toBe('s2');
  });

  it('★ 同一道题的不同关不许被当成同一条（第 1 关与第 3 关可以同时到期）', () => {
    const a = reviewCardKey({ ...CARD, round: 1 });
    const b = reviewCardKey({ ...CARD, round: 3 });
    expect(a).not.toBe(b);
  });

  it('卡身份跨课稳定、跨题稳定', () => {
    expect(reviewCardKey(CARD)).toBe(reviewCardKey({ ...CARD }));
    expect(reviewCardKey(CARD)).not.toBe(reviewCardKey({ ...CARD, sceneId: 'scene-p2' }));
    expect(reviewCardKey(CARD)).not.toBe(reviewCardKey({ ...CARD, stageId: 'stage-B' }));
  });

  it('页标题缺失时用 scene id 兜底（别显示一张没有名字的卡）', () => {
    const groups = groupCardsByScene([{ ...CARD, sceneTitle: '' }]);
    expect(groups[0].title).toBe('scene-p1');
  });
});
