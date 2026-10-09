import { describe, expect, it } from 'vitest';

import {
  emptyPlanFreeze,
  formatPlanFreezeStatus,
  freezePlan,
  normalizePlanFreeze,
  planGate,
  revisePlan,
  type PlanFreezeState,
} from '@/lib/server/agent-runtime/plan-freeze';
import { PLAN_FREEZE_TOOL_NAMES } from '@/lib/server/agent-runtime/plan-freeze-tools';
import { planFreezePromptBlock } from '@/lib/server/agent-runtime/plan-freeze-tools';
import type { SceneOutline } from '@/lib/types/generation';

const T0 = 1_700_000_000_000;

function entry(order: number): SceneOutline {
  return { id: `p${order}`, order, title: `第 ${order} 页`, type: 'slide' } as SceneOutline;
}

/** 走一遍正常路径：写计划 → 冻结。 */
function frozen(entries: SceneOutline[]): PlanFreezeState {
  return freezePlan(emptyPlanFreeze('stage-a'), { at: T0, entryCount: entries.length }).state;
}

describe('冻结', () => {
  it('★ refuses to freeze an empty plan (otherwise the gate is theatre)', () => {
    const result = freezePlan(emptyPlanFreeze('stage-a'), { at: T0, entryCount: 0 });
    expect(result.state.frozen).toBe(false);
    expect(result.error).toContain('先把要做的页写进计划');
  });

  it('freezes a non-empty plan and remembers how many entries there were', () => {
    const result = freezePlan(emptyPlanFreeze('stage-a'), { at: T0, entryCount: 4 });
    expect(result.error).toBeUndefined();
    expect(result.state.frozen).toBe(true);
    expect(result.state.frozenAt).toBe(T0);
    expect(result.state.frozenEntryCount).toBe(4);
  });
});

describe('修订（边做边想与别漂的接缝）', () => {
  it('allows changing a frozen plan — but demands a reason and leaves a trace', () => {
    const before = frozen([entry(1), entry(2)]);
    const noReason = revisePlan(before, { at: T0 + 1, reason: '   ' });
    expect(noReason.error).toContain('必须写清理由');
    expect(noReason.state.revision).toBe(0);

    const ok = revisePlan(before, { at: T0 + 1, reason: '第 3 页要拆成两页，学生反馈太快' });
    expect(ok.error).toBeUndefined();
    expect(ok.state.revision).toBe(1);
    expect(ok.state.revisions[0]?.reason).toContain('拆成两页');
    expect(ok.state.frozen).toBe(true);
  });

  it('says so when asked to "revise" something that was never frozen', () => {
    const result = revisePlan(emptyPlanFreeze('stage-a'), { at: T0, reason: '随便' });
    expect(result.error).toContain('还没冻结');
  });
});

