/**
 * `lib/concepts` 的公共出口。
 *
 * 模块只做三件事，彼此不重叠：
 *
 * - `ids.ts` —— 概念 id 的形状与名字归一化（不涉及任何数据）。
 * - `seed.ts` —— 种子图（数据全部内联，纯函数、不联网、不读盘）。
 * - `occurrence.ts` —— 从一页的大纲条目推出页级挂载（纯函数）。
 *
 * 落库不在这里：写 `xq_concept*` 是 `.tmp/seed_concepts.mts` 这种一次性脚本的
 * 事，库读写不该由纯数据模块承担。
 */
export { CONCEPT_ID_HEX_LENGTH, CONCEPT_ID_PREFIX, newConceptId, normalizeConceptName } from './ids';
export { buildSeedGraph } from './seed';
export type { SeedConcept, SeedEdge, SeedGraph } from './seed';
export { buildAliasIndex, deriveOccurrencesFromOutlines } from './occurrence';
export type { ConceptAliasIndex, ConceptHit, OccurrenceDraft, OutlinePageInput } from './occurrence';
