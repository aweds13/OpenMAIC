/**
 * 技能选择提示词块。
 *
 * 钉住三条**用户明确要求**的行为，它们很容易被后来的人"优化"掉：
 *
 *   1. 清单必须**由代码算好递给模型** —— 实测（2026-10-04）让模型自己从
 *      24 个技能里挑，它只给了 4 个选项、其余一个不列。用户原话：
 *      「他不能只列一两个，因为他对最优不一定能知道」。
 *   2. 必须**并进方案确认那一轮**，不单独加一轮空等。
 *   3. 工具类技能必须**排除**，否则 24 个糊上来，真正该选的几个被淹没。
 *
 * 还有一条容易被忽略但决定成败的：generate_scene 内部是**独立的一次模型
 * 调用**，看不到 agent 读过的技能 —— 所以写作要求必须写进 brief。不写这条，
 * 技能就断在大纲层，页面还是老样子。
 */
import { describe, expect, it } from 'vitest';

import { skillChoicePromptBlock } from '@/lib/server/agent-runtime/skills';

/** 造几个技能，够验证"分类 + 清单"即可。 */
function fakeSkill(name: string, description = `${name} 的说明。第二句不该出现。`) {
  return {
    name,
    description,
    content: `# ${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    source: 'builtin' as const,
  } as never;
}

const SKILLS = [
  fakeSkill('feynman-learning'),
  fakeSkill('lecture-style'),
  fakeSkill('workshop-style'),
  fakeSkill('slide-dsl'), // 工具类，必须被排除
  fakeSkill('pro-editing'), // 工具类
];

describe('skillChoicePromptBlock', () => {
  const block = skillChoicePromptBlock(SKILLS);

  it('asks the learner, framed as a decision that belongs to them', () => {
    expect(block).toContain('## Choosing a teaching method');
    expect(block).toContain('belongs to the learner');
    expect(block).toContain('ask_user');
  });

  it('hands over a ready catalogue of METHOD skills', () => {
    expect(block).toContain('### Method skills currently installed');
    expect(block).toContain('feynman-learning');
    expect(block).toContain('lecture-style');
    expect(block).toContain('workshop-style');
  });

  it('excludes tooling skills from the catalogue', () => {
    expect(block).not.toContain('slide-dsl');
    expect(block).not.toContain('pro-editing');
    expect(block).toMatch(/never ask about them/i);
  });

  it('trims each skill description to one line', () => {
    expect(block).not.toContain('第二句不该出现');
  });

  it('tells the agent to put the rest in the question text, not options', () => {
    expect(block).toMatch(/\*\*Then list the rest/);
    expect(block).toContain('`question` text');
    expect(block).toMatch(/cannot hold the whole catalogue/i);
  });

  it('asks once, together with the plan confirmation', () => {
    expect(block).toMatch(/Ask \*\*once\*\*/);
    expect(block).toContain('together with the plan confirmation');
  });

  it('tells the agent the brief is what carries the method into the pages', () => {
    expect(block).toContain('generate_scene');
    expect(block).toContain('does NOT see the skill you read');
    expect(block).toContain('brief');
  });

  it('returns an empty block when only tooling skills are installed', () => {
    expect(skillChoicePromptBlock([fakeSkill('slide-dsl')])).toBe('');
  });
});
