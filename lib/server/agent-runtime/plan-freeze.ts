/**
 * 阶段冻结 —— "边做边想"与"别漂"共存的那个机制。
 *
 * ── 用户的两句话，看上去矛盾，其实是一条 ─────────────────────────
 *
 * 先说：「边做边想也挺好的，避免提示词污染，但是需要打通各页，与审计吧」
 * 后说：「阶段冻结我觉得也要」
 *
 * 不矛盾。合起来是：
 *
 * | 不冻结 | 冻结 |
 * |---|---|
 * | **内容**随时改（边做边想，跑起来才发现要什么） | **结构**不许无纪变更 |
 * | 计划**不进**系统提示词（避免污染） | 计划**落盘**、按需读（`read_stage_outline`） |
 * | 生成后照样可以查资料 | 每一页在计划里**必须有条目** |
 * | — | 计划**可以**改 —— 但要**显式改、且留痕** |
 *
 * ★ 我原来提的"生成前冻结一版计划"是**错的**，用户否掉它是对的：实测那个会话在生成
 *   第一页**之后**还调了 `web_search` 23 次、`fetch_url` 21 次 —— 计划本来就在变。
 *   冻结一份注定要改的计划，只会往上下文里塞一份很快作废的东西。
 *   **所以冻结的不是"计划内容"，是"阶段的准入"。**
 *
 * ── 门槛为什么放在工具里，不放在提示词里 ────────────────────────
 *
 * 手册 §4 那条血泪：自学模式当年**只写在提示词里**，agent 照样 79/79 页都产出讲稿，
 * 最后是**在代码里**关掉的。提示词约束不住的东西，必须在代码里给默认值。
 *
 * 所以：**计划没冻结 ⇒ `generate_scene` 直接拒绝**。拒绝本身就是通知，
 * 平时零成本，而且**不需要往提示词里塞任何东西**（正好满足"避免提示词污染"）。
 *
 * ── 状态存哪：**独立小文件**，不进计划信封 ──────────────────────
 *
 * 计划信封（`document_outlines.data`）技术上能加字段（存盘只做 `assertJsonValue`，
 * 没有 schema 校验）。但**不这么做**：万一某条路径把字段丢掉，门槛就会**静默失效**
 * 或**永久卡死**——而我没有真实写入能验证它。放独立文件（照 `学习状态.md`）风险为零，
 * 而且你能随时打开看、随时删。
 */
import type { SceneOutline } from '@/lib/types/generation';

export interface PlanRevision {
  at: number;
  /** 改了什么、为什么改。**必填** —— 漂移可以，但必须留痕。 */
  reason: string;
}

export interface PlanFreezeState {
  stageId: string;
  /** 是不是冻结了。 */
  frozen: boolean;
  /** 冻结时刻（数据里的时间，不是 `now()`）。 */
  frozenAt?: number;
  /** 冻结时计划里有几条 —— 用来发现"冻结之后悄悄加页"。 */
  frozenEntryCount?: number;
  /**
   * 修订次数。**这是"边做边想"的计量器**：0 = 一次想清楚；
   * 很大 = 边做边想但每次都留了痕（可审计，不是坏事，但要看得见）。
   */
  revision: number;
  revisions: PlanRevision[];
}

export function emptyPlanFreeze(stageId: string): PlanFreezeState {
  return { stageId, frozen: false, revision: 0, revisions: [] };
}

/** 解析磁盘上的东西。缺字段/旧版本一律修好，不炸。 */
export function normalizePlanFreeze(stageId: string, value: unknown): PlanFreezeState {
  if (typeof value !== 'object' || value === null) return emptyPlanFreeze(stageId);
  const raw = value as Partial<PlanFreezeState>;
  const revisions: PlanRevision[] = Array.isArray(raw.revisions)
    ? raw.revisions
        .filter(
          (entry): entry is PlanRevision =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as PlanRevision).reason === 'string',
        )
        .map((entry) => ({ at: typeof entry.at === 'number' ? entry.at : 0, reason: entry.reason }))
    : [];
  return {
    stageId,
    frozen: raw.frozen === true,
    ...(typeof raw.frozenAt === 'number' ? { frozenAt: raw.frozenAt } : {}),
    ...(typeof raw.frozenEntryCount === 'number' ? { frozenEntryCount: raw.frozenEntryCount } : {}),
    revision: typeof raw.revision === 'number' ? raw.revision : revisions.length,
    revisions,
  };
}

/**
 * 冻结。
 *
 * ★ **拒绝冻结一个空计划**：把所有页面都生成完了再"补冻"一次，就等于没有门槛。
 *   冻结的语义是"我打算做这些页"，所以至少要有一条。
 */
