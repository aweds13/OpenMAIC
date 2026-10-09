/**
 * 课程级审计 —— "这些页有没有连成一门课"。
 *
 * ── 为什么是这个模块，而不是"冻结计划" ────────────────────────────
 *
 * 我原来的提议是"生成前先冻结一版计划"。用户否掉它是对的，理由有实测支撑：
 *
 * 「边做边想也挺好的，**避免提示词污染**，但是需要**打通各页**，与**审计**吧」
 *
 * 在一个真会话里，它**生成了第一页之后**还调了 `web_search` 23 次、`fetch_url` 21 次 ——
 * 说明计划**一直在变**。冻结一份注定要改的大计划，只会往上下文里塞一份很快作废的东西。
 *
 * **但边做边想有个代价：整体性只能靠事后审计来兜。** 所以审计不是附加项，是**这个选择的
 * 必要条件**。而"有没有连成一门课"这件事**是可算的**，不需要再问一次模型。
 *
 * ── ★ 判据是"先量再建"选出来的：三条里只有两条活下来 ──────────────
 *
 * 第一版写了三条判据，拿 7 门真实课程（146 个讲解页）跑了一遍，**两条当场被证伪**：
 *
 * | 判据（第一版） | 裁定 | 实测证据 |
 * |---|---|---|
 * | **承接率** | ✅ 留 | 各课程 13–37%，逐页 0–67%，**能区分** |
 * | **断裂承诺** | ❌ **删** | 全是噪声：把自检题干「下面哪种说法正确」当成承诺；把给学习者的指令「实现完之后…」当成承诺；而且**一句话里所有新词都成了承诺**（某页一句话报 8 个） |
 * | **一次性词** | ❌ **删** | 564 个里是「3分钟内完成」（UI 文案）、「App」「Found」（一次性提及）。而且"一次性"**本身就排除了频率闸** ⇒ 没有可用的校准方式 |
 *
 * 如果不量就建，我会交付两个满屏误报的判据，而使用者会以为"打通各页"被解决了。
 *
 * ── 活下来的两条 ────────────────────────────────────────────────
 *
 * 1. **承接率**（carry / terms）：这一页用的内容块里，有多少是**前面已经建立过**的。
 *    一页全是新块 ⇒ 它跟前面没有词面上的关系。
 *    ★ 只有**讲解页**才这么看：自检页天然不复用讲解页的措辞（见 T2 的覆盖缺口检查，
 *      那条判据已经校准过，这里不重复管）。
 * 2. **超载页**（novel > 阈值）：一页一次塞进多少**新块**。
 *    ★ 阈值是**标定出来的，不是拍的**：146 个讲解页的实测分布是
 *      `min=1 p50=25 p75=35 p90=49 max=242`，所以**最初**取 p90 = 49；2026-10-09 抬到 **60**（见常量注释）。
 *      实测最超载的三页：《学生名单管理（集合+Stream+异常+Maven）》**242**、
 *      《待办清单 App（Widget+setState+布局+路由）》**209**、
 *      Day 1《面向对象三概念》**64** —— 正是复盘里点名的那类页
 *      （「OOP 只用 1 页讲解，却要撑 5 个概念 + 3 组关系」）。
 *
 * ★ 两条都**不回滚、不删内容** —— 与 T2/T3 同一条原则：审计只让问题可见，
 *   修法是"补 / 挪 / 拆 / 改写"。
 */
import { contentChunks, extractTaughtText } from '@/lib/quiz/coverage-gap';
import { staticPageText } from '@/lib/quiz/page-text';

/**
 * 讲解页一次引入新块的告警线 —— 146 个真实讲解页的 **p90**。
 *
 * ★ **这个数字只适用于"已落盘页面内容"这个测量。** `plan-check.ts` 里那条
 *   `conceptsPerPage`（"一页 brief 引入太多新概念"）看着像同一件事，其实输入不同
 *   （计划 brief vs 页面内容），**不能共用这个常量**。见 scene-diagnostics.ts 的注释。
 */
