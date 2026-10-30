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
  input: { at: number; entries: readonly SceneOutline[] },
): { state: PlanFreezeState; error?: string } {
  const entryCount = input.entries.length;
  if (entryCount === 0) {
    return {
      state,
      error:
        '计划里一条都没有，不能冻结。冻结的语义是"我打算做这些页" —— ' +
        '先把要做的页写进计划（每页一句 brief），再冻结。',
    };
  }
  /**
   * ★★ **"计划是不是规格"这道闸**（2026-10-09）。
   *
   * 在这之前，冻结**只验条目数不为 0** —— 于是一份"一页一条、没有单元、`keyPoints`
   * 全空"的计划**照样冻结成功**，而它正是实测那一门（66 条里 24 条占位、0 条有 keyPoints）
   * 的来历。提示词里写着"计划是教学设计，不是页表"，**冻结那一刻一个字都不验**。
   *
   * 两类条目分开算（见 `planSpecGaps`）：`backfill` 派生的**一律不算账**，
   * 否则一门老课**永远无法重新冻结** —— 那比没有闸更糟。
   */
  const gaps = planSpecGaps(input.entries);
  // ★ 三条都要**真的拒** —— 只把 `practiceMissingDifficulty` 算出来、写进消息里却不拒，
  //   那就是"报了但没管"（我自己的判据当场抓到的：练习页缺难度时它照样冻结成功）。
  //   难度是"由易到难"唯一的落点，缺了它，一个单元的梯度事后无从查起。
  if (
    gaps.authored > 0 &&
    (gaps.missingKeyPoints > 0 || gaps.missingUnit > 0 || gaps.practiceMissingDifficulty > 0)
  ) {
    const parts = [
      gaps.missingUnit > 0 ? `${gaps.missingUnit} 条没写单元` : '',
      gaps.missingKeyPoints > 0 ? `${gaps.missingKeyPoints} 条 \`keyPoints\` 是空的` : '',
      gaps.practiceMissingDifficulty > 0 ? `${gaps.practiceMissingDifficulty} 条练习没写难度` : '',
    ].filter((part) => part.length > 0);
    return {
      state,
      error: [
        `这份计划还不算**规格**，不能冻结：你写的 ${gaps.authored} 条里有 ${parts.join('、')}。`,
        gaps.samples.length > 0 ? `例如：${gaps.samples.join('、')}。` : '',
        '规矩是：**一个单元 = 讲解（一页一个小点）+ 练习（同一小点的一组题）**；' +
          '每条都要有 `unit`、`keyPoints`（非空），练习条目还要有 `difficulty`。',
        '用 `plan_freeze { action: "revise", entries: [...] }` 把这些补齐（`revise` 会覆盖写，' +
          '不用先删）。补齐之前冻结不了 —— 计划不是规格，生成出来的页也不会是。',
      ]
        .filter((line) => line.length > 0)
        .join(String.fromCharCode(10)),
    };
  }
  return {
    state: {
      ...state,
      frozen: true,
      frozenAt: input.at,
      frozenEntryCount: entryCount,
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

/** `backfill` 给派生条目写的 brief —— **它是"这条不是作者写的"的唯一标记**。 */
export const BACKFILLED_BRIEF =
  'backfilled from the existing page (the original brief was never recorded)';

/**
 * 「这份计划**是不是一份规格**」—— 2026-10-09。
 *
 * ── 为什么要有这个函数（实测逼出来的）──────────────────────────
 *
 * 学习者第 3 轮吐槽里，根因最深的一条是：**计划根本不是规格**。
 * 实测 `stage-GYvpbYB_aN`：66 条里 **24 条**是 `backfill` 派生（brief 就一句
 * "backfilled…"）、`keyPoints` 有内容的 **0 条**、`teachingObjective` **0 条**。
 * 它当初是"生成页面时顺手落盘"出来的，**从来没有人设计过**。
 *
 * 而 `freezePlan` 当时**只验一件事：条目数不为 0**（见下）。
 * 所以一份"一页一条、没有单元、没有小点"的计划**照样冻结成功** ——
 * 提示词里写着"计划是教学设计，不是页表"，而**冻结那一刻一个字都不验**。
 * 这就是手册 §4 那条：**提示词约束不住的东西，必须在代码里给默认值。**
 *
 * ── 两类条目要分开（否则这个闸会误伤）────────────────────────────
 *
 * · **作者写的**：agent 按设计写进去的 —— **必须有** `keyPoints`，必须有 `【Unit …】` 抬头；
 * · **`backfill` 派生的**：从已有页面反推出来的，**天生没有**这些字段，**一律不算账**。
 *   （不分开的话，一门老课**永远无法重新冻结** —— 那比没有闸更糟。）
 */
export interface PlanSpecGaps {
  /** 作者写的条目数（派生的不算）。 */
  authored: number;
  /** 作者条目里 `keyPoints` 为空的条数 —— 空 = 这一页没有说出来的任务。 */
  missingKeyPoints: number;
  /** 作者条目里 description 没有 `【Unit …】` 抬头的条数 —— 也就是没进任何单元。 */
  missingUnit: number;
  /** 练习页（`interactive` / `quiz`）里抬头没写 `difficulty` 的条数。 */
  practiceMissingDifficulty: number;
  /** 点名用：最多几条 `order · title`。 */
  samples: string[];
}

export function planSpecGaps(entries: readonly SceneOutline[]): PlanSpecGaps {
  const authoredEntries = entries.filter(
    (entry) => (entry.description ?? '').trim() !== BACKFILLED_BRIEF,
  );
  const samples: string[] = [];
  let missingKeyPoints = 0;
  let missingUnit = 0;
  let practiceMissingDifficulty = 0;
  for (const entry of authoredEntries) {
    const description = entry.description ?? '';
    const noPoints = (entry.keyPoints ?? []).length === 0;
    const noUnit = !description.includes('【Unit ');
    const isPractice = entry.type === 'interactive' || entry.type === 'quiz';
    const noDifficulty = isPractice && !description.includes('difficulty:');
    if (noPoints) missingKeyPoints += 1;
    if (noUnit) missingUnit += 1;
    if (noDifficulty) practiceMissingDifficulty += 1;
    if ((noPoints || noUnit) && samples.length < 4) {
      samples.push(`第 ${entry.order} 页《${entry.title}》`);
    }
  }
  return {
    authored: authoredEntries.length,
    missingKeyPoints,
    missingUnit,
    practiceMissingDifficulty,
    samples,
  };
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
/**
 * ★ 门槛的**总开关**：`OPENMAIC_PLAN_GATE=1` 才生效，默认**关**。
 *
 * 为什么要开关而不是直接开：门槛一旦生效，**所有** `generate_scene` 调用都要先有
 * 一份已冻结的计划 —— 包括测试夹具里那些只造了半份文档的用例（实测 25 条被拒）。
 * 而"关掉"这件事必须是**显式**的，所以它由**部署配置**决定（进程生命周期内不变，
 * 不会中途翻转 —— 见 AGENTS.md §1.2）。
 *
 * 打开之后的行为：计划为空 / 未冻结 ⇒ `generate_scene` 拒绝，并把该怎么做原样告诉
 * agent（拒绝本身就是通知，系统提示词里不用加东西）。
 */
export function planGateEnabled(): boolean {
  return process.env.OPENMAIC_PLAN_GATE === '1';
}

export interface PlanGateOptions {
  /**
   * 是否强制"这一页必须在计划里有条目"。默认 **true**。
   *
   * ★ `generate_scene` 现在传 `false` —— **分阶段落地**：先强制"计划非空 + 已冻结"
   *   （用户批准的那一条），逐页条目那条等测试夹具跟上再开。
   *   夹具现在只把"已冻结"补上了，没为一个夹具里不存在的页号准备条目，
   *   所以打开它会让 16 条"生成新页"的用例被拒。
   *   **这不是取消这条判据** —— 纯函数这里默认 true、有 13 条测试钉着，只是调用点还没开。
   */
  requirePlannedPage?: boolean;

  /**
   * 被拒的是哪个工具 —— 只用来**把拒绝信息说对**。默认 `'generate_scene'`。
   *
   * ★ 2026-10-07 加：门槛原来**只挂在 `generate_scene`** 上，于是"**修复**一页"
   *   走 `patch_stage` 时**完全不受管** —— 用户实测：说「修复一下 Day 1」，
   *   agent 只查了一下计划状态就直接 `patch_stage` 改页，不问也不给看计划。
   *   修法是把门槛也挂到 `patch_stage`（见 `dsl-tools.ts`），而拒绝信息里必须报
   *   **它自己的**名字，否则模型会以为自己该去调 `generate_scene`。
   */
  tool?: string;
}

export function planGate(input: PlanGateInput, options: PlanGateOptions = {}): PlanGateResult {
  const { state, entries, order } = input;
  const tool = options.tool ?? 'generate_scene';

  if (entries.length === 0) {
    return {
      ok: false,
      message:
        `${tool} 被拒绝：这门课的计划是空的。**先写计划** —— 用 ` +
        '`edit_deck`/计划工具把要做的每一页写成一条（页号 + 标题 + 一句 brief），**再**回来。' +
        '计划是给你自己看的：它会按需读出（read_stage_outline），不进系统提示词。' +
        '**已有的旧课**可以用 `plan_freeze { action: "backfill" }` 从现有页面推导出来（只补缺、不覆盖）。',
    };
  }

  if (!state.frozen) {
    return {
      ok: false,
      message:
        `${tool} 被拒绝：计划有 ${entries.length} 条但**还没冻结**。冻结的语义是"我打算做这些页"，` +
        '所以冻结之前先跟学习者确认一句（`ask_user`：这一版计划做这些页、这个顺序，行不行）。' +
        '确认后用 `plan_freeze { action: "freeze" }` 冻结，然后回来。' +
        '**冻结之后照样可以改、可以继续查资料** —— 改计划要用 `plan_freeze { action: "revise", reason }` 写明理由，痕迹会留下。',
    };
  }

  if (options.requirePlannedPage === false) return { ok: true };

  const entry = entries.find((item) => item.order === order);
  if (!entry) {
    const orders = entries
      .map((item) => item.order)
      .slice(0, 20)
      .join(',');
    return {
      ok: false,
      message:
        `${tool} 被拒绝：计划里没有第 ${order} 页。计划里的页号是 ${orders}。` +
        '**先在计划里给这一页写一条 brief**（写清这页要教什么、密度目标、跟前面哪一页接上）再动它。' +
        '如果你是想新增一页，用 `plan_freeze { action: "revise", reason }` 说明为什么加。',
    };
  }

  return { ok: true };
}

/** 给 agent 的一句状态（放工具结果里；不需要时返回空串）。 */
export function formatPlanFreezeStatus(
  state: PlanFreezeState,
  entries: readonly SceneOutline[],
): string {
  const entryCount = entries.length;
  /**
   * ★ **把"这份计划不是规格"说出来**（2026-10-09）。
   *
   * 这是"以后能不能自动"的关键一环：学习者只要说一句「帮我修一下这门课」，
   * agent 一次 `plan_freeze status` 就会看到"作者写的条目里 N 条没有单元、
   * M 条 keyPoints 空" —— **于是它自己会提出重排计划，不需要用户知道要贴什么提示词**。
   *
   * 实测来历：`stage-GYvpbYB_aN` 那份计划（66 条 / 24 条占位 / keyPoints 全空）
   * 在这里**一个字都不会被提**，所以它一直没被修。
   */
  const gaps = planSpecGaps(entries);
  const specLine =
    gaps.authored === 0
      ? String.fromCharCode(10) +
        '★ 这份计划里的条目**全是 `backfill` 从已有页面反推的**（不是设计出来的）：' +
        '没有单元、没有小点。要它变成规格，就按单元重排一遍。'
      : gaps.missingUnit > 0 || gaps.missingKeyPoints > 0 || gaps.practiceMissingDifficulty > 0
        ? String.fromCharCode(10) +
          `★ **这份计划不是规格**：你写的 ${gaps.authored} 条里有 ` +
          `${gaps.missingUnit} 条没有单元、${gaps.missingKeyPoints} 条 \`keyPoints\` 是空的` +
          `${gaps.practiceMissingDifficulty > 0 ? `、${gaps.practiceMissingDifficulty} 条练习没写难度` : ''}。` +
          '（规矩见系统提示词：一个单元 = 讲解 + 练习。）'
        : '';
  if (!state.frozen) {
    return `计划：${entryCount} 条，**未冻结** —— 生成第一页之前要先确认 + 冻结。${specLine}`;
  }
  const drift = state.frozenEntryCount !== undefined && entryCount !== state.frozenEntryCount;
  return (
    `计划：已冻结（${entryCount} 条，修订 ${state.revision} 次` +
    `${drift ? `；冻结时是 ${state.frozenEntryCount} 条` : ''}）。${specLine}`
  );
}
