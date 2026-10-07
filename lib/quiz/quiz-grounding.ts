/**
 * 出题前的注入 —— 把「前面已经讲过什么」推进自检页生成器的系统提示词。
 *
 * ── 这是 T2 的**前半**，`coverage-gap.ts` 是后半 ─────────────────────
 *
 * | | 干什么 | 时点 |
 * |---|---|---|
 * | 本模块 | **拦**：生成前告诉出题的那个模型"只许考这些" | 生成前 |
 * | `coverage-gap.ts` | **查**：生成后算出"哪几段前面没讲过" | 生成后 |
 *
 * 两个共用**同一个单位**（`contentChunks` 切出来的内容块），所以"允许用的词"
 * 和"报出来的缺口"说的是同一件事 —— 判据不会互相漂。
 *
 * ── 为什么能注入，以及注在哪里 ─────────────────────────────────────
 *
 * 页面内容生成器是**另一次 LLM 调用**，它看不到 agent 读过什么、也看不到别的页
 * （见 `generation-tools.ts` 里 brief 那段注释）。所以唯一的通道是：
 *
 *   · **brief** —— agent 写，承载"这一页要什么"（含要重考的考点，因为 agent
 *     看得到系统提示词末尾的答题状态）；
 *   · **这一段** —— 代码算，承载"全课程的词表"（agent 记不住，也不该由它记）。
 *
 * 注入方式是 per-call 包一层 aiCall、往 system prompt **末尾追加** —— 与
 * `lib/server/self-study-mode.ts` 的 `applySelfStudySlideOverride` 同一手法，
 * 只是 per-page 而不是 per-deployment。追加在末尾有两个好处：前缀缓存不破；
 * 覆盖指令在最后，而 SDK 自己也是这么追加的（`scene-generator.ts` 的 editDirective）。
 *
 * ── 指令用英文，数据用课程的语言 ──────────────────────────────────
 *
 * 这是仓库里已经付过学费的一条：**指令跟原文同语言**，否则模型对"哪条优先"
 * 判断失误（`self-study-mode.ts` 头部原话）。而词表和页码是**数据**，保持中文。
 */
import type { AICallFn } from '@openmaic/generation';

import { contentChunks, extractTaughtText } from '@/lib/quiz/coverage-gap';

export interface QuizGroundingScene {
  order: number;
  title: string;
  content: unknown;
}

export interface BuildQuizGroundingInput {
  scenes: readonly QuizGroundingScene[];
  /** 本页的 order —— 只收**它之前**的页面。 */
  beforeOrder: number;
  /** 词表最多列几个。默认 80。 */
  maxTerms?: number;
  /** 整块字符上限（含指令与页码表）。默认 2400。 */
  maxChars?: number;
}

const DEFAULT_MAX_TERMS = 80;
const DEFAULT_MAX_CHARS = 2400;

/**
 * 从已教文本里挑出**词表**。
 *
 * 排序用「出现次数 → 长度」：出现得多的更接近课程的核心，长的更像术语而不是碎片。
 * 这不是精确的术语抽取（那需要词典），但它**便宜、可算、方向一致** —— 而且它与
 * `coverage-gap` 用同一把尺子，所以"列在这里"和"报了缺口"是互补的。
 */
export function taughtVocabulary(taughtText: string): string[] {
  const counts = new Map<string, number>();
  for (const chunk of contentChunks(taughtText)) {
    counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(
      (left, right) =>
        right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]),
    )
    .map(([term]) => term);
}

/**
 * 组装注入块。没有已讲内容时返回 `''`（调用方据此**不包装** aiCall）。
 */
export function buildQuizGrounding(input: BuildQuizGroundingInput): string {
  const earlier = input.scenes
    .filter((scene) => scene.order < input.beforeOrder)
    .sort((left, right) => left.order - right.order);
  if (earlier.length === 0) return '';

  const taughtText = earlier
    .map((scene) => extractTaughtText(scene.content))
    .filter(Boolean)
    .join('\n');
  if (!taughtText) return '';

  const maxTerms = input.maxTerms ?? DEFAULT_MAX_TERMS;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;

  const pageMap = earlier.map((scene) => `- 第 ${scene.order} 页《${scene.title}》`).join('\n');
  const vocabulary = taughtVocabulary(taughtText);

  const header = [
    '=== QUIZ GROUNDING — HIGHEST PRIORITY OVERRIDE ===',
    '',
    'This self-check page belongs to a course whose earlier pages the learner has',
    'already read. Those pages established the vocabulary listed at the end of this',
    'block. Any earlier instruction that conflicts with the following is overridden.',
    '',
    '1. Test ONLY what the pages before this one taught. The list at the end is the',
    '   vocabulary they established — treat it as the allowed terms.',
    '2. If the brief names concepts to RE-TEST (this learner got them wrong before),',
    '   cover those in a NEW wording. Do not spend the page on unrelated new questions.',
    '3. Distractors must come from confusions those earlier pages actually raised.',
    '   NEVER use a term this course has not introduced as a distractor: an unknown',
    '   word does not test knowledge, it tests guessing.',
    '4. The `analysis` must not lean on any term outside the list. If the correct',
    '   answer genuinely needs a new term, that term belongs on a teaching page, not',
    '   inside an explanation.',
    '5. If a term you need is missing from the list, PREFER REWORDING over introducing it.',
    '',
    '--- PAGES BEFORE THIS ONE (order / title) ---',
    pageMap,
    '',
    '--- VOCABULARY ESTABLISHED SO FAR (allowed terms) ---',
  ].join('\n');

  const footer = '\n\n=== END QUIZ GROUNDING ===\n';
  // 词表是**按重要性排序**的，所以超预算时砍掉的是尾部（最不核心的），而不是随机截断。
  //
  // ★ 预算有**下限**：`maxChars` 只能压缩词表，**不能侵蚀指令**。第一版写成
  //   `Math.max(0, ...)`，于是 maxChars 比指令块还小时会产出「有指令、却空词表」
  //   的块 —— 而指令第 1 条恰恰说"末尾那份清单就是允许用的词"。**空清单比不注入
  //   更糟**：它会让生成器以为"这门课没讲过任何东西"。下限同时保证词表非空。
  const budget = Math.max(400, maxChars - header.length - footer.length);
  const terms: string[] = [];
  let used = 0;
  for (const term of vocabulary.slice(0, maxTerms)) {
    if (used + term.length > budget) break;
    terms.push(term);
    used += term.length;
  }
  // 一个词都放不下时也要给出一块可用的指令（否则"注入了但没说允许用什么"比不注入更糟）。
  return `${header}\n${terms.join('\n')}${footer}`;
}

/**
 * 把注入块追加到**系统提示词末尾**。
 *
 * 追加在末尾而不是开头：前缀缓存按前缀算，改动落在尾部 ⇒ 前面全部照旧命中
 * （同 `runner.ts` 里 promptBlocks 的排序理由）。
 */
export function appendToSystemPrompt(call: AICallFn, block: string): AICallFn {
  return (systemPrompt, userPrompt, images) =>
    call(`${systemPrompt}\n${block}`, userPrompt, images);
}
