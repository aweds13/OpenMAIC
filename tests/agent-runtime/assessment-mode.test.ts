import { describe, expect, it } from 'vitest';

import {
  ASSESSMENT_MODES,
  assessmentModePromptBlock,
} from '@/lib/server/agent-runtime/assessment-mode';
import { studyModePromptBlock } from '@/lib/server/agent-runtime/study-mode';

const block = assessmentModePromptBlock();

describe('评估方式这条轴（讲课 / 作业 / 考试）', () => {
  it('names all three modes', () => {
    for (const mode of ASSESSMENT_MODES) expect(block).toContain(mode);
    expect(ASSESSMENT_MODES).toHaveLength(3);
  });

  it('★ says it is a separate axis from 听课/自学, so neither silently changes the other', () => {
    expect(block).toContain('separate axis');
    expect(block).toContain('self-study + exam');
    // 两条轴的取值都要出现，否则 agent 分不清哪条是哪条。
    expect(block).toContain('听课');
    expect(block).toContain('自学');
  });

  it('★ states plainly that it is a stance, not a lock', () => {
    expect(block).toContain('stance, not a lock');
    expect(block).toContain('do not build a fake restriction');
    // 这条是防"下一个窗口以为漏了实现，然后去补一个假的锁"。
    expect(block).not.toContain('enforced by');
  });

  it('★ wires 作业 to the tools that actually exist (not to a wish)', () => {
    // §1.1 的同一条原则：提一个不存在的工具比不给指引更糟。
    expect(block).toContain('practice_scaffold');
    expect(block).toContain('practice_result');
    expect(block).toContain('go back and teach');
  });

  it('is constant — no interpolation, so it cannot flip the prompt cache mid-session', () => {
    expect(assessmentModePromptBlock()).toBe(block);
    expect(block).not.toMatch(/\$\{/);
  });

  it('does not collide with the input-modality block', () => {
    const study = studyModePromptBlock();
    expect(study).not.toContain('Assessment mode');
    expect(block).not.toContain('PAGE_DENSITY');
  });
});
