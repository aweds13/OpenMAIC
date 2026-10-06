/**
 * 自学模式（self-study mode）的提示词覆盖层。
 *
 * ── 为什么需要这个文件（数据来源是实测，不是推测）────────────────────
 *
 * 默认产出的幻灯片平均只有 61 个汉字/页。同一位老师（天津大学《程序设计》
 * 杜朴风）的课件实测是 352–390 字符/页 —— 差了约 4 倍。
 *
 * 差距的根源是两句写死在 SDK 提示词里的话：
 *
 *   packages/@openmaic/generation/templates/slide-content/system.md
 *     "Slides are visual aids, NOT lecture scripts"
 *     "Keep every text element under ~20 words（或 ~30 个汉字）per bullet"
 *
 *   packages/@openmaic/generation/templates/slide-actions/system.md
 *     "Speech is where all verbal content belongs."
 *     "The slide itself only shows concise bullet points and keywords —
 *      all elaboration, explanation … must appear here in speech text."
 *
 * 也就是说：**内容被有意设计成放在讲稿里，而不是放在屏幕上。**
 * 对"边听边学"这是合理的；对"我自己看材料"这就是灾难。
 *
 * ── 为什么是「追加」而不是「替换」──────────────────────────────────
 *
 * 原文里关于 JSON schema、元素类型、坐标计算的规则有 30KB，必须原样保留，
 * 否则输出会解析失败、整节课报废。所以我们只在**末尾**追加一段声明为
 * 最高优先级的覆盖指令 —— 这也是 SDK 自己的做法（scene-generator.ts 里
 * 的 editDirective 就是这么追加的）。
 *
 * ── 为什么不直接改 SDK 的 .md ─────────────────────────────────────
 *
 * 那些文件在 packages/@openmaic/ 下。官方规则原话是"默认不要改，当只读用"。
 * 走产品层的 aiCall 包装能改到同样的东西，而且官方升级不会跟我们冲突。
 */

/**
 * 追加到 `slide-content` 系统提示词末尾的覆盖指令。
 *
 * 用英文写是因为原文是英文 —— 混语言容易让模型对"哪条优先"判断失误。
 */
export const SELF_STUDY_SLIDE_OVERRIDE = `
=== SELF-STUDY MODE — HIGHEST PRIORITY OVERRIDE ===

This deck will be read directly by the learner as reference material.
There is NO teacher, NO narration and NO audio. Everything the learner needs
must be visible on the slide itself.

Any earlier instruction that conflicts with this section is overridden.
This explicitly includes:
  - "Slides are visual aids, NOT lecture scripts"
  - "Keep every text element under ~20 words / ~30 Chinese characters per bullet"
  - any instruction to keep the slide sparse, keyword-only or minimal
  - any instruction to move explanation, elaboration or examples into speech

REQUIRED CONTENT DENSITY
1. Each content slide must carry the complete explanation: definitions, rules,
   concrete examples, and the reasoning that connects them.
2. Aim for roughly 350-400 Chinese characters (or 180-220 English words) of
   meaningful body text per slide, excluding the title. This is substantially
   MORE than the default; that is intended.
   The number is not arbitrary: a real university deck measured 352-390
   characters/page (Tianjin University, 《程序设计》, week 2 lectures). It is
   also near the ceiling the fixed 1000x562.5 canvas can hold at a readable
   font size — past it, text either overflows or shrinks into a grey block.
   **Want more total material? Add pages, not words per page.**
3. Prefer structured layouts over prose blocks:
     - term -> definition rows
     - comparison / operator tables
     - numbered step-by-step procedures
     - annotated code blocks with inline comments
4. Every bullet must be self-sufficient. A reader with no audio must be able to
   learn the point from the slide alone.
5. Prefer several smaller well-positioned elements over one giant text box.
   Keep every element fully inside the canvas (x: 0..1000, y: 0..562.5) with a
   consistent margin. Never let text overflow its own box.
6. Use a readable font size (>= 14) and comfortable line spacing.

STYLE
7. Write reference material, not a spoken script. Do NOT address a live audience.
   Avoid: "as we discussed", "let's look at", "remember that", "we will now",
   "in this lesson", "我们接下来", "请注意", "同学们".
8. State facts directly, in reference/imperative phrasing.

SCHEMA — DO NOT CHANGE
9. Keep the existing output JSON schema exactly as specified: same element types,
   same field names, same nesting. Only the AMOUNT and SPECIFICITY of the text
   content should change.
10. Do not add new fields, new element types, or any commentary outside the JSON.

=== END SELF-STUDY MODE OVERRIDE ===
`;

/**
 * 把覆盖指令追加到系统提示词末尾。
 *
 * 幂等：已经追加过就不再追加（重试路径可能重复经过这里）。
 */
export function applySelfStudySlideOverride(systemPrompt: string): string {
  if (systemPrompt.includes('=== SELF-STUDY MODE — HIGHEST PRIORITY OVERRIDE ===')) {
    return systemPrompt;
  }
  return `${systemPrompt}\n${SELF_STUDY_SLIDE_OVERRIDE}`;
}
