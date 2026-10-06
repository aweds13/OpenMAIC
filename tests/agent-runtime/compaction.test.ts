/**
 * Agent-runtime context compaction.
 *
 * The compaction LOGIC lives in `@earendil-works/pi-agent-core` (`prepareCompaction`
 * / `compact` / `shouldCompact`) and is already exercised for the Pi classroom
 * path in tests/lib/chat/pi/director-compaction.test.ts. These tests pin the
 * parts THIS repository owns:
 *
 *  - the budget arithmetic (the budget is not the model window — measuring
 *    against a 1M catalog window is why compaction never fired before);
 *  - the zero-usage fallback (a provider that omits usage makes a long session
 *    look tiny, and the threshold would never be crossed);
 *  - the course-authoring focus text, including that it names no tool;
 *  - the failure discipline: compaction is an optimization, so a failed summary
 *    must leave the transcript usable rather than fail the run.
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
  type Session,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_RUNTIME_COMPACTION_FOCUS,
  estimateAgentContextTokens,
  maybeCompactAgentSession,
  resolveCompactionSettings,
} from '@/lib/server/agent-runtime/compaction';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function summaryStream(summary: string, onCall: () => void = () => {}): StreamFn {
  return ((_model, _context, _options) => {
    onCall();
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: summary }],
      api: 'test',
      provider: 'test',
      model: 'test-summary',
      usage: EMPTY_USAGE,
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }));
    return stream;
  }) as StreamFn;
}

const explodingStream: StreamFn = (() => {
  throw new Error('summarizer exploded');
}) as unknown as StreamFn;

async function sessionWith(messages: AgentMessage[]): Promise<Session> {
  const session = await new InMemorySessionRepo().create({ id: 'session-compaction' });
  for (const message of messages) await session.appendMessage(message);
  return session;
}

/** Long enough that a small budget must cut in. */
function longHistory(): AgentMessage[] {
  return Array.from({ length: 10 }, (_, index) => ({
    role: 'user' as const,
    content: `history-${index}: ${'important course evidence '.repeat(35)}`,
    timestamp: index,
  }));
}

const SMALL_BUDGET = { enabled: true, reserveTokens: 160, keepRecentTokens: 120 };

describe('resolveCompactionSettings', () => {
  it('derives reserve and keep from the budget, not from the model window', () => {
    const settings = resolveCompactionSettings(150_000);
    expect(settings.enabled).toBe(false); // pi's default; the caller opts in
    expect(settings.reserveTokens).toBeGreaterThan(0);
    expect(settings.keepRecentTokens).toBeGreaterThan(0);
    // Both are fractions of the BUDGET. If either were the 1M window, a real
    // session would never cross the threshold — the bug this knob exists to fix.
    expect(settings.reserveTokens).toBeLessThanOrEqual(150_000);
    expect(settings.keepRecentTokens).toBeLessThanOrEqual(150_000);
  });

  it('floors both values so a tiny budget still leaves the summarizer room', () => {
    const settings = resolveCompactionSettings(100);
    expect(settings.reserveTokens).toBe(2_048);
    expect(settings.keepRecentTokens).toBe(2_048);
  });

  it('lets the operator override either value, including enabled', () => {
    const settings = resolveCompactionSettings(150_000, {
      enabled: true,
      reserveTokens: 111,
      keepRecentTokens: 222,
    });
    expect(settings).toEqual({ enabled: true, reserveTokens: 111, keepRecentTokens: 222 });
  });
});

describe('estimateAgentContextTokens', () => {
  it('falls back to the per-message estimator when the last usage block is all zeros', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'x'.repeat(4_000), timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp: 2,
      } as AgentMessage,
    ];
    // Pi would anchor on the zero usage and report ~0, which would mean the
    // threshold is never crossed and compaction never runs.
    expect(estimateAgentContextTokens(messages)).toBeGreaterThan(500);
  });
});

