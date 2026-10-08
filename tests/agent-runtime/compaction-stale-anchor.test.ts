/**
 * The provider-usage anchor a compaction leaves behind.
 *
 * Background, measured on this deployment (session `54e10af4`, 2026-10-08) and
 * reproduced below without a database:
 *
 *  - pi's `estimateContextTokens` anchors on the LAST assistant usage block. A
 *    compaction only replaces the history BEFORE that block, so the block stays
 *    in the kept tail carrying the size of the request that produced it — the
 *    size BEFORE the compaction. The reported pair was therefore identical
 *    forever (`351463 -> 351463`), while the next run's real request was 57,142
 *    tokens.
 *  - the same number feeds `shouldCompact`, so the automatic gear compacted
 *    again on the first run after EVERY compaction. 13 of the 24 automatic
 *    compactions in that database belonged to a run that was already under half
 *    the threshold.
 *
 * These tests pin the two consequences, and they are written to fail if the
 * staleness check is removed rather than merely to describe it.
 */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import {
  InMemorySessionRepo,
  type AgentMessage,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  estimateAgentContextTokens,
  maybeCompactAgentSession,
  usageAnchorIsStale,
} from '@/lib/server/agent-runtime/compaction';

const MODEL = {
  id: 'test-driver',
  name: 'test-driver',
  api: 'test' as Api,
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 8_192,
} as unknown as Model<Api>;

/**
 * A successful assistant message as the estimator sees it: 30,000 tokens of
 * ALREADY-SENT prompt, but only ~200 tokens of text. The gap is the whole point
 * — the usage number describes a request, the text describes the message.
 */
function anchoredAssistant(timestamp: number, text = 'anchor '.repeat(40)): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'test-driver',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 30_000,
      cacheWrite: 0,
      totalTokens: 30_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  } as AgentMessage;
}

function compactionSummary(timestamp: number, summary = 'Goal: keep stage-abc'): AgentMessage {
  return {
    role: 'compactionSummary',
    summary,
    tokensBefore: 30_000,
    timestamp,
  } as AgentMessage;
}

function summaryStream(summary: string, onCall: () => void = () => {}): StreamFn {
  return ((_model, _context, _options) => {
    onCall();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: summary }],
      api: 'test',
      provider: 'test',
      model: 'test-summary',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }));
    return stream;
  }) as StreamFn;
}

describe('usageAnchorIsStale', () => {
  it('says no when nothing has been compacted', () => {
    expect(usageAnchorIsStale([{ role: 'user', content: 'hi', timestamp: 1 }, anchoredAssistant(2)])).toBe(
      false,
    );
  });

  it('says yes when the anchor is older than the surviving summary', () => {
    // This is the shape `buildSessionContext` returns after a compaction: the
    // summary first, then the kept tail — which still holds the anchor.
    expect(usageAnchorIsStale([compactionSummary(9_000), anchoredAssistant(2)])).toBe(true);
  });

  it('says no once a run has produced a newer anchor', () => {
    // A run after the compaction appends fresh messages; the newest anchor then
    // describes the request that was actually sent, so it is trustworthy again.
    expect(usageAnchorIsStale([compactionSummary(9_000), anchoredAssistant(2), anchoredAssistant(9_500)])).toBe(
      false,
    );
  });

  it('says no when a compacted transcript has no anchor to doubt', () => {
    expect(usageAnchorIsStale([compactionSummary(9_000), { role: 'user', content: 'hi', timestamp: 3 }])).toBe(
      false,
    );
  });

  it('treats an undateable anchor as stale rather than trusting it', () => {
    // Doubting a fresh anchor costs the fixed system-prompt/tool overhead;
    // trusting a stale one costs the 6x over-count measured in the database.
    const undated = { ...(anchoredAssistant(2) as unknown as Record<string, unknown>) };
    delete undated.timestamp;
    expect(usageAnchorIsStale([compactionSummary(9_000), undated as unknown as AgentMessage])).toBe(true);
  });

  it('does not let a zero-usage anchor count as an anchor', () => {
    // `isUsageAnchor` mirrors pi's selection, which accepts a zero block; the
    // estimator is what rejects it. Pinned materially in the describe below.
    const zeroUsage = {
      ...(anchoredAssistant(2) as unknown as Record<string, unknown>),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    } as unknown as AgentMessage;
    expect(usageAnchorIsStale([compactionSummary(9_000), zeroUsage])).toBe(true);
  });
});

