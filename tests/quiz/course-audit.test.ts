import { describe, expect, it } from 'vitest';

import { auditCourse, formatCourseAudit, NOVEL_P90, type AuditedPage } from '@/lib/quiz/course-audit';

/**
 * ★ 超载线**只对 slide 有效** —— 项目页不该被判超载（2026-10-07 修）。
 *
 * ── 由来：agent 的一句话，而且它是对的 ──────────────────────────
 * 「项目页那 139 / 226 / 78 有一半是度量口径：PBL 页里有角色、学习目标、微任务、
 *   逐条提示这些脚手架文字，全被当成『新块』计数了，可它们不是『新教的知识』。
 *   所以我不建议照着这个数字继续拆项目页——那是把脚手架当成超载。」
 *
 * 实测分布（本机全库）：
 *     slide        n=90   p50=31  p90=52
 *     interactive  n=45   p50=11  p90=22
 *     pbl          n=4    p50=95  p90=208   ← 中位数就是那条线的两倍
 *
 * ⇒ 拿 slide 的线去量项目页，项目页**永远"超载"**。修法：
 *   `overloadedPages` 只算 slide；非 slide 里越线的进 `scaffoldPages`（**仍然报出来**，
 *   但标明量纲不同、别照着拆），统计口径（承接率 / 中位数）也只看 slide。
 *
 * ★ 这个模块此前**没有单元测试**（只有默认跳过的 live 一条）—— 所以这次改动
 *   一条判据都不会红。**没有判据的地方，改动就是静默的。**
 */

/** 60 个互不相同的三字术语 —— 实测 novel=56（> 49）。 */
function heavyBody(seed = 0): string {
  // ★ 必须能与别的重页**区分开**：两页用同一份正文时，第二页的新块早就被第一页引入过
  //   ⇒ novel≈0 ⇒ 它压根不越线（我第一版夹具就是这么错的，判据当场红）。
  return Array.from(
    { length: 60 },
    (_, i) => `术语${String.fromCharCode(0x4e00 + (i + seed * 100) % 0x5000)}码`,
  ).join('，');
}

function page(order: number, type: string, body: string): AuditedPage {
  return {
    stageId: 's',
    sceneId: `scene-${order}`,
    order,
    title: `第 ${order} 页`,
    type,
    content: { type, canvas: { elements: [{ type: 'text', content: `<p>${body}</p>` }] } },
  };
}

describe('★ 超载线只对 slide 有效', () => {
  it('★ 项目页（pbl）越线 ⇒ 不算超载，但**仍然报出来**（scaffoldPages）', () => {
    const audit = auditCourse([page(1, 'slide', '短'), page(2, 'pbl', heavyBody())]);

    expect(audit.overloadedPages).toHaveLength(0);
    expect(audit.scaffoldPages).toHaveLength(1);
    expect(audit.scaffoldPages[0]?.order).toBe(2);
    // 而它确实越了线 —— 不是因为我们把它藏了。
    expect(audit.scaffoldPages[0]?.novel).toBeGreaterThan(NOVEL_P90);
  });

  it('★ 对照：slide 越线 ⇒ 照旧算超载（别把该报的也放过去）', () => {
    const audit = auditCourse([page(1, 'slide', '短'), page(2, 'slide', heavyBody())]);

    expect(audit.overloadedPages.map((p) => p.order)).toEqual([2]);
    expect(audit.scaffoldPages).toHaveLength(0);
  });

  it('★ 统计口径也只看 slide：项目页的巨大 novel 不许污染中位数', () => {
    const withPbl = auditCourse([page(1, 'slide', '短'), page(2, 'pbl', heavyBody())]);
    const without = auditCourse([page(1, 'slide', '短')]);

    expect(withPbl.medianNovel).toBe(without.medianNovel);
  });

  it('报告里把两类分开说，并且明说"别照着拆"', () => {
    const audit = auditCourse([
      page(1, 'slide', '短'),
      page(2, 'slide', heavyBody()),
      page(3, 'pbl', heavyBody(9)),
    ]);
    const text = formatCourseAudit(audit);

    expect(text).toContain('1 页超载');
    expect(text).toContain('项目/交互页');
    expect(text).toContain('不是超载，别照着这个数字拆');
    // 统计口径要标明是 slide —— 否则读的人会以为这是全课的数。
    expect(text).toContain('slide 页');
  });
});

