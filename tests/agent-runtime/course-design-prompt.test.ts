/**
 * 课程设计质量规则。
 *
 * 这段是**提示词审计建议的应用层版本** —— 审计发现的"单薄"和"概括"根因在
 * SDK 层（`slide-content` 的 20 词上限、`requirements-to-outlines` 的 3-5 点、
 * `scene-generator` 只传自己）。SDK 是只读的，所以把那些**要求**翻译成 agent
 * 能执行的规则，由它写进每次 generate_scene 的 brief。
 *
 * 钉住四件事，它们各自对应审计里的一条：
 *   1. 知识点必须**至少展开两层**（否则就是"点了名没讲"）
 *   2. 页与页必须**互相承接**（否则就是一堆孤岛）
 *   3. 术语首次出现中英对照，之后只用中文（**只有 agent 知道哪次是首次**）
 *   4. 禁止只有现场老师才说的话（"让我们一起看看"这类）
 */
import { describe, expect, it } from 'vitest';

import { courseDesignPromptBlock } from '@/lib/server/agent-runtime/course-design';
import { PAGE_DENSITY_TARGET } from '@/lib/server/agent-runtime/study-mode';

describe('courseDesignPromptBlock', () => {
  const block = courseDesignPromptBlock({ hasMaterials: true, hasCourseLibrary: true });

  it('demands at least two layers per knowledge point', () => {
    expect(block).toContain('### Decompose each knowledge point');
    expect(block).toMatch(/at least \*\*two layers\*\*/);
    expect(block).toMatch(/What it is/);
    expect(block).toMatch(/How it behaves, or why it matters/);
  });

  it('demands cross-page continuity', () => {
    expect(block).toContain('### Pages must acknowledge each other');
    // 反面例子：每页从零重讲 = 一堆孤岛。
    expect(block).toMatch(/not a pile of independent pages/);
  });

  it('states the density target and that volume means more pages', () => {
    expect(block).toContain(PAGE_DENSITY_TARGET);
    expect(block).toMatch(/more pages, not more words per page/);
  });

  it('handles first-occurrence terms and says only the agent can know', () => {
    expect(block).toContain('### Terms');
    expect(block).toMatch(/English original/);
    expect(block).toMatch(/you\*\* are the only thing that knows this is the first/);
  });

  it('bans live-teacher filler', () => {
    expect(block).toMatch(/让我们一起看看/);
    expect(block).toMatch(/no "同学们"/i);
  });

  it('requires PBL projects to be modelled on a real repository, without naming tools', () => {
    // 用户明确要求：「PBL 用成熟的开源项目」。
    expect(block).toContain('### PBL: model the project on something that already exists');
    // **不点名具体工具**：工具是能力门控的（MCP 没配就没有 github 工具，web search
    // 没配就没有 web_search），提示词里出现一个用不了的工具名比不提更糟 ——
    // runner-web-search-registration.test.ts 有断言守着这条。
    expect(block).not.toContain('mcp__github');
    expect(block).not.toContain('web_search');
    expect(block).toMatch(/never name\s+a tool that is not in your tool list/);
    // 必须读过再建模，不能凭印象编。
    expect(block).toMatch(/Read its structure before modelling/);
    // 借了什么、补了什么要说出来。
    expect(block).toMatch(/Say what you borrowed and what you added/);
    // 域内容用本地材料，GitHub 只给"形态"。
    expect(block).toMatch(/shape\* of the work/);
    // 搜不到就说，别假装看过。
    expect(block).toMatch(/Never claim a reference you did not read/);
  });

  it('says these belong in the brief, because the generator sees nothing else', () => {
    expect(block).toMatch(/sees \*\*only the brief you write\*\*/);
  });
});

/**
 * ★ 能力条件：只点名**真的注册了**的能力（§1.1）。
 *
 * 这一组是实测逼出来的：整份装配提示词的幽灵名判据第一次跑就抓到本块 ——
 * 它**无条件注入**，却点名了材料库与 `course_search`/`read_document`
 * 这两个**条件注册**的能力。
 */
describe('courseDesignPromptBlock 的能力条件', () => {
  it('names the local capabilities when they are registered', () => {
    const block = courseDesignPromptBlock({ hasMaterials: true, hasCourseLibrary: true });
    expect(block).toContain('materials library');
    expect(block).toContain('course_search');
    expect(block).toContain('read_document');
  });

  it('★ names neither when neither is registered', () => {
    const block = courseDesignPromptBlock({ hasMaterials: false, hasCourseLibrary: false });
    expect(block).not.toContain('course_search');
    expect(block).not.toContain('read_document');
    expect(block).not.toContain('materials library');
    // 但它还得说清"用自己手上的本地材料"，不能因为去掉工具名就整段消失。
    expect(block).toContain('local material');
  });

  it('names only the one that is registered', () => {
    const onlyLibrary = courseDesignPromptBlock({ hasMaterials: false, hasCourseLibrary: true });
    expect(onlyLibrary).toContain('course_search');
    expect(onlyLibrary).not.toContain('materials library');

    const onlyMaterials = courseDesignPromptBlock({ hasMaterials: true, hasCourseLibrary: false });
    expect(onlyMaterials).toContain('materials library');
    expect(onlyMaterials).not.toContain('course_search');
  });
});

