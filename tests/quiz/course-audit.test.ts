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