/**
 * ★ 机械层：**结构空页** 与 **页码引用**（2026-10-08 新增）。
 *
 * 由来：Day02 第 19 页《嵌套循环：双层 for 怎么跑》的 `canvas.elements` 是 **0 个**，
 * 而第 18 页正文写着「双层 for 见第 19 页」—— 学习者照指引翻过去，什么都没有。
 * 这是"找不到答案"最硬的一种，而且**不需要模型**就能下结论。
 *
 * ★ 两条判据的边界都是量出来的，不是拍的：
 * · 空页**按类型判结构，不按字数** —— 实测 20 个 interactive 页里有 8 页的正文只在
 *   `<script>` 里，静态看就是 0 字，按字数判会一次误报 8 页；
 * · 页码引用**只认「第 N 页」「（p N）」「见 pN」** —— 我第一版正则 `p(\d+)` 把
 *   `p1 = new Person()`、`p2.sayHi()` 里的 `p1`/`p2` 全当成页码，一次报出 14 条假引用。
 */
describe('★ 机械层：结构空页与页码引用', () => {
  const slideWith = (order: number, body: string): AuditedPage => ({
    stageId: 's',
    sceneId: `scene-${order}`,
    order,
    title: `第 ${order} 页`,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [{ type: 'text', content: body }] } },
  });
  const emptySlide = (order: number): AuditedPage => ({
    stageId: 's',
    sceneId: `scene-${order}`,
    order,
    title: '嵌套循环：双层 for 怎么跑',
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [] } },
  });

  it('★ 0 个元素的 slide ⇒ emptyPages（这就是 2026-10-08 实测的第 19 页）', () => {
    const audit = auditCourse([slideWith(1, '有正文'), emptySlide(2)]);
    expect(audit.emptyPages.map((page) => page.order)).toEqual([2]);
    expect(formatCourseAudit(audit)).toContain('1 页是空的');
  });

  it('★ 对照：正文只在 <script> 里的 interactive 页**不算**空页（别按字数判）', () => {
    // 静态看它是 0 字（正文由 init() 建出来），但结构上它有 html。
    const interactive: AuditedPage = {
      stageId: 's',
      sceneId: 'scene-2',
      order: 2,
      title: '动手：写正负判断',
      type: 'interactive',
      content: { type: 'interactive', html: '<!DOCTYPE html><html><body><div id="r"></div><script>init()</script></body></html>' },
    };
    const audit = auditCourse([slideWith(1, '有正文'), interactive]);
    expect(audit.emptyPages).toEqual([]);
  });

  it('★ 引用指向空页 ⇒ danglingReferences（problem = empty）', () => {
    const audit = auditCourse([slideWith(1, '双层 for 见第 2 页'), emptySlide(2)]);
    expect(audit.danglingReferences).toHaveLength(1);
    expect(audit.danglingReferences[0]).toMatchObject({ fromOrder: 1, targetOrder: 2, problem: 'empty' });
    expect(formatCourseAudit(audit)).toContain('指向不存在或空的页');
  });

  it('★ 引用越界 ⇒ problem = missing', () => {
    const audit = auditCourse([slideWith(1, '回看第 99 页的 else if 链')]);
    expect(audit.danglingReferences[0]).toMatchObject({ targetOrder: 99, problem: 'missing' });
  });

  it('★ 不把 p1 / p2 这种变量名当页码（第一版正则一次误报 14 条）', () => {
    const audit = auditCourse([
      slideWith(1, 'Person p1 = new Person(); p1.sayHi(); p2.name = "张三";'),
      slideWith(2, '正常一页'),
    ]);
    expect(audit.pageReferences).toEqual([]);
  });

  it('★ 三类写法都认：第 N 页 / （p N） / 见 pN', () => {
    const audit = auditCourse([
      slideWith(1, '第 2 页讲了 / （p3）也讲了 / 见 p3'),
      slideWith(2, 'x'),
      slideWith(3, 'y'),
    ]);
    expect(audit.pageReferences.map((reference) => reference.targetOrder)).toEqual([2, 3, 3]);
    expect(audit.danglingReferences).toEqual([]);
  });

  it('★ 引用总清单与"可判定的错"分开报 —— 前者不做内容判定', () => {
    const audit = auditCourse([slideWith(1, '见第 2 页'), slideWith(2, '内容不对也可能，但这一层不管')]);
    expect(audit.pageReferences).toHaveLength(1);
    expect(audit.danglingReferences).toEqual([]);
    expect(formatCourseAudit(audit)).toContain('处写死的页码引用');
  });
});

