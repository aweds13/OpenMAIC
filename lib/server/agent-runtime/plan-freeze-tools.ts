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
import { shiftOutlineOrders, upsertOutlineEntry } from './course-outline-write';
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
  removeOrders: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      description:
        'For `revise`: page numbers whose plan entries should be REMOVED (use when a page is gone).',
    }),
  ),
  shift: Type.Optional(
    Type.Object(
      {
        fromOrder: Type.Integer({ minimum: 1, description: 'The first page number to move.' }),
        delta: Type.Integer({
          description: '+1 to make room for a page you split; -1 to close a gap.',
        }),
      },
      {
        description:
          'For `revise`: move **every** entry with `order >= fromOrder` by `delta`. This is the ' +
          'primitive for "I split a page in two, so everything after it shifts" — `add` alone ' +
          'cannot express it (it replaces whatever already sits at that order).',
      },
    ),
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
        /**
         * ★ 把「缺哪些号 / 哪些号重复」**直接报出来**（2026-10-07 加）。
         *
         * 实测：agent 只拿得到一个总数（"51 条"），于是把"补一条就挤掉一条"
         * 理解成**工具容量上限**，还据此告诉学习者"要再拆页就得先重排计划" ——
         * **对着我们的 bug 做规划**。缺号和重号都是**可算的**，不该让模型去猜。
         */
        const counts = new Map<number, number>();
        for (const entry of entries) counts.set(entry.order, (counts.get(entry.order) ?? 0) + 1);
        const duplicates = [...counts.entries()]
          .filter(([, n]) => n > 1)
          .map(([order]) => order)
          .sort((a, b) => a - b);
        const maxOrder = entries.reduce((max, entry) => Math.max(max, entry.order), 0);
        const missing: number[] = [];
        for (let order = 1; order <= maxOrder; order += 1) {
          if (!counts.has(order)) missing.push(order);
        }
        if (duplicates.length > 0) {
          lines.push(
            `★ **order 重复**：${duplicates.join(', ')} —— 同一个页号有两份条目。` +
              '写 `add` 时同 order 只保留最新那一份（已自动去重）。',
          );
        }
        if (missing.length > 0) {
          lines.push(
            `★ **缺条目**：${missing.join(', ')} —— 这些页在计划里没有条目。` +
              '往这些页号写 `add` 是**安全的**（不会覆盖任何东西）。',
          );
        }
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
        /**
         * ★ **先挡住会吃掉别的页的那种写**（2026-10-07 修，实测数据丢失）。
         *
         * `upsertOutlineEntry` 按 order 认身份 ⇒ 往一个**已被占用**的 order 写，
         * 就是**覆盖**原来那一页的条目，而且**不报错**。而拆页/插页之后页号会顺延，
         * agent 给新页写的 order 恰好会落在既有条目上 ⇒ 它"补一次、洞往后挪一格"。
         *
         * 实测（`stage-GYvpbYB_aN`）：51 页 / 计划只剩 **47 条**，缺 `37, 40, 46, 47`。
         * agent 把这理解成**工具的容量只有 47 条**，并据此告诉学习者"要再拆页就得先
         * 重排计划"—— 那是对着我们的 bug 做规划。
         *
         * 判据：**同一个 order 上已经有一条标题不同的条目** ⇒ 拒。
         * （标题相同 = 重写同一页的 brief，那是 `add` 的正常用法，放行。）
         */
        const current = outline.outlines ?? [];
        const clashes = list.filter((entry) => {
          const existing = current.find((item) => item.order === entry.order);
          return existing !== undefined && existing.title.trim() !== entry.title.trim();
        });
        if (clashes.length > 0) {
          const detail = clashes
            .map((entry) => {
              const existing = current.find((item) => item.order === entry.order);
              return `第 ${entry.order} 页已被《${existing?.title ?? ''}》占用（你要写的是《${entry.title}》）`;
            })
            .join('；');
          return text(
            `add 被拒绝：${detail}。**这一写会覆盖掉别的页的条目**，所以没有执行。` +
              '两条路：① 你要写的是**新的一页** ⇒ 先让页号顺延（`edit_deck` 的插入/重排' +
              '会同步计划条目），再用空出来的 order 写；' +
              '② 你要改的是**已经在这一页上的条目** ⇒ 用同样的标题重写（也就是 `add`，会被放行），' +
              '那表示你确认这一页就是它。',
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

      /**
       * ★ revise **现在真的改计划**（2026-10-07 修）。
       *
       * 原来这一支只调 `revisePlan()` —— 它**只记一次修订理由**，一个条目都不动。
       * 而提示词、门槛的拒绝信息、`freeze` 的回复**三处都在教模型**
       * 「改计划要用 `revise` 写明理由」 —— **那是我们写的一句假话**：
       * 唯一能写条目的是 `add`，而它按 order 覆盖。
       *
       * 实测代价（`stage-GYvpbYB_aN`）：agent 一边拆页一边补条目，条目静默消失 4 条
       * （37/40/46/47），最后把计划当成"容量只有 47 条"，并据此给学习者做了规划。
       *
       * 现在这一支能表达它真正需要的三件事：
       *   `shift`（拆页 ⇒ 后面页号顺延）· `removeOrders`（页面没了）· `entries`（写/改条目）。
       */
      const changes: string[] = [];
      let next = outline;

      if (params.shift) {
        const shifted = shiftOutlineOrders(next, params.shift.fromOrder, params.shift.delta);
        if (shifted.error) return text(shifted.error, true);
        if (shifted.outline) next = shifted.outline;
        const sign = params.shift.delta > 0 ? '+' : '';
        changes.push(
          `order ≥ ${params.shift.fromOrder} 的 ${shifted.moved} 条平移 ${sign}${params.shift.delta}`,
        );
      }

      if (params.removeOrders?.length) {
        const drop = new Set(params.removeOrders);
        const before = next?.outlines ?? [];
        const kept = before.filter((entry) => !drop.has(entry.order));
        if (next) next = { ...next, outlines: kept };
        changes.push(`删掉 ${before.length - kept.length} 条条目（order ${params.removeOrders.join('、')}）`);
      }

      if (params.entries?.length) {
        let working = next;
        for (const entry of params.entries) {
          const written = upsertOutlineEntry(working, {
            id: `p${entry.order}`,
            order: entry.order,
            title: entry.title,
            type: entry.type ?? 'slide',
            ...(entry.brief ? { description: entry.brief } : {}),
          } as SceneOutline);
          if (written.outline) working = written.outline;
        }
        next = working;
        changes.push(`写入/更新 ${params.entries.length} 条条目`);
      }

      if (changes.length > 0 && next !== undefined && next !== outline) {
        const saved = await deps.saveOutline(params.stageId, next);
        if (!saved) return text('计划没能写盘 —— 计划没有变。', true);
      }

      const result = revisePlan(state, { at: Date.now(), reason: params.reason ?? '' });
      if (result.error) return text(result.error, true);
      const written = await writePlanFreeze(result.state);
      if (!written) return text('修订没能写盘 —— 计划没有变。', true);
      return text(
        `已记下第 ${result.state.revision} 次修订：「${(params.reason ?? '').trim()}」。` +
          (changes.length > 0
            ? `\n**实际改动**：${changes.join('；')}。`
            : '\n**没有改任何条目** —— 你只传了 `reason`。要改条目请带 `entries` / `shift` / `removeOrders`。') +
          '\n改完页面结构要跟着对齐（`edit_deck` 会同步计划条目）。',
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