export function freezePlan(
  state: PlanFreezeState,
  input: { at: number; entryCount: number },
): { state: PlanFreezeState; error?: string } {
  if (input.entryCount === 0) {
    return {
      state,
      error:
        '计划里一条都没有，不能冻结。冻结的语义是"我打算做这些页" —— ' +
        '先把要做的页写进计划（每页一句 brief），再冻结。',
    };
  }
  return {
    state: {
      ...state,
      frozen: true,
      frozenAt: input.at,
      frozenEntryCount: input.entryCount,
    },
  };
}

/**
 * 改一个已经冻结的计划 —— **允许，但要留痕**。
 *
 * 这就是"边做边想"与"别漂"的接缝：跑起来才发现要改是正常的，
 * 不正常的是**悄悄改**。所以这里要求一个理由，并把次数记下来。
 */
export function revisePlan(
  state: PlanFreezeState,
  input: { at: number; reason: string },
): { state: PlanFreezeState; error?: string } {
  if (!state.frozen) {
    return { state, error: '计划还没冻结，不需要"修订" —— 直接改，然后冻结。' };
  }
  if (!input.reason.trim()) {
    return { state, error: '改已冻结的计划必须写清理由（reason）—— 漂移可以，但要留痕。' };
  }
  return {
    state: {
      ...state,
      revision: state.revision + 1,
      revisions: [...state.revisions, { at: input.at, reason: input.reason.trim() }],
    },
  };
}

export interface PlanGateInput {
  state: PlanFreezeState;
  /** 当前计划里的条目。 */
  entries: readonly SceneOutline[];
  /** 正要生成的那一页的页号。 */
  order: number;
}

export type PlanGateResult = { ok: true } | { ok: false; message: string };

/**
 * 生成一页之前的那道门。
 *
 * 三条判据，按"最该先修的"排序：
 *   1. 计划是空的 → 让它先写计划；
 *   2. 计划没冻结 → 让它先冻结（并说明冻结前该问用户一句）；
 *   3. 这一页在计划里没条目 → 让它先给这一页写 brief。
 *
 * ★ 返回的 message 是**给 agent 的执行指令**（不是给用户的抱怨），因为它会被
 *   原样放进工具结果里。
 */
export function planGate(input: PlanGateInput): PlanGateResult {
  const { state, entries, order } = input;

  if (entries.length === 0) {
    return {
      ok: false,
      message:
        'generate_scene 被拒绝：这门课的计划是空的。**先写计划** —— 用 `edit_deck`/计划工具把' +
        '要做的每一页写成一条（页号 + 标题 + 一句 brief），**再**回来生成。' +
        '计划是给你自己看的：它会按需读出（read_stage_outline），不进系统提示词。',
    };
  }

  if (!state.frozen) {
    return {
      ok: false,
      message:
        `generate_scene 被拒绝：计划有 ${entries.length} 条但**还没冻结**。冻结的语义是"我打算做这些页"，` +
        '所以冻结之前先跟学习者确认一句（`ask_user`：这一版计划做这些页、这个顺序，行不行）。' +
        '确认后用 `freeze_plan` 冻结，然后回来生成。' +
        '**冻结之后照样可以改、可以继续查资料** —— 改计划要用 `plan_revise` 写明理由，痕迹会留下。',
    };
  }

  const entry = entries.find((item) => item.order === order);
  if (!entry) {
    const orders = entries.map((item) => item.order).slice(0, 20).join(',');
    return {
      ok: false,
      message:
        `generate_scene 被拒绝：计划里没有第 ${order} 页。计划里的页号是 ${orders}。` +
        '**先在计划里给这一页写一条 brief**（写清这页要教什么、密度目标、跟前面哪一页接上）再生成。' +
        '如果你是想新增一页，用 `plan_revise` 说明为什么加。',
    };
  }

  return { ok: true };
}

/** 给 agent 的一句状态（放工具结果里；不需要时返回空串）。 */
export function formatPlanFreezeStatus(state: PlanFreezeState, entryCount: number): string {
  if (!state.frozen) {
    return `计划：${entryCount} 条，**未冻结** —— 生成第一页之前要先确认 + 冻结。`;
  }
  const drift = state.frozenEntryCount !== undefined && entryCount !== state.frozenEntryCount;
  return (
    `计划：已冻结（${entryCount} 条，修订 ${state.revision} 次` +
    `${drift ? `；冻结时是 ${state.frozenEntryCount} 条` : ''}）。`
  );
}