/**
 * ★ 「已接受的读数」—— 无状态审计的唯一解药（2026-10-08）。
 *
 * 由来：agent 报「就地改写压不下超载读数（第 4 页 58→59、第 8 页 62→63、第 9 页 53→57、
 * 第 20 页 51→52）」，而我把那四页翻出来核过：第 8/9 页被数进去的**大半是菜单路径与 pom 键**
 * （`File → Settings → Editor → File Encodings`、`modelVersion/groupId/artifactId`）——
 * 那是"要照抄的字符串"，不是"要学的知识"（与 PBL 脚手架那条同源）；第 20 页被数进去的是
 * **真概念**（一页 5 种循环）。
 *
 * 两种情况的处置不同（一个不该拆、一个该拆但用户已明确不再插页），但**共同点是：
 * 结论必须能被机器记住**。否则 `course_audit` 无状态，每个新窗口都会为同一批页再吵一次，
 * 或者有人为了消掉一条读数去动页面 —— 那才是真损失。
 */
describe('★ 已接受的读数：不再重复报成待修', () => {
  const heavy = (order: number, type = 'slide'): AuditedPage => ({
    stageId: 's',
    sceneId: `scene-${order}`,
    order,
    title: `第 ${order} 页`,
    type,
    content: { type, canvas: { elements: [{ type: 'text', content: heavyBody(order) }] } },
  });

  it('★ 全部超线页都已接受 ⇒ 只报「你已经接受过」，不出现待修', () => {
    const audit = auditCourse([page(1, 'slide', '短'), heavy(2)]);
    expect(audit.overloadedPages.map((item) => item.order)).toEqual([2]);
    const text = formatCourseAudit(audit, { acceptedPages: new Set([2]) });
    expect(text).toContain('你已经接受过');
    expect(text).not.toContain('一次引入超过');
  });

  it('★ 混合 ⇒ 待修只列没接受的，已接受单独提一句', () => {
    const audit = auditCourse([page(1, 'slide', '短'), heavy(2), heavy(3)]);
    expect(audit.overloadedPages.map((item) => item.order)).toEqual([2, 3]);
    const text = formatCourseAudit(audit, { acceptedPages: new Set([2]) });
    expect(text).toContain('你已经接受过');
    expect(text).toContain('第 3 页');
    const overloadLine = text.split('\n').find((line) => line.includes('承接过载')) ?? '';
    expect(overloadLine).not.toContain('第 2 页');
  });

  it('★ 没有凭据 ⇒ 一行不少地照报（别把闸放成空的）', () => {
    const audit = auditCourse([page(1, 'slide', '短'), heavy(2)]).overloadedPages;
    const text = formatCourseAudit(auditCourse([page(1, 'slide', '短'), heavy(2)]));
    expect(text).toContain('一次引入超过');
    expect(text).not.toContain('你已经接受过');
    expect(audit.length).toBe(1);
  });
});