describe('estimateAgentContextTokens with a stale anchor', () => {
  it('still prefers the usage anchor when no compaction intervened', () => {
    // Pins that the fix does not change the untouched-transcript path: this is
    // pi's own answer, and the budget is calibrated against it.
    const messages = [compactionSummary(1), anchoredAssistant(9_500)];
    expect(usageAnchorIsStale(messages)).toBe(false);
    expect(estimateAgentContextTokens(messages)).toBeGreaterThan(29_000);
  });

  it('measures the kept tail instead of the request that produced the anchor', () => {
    const messages = [compactionSummary(9_000), anchoredAssistant(2)];
    // The caller has to ask, because only the caller knows whether a compaction
    // is newer than the anchor — the message list alone cannot say.
    expect(estimateAgentContextTokens(messages, { trustUsageAnchor: false })).toBeLessThan(1_000);
    expect(estimateAgentContextTokens(messages)).toBeGreaterThan(29_000);
  });

  it('never makes a zero-usage anchor worse, because the estimator already rejects it', () => {
    // A provider that omits usage already sends the estimator down the
    // per-message path, so the staleness flag cannot change that outcome.
    const zeroUsage = {
      ...(anchoredAssistant(2) as unknown as Record<string, unknown>),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    } as unknown as AgentMessage;
    const messages = [compactionSummary(9_000), zeroUsage];
    expect(estimateAgentContextTokens(messages, { trustUsageAnchor: true })).toBe(
      estimateAgentContextTokens(messages, { trustUsageAnchor: false }),
    );
  });
});

describe('maybeCompactAgentSession reports the real saving', () => {
  it('reports a shrinking context even though the anchor survives the cut', async () => {
    const session = await new InMemorySessionRepo().create({ id: 'session-stale-anchor' });
    await session.appendMessage({
      role: 'user',
      content: `history: ${'important course evidence '.repeat(40)}`,
      timestamp: 1,
    });
    await session.appendMessage(anchoredAssistant(2));
    await session.appendMessage({ role: 'user', content: 'final question', timestamp: 3 });

    const trace = await maybeCompactAgentSession({
      session,
      streamFn: summaryStream('Goal: keep stage-abc page 3'),
      model: MODEL,
      contextBudget: 600,
      settings: { enabled: true, reserveTokens: 160, keepRecentTokens: 120 },
    });

    expect(trace.triggerCount).toBe(1);
    const event = trace.events[0];
    // Before: the stale anchor reported 30,000. The measure of whether this
    // number moves is whether it is no longer equal to tokensBefore — the old
    // behaviour printed the anchor twice and could never show a saving.
    expect(event?.tokensBefore).toBeGreaterThan(29_000);
    expect(event?.tokensAfter).toBeLessThan(event?.tokensBefore ?? 0);
    expect(event?.tokensAfter).toBeLessThan(1_000);
  });
});

describe('maybeCompactAgentSession does not re-compact a context it just shrank', () => {
  it('leaves the tree alone on the run right after a compaction', async () => {
    const session = await new InMemorySessionRepo().create({ id: 'session-no-double-compaction' });
    await session.appendMessage({
      role: 'user',
      content: `history: ${'important course evidence '.repeat(40)}`,
      timestamp: 1,
    });
    await session.appendMessage(anchoredAssistant(2));
    await session.appendMessage({ role: 'user', content: 'final question', timestamp: 3 });

    const settings = { enabled: true, reserveTokens: 160, keepRecentTokens: 120 };
    // Threshold is 600 - 160 = 440 tokens.
    const first = await maybeCompactAgentSession({
      session,
      streamFn: summaryStream('Goal: keep stage-abc page 3'),
      model: MODEL,
      contextBudget: 600,
      settings,
    });
    expect(first.triggerCount).toBe(1);
    expect(first.events[0]?.tokensAfter).toBeLessThan(440);

    // The next run sees the compacted transcript. Its real size is what
    // `tokensAfter` just measured, so there is nothing left to do — but the
    // kept anchor still claims 30,000, and that claim used to win.
    const onCall = vi.fn();
    const second = await maybeCompactAgentSession({
      session,
      streamFn: summaryStream('unused', onCall),
      model: MODEL,
      contextBudget: 600,
      settings,
    });

    expect(second).toMatchObject({ checkCount: 1, triggerCount: 0, failures: [] });
    expect(onCall).not.toHaveBeenCalled();
    expect((await session.getBranch()).filter((entry) => entry.type === 'compaction')).toHaveLength(1);
  });
});
