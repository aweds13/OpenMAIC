/**
 * T3：计划期依赖校验 —— 在**还没有生成任何一页**的时候，先把顺序和预算问题挑出来。
 *
 * ── 与 T2 的分工 ──────────────────────────────────────────────────
 *
 * | | 看什么 | 什么时候 | 花模型吗 |
 * |---|---|---|---|
 * | 本模块（T3） | **计划**（每页的 brief / keyPoints） | 计划写下的那一刻 | 不花 |
 * | `coverage-gap`（T2） | **已落盘的页面内容** | 生成之后 | 不花 |
 *
 * 两者共用同一把尺子（`contentChunks` 切的内容块），所以"计划里没讲"和"页面上没讲"
 * 说的是同一件事。T3 更早、更便宜；T2 更真（它看的是真的写出来的东西）。
 *
 * ── 三条判据，以及**为什么每条都只给"增"的修法** ────────────────
 *
 * 1. **预算**：一页 brief 引入的新概念超过 N 个 → 建议**拆页**。
 *    （复盘的原话是「OOP 只用 1 页讲解，却要撑 5 个概念 + 3 组关系」—— 那是页数
 *    预算不足，不是内容太多。所以要加页，不是砍概念。）
 * 2. **超前引用**：某页要考的东西**第一次出现在更后面的页** → 建议**挪位**或**补讲**。
 * 3. **无归属**：某页要考的东西**全计划没有任何一页讲** → 建议**补一页**。
 *
 * ★ 这三条**没有一条的输出是"删"**。这是刻意的，也是被用户当面纠正过的：
 * 「假如我先定范围，再出题，会不会错失多态下面的具体内容」—— 门禁一旦允许删，
 * 就会变成棘轮：讲解页越薄，它把课程压得越薄。**它只准许要求"补"和"挪"。**
 */
import { contentChunks } from '@/lib/quiz/coverage-gap';

/** 计划里的一页 —— `SceneOutline` 的子集，好让本模块不依赖生成包。 */
export interface PlanEntryLike {
  order: number;
  type: string;
  title: string;
  description?: string;
  keyPoints?: string[];
}

export type PlanIssueKind =
  /** 一页塞太多新概念。 */
  | 'budget'
  /** 考的东西第一次出现在更后面的页。 */
  | 'forward-reference'
  /** 考的东西全计划没有归属页。 */
  | 'unintroduced';

export interface PlanIssue {
  kind: PlanIssueKind;
  /** 相关的页号（涉及的页在前）。 */
  orders: number[];
  /** 给 agent 看的一句话，**必须自带一个合法修法**。 */
  message: string;
}

export interface CheckPlanDependenciesOptions {
  /**
   * 一页 brief 最多算几个"新概念"。**不给就不检查**（默认关闭）。
   *
   * ★ 为什么没有默认值：**内容块 ≠ 概念**。实测
   * `封装 private 字段 + getter setter` 切出 5 个块，而它只是**一个**概念 ——
   * 第一版把默认设成 3，于是正常的一页也会被报"引入过多概念"（测试当场抓住）。
   *
   * 要把它调准，只能拿**真实的计划数据**标定；而 T1 之前这个部署的计划
   * **永远是空的**（7 门课、0 条），所以现在**没有数据可标**。与其拍一个数，
   * 不如默认关掉：调用方要么自己标定过，要么就别开。
   */
  conceptsPerPage?: number;
  /** 只看这些类型的页有没有"考"。默认 `['quiz']`。 */
  assessedTypes?: readonly string[];
  /**
   * 一个内容块至少要在**几页**里出现过才当回事。默认 2。
   *
   * ★ 这是 T2 验证过的同一条判据（**新颖 + 重复 ≈ 术语**），分母换成"计划里有几页
   *   提到它"。理由一模一样：计划的 brief 很短、口气话很多 —— 实测
   *   `考封装：private 字段怎么读` 里的「怎么读」只出现在这一页，而真概念至少会同时
   *   出现在**讲解页的 brief** 和**自检页的 brief** 里（≥2 页）。
   *   没有这道闸时，「怎么读」被报成"没讲就考"（第一版实测如此）。
   */
  minPages?: number;
}

