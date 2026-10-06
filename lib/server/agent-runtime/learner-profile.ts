/**
 * 学习者画像 —— 把一份 Markdown 档案注入每次 agent 运行的系统提示词。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 *
 * 在此之前，agent 对学习者一无所知：不知道他学过什么、目标是什么、会哪门
 * 语言。它只能按"对所有人都安全"（也就是对所有人都不合适）的默认深度规划。
 *
 * 更糟的是：它**本来可以问**（有 ask_user），但它不知道**该问什么** ——
 * 一个没有画像的智能体不会想到"先确认起点"，因为它不觉得自己缺信息。
 * 所以画像的作用不只是"告诉它答案"，还是"**告诉它有哪些坑没填**"。
 *
 * ── 设计约束（来自用户明确要求）────────────────────────────────
 *
 * 「你不要把这个文档当做用户用了好不好？要当做给 agent 看的。」
 * 「只保留状态啊这些必要的信息」
 *
 * 所以这一层只承载**学习者状态**，不承载生成指令（那些在 self-study-mode.ts）
 * 也不承载材料策略。档案里的 UNKNOWN 标记是**给智能体的行动指令**：
 * 看到 UNKNOWN 就去问，而不是猜。
 *
 * ── 两个不同的生命周期（别混淆）──────────────────────────────────
 *
 *   · **路径**来自 `agentRuntimeConfig`，在模块加载时求值 —— 换路径要重启；
 *   · **内容**每次调用 `resolveLearnerProfile()` 都重读 —— 改画像不用重启。
 *
 * 后者才是常用的那个：画像本体天天改，路径基本不动。缓存内容会让
 * "改了没生效"变成一个需要重启才能诊断的谜。
 *
 * 读取规则（大小上限、剥注释、静默失败）在 prompt-context-file.ts 里只写一遍。
 */
import { agentRuntimeConfig } from './config';
import { readPromptContextFile } from './prompt-context-file';

/**
 * 读取画像内容；任何失败都返回 null（= 不注入，而不是注入一段坏内容）。
 */
export function resolveLearnerProfile(): string | null {
  return readPromptContextFile(agentRuntimeConfig.learnerProfilePath);
}

/**
 * 提示词块。
 *
 * 框定语刻意很短 —— 档案本身已经是写给智能体的，再套一层长篇说明只会
 * 稀释它。这里只补三件档案自己说不清的事：
 *   1. 这是什么；
 *   2. UNKNOWN 该怎么处理（去问，不要猜 —— 这是整份档案的核心用法）；
 *   3. 不要把档案念给学习者听。
 */
export function learnerProfilePromptBlock(profile: string): string {
  return [
    '## Learner profile',
    '',
    'Who you are planning for. Treat it as fact, not as a suggestion to work around.',
    '',
    '**`UNKNOWN` means ask, do not assume.** The profile deliberately records what is not',
    'known — that is the list of things you are expected to resolve with `ask_user` before',
    'committing to a plan. A learner who has touched Git and one who has not need different',
    'openings; the profile tells you that you cannot tell yet.',
    '',
    'Do not recite this profile back to the learner, and do not mention that you have one.',
    'Use it to shape what you plan and what you ask.',
    '',
    '---',
    '',
    profile,
  ].join('\n');
}
