/**
 * ★ 密度规则：**语义完整 > 句子完整 > 字数**（2026-10-08，用户诊断逼出来的）。
 *
 * 由来：那条「每页 350–400 字」被当成**硬阀门**用，代价是**砍主谓宾** ——
 * 「为真，走 if」写成「为真走 if」、「两个 boolean，不短路」写成「两个 boolean 不短路」，
 * 第 17 页甚至截断到**表意变了**。用户的原话：「这条规则应当让位：语义完整 > 句子完整 > 字数。
 * 讲不透的地方就加页或改写，不缩句。」
 *
 * 这组判据钉的就是"规则的**优先级**别被下一步的措辞读软"——数字可以留着（它是容量实测），
 * 但必须同时带着"它不是配额、不是上限、超了可以、截断到改意思不行"。
 */
import { describe, expect, it } from 'vitest';

import { CONTENT_PRIORITY, studyModePromptBlock } from '@/lib/server/agent-runtime/study-mode';
import { COURSE_REVIEW_RULES } from '@/lib/server/agent-runtime/review-tools';
import { SELF_STUDY_SLIDE_OVERRIDE } from '@/lib/server/self-study-mode';

/** 见 AGENTS.md：密度规则一度被当硬阀门用，代价是砍主谓宾（2026-10-08）。 */
describe('★ 内容与页面的六条优先级（用户定序，一处定义三处引用）', () => {
  it('★ 六条按序：内容 > 语义完整准确 > 语言合适 > 结构完整 > 不用人猜 > 画面布局', () => {
    const order = ['Substance first', 'Meaning complete and accurate', 'Language that fits',
      'Structure complete', 'Nothing left to guess', 'Layout that holds'];
    let last = -1;
    for (const marker of order) {
      const at = CONTENT_PRIORITY.indexOf(marker);
      expect(at, marker).toBeGreaterThan(last);
      last = at;
    }
    // 具体反例必须留着（抽象措辞生成器读不进去）
    expect(CONTENT_PRIORITY).toContain('「为真，走 if」 is correct; 「为真走 if」 is not');
    expect(CONTENT_PRIORITY).toMatch(/truncated until its meaning changes is worse/);
    // ★ 第 5 条必须**拆成两类**：新概念（有机械替代）与表达不清（只能靠模型）。
    //   用户原话：「不用人猜有两种：新概念和表达不清」—— 混成一条会让收紧做错方向
    //   （把"表达不清"也当成可以机械算的）。
    expect(CONTENT_PRIORITY).toContain('5a.');
    expect(CONTENT_PRIORITY).toContain('5b.');
    expect(CONTENT_PRIORITY).toMatch(/5a[\s\S]*HAS a mechanical substitute/);
    expect(CONTENT_PRIORITY).toMatch(/5b[\s\S]*NO mechanical check can find this one/);
    // 表达不清必须"引用那句话"，否则读者无从核对
    expect(CONTENT_PRIORITY).toMatch(/Quote the sentence that fails/);

    // 字数属于第 6 条的地界，不是第 1 条
    expect(CONTENT_PRIORITY).toMatch(/CAPACITY/);
    expect(CONTENT_PRIORITY).toMatch(/add a page or rewrite/);
  });

  it('★ 六个轴要真的进审查规矩（不是躺在生成侧常量里）', () => {
    expect(COURSE_REVIEW_RULES).toContain(CONTENT_PRIORITY);
    // 两个字面上的病灶要在审查规矩里点名
    expect(COURSE_REVIEW_RULES).toMatch(/「为真，走 if」 became 「为真走 if」/);
    expect(COURSE_REVIEW_RULES).toMatch(/Layout that does not hold/);
    // 索引式引用：禁写页码、按《标题》，并要核"标题是否唯一命中"
    expect(COURSE_REVIEW_RULES).toMatch(/by 《title》/);
    expect(COURSE_REVIEW_RULES).toMatch(/match exactly one page/);
  });

  it('★ 生成侧（工作台）与审查侧引用的是同一份顺序', () => {
    expect(studyModePromptBlock()).toContain(CONTENT_PRIORITY);
  });

  it('★ 经典自学覆盖也带同一条顺序（两条路不许只有一条改对）', () => {
    expect(SELF_STUDY_SLIDE_OVERRIDE).toMatch(/substance > complete and accurate meaning/);
    expect(SELF_STUDY_SLIDE_OVERRIDE).toMatch(/character count is LAST/);
  });
});
