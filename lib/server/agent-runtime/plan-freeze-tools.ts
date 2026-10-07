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

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { SceneOutline } from '@/lib/types/generation';
import { upsertOutlineEntry } from './course-outline-write';
import {
  formatPlanFreezeStatus,
  freezePlan,
  revisePlan,
} from './plan-freeze';
import { readPlanFreeze, writePlanFreeze } from './plan-freeze-store';

export const PLAN_FREEZE_TOOL_NAMES = ['plan_freeze'] as const;

const PLAN_FREEZE_PARAMS = Type.Object({
  stageId: Type.String({ description: 'The stage whose plan you are freezing or revising.' }),
  action: Type.Union(
    [
      Type.Literal('status'),
      Type.Literal('add'),
      Type.Literal('backfill'),
      Type.Literal('freeze'),
      Type.Literal('revise'),
    ],
    {
      description:
        'status = report; add = write page entries into the plan; freeze = lock the plan before ' +
        'generating; revise = change a frozen plan.',
    },
  ),
  entries: Type.Optional(
    Type.Array(
      Type.Object({
        order: Type.Integer({ minimum: 1 }),
        title: Type.String(),
        brief: Type.Optional(
          Type.String({ description: 'One line: what this page teaches and what it builds on.' }),
        ),
        type: Type.Optional(Type.String({ description: 'slide | quiz | interactive | pbl' })),
      }),
      {
        description:
          'For `add`: the pages to write into the plan. Give brief for each — it is the only thing ' +
          'that records why the page exists.',
      },
    ),
  ),
  reason: Type.Optional(
    Type.String({
      description:
        'Required for `revise`: what changed and why. Drifting is fine; drifting silently is not.',
    }),
  ),
});

/**
 * 工具需要的最小依赖 —— 读计划信封 + 写回。
 *
 * ★ 必须**能写**，不能只读。这是做门槛时发现的死锁：agent 路径上原本只有
 *   `generate_scene` 会往计划里写条目（T1 那次落盘），而门槛会拒绝 `generate_scene`，
 *   于是"计划空 → 生成被拒 → 计划还是空"。所以 `add` 是解开门槛的钥匙，
 *   **它和门槛必须一起落地**。
 */
export interface PlanFreezeToolDeps {
  loadOutline(stageId: string): Promise<AppDocumentOutline | undefined>;
  saveOutline(stageId: string, outline: AppDocumentOutline): Promise<boolean>;
  /** `backfill` 用：这一门**已经落盘**的页面（老课没有计划，只能从页面反推）。 */
  loadPages(stageId: string): Promise<readonly PlanFreezePage[] | null>;
}

/** `backfill` 只需要这三个字段。 */
export interface PlanFreezePage {
  order: number;
  title: string;
  type: string;
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
      '`add` writes entries into it — do this first, one entry per page. ' +
      '`backfill` derives entries from the pages a course already has (for a course made before the ' +
      'plan existed); it only fills gaps and never overwrites a brief you wrote. ' +
      '`freeze` locks it before you start generating — every page you generate must already have an ' +
      'entry in it. Freezing an empty plan is refused: freezing means "these are the pages I intend to make". ' +
      'You may still change a frozen plan with `revise` (state what changed and why), and you may keep ' +
      'researching after freezing. The plan is read on demand with `read_stage_outline`; it is never ' +
      'pushed into your context.',
    parameters: PLAN_FREEZE_PARAMS,
    executionMode: 'sequential',
    async execute(_id: string, params: Static<typeof PLAN_FREEZE_PARAMS>) {
      const outline = await deps.loadOutline(params.stageId);
      const entries = outline?.outlines ?? [];
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

      if (params.action === 'add') {
        const list = params.entries ?? [];
        if (list.length === 0) {
          return text(
            'add needs at least one entry. Pass `entries: [{ order, title, brief }]` — ' +
              'one entry per page you intend to make.',
            true,
          );
        }
        if (!outline) {
          return text(
            '这一门没有计划信封（document_outlines 缺行），写不了计划。' +
              '先 `create_stage` 建课，再写计划。',
            true,
          );
        }
        let next = outline;
        for (const entry of list) {
          const result = upsertOutlineEntry(next, {
            id: `p${entry.order}`,
            order: entry.order,
            title: entry.title,
            type: entry.type ?? 'slide',
            ...(entry.brief ? { description: entry.brief } : {}),
          } as SceneOutline);
          if (result.outline) next = result.outline;
        }
        const saved = await deps.saveOutline(params.stageId, next);
        if (!saved) return text('计划没能写盘 —— 计划没有变。', true);
        const after = next.outlines ?? [];
        const listing = after.map((item) => `${item.order}. ${item.title}`).join(' | ');
        return text(
          `计划现在有 ${after.length} 条：${listing}\n\n` +
            '确认这一版页数和顺序之后 `plan_freeze { action: "freeze" }`，' +
            '然后才能 `generate_scene`。',
        );
      }

      if (params.action === 'backfill') {
        if (!outline) {
          return text('这一门没有计划信封（document_outlines 缺行），没法补计划。', true);
        }
        const pages = await deps.loadPages(params.stageId);
        if (!pages || pages.length === 0) {
          return text('这一门没有任何已落盘的页面，没有东西可以反推。', true);
        }
        const existingOrders = new Set((outline.outlines ?? []).map((item) => item.order));
        const missing = pages.filter((page) => !existingOrders.has(page.order));
        if (missing.length === 0) {
          return text(
            `计划里已经有全部 ${pages.length} 页的条目，**没有补任何东西**。` +
              '（backfill 只补缺的 —— 它绝不会覆盖你写过的 brief。）',
          );
        }
        let next = outline;
        for (const page of missing) {
          const result = upsertOutlineEntry(next, {
            id: `p${page.order}`,
            order: page.order,
            title: page.title,
            type: page.type,
            description: 'backfilled from the existing page (the original brief was never recorded)',
          } as SceneOutline);
          if (result.outline) next = result.outline;
        }
        const saved = await deps.saveOutline(params.stageId, next);
        if (!saved) return text('计划没能写盘 —— 计划没有变。', true);
        return text(
          `补了 ${missing.length} 条（第 ${missing.map((page) => page.order).join(',')} 页），` +
            `原有 ${existingOrders.size} 条**一个字没动**。` +
            '这些条目的 brief 标了 backfilled —— 它们是从页面反推的，不是当初的意图；' +
            '要改就用 `plan_freeze { action: "revise", reason }` 或 `add` 重写那一条。',
        );
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
    '- **`patch_stage` is gated too** (2026-10-07). Repairing a page needs the same frozen plan:',
    '  for a course that predates this, `plan_freeze { action: "backfill" }` first (it only fills gaps).',
    '  The reason is measured, not theoretical — asked to "fix Day 1", an agent checked the plan status',
    '  and went straight to editing pages: the gate was only on `generate_scene`, so the most common',
    '  repair path was unguarded. **Do not treat a repair as exempt from the plan.**',
    '- **Freezing does not mean the plan is final.** Use `plan_freeze { action: "revise", reason }`',
    '  to change it; state what changed. Drifting while building is normal; drifting silently is not.',
    '- The plan is **never pushed into your context** — read it with `read_stage_outline` when you',
    '  need it. Keeping it out of the prompt is deliberate.',
    '- For a course that predates this, `plan_freeze { action: "backfill" }` derives entries from the',
    '  pages it already has. It only fills gaps; it never overwrites a brief you wrote, and the',
    '  entries it adds are marked as derived rather than original.',
  ].join('\n');
}


