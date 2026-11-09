/**
 * `lib/concepts` 的公共出口。
 *
 * 模块只做三件事，彼此不重叠：
 *
 * - `ids.ts` —— 概念 id 的形状与名字归一化（不涉及任何数据）。
 * - `seed.ts` —— 种子图（数据全部内联，纯函数、不联网、不读盘）。
 * - `occurrence.ts` —— 从一页的大纲条目推出页级挂载（纯函数）。
 * - `question.ts` —— 从一道题的题干推出题级挂载（纯函数）。
 *
 * 页级与题级是两件事：一页八道题共用一份页级概念集，等于把每道题都算成
 * 「考了那八个概念」。题级必须按题面收窄，理由与实测表在 `question.ts` 头注。
 *
 * 落库不在这里：写 `xq_concept*` / `xq_question_concept` 是一次性脚本的事
 * （`scripts/backfill-question-concepts.ts`），库读写不该由纯数据模块承担。
 */
export {
  CONCEPT_ID_HEX_LENGTH,
  CONCEPT_ID_PREFIX,
  newConceptId,
  normalizeConceptName,
} from './ids';
export { buildSeedGraph } from './seed';
export type { SeedConcept, SeedEdge, SeedGraph } from './seed';
export { buildAliasIndex, deriveOccurrencesFromOutlines } from './occurrence';
export type {
  ConceptAliasIndex,
  ConceptHit,
  OccurrenceDraft,
  OutlinePageInput,
} from './occurrence';
export {
  QUESTION_CONCEPT_CONFIDENCE_STRONG,
  QUESTION_CONCEPT_CONFIDENCE_WEAK,
  STRONG_MIN_ASCII_CHARS,
  STRONG_MIN_CJK_CHARS,
  deriveQuestionConcepts,
  questionStemWords,
  questionWordTier,
} from './question';
export type { QuestionConceptDraft, QuizPageInput } from './question';
