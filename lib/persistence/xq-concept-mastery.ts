/**
 * 学情（xq）的**概念级三态读数**：这个概念，他到底会不会。
 *
 * ## 为什么要有这一层（而它之前一直没有）
 *
 * `xq_cell_state` 的主键是 `(stage_id, scene_id)` —— 一格是一**页**。
 * 规格 `SR-F11.2` 写了三级粒度（页 / 题 / 知识点），而 2026-11-10 之前的实测是：
 * 页级有三态读数，**题级与知识点级都没有自己的三态读数**。
 *
 * 这不是漏了一行代码：页级读数回答「这一页的自检他过了没有」，它天生绑在
 * 「那一页有 8 道题」这个形状上。而学习者问的是「我到底会不会 Dart 的空安全」——
 * 那个概念可能在三门课的五个页面上各考过一道题，页级永远把它切成五份，
 * 每份都不够判（每页 1 题 < `MIN_ITEMS_FOR_VERDICT`）。
 *
 * 概念级读数把这五条证据**合到一处**，才第一次有可能跨过判据门槛。
 *
 * ## 为什么算而不存
 *
 * `xq_cell_state` 是缓存，可以整表删掉重算。概念级读数这一层**连缓存都不建**：
 *
 *   - 它的输入（证据）只追加不改；输出是纯函数 `classifyEvidence()` 的结果；
 *   - 加一张 `xq_concept_state` 就要回答「证据变了谁去重算」——那是第二条刷新链，
 *     而刷新时机刚刚才因为「只有 agent 运行时才刷」出过一次错（`SR-F11.13`）；
 *   - 今天的规模是 56 条证据 / 104 个概念，一次读全表比维护缓存便宜。
 *
 * 等证据上到几万条、每次读都要扫全表时再谈缓存；那时要解决的是「谁触发重算」，
 * 不是「表长什么样」。
 *
 * ## 为什么要在这里判盲猜率，而页级不判
 *
 * `classifyEvidence()` 的 `guessRate` 缺省按单选 0.25。页级读数**没得选**：
 * 一格里单选多选混着，取哪个都是编。概念级这一层拿得到每道题的 `type`
 * （`document_scenes.data -> 'content' -> 'questions'[]` 里的 `type`），
 * 所以能按 `GUESS_RATE_CHOICE` / `GUESS_RATE_MULTIPLE_MEAN` 分开给。
 *
 * ★ 但**不给**页级读数补这个口径：那会改变已经标定过的页级判据（7/8 即可、
 * 0.8836 检出率），而标定是按 0.25 做的。两个层级用不同盲猜率是**刻意的**，
 * 不是不一致 —— 它们回答的不是同一个问题。
 *
 * ## 「唯一才用」与「并列就丢」
 *
 * `xq_question_concept` 里一道题可能挂多个同档概念（S6 的强弱两档设计：
 * 最高档恰好一个概念才算「这道题考的就是它」）。本模块沿用同一条规则：
 * `ties = 1` 才把这道题算进那个概念。并列时**一条都不算** ——
 * 挑一个会让「我到底会不会 A」变成「我到底会不会 A 或 B」，
 * 而这两件事的答案可以完全相反（A 会、B 不会）。
 *
 * 真库实测（2026-11-10）：51 行题级映射里**并列 0 行**，这条规则今天不损失任何题。
 * 仍要写死，是因为它是判据的一部分而不是当下的巧合。
 *
 * ## 为什么概念名要经映射才成 id
 *
 * `xq_question_concept.concept` 与 `xq_review_schedule.concept` 存的都是
 * **概念名**（不是 `concept_id`）。名字是证据，不是身份（`lib/concepts/ids.ts`
 * 文件头原话）。所以进本模块的第一步是名字 → `concept_id`：
 * `canonical_name` 精确优先，其次非歧义别名。映射不上就**如实回空**，
 * 不猜、不模糊匹配 —— 猜错会把 A 的证据记到 B 头上，而那是最难发现的一类错。
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  GUESS_RATE_CHOICE,
  GUESS_RATE_MULTIPLE_MEAN,
  classifyEvidence,
  type EvidenceItem,
  type TriVerdict,
} from '@/lib/quiz/xq-mastery';

/**
 * 一次最多算多少个概念。
 *
 * 与 `SESSION_DIGEST_LIMIT` / `DUE_REVIEW_CARD_LIMIT` 同量级：这是**一次读**的
 * 上限，不是「世界上有多少概念」。要更多就分页，而分页这件事在有人真的需要
 * 第 51 个概念之前不该先做。
 */
export const CONCEPT_MASTERY_LIMIT = 50;

/** 名字映射不上时 `conceptId` 是 `null` —— 不是空串，空串会被当成一个真的 id。 */
export interface ConceptMasteryRow {
  readonly conceptId: string | null;
  readonly concept: string;
  /** 这道概念一共吃到多少条证据（按 `counted_n` 加权后的题数）。 */
  readonly verdict: TriVerdict;
  /** 参与判定的题数（去重后的题目个数），与 `verdict.n` 不是一回事。 */
  readonly questions: number;
}