/**
 * 一页"一次性引入多少个**新内容块**"才值得提一句。
 *
 * ★★ **这是新颖度，不是"讲太多"**（2026-10-09，用户的诊断）：
 *   一页老老实实把 5 种循环讲清楚，它**必然**引入很多新块 —— 按旧值（49）报出来，
 *   等于**惩罚"讲完整"**，而六条优先级里**内容是第一位**。
 *   所以这条线的语义是「**这一页塞的东西可能超出一次消化的量**」，不是「你写多了」：
 *   它是一条**提示**，合规的处理是**拆页**（或确认它确实该在这一页讲完），**不是删内容**。
 *
 * 取值：60（原 49）。49 是 146 个真实讲解页的 **p90**；抬到 60 之后只剩最极端的那几页会响。
 * ⚠ 它**只在 slide 上标定过**（`pbl` p50=95、`interactive` p50=11 是别的量纲，走 `scaffoldPages`）。
 */
export const NOVEL_P90 = 60;

/** 审计看到的一页。只需内容和身份，不需要生成包的类型。 */
export interface AuditedPage {
  stageId: string;
  sceneId: string;
  order: number;
  title: string;
  type: string;
  content?: unknown;
}

/**
 * 这一页的练习上有几个**任务**（2026-10-09）。
 *
 * ── 为什么要有这个数 ──────────────────────────────────────────────
 *
 * 学习者第 3 轮吐槽里最刺眼的一条是「**练习页的难度真的很离谱**」。量下来根因不是难度，
 * 是**粒度**：实测 Day02 的练习页**一页塞 3~4 个任务**（P19/P22/P26/P37/P40/P42/P44/P49
 * 各 3，P38/P46/P51 各 4）。而 P19 那一页还横跨三档难度 —— 补一个 `if` → `if/else if`
 * 链 → 闰年（`%` + `&&` + `||` + 括号优先级），而**讲解页 P18 把闰年那句原样写了出来**。
 * 于是"练"变成了"抄"。
 *
 * 规矩（见 `course-design.ts` 的 "Practice: one small point, a graded set of questions"）：
 * **练习围绕一个小点** —— 同一小点可以出多题、可以跨多页（页数不是约束），
 * **但一页不许混别的小点**。
 *
 * ★ 所以这个数是**信号，不是合格线**：`>1` 不等于错（一组题本来就该有多题），
 *   它要回答的是「这一页上压了几组题」—— 配合页标题就能看出有没有混小点
 *   （Day02 P19 标题写着「正负判断、成绩等级、闰年判断」，计数 3 ⇒ 三个小点挤一页）。
 *   真正的合格线在 brief 那一侧（`course-design.ts`），不在这个计数上。
 *
 * ── 三种情况，判据不同（**别把它们混成一个数**）──────────────────────
 *
 * 1. `quiz` —— 题量是**结构化**的（`content.questions`），数得准。
 * 2. `interactive` **带 `widgetConfig`** —— 那是**上游合同**：
 *    `{starterCode, solution, testCases, hints, …}`，**一份 starterCode = 一个任务** ⇒
 *    按合同就是 **1**。`testCases.length` 是"这一题查了几件事"，**不是**任务数
 *    （实测 P26 有 8 条 testCases，可它那一道题里塞了三个练习）。所以两个数都给出来。
 * 3. `interactive` **没有 `widgetConfig`** —— 那一页**自己造了 UI**（P19 就是），
 *    任务数只能尽力从 HTML 里认；认不出就返回 **`null`（不知道）**，**绝不返回 0** ——
 *    把"不知道"说成"没有任务"，正是这个仓库反复栽过的那种静默。
 *
 * ★ 「没有 `widgetConfig`」本身就是一个可查的缺陷：20 个练习页里 **8 个**是这样，
 *   而它们同时**不受任何结构化检查覆盖**。
 */
export interface PracticePageShape {
  /** 任务数；`null` = 认不出来（**不是** 0）。 */
  tasks: number | null;
  /** `interactive` 且带上游合同时，这一题查了几件事。 */
  testCases?: number;
  /** 这一页有没有按上游合同带 `widgetConfig`。 */
  followsContract: boolean;
}

