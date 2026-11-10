/**
 * 把种子图（`lib/concepts/seed.ts`）同步进 `xq_concept*` 四张表。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────
 *
 * 2026-11-10 实测：全仓 `grep buildSeedGraph` 只命中 `lib/concepts/index.ts`
 * 的 re-export、`scripts/backfill-question-concepts.ts`（**只拿它建别名索引做
 * 匹配**，不写概念表）与两个测试。也就是说「种子图 → 库」这条链**从来不在仓
 * 里** —— 库里那 104 概念 / 357 别名 / 63 外部引用 / 105 边是 2026-11-09 用
 * 一个已不在盘上的 `.tmp` 一次性脚本灌的。
 *
 * 后果不是「数据少了」，而是**这份数据不可再生**：换一台机器、重建一个库、
 * 或者只是想加一个概念，都没有人能照着仓里的代码把它再做一遍。`seed.ts` 里
 * 那 105 条带理由的先修边只存在于某次对话的上下文里。
 *
 * ── 为什么不重造 id ────────────────────────────────────────────
 *
 * 概念 id 是不承载语义的随机串（`c_` + 12 hex，见 `lib/concepts/ids.ts` 的
 * 文件头）。所以同步时**以 `canonical_name` 认领已有行**、保留它原来的 id；
 * 只有真正新的概念才 `newConceptId()`。理由：`xq_concept_occurrence` /
 * `xq_question_concept` / `xq_concept_edge` 全部按 id 外键，换一次 id 就把
 * 644 条出现记录与 71 条题级映射全部指空 —— 而它们不在本模块的管辖范围里。
 *
 * ★ 名字认领有一个已知代价：两个同名不同义的概念（同形异义）会被认成同一个。
 * 这不是本模块漏考虑，而是**种子图自己的约束** —— `buildSeedGraph()` 内部
 * 用 `aliasOwner` 查归一化冲突，撞了直接抛。真出现同形异义时，第一步是让
 * 种子图能表达它（`ambiguous`），不是让同步器去猜。
 *
 * ── 四张表的写入顺序与幂等 ──────────────────────────────────────
 *
 *   1. `xq_concept`        —— 先有行，后面三张才有外键可指。按名字 upsert。
 *   2. `xq_concept_alias`  —— `ON CONFLICT (alias, kind, concept_id) DO NOTHING`。
 *   3. `xq_concept_external_ref` —— `ON CONFLICT (source_graph, external_id)`：
 *      已指向**别的**概念时**不覆盖**，只报冲突（那是归并没做完，不该被一次
 *      同步悄悄改掉方向）。
 *   4. `xq_concept_edge`   —— `ON CONFLICT (from_id, to_id, relation)`：已存在
 *      时比较 `strength` / `reason` / `source`，**不同就更新并计数**（边是声明，
 *      改一次声明就该生效，但必须让人看见改了几条）。
 *
 * 四步都幂等：同一张图同步两次，第二次的全部计数都是 0。
 *
 * ── 为什么默认不写 ──────────────────────────────────────────────
 *
 * `execute = false` 时全部读、全部算，只回报告。理由：这个模块会一次动四张表、
 * 其中概念表是所有学情表的外键父表。默认只报告，让人先看一眼「会新增几个概念、
 * 会改几条边」再决定。
 *
 * ── 本模块不做什么 ──────────────────────────────────────────────
 *
 * - **不写 `xq_concept_occurrence`** —— 那是「哪一页在讲它」，来源是课程大纲，
 *   不是种子图（`deriveOccurrencesFromOutlines` 的输入在 `document_outlines`，
 *   不在 `seed.ts`）。
 * - **不写 `xq_question_concept`** —— 那是题级映射，走
 *   `scripts/backfill-question-concepts.ts`，规则不同（只认题干、成员访问只取
 *   链头）。
 * - **不动 `status` / `merged_into`** —— 退役与合并是人做的判断，一次同步不该
 *   把它们改回 `active`。已经 `merged` / `retired` 的概念照样认领 id，跳过其余写入。
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  buildSeedGraph,
  normalizeConceptName,
  newConceptId,
  type SeedEdge,
  type SeedGraph,
} from '@/lib/concepts';

/** 每个概念的归一化形式（规范名 / 英文名 / 别名），归一后去重。 */
export function aliasFormsOf(concept: {
  name: string;
  nameEn?: string;
  aliases?: readonly string[];
  kind: string;
}): { alias: string; kind: string }[] {
  const raw = [concept.name, concept.nameEn, ...(concept.aliases ?? [])];
  const seen = new Set<string>();
  const forms: { alias: string; kind: string }[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const alias = normalizeConceptName(value);
    if (alias === '') continue;
    // (alias, kind) 是「不含糊别名」的唯一键，同一个概念内部先自己收拢。
    const key = `${alias}\u0000${concept.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    forms.push({ alias, kind: concept.kind });
  }
  return forms;
}

/** 同步报告。每个数字都是「这次真的动了多少行」，不是「表里现在有多少行」。 */
export interface SeedSyncReport {
  /** 读到的种子图规模（概念数 / 边数 / 外部引用数 / 别名行数）。 */
  seed: { concepts: number; edges: number; externalRefs: number; aliases: number };
  /** 库里认领到的已有概念数（按 `canonical_name`）。 */
  matched: number;
  /** 这次新插入的概念数。 */
  insertedConcepts: number;
  aliases: { inserted: number; skipped: number };
  externalRefs: { inserted: number; skipped: number; conflicting: string[] };
  edges: { inserted: number; updated: number; unchanged: number };
  /** 认领不了的种子概念（同名多行等），其余照写。 */
  problems: string[];
  /** 是否真的写了库。`false` 表示这一次只算不写。 */
  written: boolean;
}

interface ConceptRow extends Record<string, unknown> {
  id: string;
  canonical_name: string;
  status: string;
}

interface AliasRow extends Record<string, unknown> {
  alias: string;
  kind: string;
  concept_id: string;
}

interface ExternalRefRow extends Record<string, unknown> {
  source_graph: string;
  external_id: string;
  concept_id: string;
}

interface EdgeRow extends Record<string, unknown> {
  from_id: string;
  to_id: string;
  relation: string;
  strength: string | null;
  reason: string | null;
  source: string | null;
}

/**
 * 把 `graph` 同步进 `queryable` 指向的库。
 *
 * `execute` 为假时只返回报告，一行都不写。
 */
export async function syncSeedGraph(
  queryable: Queryable,
  options: { graph?: SeedGraph; execute?: boolean } = {},
): Promise<SeedSyncReport> {
  const graph = options.graph ?? buildSeedGraph();
  const execute = options.execute === true;

  const report: SeedSyncReport = {
    seed: {
      concepts: graph.concepts.length,
      edges: graph.edges.length,
      externalRefs: graph.concepts.reduce((sum, c) => sum + (c.externalRefs ?? []).length, 0),
      aliases: graph.concepts.reduce((sum, c) => sum + aliasFormsOf(c).length, 0),
    },
    matched: 0,
    insertedConcepts: 0,
    aliases: { inserted: 0, skipped: 0 },
    externalRefs: { inserted: 0, skipped: 0, conflicting: [] },
    edges: { inserted: 0, updated: 0, unchanged: 0 },
    problems: [],
    written: execute,
  };

  // ── 1. 概念：按 canonical_name 认领，认领不到才新造 ──────────────
  const existing = await queryable.query<ConceptRow>(
    'SELECT id, canonical_name, status FROM xq_concept ORDER BY id',
  );
  const byName = new Map<string, ConceptRow>();
  const duplicateNames = new Set<string>();
  for (const row of existing.rows) {
    if (byName.has(row.canonical_name)) {
      duplicateNames.add(row.canonical_name);
      continue;
    }
    byName.set(row.canonical_name, row);
  }
  for (const name of duplicateNames) {
    report.problems.push(`库里有两行同名概念（${name}），同名行只认第一行`);
  }

  /** 种子 key → 库里的概念 id。后面三张表全靠它。 */
  const idByKey = new Map<string, string>();
  /**
   * 库里已经不是 `active` 的种子 key。
   *
   * 这些概念照样认领 id（不能换 —— 出现记录与题级映射按 id 指），但**不写**
   * 别名、外部引用与新边：退役/合并是人做过的判断，一次同步不该把它的叫法
   * 重新加回去，也不该给它添新的先修声明。
   */
  const inactiveKeys = new Set<string>();
  const pendingConcepts: { key: string; id: string; name: string; kind: string }[] = [];

  for (const concept of graph.concepts) {
    const hit = byName.get(concept.name);
    if (hit !== undefined) {
      idByKey.set(concept.key, hit.id);
      report.matched += 1;
      if (hit.status !== 'active') {
        inactiveKeys.add(concept.key);
        report.problems.push(
          `概念「${concept.name}」在库里是 ${hit.status}，只认领 id，不写别名、外部引用与边`,
        );
      }
      continue;
    }
    const id = newConceptId();
    idByKey.set(concept.key, id);
    pendingConcepts.push({ key: concept.key, id, name: concept.name, kind: concept.kind });
    report.insertedConcepts += 1;
  }

  if (execute && pendingConcepts.length > 0) {
    // 新概念归到当前开放的图谱版本。没有开放版本就留 NULL ——
    // 那表示「还不知道它是哪一版进的图」，比硬编一个版本诚实。
    const open = await queryable.query<{ version: number }>(
      'SELECT version FROM xq_graph_version WHERE frozen_at IS NULL ORDER BY version DESC LIMIT 1',
    );
    const createdIn = open.rows[0]?.version ?? null;
    for (const concept of pendingConcepts) {
      await queryable.query(
        `INSERT INTO xq_concept (id, canonical_name, kind, status, created_in)
         VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (id) DO NOTHING`,
        [concept.id, concept.name, concept.kind, createdIn],
      );
    }
  }

  // ── 2. 别名 ────────────────────────────────────────────────────
  const aliasRows = await queryable.query<AliasRow>(
    'SELECT alias, kind, concept_id FROM xq_concept_alias ORDER BY alias',
  );
  const aliasKey = new Set(
    aliasRows.rows.map((r) => `${r.alias}\u0000${r.kind}\u0000${r.concept_id}`),
  );
  /** 不含糊别名已被谁占用：`alias\u0000kind` → concept_id。 */
  const aliasOwner = new Map<string, string>();
  for (const row of aliasRows.rows) aliasOwner.set(`${row.alias}\u0000${row.kind}`, row.concept_id);

  const aliasesToWrite: { alias: string; kind: string; conceptId: string }[] = [];
  for (const concept of graph.concepts) {
    const conceptId = idByKey.get(concept.key);
    if (conceptId === undefined) continue;
    if (inactiveKeys.has(concept.key)) continue;
    for (const form of aliasFormsOf(concept)) {
      const rowKey = `${form.alias}\u0000${form.kind}\u0000${conceptId}`;
      if (aliasKey.has(rowKey)) {
        report.aliases.skipped += 1;
        continue;
      }
      const owner = aliasOwner.get(`${form.alias}\u0000${form.kind}`);
      if (owner !== undefined && owner !== conceptId) {
        // 一个不含糊的别名已经指向别的概念。种子图内部查过冲突，
        // 所以走到这里说明**库里有种子图不知道的别名**（别处写进来的）。
        report.problems.push(
          `别名「${form.alias}」（${form.kind}）在库里已指向 ${owner}，跳过 ${conceptId}`,
        );
        report.aliases.skipped += 1;
        continue;
      }
      aliasKey.add(rowKey);
      aliasOwner.set(`${form.alias}\u0000${form.kind}`, conceptId);
      aliasesToWrite.push({ alias: form.alias, kind: form.kind, conceptId });
      report.aliases.inserted += 1;
    }
  }

  if (execute && aliasesToWrite.length > 0) {
    for (const row of aliasesToWrite) {
      await queryable.query(
        `INSERT INTO xq_concept_alias (alias, kind, concept_id, source, confidence, ambiguous)
         VALUES ($1, $2, $3, 'seed:lib/concepts', 1.00, false)
         ON CONFLICT (alias, kind, concept_id) DO NOTHING`,
        [row.alias, row.kind, row.conceptId],
      );
    }
  }

  // ── 3. 外部引用 ────────────────────────────────────────────────
  const refRows = await queryable.query<ExternalRefRow>(
    'SELECT source_graph, external_id, concept_id FROM xq_concept_external_ref ORDER BY source_graph, external_id',
  );
  const refOwner = new Map<string, string>();
  for (const row of refRows.rows)
    refOwner.set(`${row.source_graph}\u0000${row.external_id}`, row.concept_id);

  const refsToWrite: { sourceGraph: string; externalId: string; conceptId: string }[] = [];
  for (const concept of graph.concepts) {
    const conceptId = idByKey.get(concept.key);
    if (conceptId === undefined) continue;
    if (inactiveKeys.has(concept.key)) continue;
    for (const ref of concept.externalRefs ?? []) {
      const key = `${ref.sourceGraph}\u0000${ref.externalId}`;
      const owner = refOwner.get(key);
      if (owner === conceptId) {
        report.externalRefs.skipped += 1;
        continue;
      }
      if (owner !== undefined) {
        report.externalRefs.conflicting.push(
          `${ref.sourceGraph}:${ref.externalId} 已指向 ${owner}`,
        );
        report.externalRefs.skipped += 1;
        continue;
      }
      refOwner.set(key, conceptId);
      refsToWrite.push({ sourceGraph: ref.sourceGraph, externalId: ref.externalId, conceptId });
      report.externalRefs.inserted += 1;
    }
  }

  if (execute && refsToWrite.length > 0) {
    for (const row of refsToWrite) {
      await queryable.query(
        `INSERT INTO xq_concept_external_ref (source_graph, external_id, concept_id, confidence)
         VALUES ($1, $2, $3, 1.00)
         ON CONFLICT (source_graph, external_id) DO NOTHING`,
        [row.sourceGraph, row.externalId, row.conceptId],
      );
    }
  }

  // ── 4. 边 ──────────────────────────────────────────────────────
  const edgeRows = await queryable.query<EdgeRow>(
    `SELECT from_id, to_id, relation, strength, reason, source
       FROM xq_concept_edge ORDER BY from_id, to_id, relation`,
  );
  const edgeByKey = new Map<string, EdgeRow>();
  for (const row of edgeRows.rows) {
    edgeByKey.set(`${row.from_id}\u0000${row.to_id}\u0000${row.relation}`, row);
  }

  const edgesToInsert: { edge: SeedEdge; fromId: string; toId: string }[] = [];
  const edgesToUpdate: { edge: SeedEdge; fromId: string; toId: string }[] = [];
  for (const edge of graph.edges) {
    const fromId = idByKey.get(edge.from);
    const toId = idByKey.get(edge.to);
    if (fromId === undefined || toId === undefined) {
      report.problems.push(`边的端点不在种子图里：${edge.from} → ${edge.to}`);
      continue;
    }
    if (fromId === toId) {
      report.problems.push(`自环边被跳过：${edge.from}`);
      continue;
    }
    if (inactiveKeys.has(edge.from) || inactiveKeys.has(edge.to)) {
      // 端点之一已退役/合并：这条边要么已经不需要，要么该由人去改种子图。
      // 静默跳过会让「为什么这条边没写进去」变成一个谜。
      report.problems.push(`边 ${edge.from} → ${edge.to} 的端点不是 active，跳过`);
      continue;
    }
    const hit = edgeByKey.get(`${fromId}\u0000${toId}\u0000${edge.relation}`);
    if (hit === undefined) {
      edgesToInsert.push({ edge, fromId, toId });
      continue;
    }
    const same =
      (hit.strength ?? '') === edge.strength &&
      (hit.reason ?? '') === edge.reason &&
      (hit.source ?? '') === edge.source;
    if (same) report.edges.unchanged += 1;
    else edgesToUpdate.push({ edge, fromId, toId });
  }

  report.edges.inserted = edgesToInsert.length;
  report.edges.updated = edgesToUpdate.length;

  if (execute) {
    for (const row of edgesToInsert) {
      await queryable.query(
        `INSERT INTO xq_concept_edge (from_id, to_id, relation, strength, reason, source)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (from_id, to_id, relation) DO NOTHING`,
        [
          row.fromId,
          row.toId,
          row.edge.relation,
          row.edge.strength,
          row.edge.reason,
          row.edge.source,
        ],
      );
    }
    for (const row of edgesToUpdate) {
      await queryable.query(
        `UPDATE xq_concept_edge
            SET strength = $4, reason = $5, source = $6
          WHERE from_id = $1 AND to_id = $2 AND relation = $3`,
        [
          row.fromId,
          row.toId,
          row.edge.relation,
          row.edge.strength,
          row.edge.reason,
          row.edge.source,
        ],
      );
    }
  }

  return report;
}
