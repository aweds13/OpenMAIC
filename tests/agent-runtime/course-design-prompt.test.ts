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
