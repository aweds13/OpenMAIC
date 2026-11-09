/**
 * 「这道题我不会，问一句」——把题目接成一句可以发给对话模型的话。
 *
 * ## 为什么这句话要单独成一个模块
 *
 * 它看起来只是拼字符串，但它是**唯一一处**把「学情事件」与「对话」
 * 接起来的地方，而这两边各有各的不变量：
 *
 * - 学情那边要的是 `questionId` 与 `hint_subtype`（`N3` §5.4：instrumental
 *   问「怎么想」、executive 求「直接给答案」，两者与成绩的相关方向相反）；
 * - 对话那边要的是一段自然语言，且**不能超过题干本身** —— 多了就成了
 *   「我已经这样想过了」的暗示，会把模型推到「顺着你说」那条路上
 *   （`2506.10297`：学生提示错误答案时正确率最多降 15pp）。
 *
 * 所以这里只做三件事：截断题干、把题干放进模板、不附加任何「我的想法」。
 * 学生自己的想法**不进上下文**，只落 `xq_event.payload`（M §10.4）。
 *
 * ## 为什么模板由调用方给
 *
 * 这句话要跟界面同语言，而语言资源在 `lib/i18n/locales/*.json` 里
 * （`quiz.askPrompt`）。这个模块不引 i18n，只负责把题干塞进模板 ——
 * 这样它在 Node 里可以被直接测，不必搭 React。
 */

/**
 * 题干最多带多少字符进对话。
 *
 * 取 200 不是有依据的阈值，而是「一屏能读完」的上限：真实题库里最长的
 * 题干（`stage--ShZtYAYOj/scene-p18/q7` 的类与构造方法题）是 118 字，
 * 撑到 200 仍然原样带完；再长就是带了一整段代码，那时让模型读整页
 * 比读一句截断的话更好 —— 而这条路今天没走（对话不读页内容）。
 */
export const HINT_STEM_MAX_CHARS = 200;

/** 模板里题干的位置。 */
export const HINT_STEM_PLACEHOLDER = '{{stem}}';

/**
 * 按**码点**截断（不是 `slice` 按 UTF-16 码元），末尾补省略号。
 *
 * 题面里有 `∑`、`≤` 这类字符，也有 emoji 出现在数学题选项里；按码元切
 * 会把一个代理对切成两半，发出去就是乱码。
 */
export function truncateStem(stem: string): string {
  const trimmed = stem.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= HINT_STEM_MAX_CHARS) return trimmed;
  return `${chars.slice(0, HINT_STEM_MAX_CHARS).join('')}…`;
}

/**
 * 把题干填进模板。
 *
 * 模板里没有占位符时**退回一句只含题干的话**（而不是把模板原样发出去）：
 * 缺占位符是翻译漏了，而漏了占位符的模板发出去，学生问的就是一句
 * 「{{stem}}」——那比少一层礼貌更糟。
 */
export function buildHintPrompt(template: string, stem: string): string {
  const body = truncateStem(stem);
  if (!template.includes(HINT_STEM_PLACEHOLDER)) return body;
  return template.split(HINT_STEM_PLACEHOLDER).join(body);
}