export function practiceTaskCount(page: AuditedPage): PracticePageShape {
  // ★ 两种形状都收：`page.content` 既可能是**场景的 content**（`{canvas|html|questions}`），
  //   也可能是**整条场景**（`{id,type,order,…,content}`）—— 仓库里两种调用点都有
  //   （`course-audit-live.test.ts` 的 loader 传的就是整条场景）。
  //   只认一种，另一种会**静默**返回"不知道"。
  const outer = page.content as { content?: unknown } | undefined;
  const content = (outer?.content && typeof outer.content === 'object' ? outer.content : outer) as
    | { questions?: unknown; html?: unknown; widgetConfig?: Record<string, unknown> }
    | undefined;

  if (page.type === 'quiz') {
    return { tasks: Array.isArray(content?.questions) ? content.questions.length : null, followsContract: true };
  }
  if (page.type !== 'interactive') return { tasks: null, followsContract: true };

  const config = content?.widgetConfig;
  if (config && typeof config === 'object') {
    const cases = Array.isArray(config.testCases) ? config.testCases.length : undefined;
    return { tasks: 1, ...(cases === undefined ? {} : { testCases: cases }), followsContract: true };
  }

  const html = typeof content?.html === 'string' ? content.html : '';
  const declared = html.match(/const\s+TASKS\s*=\s*\[([\s\S]*?)\n\s*\];/);
  // ★ 按 `title:` 数，**不按 `id:` 数** —— 实测（Day02 P19/P40/P54）：
  //   `id:` 在这三页上是 **3 / 17 / 15**，而它们的标题分别写着「正负判断、成绩等级、闰年」
  //   「这三段」「这三处」⇒ 真值都是 **3**。多出来的是**任务内部**嵌套对象的 id
  //   （改错页每一段里还有自己的 id）。`title:` 三页都是 3，与标题对得上。
  const titles = declared?.[1]?.match(/\btitle:\s*'/g);
  return { tasks: titles ? titles.length : null, followsContract: false };
}

export interface PageLinkage {
  stageId: string;
  sceneId: string;
  order: number;
  title: string;
  type: string;
  /** 这一页自己引入了多少个前面没出现的块。 */
  novel: number;
  /** 这一页用了多少个**前面已经建立过**的块 —— 这就是"承接"。 */
  carried: number;
  /** 这一页用到的块总数。 */
  terms: number;
  /** 承接率 = carried / terms。**0 意味着这页跟前面没有任何词面关系。** */
  carryRatio: number;
}

/**
 * 正文里**写死的页码引用** —— 每一条都报出来，但**不做内容判定**。
 *
 * ★ 为什么不判"内容对不对"：试过。用「目标页里有没有引用附近的实词」当判据，
 *   36 条引用里报出 9 条候选，逐条核对后**误报率 80%**（例：第 15 页写「位运算见第 15 页」，
 *   目标页就是位运算，判据却因为窗口取错而报错）。所以这一层只做**两条可判定的**：
 *   目标页不存在，或者目标页是**结构空页**。其余交给带引用的审查 agent。
 */
export interface PageReference {
  /** 出处页 order。 */
  fromOrder: number;
  fromTitle: string;
  /** 它写的是第几页。 */
  targetOrder: number;
  /** 引用附近的原文，给人和模型核对用。 */
  context: string;
  /** 只在 `danglingReferences` 里有值。 */
  problem?: 'missing' | 'empty';
  /** 一句话说明为什么算错。 */
  problemText?: string;
}

/**
 * 一页在**结构上**是不是空的 —— ★ **按类型判，不按字数**。
 *
 * 2026-10-08 实测：Day02 第 19 页《嵌套循环：双层 for 怎么跑》的 `canvas.elements` 是
 * **0 个**，而第 18 页正文写着「双层 for 见第 19 页」—— 学习者照指引翻过去，什么都没有。
 * 这是"找不到答案"最硬的一种。按字数判会误报（渲染型页面静态看就是 0 字，实测 20 个
 * interactive 页里有 8 页的正文只在 `<script>` 里），所以这里只看结构。
 */
export function isStructurallyEmpty(page: AuditedPage): boolean {
  const content = page.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== 'object') return true;
  switch (page.type) {
    case 'slide': {
      const canvas = content.canvas as { elements?: unknown[] } | undefined;
      return (canvas?.elements ?? []).length === 0;
    }
    case 'interactive':
      return !content.html && !content.widgetConfig;
    case 'quiz':
      return ((content.questions as unknown[] | undefined) ?? []).length === 0;
    case 'pbl':
      return !content.projectV2;
    default:
      return false;
  }
}

