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
 *      `min=1 p50=25 p75=35 p90=49 max=242`，所以默认取 **p90 = 49**。
 *      实测最超载的三页：《学生名单管理（集合+Stream+异常+Maven）》**242**、
 *      《待办清单 App（Widget+setState+布局+路由）》**209**、
 *      Day 1《面向对象三概念》**64** —— 正是复盘里点名的那类页
 *      （「OOP 只用 1 页讲解，却要撑 5 个概念 + 3 组关系」）。
 *
 * ★ 两条都**不回滚、不删内容** —— 与 T2/T3 同一条原则：审计只让问题可见，
 *   修法是"补 / 挪 / 拆 / 改写"。
 */
import { contentChunks, extractTaughtText } from '@/lib/quiz/coverage-gap';

/** 讲解页一次引入新块的告警线 —— 146 个真实讲解页的 **p90**。 */
export const NOVEL_P90 = 49;

/** 审计看到的一页。只需内容和身份，不需要生成包的类型。 */
export interface AuditedPage {
  stageId: string;
  sceneId: string;
  order: number;
  title: string;
  type: string;
  content?: unknown;
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

export interface CourseAudit {
  pages: PageLinkage[];
  /** 承接率为 0 的讲解页（独立小作文）。**第一页不算** —— 它前面本来就没东西。 */
  unattachedPages: PageLinkage[];
  /** 一次引入的新块超过阈值的讲解页。 */
  overloadedPages: PageLinkage[];
  /** 全部讲解页的平均承接率。 */
  averageCarryRatio: number;
  /** 讲解页 novel 的中位数 —— 跟阈值一起看才知道这门课整体紧不紧。 */
  medianNovel: number;
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
  const firstTeachingOrder = teaching[0]?.order;

  const unattachedPages = teaching.filter(
    (page) => page.carried === 0 && page.order !== firstTeachingOrder,
  );
  const overloadedPages = teaching.filter((page) => page.novel > novelThreshold);

  const averageCarryRatio =
    teaching.length === 0
      ? 0
      : teaching.reduce((sum, page) => sum + page.carryRatio, 0) / teaching.length;

  return {
    pages: linkages,
    unattachedPages,
    overloadedPages,
    averageCarryRatio,
    medianNovel: median(teaching.map((page) => page.novel)),
  };
}

/** 渲染成一段给 agent / 人看的报告。 */
export function formatCourseAudit(
  audit: CourseAudit,
  options: { maxItems?: number; novelThreshold?: number } = {},
): string {
  const maxItems = options.maxItems ?? 8;
  const threshold = options.novelThreshold ?? NOVEL_P90;
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const list = (pages: PageLinkage[]): string =>
    pages
      .slice(0, maxItems)
      .map((page) => `第 ${page.order} 页《${page.title}》`)
      .join('、') + (pages.length > maxItems ? ' …' : '');

  const lines = [
    `课程审计：${audit.pages.length} 页，讲解页平均承接率 **${pct(audit.averageCarryRatio)}**` +
      `（这一页用的词里有多少是前面建立过的），讲解页引入新块的中位数 ${audit.medianNovel}。`,
  ];

  if (audit.overloadedPages.length) {
    lines.push(
      `· **${audit.overloadedPages.length} 页超载**（一次引入超过 ${threshold} 个新块，实测 p90）：` +
        audit.overloadedPages
          .slice(0, maxItems)
          .map((page) => `第 ${page.order} 页《${page.title}》(${page.novel})`)
          .join('、') +
        (audit.overloadedPages.length > maxItems ? ' …' : ''),
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