/**
 * ★★ 讲练节奏（2026-10-09，学习者第 3 轮吐槽）。
 *
 * 他的原话：「**练习页的难度真的很离谱**」「**很多小点他都没讲细，只是浅浅的过**」
 * 「每个小点他都可以拆出来」「练习要循序渐进，先给简单的练熟了，然后再给复杂的」
 * 「页数不是问题」。
 *
 * 量出来的根因**不是难度，是粒度**：Day02 的练习页**一页塞 3~4 个任务**，
 * 自检页一页 8~10 题；而 P19 一页横跨三档（补一个 `if` → `if/else if` 链 → 闰年），
 * 偏偏**讲解页 P18 把闰年那句原样写了出来** —— 于是"练"成了"抄"。
 *
 * 这组判据钉四条：**一页一个小点**、**代码讲三件事（结构/执行顺序/怎么写）**、
 * **讲解不许泄练习答案**、**练习一页一个任务且由易到难**。
 */
describe('★ 讲练节奏：一页一个小点 · 练习=同一小点的一组题（由易到难）· 讲解不泄答案', () => {
  const block = courseDesignPromptBlock({ hasMaterials: true, hasCourseLibrary: true });

  it('★ 一页一个小点，而且**不许**再拿"太薄"当合并的理由', () => {
    expect(block).toMatch(/One small point per page/);
    // 反面：原来那句「太薄就该合并到邻页」是反的，必须消失。
    expect(block).not.toMatch(/belongs merged with a neighbour/);
    // 正解是"配一道练习"或"并进单元"，以及"加页"。
    expect(block).toMatch(/pair it with[\s\S]{0,40}its own practice page/);
  });

  it('★ 代码要讲三件事：结构 / 执行顺序 / 怎么写', () => {
    expect(block).toMatch(/Its structure/);
    expect(block).toMatch(/The order it runs in/);
    expect(block).toMatch(/How to write it/);
    // 「抄这几行不算教」—— 学习者要能**写出来**，不是**抄回来**。
    expect(block).toMatch(/produce it, not reproduce it/);
  });

  it('★★ 讲解页不许给出练习的答案（P18 泄闰年答案就是这条缺了）', () => {
    expect(block).toMatch(/must not give away the practice/);
    expect(block).toMatch(/teaches the \*shape\* of the solution/);
  });

  it('★ 练习 = **同一小点的一组题**（多题组合），页数不是约束', () => {
    expect(block).toContain('### Practice: one small point');
    expect(block).toMatch(/a set of questions about one small point/);
    expect(block).toMatch(/One small point per page/);
    expect(block).toMatch(/Page count is not a constraint/);
    // 一组题可以跨页 —— 不是"一页一题"。
    expect(block).toMatch(/continue it on the next\s+page/);
  });

  it('★ 不许太简单，而且**一页不许混别的小点**（P19 就是三个小点挤一页）', () => {
    expect(block).toMatch(/Not too easy/);
    expect(block).toMatch(/without having read the page measures nothing/);
    expect(block).toMatch(/Questions about \*different\* points must not/);
  });

  it('★ 形态可以在**一组之内混用**（这才是"循序渐进的多题组合"）', () => {
    expect(block).toMatch(/Mix the two forms inside one set/);
    expect(block).toMatch(/Both are about \*\*the same small point\*\*/);
  });

  it('★ 两个形态：**改错 → 写作**（顺序本身是要求）', () => {
    expect(block).toMatch(/\*\*Fix the bug\*\*/);
    expect(block).toMatch(/\*\*Write it\*\*/);
    const fix = block.indexOf('**Fix the bug**');
    const write = block.indexOf('**Write it**');
    expect(fix).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(fix);
  });

  it('★★ **选择不是默认**（学习者第 3 轮：「主要先是改错和写作，选择不太适合」）', () => {
    expect(block).toMatch(/Choice questions are the exception, not the default/);
    expect(block).toMatch(/picking an option is not the skill being built/);
    // 只许在"没有可写形态"的点上用。
    expect(block).toMatch(/no\s+writable form at all/);
  });

  it('★★ 练习数量要少 —— 一个单元一改错一写作是常态，不是"越多越 thorough"', () => {
    expect(block).toMatch(/Few exercises, each worth doing/);
    expect(block).toMatch(/padding, and it buries the one task/);
  });
});
