/**
 * 阶段冻结的**工具**与**提示词块**。
 *
 * ── 一个工具，三个动作 ───────────────────────────────────────────
 *
 *   plan_freeze { stageId, action: "status" }                    ← 看现在什么状态
 *   plan_freeze { stageId, action: "freeze" }                    ← 冻结（空计划会被拒）
 *   plan_freeze { stageId, action: "revise", reason: "…" }        ← 改已冻结的计划，要写理由
 *
 * ── 提示词里只有**一句恒定的话** ─────────────────────────────────
 *
 * `planFreezePromptBlock()` **无参、恒定**。理由见 AGENTS.md §1.2：系统消息在
 * provider 的前缀缓存里是一个整体，**改一个字节就整段重算**。而"计划有没有冻结"
 * 是**每轮都可能变**的 —— 所以：
 *   · 提示词里只说"有这个东西、在哪、怎么用"（恒定，不进缓存代价）
 *   · 状态本身走**工具结果**（`plan_freeze(action:"status")`）与**拒绝消息**
 *     （`generate_scene` 被拒时那句就是通知）
 *
 * 这也满足用户那句「避免提示词污染」：不往上下文里塞计划正文。
 */
import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
  formatPlanFreezeStatus,
  freezePlan,
  revisePlan,
  type PlanFreezeState,
} from './plan-freeze';
import { readPlanFreeze, writePlanFreeze } from './plan-freeze-store';

export const PLAN_FREEZE_TOOL_NAMES = ['plan_freeze'] as const;

const PLAN_FREEZE_PARAMS = Type.Object({
  stageId: Type.String({ description: 'The stage whose plan you are freezing or revising.' }),
  action: Type.Union([Type.Literal('status'), Type.Literal('freeze'), Type.Literal('revise')], {
    description: 'status = report; freeze = lock the plan before generating; revise = change a frozen plan.',
  }),
  reason: Type.Optional(
    Type.String({
      description:
        'Required for `revise`: what changed and why. Drifting is fine; drifting silently is not.',
    }),
  ),
});

/** 工具需要的最小依赖 —— 只要能读出这一门的计划条目。 */
export interface PlanFreezeToolDeps {
  loadOutlineEntries(stageId: string): Promise<unknown[]>;
}

function text(message: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: {},
    ...(isError ? { isError: true } : {}),
  };
}

export function buildPlanFreezeTool(
  deps: PlanFreezeToolDeps,
): AgentTool<typeof PLAN_FREEZE_PARAMS, unknown> {
  return {
    name: 'plan_freeze',
    label: 'Freeze or revise the course plan',
    description:
      'The plan is the list of pages you intend to make (order + title + one-line brief). ' +
      '`freeze` locks it before you start generating — every page you generate must already have an ' +
      'entry in it. Freezing an empty plan is refused: freezing means "these are the pages I intend to make". ' +
      'You may still change a frozen plan with `revise` (state what changed and why), and you may keep ' +
      'researching after freezing. The plan is read on demand with `read_stage_outline`; it is never ' +
      'pushed into your context.',
    parameters: PLAN_FREEZE_PARAMS,
    executionMode: 'sequential',
    async execute(_id: string, params: Static<typeof PLAN_FREEZE_PARAMS>) {
      const entries = await deps.loadOutlineEntries(params.stageId);
      const state = await readPlanFreeze(params.stageId);

      if (params.action === 'status') {
        const lines = [formatPlanFreezeStatus(state, entries.length)];
        if (state.revisions.length) {
          lines.push('修订记录（新 → 旧）：');
          for (const revision of [...state.revisions].reverse().slice(0, 5)) {
            lines.push(`  - ${revision.reason}`);
          }
        }
        if (!state.frozen) {
          lines.push(
            '',
            '生成第一页之前要先冻结。冻结之前跟学习者确认一句（`ask_user`：这一版计划做这些页、',
            '这个顺序，行不行），确认后 `plan_freeze { action: "freeze" }`。',
          );
        }
        return text(lines.join('\n'));
      }

      if (params.action === 'freeze') {
        if (state.frozen) {
          return text(
            `这一门已经冻结过了（修订 ${state.revision} 次）。要改就用 ` +
              '`plan_freeze { action: "revise", reason: "…" }`。',
          );
        }
        const result = freezePlan(state, { at: Date.now(), entryCount: entries.length });
        if (result.error) return text(result.error, true);
        const written = await writePlanFreeze(result.state);
        if (!written) {
          return text('冻结没能写盘（权限或磁盘问题）—— 计划仍未冻结。', true);
        }
        return text(
          `已冻结：${entries.length} 条计划。现在可以 ` +
            '`generate_scene` 了。冻结不等于不许改 —— 计划要改就用 `revise` 写明理由，' +
            '冻结之后也照样可以继续查资料（查的是"补某个具体缺口"，不是"继续逛"）。',
        );
      }

      // revise
      const result = revisePlan(state, { at: Date.now(), reason: params.reason ?? '' });
      if (result.error) return text(result.error, true);
      const written = await writePlanFreeze(result.state);
      if (!written) return text('修订没能写盘 —— 计划没有变。', true);
      return text(
        `已记下第 ${result.state.revision} 次修订：「${(params.reason ?? '').trim()}」。` +
          '计划本身照你说的改，改完页面结构要跟着对齐（`edit_deck` 会同步计划条目）。',
      );
    },
  };
}

/**
 * 系统提示词里的那一句 —— **无参、恒定**。
 *
 * 别往里加会变的东西（当前状态、页数、时间戳）：那会让每次运行的系统消息都不同，
 * 整个前缀缓存作废。状态走工具结果。
 */
export function planFreezePromptBlock(): string {
  return [
    '## The course plan is a durable artifact you own',
    '',
    'Before you generate the first page of a course, the plan must exist **and be frozen**.',
    'The plan is one entry per page (order, title, one-line brief) — it is what lets you answer',
    '"why does this page exist" later, and it is what `read_stage_outline` shows.',
    '',
    '- Write the entries first, confirm the set and the order with the learner once (`ask_user`),',
    '  then call `plan_freeze { action: "freeze" }`.',
    '- `generate_scene` refuses a page that has no entry in the plan. That refusal is the reminder —',
    '  there is nothing to memorise.',
    '- **Freezing does not mean the plan is final.** Use `plan_freeze { action: "revise", reason }`',
    '  to change it; state what changed. Drifting while building is normal; drifting silently is not.',
    '- The plan is **never pushed into your context** — read it with `read_stage_outline` when you',
    '  need it. Keeping it out of the prompt is deliberate.',
  ].join('\n');
}

/** 给别的工具用：把状态读成一句话（缺省不输出任何东西）。 */
export async function planFreezeStatusLine(stageId: string, entryCount: number): Promise<string> {
  const state = await readPlanFreeze(stageId);
  return formatPlanFreezeStatus(state, entryCount);
}

/** 供 `generate_scene` 的门槛直接复用（避免两处各读一次文件）。 */
export async function planFreezeStateFor(stageId: string): Promise<PlanFreezeState> {
  return readPlanFreeze(stageId);
}
