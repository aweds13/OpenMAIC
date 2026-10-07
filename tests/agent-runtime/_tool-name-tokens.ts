/**
 * 共享的测试工具：从"模型能看到的文字"里抽出**像工具名**的标识符。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────
 *
 * 同一把尺子有两处要用：一处量**本 fork 自己的模块**（`tool-name-invariant.test.ts`），
 * 一处量**整个装配出来的提示词**（`runner-course-search-registration.test.ts`）。
 * 两份实现必然漂 —— 而漂了之后，两处会给出不同的结论，比只有一处更糟。
 *
 * ── 判据（窄，但正是要抓的形状）────────────────────────────────
 *
 * 反引号里、小写开头、**含下划线**、后面跟空白/反引号/左括号的标识符。
 *
 * 要求"含下划线"是为了排掉字段名（`stageId`）、文件名（`check.mjs`）、
 * 大写常量（`NOVEL_P90`）。
 *
 * ★ 前瞻 `(?=[\s`(])` 是必需的：工具名有两种写法 —— 裸的（`` `plan_freeze` ``）
 *   和**调用形状**的（`` `practice_scaffold { stageId, … }` ``）。
 *   第一版只抓裸的，漏掉调用形状 —— 也就是说它**比自己声称的窄**，却照样全绿。
 *   那给的是假信心，不是覆盖。
 */
export function toolLikeTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)(?=[\s`(])/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * 报告 `text` 里提到的、**不在 `allowed` 里**的工具名。
 *
 * 返回空数组 = 干净。返回非空 = 有幽灵（模型会去找一个不存在的东西）。
 */
export function phantomToolNames(text: string, allowed: ReadonlySet<string>): string[] {
  return toolLikeTokens(text).filter((token) => !allowed.has(token));
}