describe('★ 生成前的那道门', () => {
  it('blocks when the plan is empty and says how to fix it', () => {
    const result = planGate({ state: emptyPlanFreeze('stage-a'), entries: [], order: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('计划是空的');
    expect(result.message).toContain('先写计划');
    // 门槛是给 agent 的执行指令，不是给用户的抱怨。
    expect(result.message).toContain('generate_scene 被拒绝');
  });

  it('blocks when the plan exists but is not frozen, and points at ask_user', () => {
    const entries = [entry(1), entry(2)];
    const result = planGate({ state: emptyPlanFreeze('stage-a'), entries, order: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('还没冻结');
    expect(result.message).toContain('ask_user');
    // ★ 这里原来钉的是 `freeze_plan` —— 一个**根本不存在的工具**。
    //   拒绝消息指向不存在的工具 = agent 卡死在自己看不懂的指引上（§1.1 的反面），
    //   而这条测试当时在**保护**那个 bug。现在钉真实工具名，并用下面的不变式防它回来。
    expect(result.message).toContain('plan_freeze');
    expect(result.message).toContain('action: "freeze"');
    // 也必须说清"冻结不等于不许改"，否则 agent 会怕冻结。
    expect(result.message).toContain('照样可以改');
  });

  it('blocks a page that has no entry in the plan, and lists what the plan does have', () => {
    const entries = [entry(1), entry(2)];
    const result = planGate({ state: frozen(entries), entries, order: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('计划里没有第 7 页');
    expect(result.message).toContain('1,2');
    expect(result.message).toContain('plan_freeze');
    expect(result.message).toContain('action: "revise"');
  });

  it('lets a planned page through once the plan is frozen', () => {
    const entries = [entry(1), entry(2)];
    expect(planGate({ state: frozen(entries), entries, order: 2 })).toEqual({ ok: true });
  });

  it('★ the page must be IN the plan — freezing alone is not enough', () => {
    // 这条是 T1（brief 落盘）真正的回报：以前"计划"只是对话里的一句话，
    // 现在它是可检查的产物，于是"这一页当初为什么做"有了着落。
    const entries = [entry(1)];
    expect(planGate({ state: frozen(entries), entries, order: 2 }).ok).toBe(false);
  });
});

describe('解析磁盘上的状态', () => {
  it('repairs garbage instead of throwing', () => {
    expect(normalizePlanFreeze('s', null).frozen).toBe(false);
    expect(normalizePlanFreeze('s', { frozen: 'yes' }).frozen).toBe(false);
    const repaired = normalizePlanFreeze('s', {
      frozen: true,
      revisions: [{ at: 1, reason: '有理由' }, { at: 2 }, null, 'x'],
    });
    expect(repaired.frozen).toBe(true);
    expect(repaired.revisions).toEqual([{ at: 1, reason: '有理由' }]);
  });

  it('keeps the revision counter consistent with the log when it is missing', () => {
    const state = normalizePlanFreeze('s', { frozen: true, revisions: [{ at: 1, reason: 'a' }] });
    expect(state.revision).toBe(1);
  });
});

describe('状态行', () => {
  it('says未冻结 when it is not frozen', () => {
    expect(formatPlanFreezeStatus(emptyPlanFreeze('s'), 3)).toContain('未冻结');
  });

  it('reports the revision count, and notices drift in the entry count', () => {
    const state = frozen([entry(1), entry(2)]);
    expect(formatPlanFreezeStatus(state, 2)).toContain('修订 0 次');
    expect(formatPlanFreezeStatus(state, 2)).not.toContain('冻结时是');
    // 冻结之后悄悄加了页 —— 要看得见。
    expect(formatPlanFreezeStatus(state, 5)).toContain('冻结时是 2 条');
  });
});

describe('★ 拒绝消息里点名的工具必须真实存在', () => {
  // 这条不变式是有来历的：消息里原本写着 `freeze_plan` / `plan_revise` ——
  // **两个都不存在**（真实的是 `plan_freeze`，动作 freeze/revise），
  // 而当时的测试正**钉着**那个错名。agent 照着消息去调，只会拿到"没有这个工具"。
  // 所以这里同时钉两边：消息里不许出现幽灵名，且消息点名的那个必须在注册表里。
  const PHANTOMS = ['freeze_plan', 'plan_revise'];

  it('never names a tool that is not in the registry', () => {
    const messages = [
      planGate({ state: emptyPlanFreeze('stage-x'), entries: [], order: 1 }),
      planGate({ state: emptyPlanFreeze('stage-x'), entries: [entry(1)], order: 1 }),
      planGate({
        state: freezePlan(emptyPlanFreeze('stage-x'), { at: T0, entryCount: 1 }).state,
        entries: [entry(1)],
        order: 9,
      }),
    ]
      .map((result) => (result.ok ? '' : result.message))
      .join('\n');

    for (const phantom of PHANTOMS) {
      expect(messages).not.toContain(phantom);
      expect(PLAN_FREEZE_TOOL_NAMES as readonly string[]).not.toContain(phantom);
    }
    expect(messages).toContain('plan_freeze');
    expect(PLAN_FREEZE_TOOL_NAMES as readonly string[]).toContain('plan_freeze');
  });
});

/**
 * ★★ 大纲阶段就该把「单元 × 小点 × 讲/练」列清楚（2026-10-09，学习者第 3 轮吐槽）。
 *
 * 他的原话：「**小块的话，你可以在大纲的时候研究啊，你大纲的时候就应该列清楚了**」
 * 「计划和大纲应该是并行的，**大纲应该是计划的载体**」。
 *
 * 而这段提示词原来写的是 **"one entry per page (order, title, one-line brief)"** ——
 * 只列页码，不设计单元。于是"讲什么、练什么、多难"**在大纲阶段根本没人想**，
 * 全留给写页的那一刻现编。Day02 的计划里 24/66 条是回填占位、`keyPoints` 与
 * `quizConfig` 全是 0，就是这条缺了的后果。
 */
describe('★ 大纲阶段：单元 · 小点 · 讲/练 · 难度', () => {
  const block = planFreezePromptBlock();

  it('★ 计划是**教学设计**，不是页表', () => {
    expect(block).toMatch(/teaching design, not a page list/);
    expect(block).toMatch(/Do the decomposition \*\*here, at plan time\*\*/);
  });

  it('★ 拆成**单元**；讲解一页一个小点', () => {
    expect(block).toMatch(/Break the course into \*\*units\*\*/);
    expect(block).toMatch(/one small point per page, never more/);
  });

  it('★ 练习按**一组题**规划（多题可跨页），一页不许混小点', () => {
    expect(block).toMatch(/a graded set of questions about one small point/);
    expect(block).toMatch(/page count is not a constraint/i);
    expect(block).toMatch(/One small point per page/);
    expect(block).toMatch(/questions about \*different\* points must not/i);
  });

  it('★ 不许太简单；形态可在一组内混用，由易到难', () => {
    expect(block).toMatch(/not too easy/);
    expect(block).toMatch(/answered without reading the page measures nothing/);
    expect(block).toMatch(/Choice\s+questions are the exception/);
    expect(block).toMatch(/Keep the count\s+small/);
  });

  it('★ 条目要带：单元/角色抬头、`keyPoints`（非空）、`quizConfig.difficulty`', () => {
    expect(block).toMatch(/prefixed with the unit and the role/);
    expect(block).toMatch(/【Unit U7 · explanation 1\/2/);
    expect(block).toMatch(/Not empty/);
    expect(block).toMatch(/quizConfig\.difficulty/);
  });
});