/**
 * 一页的"文本"：就是 agent 写进计划的那部分。
 *
 * ★ `includeTitle` 分开是有理由的：**标题在两侧的作用不同**。
 *   · **讲解页**的标题在教词（「多态」「封装」）⇒ 要算进去；
 *   · **自检页**的标题是**标签**（「小测」「自检：Java 基础语法八道题」）⇒ 算进去
 *     就会把「小测」报成"没讲就考"（第一版实测如此）。
 * 所以自检页只看 `description` + `keyPoints` —— 那才是"要考什么"。
 */
function entryText(entry: PlanEntryLike, options: { includeTitle?: boolean } = {}): string {
  return [
    ...(options.includeTitle === false ? [] : [entry.title]),
    entry.description ?? '',
    ...(entry.keyPoints ?? []),
  ].join('\n');
}

/**
 * 按页号扫描计划，返回问题清单（按页号排序）。
 *
 * 纯函数、不花模型、不做任何写操作 —— 调用方决定怎么把 issue 交给 agent。
 */
export function checkPlanDependencies(
  entries: readonly PlanEntryLike[],
  options: CheckPlanDependenciesOptions = {},
): PlanIssue[] {
  const conceptsPerPage = options.conceptsPerPage;
  const minPages = options.minPages ?? 2;
  const assessedTypes = new Set(options.assessedTypes ?? ['quiz']);
  const ordered = [...entries].sort((left, right) => left.order - right.order);

  // 每个内容块**第一次出现在讲解页**的页号；以及它出现在哪些页。
  //
  // ★ 为什么是"第一次出现在讲解页"而不是"第一次出现"：第一版用了后者，
  //   结果超前引用**永远不可能触发** —— 一个词只要出现在第 5 页（自检）上，
  //   它的"第一次出现"就 ≤ 5，不可能 > 5。真正要问的是：
  //   **讲它的那一页，排在这一页之前了吗。**
  const firstTeachingOrder = new Map<string, number>();
  const pagesWith = new Map<string, Set<number>>();
  for (const entry of ordered) {
    const assessed = assessedTypes.has(entry.type);
    for (const chunk of contentChunks(entryText(entry, { includeTitle: !assessed }))) {
      const pages = pagesWith.get(chunk) ?? new Set<number>();
      pages.add(entry.order);
      pagesWith.set(chunk, pages);
      if (!assessed && !firstTeachingOrder.has(chunk)) {
        firstTeachingOrder.set(chunk, entry.order);
      }
    }
  }
  const teachingChunks = [...firstTeachingOrder.keys()];

  /**
   * 这个块在讲解页里被覆盖了吗？覆盖时返回**讲它的最早页号**。
   *
   * ★ 判据是"**整块命中，或者本块里包含某个已教的块**" —— 后一半是关键：
   *   自检页会写「考封装」，而讲解页写的是「封装」。按整块相等判断会把
   *   「考封装」报成"没讲就考"（第一版就这样，测试当场抓住）；按块包含判断，
   *   「考封装」里含已教的「封装」⇒ 覆盖，而真正没讲过的「动态绑定」里
   *   不含任何已教块 ⇒ 照旧报出来。
   */
  const coveredBy = (chunk: string): number | undefined => {
    const exact = firstTeachingOrder.get(chunk);
    if (exact !== undefined) return exact;
    let earliest: number | undefined;
    for (const teaching of teachingChunks) {
      if (teaching.length < 2 || !chunk.includes(teaching)) continue;
      const order = firstTeachingOrder.get(teaching);
      if (order === undefined) continue;
      if (earliest === undefined || order < earliest) earliest = order;
    }
    return earliest;
  };

  const issues: PlanIssue[] = [];

  for (const entry of ordered) {
    const assessed = assessedTypes.has(entry.type);
    // 自检页不看标题（标题是标签，不是考点）；讲解页看。
    const chunks = [...new Set(contentChunks(entryText(entry, { includeTitle: !assessed })))];
    if (chunks.length === 0) continue;

    // ── 1) 预算：这一页引入了多少**前面任何页都没出现过**的块 ────────
    const seenBefore = new Set<string>();
    for (const earlier of ordered) {
      if (earlier.order >= entry.order) break;
      for (const chunk of contentChunks(entryText(earlier))) seenBefore.add(chunk);
    }
    const introduced = chunks.filter((chunk) => !seenBefore.has(chunk));
    if (conceptsPerPage !== undefined && introduced.length > conceptsPerPage) {
      issues.push({
        kind: 'budget',
        orders: [entry.order],
        message:
          `第 ${entry.order} 页《${entry.title}》一次引入 ${introduced.length} 个新概念` +
          `（上限 ${conceptsPerPage}）：${introduced.slice(0, 8).join('、')}${introduced.length > 8 ? '…' : ''}。` +
          '**拆成 2–3 页**，每页讲透一个；不要砍掉其中任何一个概念。',
      });
    }

    // ── 2) / 3) 只对"要考"的页检查依赖 ─────────────────────────────
    if (!assessed) continue;

    const orphan: string[] = [];
    const forward = new Map<number, string[]>();
    for (const chunk of chunks) {
      // 新颖 + 重复：只在一页里出现过的块是措辞，不是"要考的东西"。
      const pages = pagesWith.get(chunk) ?? new Set<number>();
      const repeated =
        pages.size >= minPages ||
        // 被某个已教块**包含**（「考封装」含「封装」）时也算它出现过。
        coveredBy(chunk) !== undefined;
      if (!repeated) continue;
      const taughtAt = coveredBy(chunk);
      if (taughtAt === undefined) {
        // 没有任何**讲解页**讲它（可能只在这一页自己、或只散在别的自检页里）。
        orphan.push(chunk);
        continue;
      }
      if (taughtAt > entry.order) {
        forward.set(taughtAt, [...(forward.get(taughtAt) ?? []), chunk]);
      }
    }

    for (const [taughtAt, chunksHere] of [...forward.entries()].sort((a, b) => a[0] - b[0])) {
      issues.push({
        kind: 'forward-reference',
        orders: [entry.order, taughtAt],
        message:
          `第 ${entry.order} 页《${entry.title}》要考 ${chunksHere.slice(0, 6).join('、')}` +
          `${chunksHere.length > 6 ? '…' : ''}，而讲它们的是**第 ${taughtAt} 页**（更靠后）。` +
          '把这一页**挪到讲解之后**，或者把讲解**提前**；不要删掉这道题。',
      });
    }

    if (orphan.length) {
      issues.push({
        kind: 'unintroduced',
        orders: [entry.order],
        message:
          `第 ${entry.order} 页《${entry.title}》要考 ${orphan.slice(0, 6).join('、')}` +
          `${orphan.length > 6 ? '…' : ''}，而计划里**没有任何讲解页讲过它们**。` +
          '**补一页讲解**（题可以原样留着），或者把这道题改成只用已讲过的说法；' +
          '若本课确实不展开它，就在计划里写明「本课不展开」并把它从题干里去掉。',
      });
    }
  }

  return issues.sort((left, right) => (left.orders[0] ?? 0) - (right.orders[0] ?? 0));
}

/** 把问题清单渲染成给 agent 的一段诊断。 */
export function formatPlanIssues(issues: readonly PlanIssue[], options: { max?: number } = {}): string {
  if (issues.length === 0) return '';
  const max = options.max ?? 6;
  const shown = issues.slice(0, max);
  const lines = [
    `Plan dependency check — ${issues.length} 处问题（这是**计划**层面，页面还没生成）：`,
    ...shown.map((issue) => `- [${issue.kind}] ${issue.message}`),
  ];
  if (issues.length > max) lines.push(`- …还有 ${issues.length - max} 处`);
  lines.push(
    '',
    '这些修法**只允许"补"和"挪"**：补一页/补一段讲解、把练习挪到讲解之后、把一页拆成两页、' +
      '换一种已讲过的说法。**不允许删题、砍概念、或把两页合并来消掉冲突** —— 那会让课程' +
      '越修越薄。',
  );
  return lines.join('\n');
}