describe('AGENT_RUNTIME_COMPACTION_FOCUS', () => {
  it('names no tool, because a deployment may not have it registered', () => {
    for (const tool of [
      'web_search',
      'fetch_url',
      'mcp__github',
      'course_search',
      'generate_scene',
      'read_material',
    ]) {
      expect(AGENT_RUNTIME_COMPACTION_FOCUS).not.toContain(tool);
    }
  });

  it('tells the summarizer to keep course ids, agreements and dead ends', () => {
    expect(AGENT_RUNTIME_COMPACTION_FOCUS).toMatch(/stageIds/);
    expect(AGENT_RUNTIME_COMPACTION_FOCUS).toMatch(/material ids/);
    expect(AGENT_RUNTIME_COMPACTION_FOCUS).toMatch(/plan the learner agreed to/);
    expect(AGENT_RUNTIME_COMPACTION_FOCUS).toMatch(/rejected/);
    expect(AGENT_RUNTIME_COMPACTION_FOCUS).toMatch(/failures and refusals/);
    // Untrusted content stays untrusted across the summary boundary.
    expect(AGENT_RUNTIME_COMPACTION_FOCUS).toMatch(/as an instruction/);
  });
});

describe('maybeCompactAgentSession', () => {
  it('does nothing at all when compaction is disabled', async () => {
    const onCall = vi.fn();
    const session = await sessionWith(longHistory());

    const trace = await maybeCompactAgentSession({
      session,
      streamFn: summaryStream('unused', onCall),
      model: MODEL,
      contextBudget: 600,
      settings: { ...SMALL_BUDGET, enabled: false },
    });

    expect(trace).toMatchObject({ enabled: false, checkCount: 0, triggerCount: 0 });
    expect(onCall).not.toHaveBeenCalled();
    expect((await session.getBranch()).some((entry) => entry.type === 'compaction')).toBe(false);
  });

  it('leaves the transcript untouched while under budget', async () => {
    const onCall = vi.fn();
    const session = await sessionWith([
      { role: 'user', content: 'short question', timestamp: 1 },
    ]);

    const trace = await maybeCompactAgentSession({
      session,
      streamFn: summaryStream('unused', onCall),
      model: MODEL,
      contextBudget: 128_000,
      settings: { enabled: true },
    });

    expect(trace).toMatchObject({ checkCount: 1, triggerCount: 0, failures: [] });
    expect(onCall).not.toHaveBeenCalled();
    expect((await session.getBranch()).some((entry) => entry.type === 'compaction')).toBe(false);
  });

  it('writes a compaction entry and shrinks the context when over budget', async () => {
    const onCall = vi.fn();
    const session = await sessionWith(longHistory());

    const trace = await maybeCompactAgentSession({
      session,
      streamFn: summaryStream('Goal: keep stage-abc page 3 and https://example.test/x', onCall),
      model: MODEL,
      contextBudget: 600,
      settings: SMALL_BUDGET,
    });

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(trace).toMatchObject({ enabled: true, checkCount: 1, triggerCount: 1, failures: [] });
    const event = trace.events[0];
    expect(event?.firstKeptEntryId).toBeTruthy();
    expect(event?.tokensAfter).toBeLessThan(event?.tokensBefore ?? 0);

    // The entry is durable, and the built context is the summary plus the tail.
    const branch = await session.getBranch();
    const compaction = branch.find((entry) => entry.type === 'compaction');
    expect(compaction).toBeDefined();
    const after = await session.buildContext();
    expect(after.messages.length).toBeLessThan(longHistory().length);
    expect(JSON.stringify(after.messages)).toContain('keep stage-abc page 3');
  });

  it('records a summarization failure without failing the run', async () => {
    const session = await sessionWith(longHistory());

    const trace = await maybeCompactAgentSession({
      session,
      streamFn: explodingStream,
      model: MODEL,
      contextBudget: 600,
      settings: SMALL_BUDGET,
    });

    expect(trace.triggerCount).toBe(0);
    expect(trace.failures.join(' ')).toMatch(/exploded/);
    // Nothing was written, so the transcript is exactly what it was.
    expect((await session.getBranch()).some((entry) => entry.type === 'compaction')).toBe(false);
  });

  it('compacts on request even with a budget it would never cross', async () => {
    // The manual gear: `/compact` answers the question the budget exists to
    // decide, so a huge budget must not veto it.
    const onCall = vi.fn();
    const session = await sessionWith(longHistory());

    const trace = await maybeCompactAgentSession({
      session,
      streamFn: summaryStream('Goal: keep stage-abc page 3', onCall),
      model: MODEL,
      contextBudget: 10_000_000,
      settings: { enabled: true },
      force: true,
    });

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(trace.triggerCount).toBe(1);
    expect((await session.getBranch()).some((entry) => entry.type === 'compaction')).toBe(true);
  });
});