const RESOLVE_NAMES_SQL = `WITH asked(name) AS (
  SELECT DISTINCT unnest($1::text[])
), by_name AS (
  SELECT a.name, c.id AS concept_id
    FROM asked a
    JOIN xq_concept c ON c.canonical_name = a.name
   WHERE c.status <> 'merged'
), by_alias AS (
  -- 别名只在名字映射不上时才用；歧义别名一律不用（那正是 ambiguous 的含义）。
  SELECT a.name, al.concept_id
    FROM asked a
    JOIN xq_concept_alias al ON al.alias = a.name AND al.ambiguous = false
    JOIN xq_concept c ON c.id = al.concept_id AND c.status <> 'merged'
   WHERE NOT EXISTS (SELECT 1 FROM by_name n WHERE n.name = a.name)
   ORDER BY a.name, al.confidence DESC, al.concept_id
)
SELECT asked.name, coalesce(n.concept_id, x.concept_id) AS concept_id
  FROM asked
  LEFT JOIN by_name n ON n.name = asked.name
  LEFT JOIN LATERAL (
    SELECT concept_id FROM by_alias x0 WHERE x0.name = asked.name LIMIT 1
  ) x ON TRUE`;

const READ_CONCEPT_EVIDENCE_SQL = `WITH top AS (
  SELECT stage_id, scene_id, question_id, max(confidence) AS top_confidence
    FROM xq_question_concept
   WHERE concept_kind = 'keypoint'
   GROUP BY stage_id, scene_id, question_id
), unique_concept AS (
  -- ties = 1 才用：并列时这道题不归任何一个概念（见文件头「唯一才用」）。
  SELECT t.stage_id, t.scene_id, t.question_id,
         min(qc.concept) AS concept,
         count(*) AS ties
    FROM top t
    JOIN xq_question_concept qc
      ON qc.stage_id = t.stage_id
     AND qc.scene_id = t.scene_id
     AND qc.question_id = t.question_id
     AND qc.concept_kind = 'keypoint'
     AND qc.confidence = t.top_confidence
   GROUP BY t.stage_id, t.scene_id, t.question_id
)
SELECT u.concept,
       u.stage_id,
       u.scene_id,
       p.question_id,
       p.counted_n,
       p.correct,
       p.asked_at,
       q.value ->> 'type' AS question_type
  FROM unique_concept u
  JOIN xq_probe_item p
    ON p.stage_id = u.stage_id
   AND p.scene_id = u.scene_id
   AND p.question_id = u.question_id
  LEFT JOIN document_scenes s
    ON s.stage_id = u.stage_id AND s.id = u.scene_id
  LEFT JOIN LATERAL (
    SELECT value
      FROM jsonb_array_elements(coalesce(s.data -> 'content' -> 'questions', '[]'::jsonb)) AS value
     WHERE value ->> 'id' = u.question_id
     LIMIT 1
  ) q ON TRUE
 WHERE u.ties = 1
   AND ($2::text[] IS NULL OR p.stage_id = ANY($2::text[]))
   AND ($1::text[] IS NULL OR u.concept = ANY($1::text[]))
 ORDER BY u.concept, p.asked_at, p.id`;

interface NameRow extends Record<string, unknown> {
  name: unknown;
  concept_id: unknown;
}

interface EvidenceRow extends Record<string, unknown> {
  concept: unknown;
  stage_id: unknown;
  scene_id: unknown;
  question_id: unknown;
  counted_n: unknown;
  correct: unknown;
  asked_at: unknown;
  question_type: unknown;
}

/**
 * `counted_n` 是 `numeric(3,1)`，两个驱动都会回字符串；为 null 按 1.0。
 *
 * 与 `XqLearnerStore.recomputeCellState` 里那一段同一口径 —— 两处对同一条证据
 * 给出不同的份量，页级与概念级就会互相矛盾。
 */
