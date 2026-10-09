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
import { courseDesignPromptBlock } from '@/lib/server/agent-runtime/course-design';
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
    expect(CONTENT_PRIORITY).toMatch(/HAS a mechanical substitute/);
    // ★ 表达不清**不是独立的轴**，是症状 —— 必须归因到 1–4 里的一条，修法只许走那一条
    //   （用户原话：「表达不清要符合内容优先，语义完整准确优先，语言合适，结构完整来解决」）
    expect(CONTENT_PRIORITY).toMatch(/is NOT a separate axis/);
    expect(CONTENT_PRIORITY).toMatch(/name which of items 1–4 fails/);
    // 四条修法路径都要在（少一条就会有人只去"把句子改通顺"）
    expect(CONTENT_PRIORITY).toMatch(/the content is not there → add it \(1\)/);
    expect(CONTENT_PRIORITY).toMatch(/say what it must still say \(2\)/);
    expect(CONTENT_PRIORITY).toMatch(/rewrite the wording \(3\)/);
    expect(CONTENT_PRIORITY).toMatch(/complete the structure \(4\)/);
    // 而且明说"只报 unclear 没用"
    expect(CONTENT_PRIORITY).toMatch(/not actionable/);

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

/**
 * ★ 带代码的页：**生成侧与审查侧都要有**（用户：「先做A呗。生成册和审查册都要有」）。
 *
 * 一句话的规矩：代码用 `code` 元素写；并且**三件事是一起要求的** ——
 * ① 它的**结构**（由哪几块构成、怎么嵌套）② 它按什么顺序执行 ③ **怎么写**（标准/惯用写法
 * 长什么样、怎么从空文件搭出来，与页面这段差在哪）。
 * 少一件都不算完；页面里没有代码就一个字别扯这个。
 *
 * ★ 2026-10-09 从"两件"改成"三件"：学习者第 3 轮吐槽「很多东西他没有真的讲清楚那个代码的
 *   **结构**，执行逻辑，也没有讲清楚**怎么写**」。改的是定义本身，所以**两侧一起改** ——
 *   这一组判据（生成侧 + 审查侧）就是防它们漂的那道闸。
 */
describe('★ 带代码的页：两侧都有这条要求', () => {
  it('★ 生成侧 brief 清单里有', () => {
    const block = courseDesignPromptBlock({ courseSearch: false, mcp: false } as never);
    expect(block).toMatch(/`code` element/);
    expect(block).toMatch(/Its structure/);
    expect(block).toMatch(/order it runs in/);
    expect(block).toMatch(/How to write it/);
    // 三件事**一起**要求，别拆成可选
    expect(block).toContain('they are one');
    // ★ 两批，不一刀切（生成侧也要有）
    expect(block).toMatch(/Two batches, not all-or-nothing/);
  });

  it('★ 审查侧规矩里有，并且明说"没代码就别提"', () => {
    expect(COURSE_REVIEW_RULES).toMatch(/A page that carries code/);
    expect(COURSE_REVIEW_RULES).toMatch(/its structure/);
    expect(COURSE_REVIEW_RULES).toMatch(/the order it runs in/);
    expect(COURSE_REVIEW_RULES).toMatch(/how to write it/);
    expect(COURSE_REVIEW_RULES).toMatch(/carries no code, say nothing about this/);
    // ★ 两批，不一刀切：多行进 code 元素；**单行片段留在正文里是对的，不许报成问题**
    expect(COURSE_REVIEW_RULES).toMatch(/Two batches/);
    expect(COURSE_REVIEW_RULES).toMatch(/\*\*one-line\*\*/);
    expect(COURSE_REVIEW_RULES).toMatch(/staying inline in the prose is correct/);
  });

  it('★ 审查侧也有**练习**那条（一页混小点 / 太简单 / 跳步）——两侧一起改', () => {
    expect(COURSE_REVIEW_RULES).toMatch(/A set of questions about ONE small point/);
    expect(COURSE_REVIEW_RULES).toMatch(/different\*\* points packed onto one page/);
    expect(COURSE_REVIEW_RULES).toMatch(/too easy\*\* to measure anything/);
    expect(COURSE_REVIEW_RULES).toMatch(/a jump the\s+learner cannot see/);
  });
});
