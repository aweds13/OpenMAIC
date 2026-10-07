/**
 * 提示词审计：把**真实拼出来的**工作台系统提示词 dump 到一个文件里，好让人（和 agent）
 * 用眼睛读一遍，找**互相打架的指令**。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 现有诊断只有 `OPENMAIC_DEBUG_PROMPT_FINGERPRINT=1`，它打的是**每块的哈希和长度** ——
 * 能告诉你"哪块变了"，**不能告诉你它说了什么**。而要判断"新加一条规矩会不会跟旧规矩
 * 打架"，只能读全文。
 *
 * 提示词是**多个块拼出来的**（见 `runner.ts` 的 `promptBlocks`），块之间没有任何机制
 * 防止互相矛盾 —— 一个说"先讨论再动手"，另一个说"不要问，直接做"，两边都读不到对方。
 * 所以需要一个能整体读一遍的入口。
 *
 * ── 覆盖范围（**诚实标注**）────────────────────────────────────
 *
 * ✅ 本用例拼的是真实的：课程设计、自学/听课、课程工具、名单工具、fetch 纪律、
 *    不可信内容策略、材料库索引、学习画像、**学习状态**、语音工具。
 * ❌ **没有**拼进来的：能力块（`search` / `courseLibrary` / `browse` / `mcp` —— 要探活）、
 *    技能清单（要按 ownerId 查库）、`sessionMaterials` 与 `dslTools` 常量块。
 *    它们基本都是**工具说明**，不是行为纪律；纪律块的冲突才是要害。
 *
 * 跑法（默认跳过，因为它读本机真实数据）：
 *   TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/agent-runtime/prompt-audit-live.test.ts
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { courseDesignPromptBlock } from '@/lib/server/agent-runtime/course-design';
import { CURRICULUM_TOOLS_PROMPT } from '@/lib/server/agent-runtime/curriculum-tools';
import {
  fetchPromptBlock,
  untrustedContentPolicyPromptBlock,
} from '@/lib/server/agent-runtime/fetch-url';
import { learnerProfilePromptBlock, resolveLearnerProfile } from '@/lib/server/agent-runtime/learner-profile';
import { learnerStatePromptBlock, resolveLearnerState } from '@/lib/server/agent-runtime/learner-state';
import {
  materialsIndexPromptBlock,
  resolveMaterialsIndex,
} from '@/lib/server/agent-runtime/materials-library';
import { ROSTER_TOOLS_PROMPT } from '@/lib/server/agent-runtime/roster-tools';
import { buildRunnerCoursePrompt } from '@/lib/server/agent-runtime/runner-contract';
import { studyModePromptBlock } from '@/lib/server/agent-runtime/study-mode';
import { voiceCloneToolsPrompt } from '@/lib/server/agent-runtime/voice-clone-tools';

/**
 * dump 到哪儿 —— **harness 的调试产物跟 harness 走**。
 *
 * ★ 不要写到 `个人数据\`：那里只放**学习成长**相关的东西（学习画像 / 学习状态 /
 *   材料清单）。一次误写就会让"哪些是我的成长数据、哪些是机器的调试垃圾"分不清。
 *   见 AGENTS.md §6.8。
 */
const DUMP_DIR =
  process.env.OPENMAIC_PROMPT_DUMP_DIR ?? 'D:\\文档\\jelly_ware\\_tools\\openmaic\\diagnostics';
const DUMP_FILE = join(DUMP_DIR, '工作台提示词.txt');

describe.skipIf(process.env.TEST_LOAD_LOCAL_ENV !== '1')('工作台提示词审计', () => {
  it('拼出真实提示词、打印每块字数、写一份到磁盘', () => {
    const materialsIndex = resolveMaterialsIndex();
    const learnerProfile = resolveLearnerProfile();
    const learnerState = resolveLearnerState();

    const blocks: Record<string, string> = {
      studyMode: studyModePromptBlock(),
      courseDesign: courseDesignPromptBlock(),
      curriculum: CURRICULUM_TOOLS_PROMPT,
      ...(materialsIndex ? { materialsLibrary: materialsIndexPromptBlock(materialsIndex) } : {}),
      ...(learnerProfile ? { learnerProfile: learnerProfilePromptBlock(learnerProfile) } : {}),
      fetch: fetchPromptBlock(),
      untrustedContent: untrustedContentPolicyPromptBlock(),
      roster: ROSTER_TOOLS_PROMPT,
      voice: voiceCloneToolsPrompt(true),
      // ★ 与 runner.ts 一致：学习状态放**最后**（唯一会随答题变化的一块）。
      ...(learnerState ? { learnerState: learnerStatePromptBlock(learnerState) } : {}),
    };

    const prompt = buildRunnerCoursePrompt(blocks as Parameters<typeof buildRunnerCoursePrompt>[0]);

    const sizes = Object.entries(blocks)
      .map(([name, text]) => [name, text.length] as const)
      .sort((left, right) => right[1] - left[1]);
    console.log(
      `\n[提示词审计] 全文 ${prompt.length} 字；分块（大 → 小）：\n` +
        sizes.map(([name, size]) => `  ${name}: ${size}`).join('\n') +
        `\n  缺（未拼进来）：技能清单 / search / courseLibrary / browse / mcp / sessionMaterials / dslTools`,
    );

    expect(prompt.length).toBeGreaterThan(2000);
    mkdirSync(DUMP_DIR, { recursive: true });
    writeFileSync(DUMP_FILE, prompt, 'utf8');
    console.log(`[提示词审计] 已写到 ${DUMP_FILE}`);
    expect(prompt).toContain('课程');
  });
});