function countedNOf(value: unknown): number {
  if (value === null || value === undefined) return 1;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * 多选题的盲猜率不是 `1/选项数`，是「至少蒙对一个组合」的均值 0.0638。
 *
 * 只用 `GUESS_RATE_MULTIPLE_MEAN`（`xq-mastery.ts` 里只有一个均值常数）；
 * 分选项数逐题算需要 `options` 数组，而那道题现在长什么样与**当时**长什么样
 * 可能不同 —— 拿今天的选项数去修正一年前的证据，是另一种编造。
 */
function guessRateOf(questionType: unknown): number {
  return questionType === 'multiple' ? GUESS_RATE_MULTIPLE_MEAN : GUESS_RATE_CHOICE;
}

/**
 * 按概念把这些证据折成三态。
 *
 * `queryable` 只读：本函数不发一条写语句。
 *
 * `stageIds` **可以不给**，那时算的是「所有课」。这个缺省不是随手留的：
 * 复习卡上那句「这个概念现在…」如果只统计「今天恰好有到期关的那几门课」，
 * 同一个概念在别的课上的证据就被悄悄排除了 —— 而排除之后照样给出一个
 * 看着很确定的读数（「暂未定（1 题）」），比不给更坏。
 *
 * 跨课不存在串号风险：`xq_question_concept` 与 `xq_probe_item` 是按
 * `(stage_id, scene_id, question_id)` 三元组连的，`question_id` 只在页内唯一
 * 这件事在两处都已由 stage 与 scene 兜住。
 *
 * 没映射上 id 的名字会出现在结果里（`conceptId: null`），不静默丢 ——
 * 「这个名字映射不上」本身就是需要被看见的缺口。
 */
export async function readConceptMastery(
  queryable: Queryable,
  options: {
    /** 只算这些课；不给就是所有课（见文件头「`stageIds` 可以不给」）。 */
    readonly stageIds?: readonly string[];
    /** 只算这些概念名；不给就是**所有**吃到过证据的概念。 */
    readonly concepts?: readonly string[];
    readonly now?: Date;
    readonly limit?: number;
  },
): Promise<readonly ConceptMasteryRow[]> {
  const scoped = options.stageIds;
  const stageIds =
    scoped === undefined
      ? null
      : [...new Set(scoped)].filter((id) => typeof id === 'string' && id !== '');
  if (stageIds !== null && stageIds.length === 0) return [];

  const requested = options.concepts === undefined ? null : [...new Set(options.concepts)];
  if (requested !== null && requested.length === 0) return [];

  const { rows } = await queryable.query<EvidenceRow>(READ_CONCEPT_EVIDENCE_SQL, [
    requested,
    stageIds,
  ]);

  interface Bucket {
    readonly concept: string;
    readonly items: EvidenceItem[];
    readonly questions: Set<string>;
  }
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const concept = typeof row.concept === 'string' ? row.concept : null;
    const stageId = typeof row.stage_id === 'string' ? row.stage_id : null;
    const sceneId = typeof row.scene_id === 'string' ? row.scene_id : null;
    const questionId = typeof row.question_id === 'string' ? row.question_id : null;
    if (concept === null || stageId === null || sceneId === null || questionId === null) continue;
    let bucket = buckets.get(concept);
    if (bucket === undefined) {
      bucket = { concept, items: [], questions: new Set() };
      buckets.set(concept, bucket);
    }
    // ★ 同一道题的两次观测是**两条**证据（`counted_n` 已经把它折成 0.5），
    //   不是一条 —— 「他答过两次」与「他答过一次」在区间上不该相同。
    bucket.items.push({
      countedN: countedNOf(row.counted_n),
      correct: row.correct === true,
      guessRate: guessRateOf(row.question_type),
      askedAt: row.asked_at instanceof Date ? row.asked_at : String(row.asked_at ?? ''),
    });
    // ★ 题目身份是 `(stage, scene, question)` 三元组，不是 `question_id`：
    //   题号只在页内唯一（真库 234 页里 35 个 scene id 跨课复用，`q1` 更是到处都有）。
    //   只按题号去重会把三门课的三道 `q1` 数成一道。
    bucket.questions.add(`${stageId}\u0000${sceneId}\u0000${questionId}`);
  }

  const names = [...buckets.keys()];
  const ids =
    names.length === 0 ? new Map<string, string>() : await resolveConceptIds(queryable, names);

  const limit =
    options.limit !== undefined && Number.isFinite(options.limit)
      ? Math.max(0, Math.min(Math.trunc(options.limit), CONCEPT_MASTERY_LIMIT))
      : CONCEPT_MASTERY_LIMIT;

  const out: ConceptMasteryRow[] = [];
  // 名字排序而不是「证据多的在前」：这是一个读数表，位置稳定才不会让人以为
  // 排名在变（与 `learner-state-render` 的稳定排序同一条理由）。
  for (const concept of names.sort()) {
    const bucket = buckets.get(concept);
    if (bucket === undefined) continue;
    out.push({
      conceptId: ids.get(concept) ?? null,
      concept,
      verdict: classifyEvidence(bucket.items, {
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      questions: bucket.questions.size,
    });
  }
  return out.slice(0, limit);
}

/**
 * 概念名 → `concept_id`。映射不上就不出现在 Map 里（调用方回 `null`）。
 *
 * 判据写进 SQL 而不是 JS：`canonical_name` 精确优先、别名只在名字映射不上时兜底、
 * 歧义别名不用、合并过的概念不用 —— 这四条都是集合层面的条件，
 * 拉回 JS 再筛会把「哪个名字没映射上」变成一堆 if。
 */
export async function resolveConceptIds(
  queryable: Queryable,
  names: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(names)].filter((name) => typeof name === 'string' && name !== '');
  const resolved = new Map<string, string>();
  if (unique.length === 0) return resolved;

  const { rows } = await queryable.query<NameRow>(RESOLVE_NAMES_SQL, [unique]);
  for (const row of rows) {
    const name = typeof row.name === 'string' ? row.name : null;
    const conceptId = typeof row.concept_id === 'string' ? row.concept_id : null;
    if (name === null || conceptId === null) continue;
    resolved.set(name, conceptId);
  }
  return resolved;
}