/** 只认「第 N 页」「（p N）」「见 pN」—— **不认 `p1`/`p2` 这种变量名**。 */
const PAGE_REFERENCE = /第\s*(\d+)\s*页|（\s*p\s*(\d+)\s*）|\(\s*p\s*(\d+)\s*\)|见\s*p\s*(\d+)/g;

/** 从一页的静态正文里抽出全部页码引用（interactive 的渲染内容看不到，见 AGENTS.md §2）。 */
export function pageReferencesOf(page: AuditedPage): PageReference[] {
  if (page.type === 'interactive') return [];
  const text = staticPageText({
    order: page.order,
    type: page.type,
    title: page.title,
    content: page.content,
  });
  const out: PageReference[] = [];
  for (const match of text.matchAll(PAGE_REFERENCE)) {
    const target = Number(match[1] ?? match[2] ?? match[3] ?? match[4]);
    if (!Number.isFinite(target) || target <= 0) continue;
    out.push({
      fromOrder: page.order,
      fromTitle: page.title,
      targetOrder: target,
      context: text.slice(Math.max(0, (match.index ?? 0) - 30), (match.index ?? 0) + match[0].length + 16).trim(),
    });
  }
  return out;
}

export interface CourseAudit {
  pages: PageLinkage[];
  /** 承接率为 0 的讲解页（独立小作文）。**第一页不算** —— 它前面本来就没东西。 */
  unattachedPages: PageLinkage[];
  /**
   * 一次引入的新块超过阈值的 **slide** 页。
   *
   * ★ 只算 slide（2026-10-07 修）：**那条 49 是在 slide 上标定的**（p50=31 / p90=52）。
   *   `pbl`（项目页）与 `interactive` 是**另一个量纲** —— 实测 `pbl` n=4 的
   *   p50 = **95**，本身就接近那条线的两倍。拿 slide 的线去量项目页，
   *   等于**把脚手架当超载**：agent 原话「PBL 页里有角色、学习目标、微任务、
   *   逐条提示这些脚手架文字，全被当成新块计数了，而它们不是新教的知识」——
   *   **它是对的**，而它差点照这个数字去拆项目页。
   */
  overloadedPages: PageLinkage[];
  /**
   * 非 slide 的页里超过同一条线的（项目页 / 交互页）。
   *
   * **不是超载** —— 它们的"新块"大半是任务说明与脚手架（`roles` / `milestones` /
   * `gains`），不是新教的知识。**报出来是为了可见**，判断权交给人。
   */
  scaffoldPages: PageLinkage[];
  /** **slide 页**的平均承接率（含项目页会把两个量纲混在一起）。 */
  averageCarryRatio: number;
  /** **slide 页** novel 的中位数 —— 跟阈值一起看才知道这门课整体紧不紧。 */
  medianNovel: number;
  /**
   * **结构上空的页**（按类型判，见 `isStructurallyEmpty`）。
   *
   * 这一类**不需要模型就能下结论**：它没有内容，不是"讲得浅"。修法只有「补」。
   */
  emptyPages: AuditedPage[];
  /** 正文里**全部**写死的页码引用（不判内容，只列出来）。 */
  pageReferences: PageReference[];
  /** 其中**可判定的错**：目标页不存在，或目标页是结构空页。 */
  danglingReferences: PageReference[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
}

/**
 * 审计一门课。
 *
 * `pages` 必须是**全部页面**（讲解页也要）—— 与 `findCourseCoverageGaps` 同一个陷阱：
 * 只给自检页会让"前面建立过什么"变成空的。
 */
export function auditCourse(
  pages: readonly AuditedPage[],
  options: { novelThreshold?: number } = {},
): CourseAudit {
  const novelThreshold = options.novelThreshold ?? NOVEL_P90;
  const ordered = [...pages].sort((left, right) => left.order - right.order);

  const pageChunks = new Map<string, string[]>();
  for (const page of ordered) {
    const text = extractTaughtText(page.content);
    pageChunks.set(page.sceneId, [...new Set(contentChunks(text))]);
  }

  const seenBefore = new Set<string>();
  const linkages: PageLinkage[] = [];

  for (const page of ordered) {
    const chunks = pageChunks.get(page.sceneId) ?? [];
    const novel = chunks.filter((chunk) => !seenBefore.has(chunk));
    const carried = chunks.filter((chunk) => seenBefore.has(chunk));

    linkages.push({
      stageId: page.stageId,
      sceneId: page.sceneId,
      order: page.order,
      title: page.title,
      type: page.type,
      novel: novel.length,
      carried: carried.length,
      terms: chunks.length,
      carryRatio: chunks.length === 0 ? 0 : carried.length / chunks.length,
    });

    for (const chunk of chunks) seenBefore.add(chunk);
  }

  // ★ 只对**讲解页**下判断：
  //   · 自检页天然不复用讲解页的措辞（T2 已经在校准过的覆盖缺口里管这件事）；
  //   · **第一页必然是 0% 承接**（前面本来就没东西）—— 第一版把它当成"孤岛"报出来，
  //     是我自己的 bug。所以跳过前面还没有任何内容的第一页。
  const teaching = linkages.filter((page) => page.type !== 'quiz' && page.terms > 0);
  /**
   * ★ **判断超载只看 slide**（2026-10-07 修）。
   * 那条线（`NOVEL_P90 = 49`）是在 slide 上标定的；`pbl` / `interactive` 是另一个量纲
   * （实测 `pbl` p50 = 95，`interactive` p50 = 11）。混在一起量，项目页**永远"超载"**，
   * 于是 agent 会去拆一个结构上本来就该由多段任务组成的页面。
   */
  const graded = teaching.filter((page) => page.type === 'slide');
  const firstTeachingOrder = teaching[0]?.order;

  const unattachedPages = teaching.filter(
    (page) => page.carried === 0 && page.order !== firstTeachingOrder,
  );
  const overloadedPages = graded.filter((page) => page.novel > novelThreshold);
  const scaffoldPages = teaching.filter(
    (page) => page.type !== 'slide' && page.novel > novelThreshold,
  );

  const averageCarryRatio =
    graded.length === 0
      ? 0
      : graded.reduce((sum, page) => sum + page.carryRatio, 0) / graded.length;

  // 结构空页与页码引用：两条都不花模型，也不需要阈值。
  const byOrder = new Map(pages.map((page) => [page.order, page]));
  const emptyPages = pages.filter(isStructurallyEmpty);
  const pageReferences = pages.flatMap((page) => pageReferencesOf(page));
  const danglingReferences = pageReferences.flatMap<PageReference>((reference) => {
    if (!byOrder.has(reference.targetOrder)) {
      return [
        { ...reference, problem: 'missing' as const, problemText: `第 ${reference.targetOrder} 页不存在（这门课只有 ${pages.length} 页）` },
      ];
    }
    if (isStructurallyEmpty(byOrder.get(reference.targetOrder)!)) {
      return [
        { ...reference, problem: 'empty' as const, problemText: `第 ${reference.targetOrder} 页是空的（没有任何内容）` },
      ];
    }
    return [];
  });

  return {
    pages: linkages,
    unattachedPages,
    overloadedPages,
    scaffoldPages,
    averageCarryRatio,
    medianNovel: median(graded.map((page) => page.novel)),
    emptyPages,
    pageReferences,
    danglingReferences,
  };
}

/** 渲染成一段给 agent / 人看的报告。 */
export function formatCourseAudit(
  audit: CourseAudit,
  options: { maxItems?: number; novelThreshold?: number; acceptedPages?: ReadonlySet<number> } = {},
): string {
  const maxItems = options.maxItems ?? 8;
  const accepted = options.acceptedPages ?? new Set<number>();
  const threshold = options.novelThreshold ?? NOVEL_P90;
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const list = (pages: PageLinkage[]): string =>
    pages
      .slice(0, maxItems)
      .map((page) => `第 ${page.order} 页《${page.title}》`)
      .join('、') + (pages.length > maxItems ? ' …' : '');

  const lines = [
    `课程审计：${audit.pages.length} 页，**slide 页**平均承接率 **${pct(audit.averageCarryRatio)}**` +
      `（这一页用的词里有多少是前面建立过的），slide 页引入新块的中位数 ${audit.medianNovel}。`,
  ];

  // ★ 已接受的超载页单独说 —— 否则它每次审计都再报一次，而"拆页"有时不可用（用户已明确
  //   不再插页）、有时不该用（读数是"要照抄的字符串"而不是"要学的知识"）。凭据落盘，
  //   见 `plan-freeze-store.ts` 的 `AcceptedReadings`。
  const acceptedOverload = audit.overloadedPages.filter((page) => accepted.has(page.order));
  const pendingOverload = audit.overloadedPages.filter((page) => !accepted.has(page.order));
  if (acceptedOverload.length > 0) {
    lines.push(
      `· ${acceptedOverload.length} 页超载**你已经接受过**（第 ` +
        acceptedOverload.map((page) => page.order).join('、') +
        ' 页）—— 不再列进待修。要重新评估就把凭据删掉。',
    );
  }
  audit = { ...audit, overloadedPages: pendingOverload };

  if (audit.overloadedPages.length) {
    lines.push(
      `· **${audit.overloadedPages.length} 页一次性引入的新块超过 ${threshold}** —— ★ **这是新颖度，` +
        '不是「讲太多」**（一页把 5 种循环讲清楚，本来就会引入很多新块）。它是**提示**：' +
        '要处理就**拆页**，或者用 `course_audit { accept }` 记成「已知、暂不修」。' +
        '这条线只在 slide 上标定过：' +
        audit.overloadedPages
          .slice(0, maxItems)
          .map((page) => `第 ${page.order} 页《${page.title}》(${page.novel})`)
          .join('、') +
        (audit.overloadedPages.length > maxItems ? ' …' : ''),
    );
  }
  if (audit.scaffoldPages.length) {
    lines.push(
      `· （另有 **${audit.scaffoldPages.length} 页项目/交互页**也超过同一条线：` +
        audit.scaffoldPages
          .slice(0, maxItems)
          .map((page) => `第 ${page.order} 页《${page.title}》(${page.novel})`)
          .join('、') +
        ' —— 这些页的"新块"大半是**任务说明与脚手架**（角色 / 学习目标 / 微任务 / 逐条提示），' +
        '不是新教的知识。**它们不是超载，别照着这个数字拆。**）',
    );
  }

  // ★ 结构空页与"引用指向空页"：**不需要模型就能下结论**，所以排在超载之前 ——
  //   它们不是"讲得浅"，是"这一页没有内容"。
  if (audit.emptyPages.length) {
    lines.push(
      `· ★ **${audit.emptyPages.length} 页是空的**（没有任何内容，不是"讲得浅"）：` +
        audit.emptyPages
          .slice(0, maxItems)
          .map((page) => `第 ${page.order} 页《${page.title}》`)
          .join('、') +
        (audit.emptyPages.length > maxItems ? ' …' : ''),
    );
  }

  if (audit.danglingReferences.length) {
    lines.push(
      `· ★ **${audit.danglingReferences.length} 处页码引用指向不存在或空的页**：` +
        audit.danglingReferences
          .slice(0, maxItems)
          .map((reference) => `第 ${reference.fromOrder} 页 → 第 ${reference.targetOrder} 页（${reference.problemText}）`)
          .join('、') +
        (audit.danglingReferences.length > maxItems ? ' …' : ''),
    );
  }

  // 全部引用都列出来（一行一条，供逐条核对）—— **这一项不做内容判定**，见 PageReference 的注释。
  if (audit.pageReferences.length) {
    lines.push(
      `· 正文里有 **${audit.pageReferences.length} 处写死的页码引用**（插页/拆页会让它们失效；` +
        `这里只列出来，内容对不对要逐条看）：` +
        audit.pageReferences
          .slice(0, maxItems)
          .map((reference) => `第 ${reference.fromOrder} 页 → 第 ${reference.targetOrder} 页`)
          .join('、') +
        (audit.pageReferences.length > maxItems ? ' …' : ''),
    );
  }

  if (audit.unattachedPages.length) {
    lines.push(
      `· **${audit.unattachedPages.length} 页跟前面没有词面承接**（承接率 0）：` +
        list(audit.unattachedPages),
    );
  }

  if (lines.length === 1) lines.push('· 没发现异常。');
  lines.push(
    '',
    '修法只允许「补 / 挪 / 拆 / 改写」：超载就**拆成 2–3 页**（不要砍概念）、' +
      '没有承接就**补一句回指前面的页**。**不要删页、不要合并页。**',
  );
  return lines.join('\n');
}
