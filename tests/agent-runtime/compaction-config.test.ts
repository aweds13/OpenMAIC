/**
 * Agent runtime compaction config: OPENMAIC_AGENT_COMPACTION_* env knobs.
 * The config object is read at module load, so each case re-imports it after
 * scrubbing the env.
 *
 * ★ 本 fork 与上游有一处**刻意的默认值相反**：上游是 opt-out（`!== 'false'`，
 *   默认开），我们是 opt-in（`=== 'true'`，默认关）。理由是压缩会改变模型能
 *   看到什么，还要花一次摘要调用，这属于运维决定而不是惊喜。合流时保留这个
 *   默认值，因此本文件在 v1.5.0 的原版上改了默认值相关的三条断言。
 *
 * Reserve/keep 保持上游的形状：OPTIONAL —— 只有运维显式设了 env 才出现。缺席时
 * 由压缩运行时按驱动模型的窗口缩放（见 tests/agent-runtime/compaction.test.ts），
 * 而不是由 runner 把 pi 的固定默认值（16384/20000）当显式覆盖塞进去、把缩放废掉
 * （那样小窗口会每一轮都压）。
 *
 * ★ 本 fork 还多一个上游没有的键：`contextBudgetTokens`（绝对预算）。判定窗口 =
 *   min(模型窗口, 预算)；只按模型窗口算的话 1M 窗口要 98.4% 才触发压缩。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const COMPACTION_ENV_KEYS = [
  'OPENMAIC_AGENT_COMPACTION_ENABLED',
  'OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS',
  'OPENMAIC_AGENT_COMPACTION_KEEP_RECENT_TOKENS',
  'OPENMAIC_AGENT_COMPACTION_CONTEXT_BUDGET',
] as const;

describe('agent runtime compaction config', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of COMPACTION_ENV_KEYS) delete process.env[key];
  });

  it('★ defaults to DISABLED (opt-in), and carries the absolute context budget', async () => {
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    // 默认关：只有显式 =true 才开。
    expect(agentRuntimeConfig.compaction.enabled).toBe(false);
    // 预算永远在，即使压缩关着 —— 准入检查（CONTEXT_BUDGET_EXCEEDED）照跑。
    expect(agentRuntimeConfig.compaction.contextBudgetTokens).toBe(150_000);
    // reserve/keep 缺席时由运行时按窗口缩放。
    expect('reserveTokens' in agentRuntimeConfig.compaction).toBe(false);
    expect('keepRecentTokens' in agentRuntimeConfig.compaction).toBe(false);
  });

  it('can be enabled via OPENMAIC_AGENT_COMPACTION_ENABLED=true', async () => {
    process.env.OPENMAIC_AGENT_COMPACTION_ENABLED = 'true';
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    expect(agentRuntimeConfig.compaction.enabled).toBe(true);
  });

  it('accepts env overrides for reserve/keep tokens', async () => {
    process.env.OPENMAIC_AGENT_COMPACTION_ENABLED = 'true';
    process.env.OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS = '4096';
    process.env.OPENMAIC_AGENT_COMPACTION_KEEP_RECENT_TOKENS = '5000';
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    expect(agentRuntimeConfig.compaction).toEqual({
      enabled: true,
      contextBudgetTokens: 150_000,
      reserveTokens: 4096,
      keepRecentTokens: 5000,
    });
  });

  it('honors a single override without inventing the other', async () => {
    process.env.OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS = '4096';
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    expect(agentRuntimeConfig.compaction).toEqual({
      enabled: false,
      contextBudgetTokens: 150_000,
      reserveTokens: 4096,
    });
  });

  it('★ reads the absolute budget from OPENMAIC_AGENT_COMPACTION_CONTEXT_BUDGET', async () => {
    process.env.OPENMAIC_AGENT_COMPACTION_CONTEXT_BUDGET = '400000';
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    expect(agentRuntimeConfig.compaction.contextBudgetTokens).toBe(400_000);
  });
});
