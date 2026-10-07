/**
 * 「讲课 / 作业 / 考试」—— **评估方式**这条轴，在提示词里怎么落地。
 *
 * ── 它和 `study-mode.ts` 是**两条不同的轴**，别合并 ─────────────
 *
 * | 轴 | 文件 | 问的是 | 取值 |
 * |---|---|---|---|
 * | **输入方式** | `study-mode.ts` | 内容放在屏幕上还是讲稿里 | 听课 / 自学 |
 * | **评估方式** | 本文件 | 学完之后怎么验 | 讲课 / 作业 / 考试 |
 *
 * 两条轴**正交**：可以是"自学 + 考试"（自己看材料，然后闭卷自测），
 * 也可以是"听课 + 作业"。所以本块里明说这一点 —— 否则 agent 会以为
 * 选了考试就等于改了输入方式。
 *
 * ── 用户的原话（这是需求，不是我的设计偏好）────────────────────
 *
 * 「错过的再也不考，要是有个专门配套所制作课程的作业模式，test 模式，还有类似洛谷，
 *   leetcode 那种」
 * 问「考试怎么防止他直接去看答案」时答：**「考试只是心态」**。
 *
 * 所以**故意不做闸**：不锁答案、不禁用工具、不藏 `solution`（页面 HTML 里本来就带着）。
 * 这是**姿态**，不是安全边界 —— 而这句话必须**写进块里**，否则下一个窗口会把它当成
 * 一个漏了实现的闸，然后去"补"一个假的锁。（同类判断见 AGENTS.md §1.1：
 * 不许提一个不存在的能力；这里反过来 —— 不许假装存在一个不存在的约束。）
 *
 * ── 三个模式各自真正改变什么 ──────────────────────────────────
 *
 * · **讲课**（默认）：讲清楚，末尾自检页收口。
 * · **作业**：每个概念**再配一个真能在 VS Code 里跑的练习** —— 这是本 fork 已经有的
 *   `practice_scaffold`（生成文件夹 + 判据）与 `practice_result`（读回结果）。
 *   作业模式的实质就是：**不要只给自检页，要给能跑的东西，并且把结果读回来。**
 * · **考试**：一组题，**学习者在答完之前不该看到提示或答案**；而且**开始前先说明**
 *   这是心态约定、不是什么技术封锁 —— 让他自己选择遵守。答完再看解析。
 *
 * ── 提示词缓存 ────────────────────────────────────────────────
 *
 * **无参、恒定**（AGENTS.md §1.2）：模式是每次对话里由学习者说的，不进系统提示词做
 * 状态；状态走 `ask_user` 的对话与工具结果。所以本块**每个字节都是常量**。
 */

/** 三个模式的名字 —— 供块与测试共用一处定义，避免两边各写一份而漂。 */
export const ASSESSMENT_MODES = ['讲课', '作业', '考试'] as const;

export type AssessmentMode = (typeof ASSESSMENT_MODES)[number];

/**
 * 系统提示词块 —— **无参、恒定**。
 *
 * 它不携带"现在是什么模式"（那是会话里的对话，不是提示词状态）；
 * 它只告诉 agent：**有这条轴、三个取值各改变什么、以及它是姿态不是闸。**
 */
export function assessmentModePromptBlock(): string {
  return [
    '## Assessment mode: teaching / homework / exam',
    '',
    'This is a **separate axis** from 听课/自学. That one decides *where the content lives*',
    '(on screen vs. in the speech). This one decides *how it gets verified*. They are independent:',
    '"self-study + exam" (read it yourself, then a closed-book check) is a normal combination, and',
    'choosing one must not silently change the other.',
    '',
    'Ask which one is wanted if it is not clear yet; then hold to it for that course or session.',
    '',
    '- **讲课 (teaching, the default)** — explain it properly, close with a self-check page.',
    '- **作业 (homework)** — for each concept, also give something that **actually runs**:',
    '  `practice_scaffold { … }` writes a folder with starter files and checks that the learner',
    '  runs in VS Code, and `practice_result { … }` reads the outcome back. The substance of',
    '  homework mode is exactly this: **not just a quiz page — something they run, and the result',
    '  comes back to you.** Failing checks tell you what to go back and teach.',
    '- **考试 (exam)** — a set of questions, and **the learner should not see hints or answers',
    '  before answering**. Say so up front, then wait. After they answer, go through the reasoning.',
    '',
    '★ **This is a stance, not a lock — and that is deliberate.** Nothing enforces it: no tool is',
    'disabled, answers are not hidden (they are in the page HTML anyway), and the deployment does',
    'not police it. The learner asked for exam conditions as a **mindset** and keeps to it himself.',
    'Do not present it as a guarantee, and do not build a fake restriction to make it feel real.',
  ].join('\n');
}
