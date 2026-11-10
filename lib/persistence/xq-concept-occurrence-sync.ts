/**
 * 把「哪一页在讲哪个概念」从课程页与大纲算出来，写进 `xq_concept_occurrence`。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────
 *
 * 2026-11-10 实测：全仓 `grep deriveOccurrencesFromOutlines` 除了
 * `lib/concepts/` 自身与 `scripts/backfill-question-concepts.ts` 的一句注释，
 * **只命中测试**。也就是说 `xq_concept_occurrence` 里那 644 行是 2026-11-09
 * 用一个已不在盘上的 `.tmp` 脚本灌的 —— 与种子图一样**不可再生**。新课生成
 * 之后没有任何代码会把它的页挂到概念上，「这一页在讲什么」这件事只对老课成立。
 *
 * ── 为什么关联靠 `outlineId` 而不是 id 前缀 ─────────────────────
 *
 * 大纲条目的 id 是 `p1` / `p2`，页的 id 是 `scene-p1` / `scene-chTrlXFTBpZs`
 * 这类混合形式。实测三种关联法在 214 条大纲上的命中数：
 *
 * | 关联法 | 命中 | 说明 |
 * |---|---|---|
 * | `s.id = 'scene-' \|\| o.id` | 130 | 自动生成的页恰好带前缀，生成器改过命名就断 |
 * | `s.scene_order = o.order` | 134 | 序号在大纲被重排后整体错位 |
 * | `s.data->>'outlineId' = o.id` | **160/242** | 页自带它的大纲 id，是唯一**声明式**的关联 |
 *
 * 取第三种。★ 一条大纲可以对应**多页**（`stage-GYvpbYB_aN` 的 `p3` 同时挂着
 * `scene-ChTrlXFTBpZs` 与 `scene-2jmaAS99p4sr`），所以按大纲 id 建的是
 * `Map<oid, keyPoints[]>` 的**多值**索引；写成单值 Map 会让后一页顶掉前一页的
 * keyPoints（实测有 96 页因此拿不到要点）。
 *
 * ── 正文从哪来：复用 `staticPageText()`，不自己摊 ──────────────────
 *
 * 这一条不是选择，是**仓里已经写下过的裁决**（`docs/implementation/modules.md`
 * 里 `lib/concepts/occurrence.ts` 那一行）。同一份 234 页，喂什么文字进去能算出
 * 三个数：只喂 title+keyPoints ⇒ 144 条；自己摊 canvas 的 text 元素 ⇒ 413 条；
 * 用 `staticPageText()` ⇒ **644 条 / 209 页 / 75 概念**。
 *
 * `staticPageText()`（`lib/quiz/page-text.ts`）是「这一页学生能看到哪些字」在
 * 本仓的**唯一定义** —— `coverage-gap` 与 `quiz-grounding` 用的就是它。另写一个
 * 摊平函数等于造第二个单位，两处对「这页讲过什么」的答案会不一样。差别不是
 * 一点点：它按 `data.type` 分派，`interactive` 页若带 `widgetConfig` 就读 widget
 * 字段（`description` / `starterCode` / `solution` / `hints` / `testCases`），
 * 而不是只把外壳 HTML 剥了 —— 真库 72 个 interactive 页里 **48 个带 widgetConfig**，
 * 而那 48 页的正文根本不在 html 里。
 *
 * 所以本模块**不再有**自己的正文抽取函数。第一版写过 `pageBodyText()`
 * （按 `content` 里实际有哪种结构分派），它算出来 674 行、与库对 613 行 ——
 * 看着更高的对齐率恰恰是**错的证据**：那 674 行里 61 行是「外壳 HTML 里的词被
 * 当成了正文」或者「widget 页的正文整段漏掉」，跟库对不上的是同一批页。
 * 换成 `staticPageText()` 之后是 **645 行 / 614 行逐档吻合**，`onlyDb` 60 条
 * 全部来自「历史那份用的是旧版 staticPageText」。
 *
 * ── 为什么不自己切词 ──────────────────────────────────────────
 *
 * 试过「正文切成词段再按出现次数过滤」，三种阈值下 `same` 全是 0：`occurrence.ts`
 * 查别名表用的是**整段相等**，切碎之后多字中文概念永远切不出来。正文整串交给
 * `deriveOccurrencesFromOutlines`，切词规则只有它那一份。
 *
 * ── 换对单位之后的读数（真库 2026-11-10）──────────────────────
 *
 * | 口径 | 行 | 页 | body | title | keypoint |
 * |---|---|---|---|---|---|
 * | 历史那次导入（2026-11-09） | **644** | 209 | **500** | 127 | 17 |
 * | 第一版自己摊（按 `content` 结构分派） | 674 | 211 | 529 | 126 | 19 |
 * | `staticPageText()`（本模块现在） | **645** | **209** | **500** | 126 | 19 |
 *
 * `body` 一栏是关键：第一版 529 比历史多 29 行，那 29 行正是 interactive 外壳
 * HTML 里的词被当成了正文；换成 `staticPageText()` 之后 `body` 落回 **500**，
 * 页数落回 **209**。三栏同时对上不是巧合 —— 它说明历史那次导入用的就是这个单位。
 *
 * ★ 一个不能省的口径提醒：`614 / 31 / 60` 那组比对是在**第一版自己摊的结果**
 * 上做的（当时库已被写进 674 行），不是对着历史那 644 行。真正的证据是上面
 * 那张表的第一行与第三行 —— `body 500`、`页 209` 两栏同时落回原位。库现在
 * 就是这 645 行；`--execute` 之后再跑一次是 `新增 0 / 更新 0 / 未变 645`。
 *
 * ── 为什么默认不写 ────────────────────────────────────────────
 *
 * 与 `xq-seed-sync.ts` 同一条理由，但这里更硬：本模块会**删行**。重算之后
 * 库里多出来的那些（`source` 是 `keypoint`/`title`/`body` 的）说明那一页不再
 * 讲了 —— 派生表该跟着变。但 `source = 'manual'` 的行**一行都不许删**：那是人
 * 手动挂上去的判断，本模块没有资格推翻它。这条写在 `deletable` 的判据里，
 * 不是调用方自觉。
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  buildSeedGraph,
  deriveOccurrencesFromOutlines,
  type OccurrenceDraft,
  type SeedGraph,
} from '@/lib/concepts';
import { staticPageText } from '@/lib/quiz/page-text';
import { pageHashOf } from '@/lib/persistence/xq-import-batch';

/**
 * `xq_concept_occurrence.source` 的取值域（与迁移 v6 的 CHECK 逐字一致）。
 *
 * 比本模块用得着的三档多了 `manual` 与三档 `foreign-*`：这一列是读方要解释
 * 「这条挂载凭什么存在」时唯一的依据，取值域必须完整，哪怕本模块只写三档。
 */
export const OCCURRENCE_SOURCES = [
  'keypoint',
  'title',
  'body',
  'manual',
  'foreign-keypoint',
  'foreign-body',
  'foreign-title',
] as const;

/**
 * 本模块**会生成**的来源。`manual` 不在其中 —— 它只能由人写。
 *
 * ★ `foreign-*` 三档也**不许**加进来。这个常量是删行的判据（重算后不再成立
 * 的行会被删），而外来课程挂的证据来自另一套判断（三段匹配 + 人裁决）。
 * 把它们算成「本模块的派生行」，下一次重算就会静默删掉别的链路写的东西。
 */
export const GENERATED_SOURCES = ['keypoint', 'title', 'body'] as const;

/** 一页的抽取结果，交给 `deriveOccurrencesFromOutlines`。 */
export interface PageOccurrenceInput {
  stageId: string;
  sceneId: string;
  title?: string;
  keyPoints?: string[];
  body?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 一页的正文 —— 直接调 `staticPageText()`，本模块不另写摊平逻辑。
 *
 * `data.type` 是页自身声明的类型，`staticPageText()` 按它分派；`title` 与
 * `order` 传进去只为满足签名（标题在 `deriveOccurrencesFromOutlines` 里另走
 * `title` 那一档，正文这串里再带上它会让标题命中被重复算成正文）。
 *
 * ★ 2026-11-10 修正：第一版这里有一个自己写的 `pageBodyText()`（按 `content`
 * 里实际有哪种结构分派），它算出 674 行、与库对 613 行。**那个更高的对齐率是
 * 假象** —— 它把 interactive 外壳 HTML 里的词当成正文、又漏掉了 48 个带
 * `widgetConfig` 的页的真实正文。改用仓里唯一的那个单位后是 645 行 / 614 行。
 */
export function pageBodyText(data: unknown): string {
  const record =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (record === null) return '';
  const content = record.content;
  if (typeof content !== 'object' || content === null) return '';
  return staticPageText({
    order: typeof record.order === 'number' ? record.order : 0,
    type: asText(record.type),
    // 刻意不传 title：标题有自己的档位，混进正文会把它变成 0.4 的命中。
    content,
  });
}

/**
 * 把 `document_outlines` 的九行摊成「(stage, oid) → keyPoints」的**多值**索引。
 *
 * 同一 `oid` 可能出现在多行里（大纲被重排过、或生成器重复写了同一个 id），
 * 所以值是数组的数组：一页可能命中同一 oid 的多条大纲，要点取并集。
 */
export function outlineKeyPointsByPage(
  rows: readonly { stage_id: string; data: unknown }[],
): Map<string, string[][]> {
  const index = new Map<string, string[][]>();
  for (const row of rows) {
    const outlines = asRecord(row.data)?.outlines;
    if (!Array.isArray(outlines)) continue;
    for (const raw of outlines) {
      const outline = asRecord(raw);
      if (outline === null) continue;
      const oid = asText(outline.id);
      if (oid === '') continue;
      const keyPoints: string[] = [];
      const rawPoints = outline.keyPoints;
      if (Array.isArray(rawPoints)) {
        for (const point of rawPoints) {
          const text = asText(point);
          if (text !== '') keyPoints.push(text);
        }
      }
      const key = `${row.stage_id}\u0000${oid}`;
      const bucket = index.get(key);
      if (bucket === undefined) index.set(key, [keyPoints]);
      else bucket.push(keyPoints);
    }
  }
  return index;
}

/** 同步报告。每个数字都是「这一次真的动了多少行」。 */
export interface OccurrenceSyncReport {
  /** 读到的页数。 */
  pages: number;
  /** 页里 `outlineId` 能在大纲里找到的页数（其余页只有标题与正文）。 */
  pagesWithOutline: number;
  /** 算出来的挂载行数（去重后）。 */
  occurrences: number;
  /** 按来源分。 */
  bySource: Record<string, number>;
  /** 与库比对的结果。 */
  insert: number;
  /** 权重或来源变了、要改的行。 */
  update: number;
  /** 一行都不用动。 */
  unchanged: number;
  /** 库里多出来的、本模块生成来源的行（重算后不再成立）。 */
  stale: number;
  /** 库里 `manual` 行 —— 一行都不动，只报数。 */
  manual: number;
  /** 库里 `foreign-*` 行 —— 外来课程挂的证据，本模块也不动，只报数。 */
  foreign: number;
  /** 认领不了的概念（种子图里有、库里没有）与其它异常。 */
  problems: string[];
  /** 这批挂上了多少个批次（一问一课一个批次；0 表示调用方没传 `batchIds`）。 */
  batches: number;
  written: boolean;
}

interface ConceptRow extends Record<string, unknown> {
  id: string;
  canonical_name: string;
  status: string;
}

interface OccurrenceRow extends Record<string, unknown> {
  concept_id: string;
  stage_id: string;
  scene_id: string;
  weight: string | number;
  source: string;
  batch_id: string | null;
  page_hash: string | null;
}

function rowKey(conceptId: string, stageId: string, sceneId: string): string {
  return `${conceptId}\u0000${stageId}\u0000${sceneId}`;
}

function sameWeight(left: string | number, right: number): boolean {
  return Math.abs(Number(left) - right) < 1e-9;
}

/**
 * 重算并（可选）写回 `xq_concept_occurrence`。
 *
 * `execute` 为假时全部读、全部算，只回报告，一行都不写。
 */
export async function syncConceptOccurrences(
  queryable: Queryable,
  options: {
    graph?: SeedGraph;
    execute?: boolean;
    /**
     * 课 → 批次 id。**一问一课一批**（`xq_import_batch.stage_id` 非空且有外键），
     * 所以这里是一张表而不是一个值：一次重算可以覆盖多门课，每门课各属各的批。
     * 不传就没有批次归属（老调用、单元测试走这条），行上那两列保持原样不动。
     */
    batchIds?: ReadonlyMap<string, string>;
  } = {},
): Promise<OccurrenceSyncReport> {
  const graph = options.graph ?? buildSeedGraph();
  const execute = options.execute === true;
  const batchIds = options.batchIds;

  const report: OccurrenceSyncReport = {
    pages: 0,
    pagesWithOutline: 0,
    occurrences: 0,
    bySource: {},
    insert: 0,
    update: 0,
    unchanged: 0,
    stale: 0,
    manual: 0,
    foreign: 0,
    problems: [],
    batches: batchIds === undefined ? 0 : batchIds.size,
    written: execute,
  };

  // ── 1. 概念 id 表：种子 key → 库里的 id ────────────────────────
  //
  // 这一跳**只读**概念表。按 `canonical_name` 认领，认不到的说明种子图还没
  // 同步进库（先跑 `scripts/seed-concept-graph.ts`），跳过并报出来 ——
  // 不在这里顺手新造概念，那会让「谁负责建概念」变成两个地方。
  const conceptRows = await queryable.query<ConceptRow>(
    'SELECT id, canonical_name, status FROM xq_concept ORDER BY id',
  );
  const idByName = new Map<string, string>();
  for (const row of conceptRows.rows) {
    if (idByName.has(row.canonical_name)) continue;
    idByName.set(row.canonical_name, row.id);
  }
  const idByKey = new Map<string, string>();
  for (const concept of graph.concepts) {
    const id = idByName.get(concept.name);
    if (id === undefined) {
      report.problems.push(`概念「${concept.name}」在库里没有行，先跑 seed-concept-graph.ts`);
      continue;
    }
    idByKey.set(concept.key, id);
  }

  // ── 2. 读页与大纲 ─────────────────────────────────────────────
  const outlineRows = await queryable.query<{ stage_id: string; data: unknown }>(
    'SELECT stage_id, data FROM document_outlines',
  );
  const keyPointsByPage = outlineKeyPointsByPage(outlineRows.rows);

  const sceneRows = await queryable.query<{
    stage_id: string;
    id: string;
    title: string | null;
    outline_id: string | null;
    data: unknown;
  }>(
    `SELECT stage_id, id,
            data->>'title' AS title,
            data->>'outlineId' AS outline_id,
            data
       FROM document_scenes
      ORDER BY stage_id, id`,
  );

  // ── 3. 算挂载 ─────────────────────────────────────────────────
  const desired = new Map<
    string,
    { draft: OccurrenceDraft; conceptId: string; pageHash: string; batchId: string | null }
  >();
  for (const scene of sceneRows.rows) {
    report.pages += 1;
    const oid = scene.outline_id ?? '';
    const buckets = oid === '' ? undefined : keyPointsByPage.get(`${scene.stage_id}\u0000${oid}`);
    const keyPoints = buckets === undefined ? [] : buckets.flat();
    if (buckets !== undefined) report.pagesWithOutline += 1;

    // ★ 页指纹必须覆盖**整页的 data**（不只是喂进匹配的那串正文），否则
    // 「页改了但正文没变」会被判成同一页 —— 而那种改动照样让旧证据过期。
    const pageHash = pageHashOf(scene.data);
    const batchId = batchIds?.get(scene.stage_id) ?? null;
    const input: PageOccurrenceInput = {
      stageId: scene.stage_id,
      sceneId: scene.id,
      title: scene.title ?? undefined,
      keyPoints,
      body: pageBodyText(scene.data),
    };
    for (const draft of deriveOccurrencesFromOutlines(input, graph)) {
      const conceptId = idByKey.get(draft.conceptKey);
      if (conceptId === undefined) continue;
      const key = rowKey(conceptId, draft.stageId, draft.sceneId);
      const previous = desired.get(key);
      // 同一页同一个概念只留最高档 —— `deriveOccurrencesFromOutlines` 已经做了，
      // 这里再兜一次是因为一页可能命中同一 oid 的多条大纲。
      if (previous !== undefined && previous.draft.weight >= draft.weight) continue;
      desired.set(key, { draft, conceptId, pageHash, batchId });
    }
  }

  report.occurrences = desired.size;
  for (const { draft } of desired.values()) {
    report.bySource[draft.source] = (report.bySource[draft.source] ?? 0) + 1;
  }

  // ── 4. 与库比对 ───────────────────────────────────────────────
  const existingRows = await queryable.query<OccurrenceRow>(
    `SELECT concept_id, stage_id, scene_id, weight, source, batch_id::text AS batch_id, page_hash
       FROM xq_concept_occurrence`,
  );
  const existing = new Map<string, OccurrenceRow>();
  for (const row of existingRows.rows) {
    const key = rowKey(row.concept_id, row.stage_id, row.scene_id);
    existing.set(key, row);
    if ((GENERATED_SOURCES as readonly string[]).includes(row.source)) continue;
    // `manual` 与 `foreign-*` 都不是本模块的派生行，但原因不同，分开报数：
    // 前者是人挂的，后者来自另一条链路（三段匹配 + 人裁决）。
    if (row.source === 'manual') report.manual += 1;
    else report.foreign += 1;
  }

  type Entry = {
    conceptId: string;
    draft: OccurrenceDraft;
    pageHash: string;
    batchId: string | null;
  };
  const toInsert: Entry[] = [];
  const toUpdate: Entry[] = [];
  for (const [key, entry] of desired) {
    const hit = existing.get(key);
    if (hit === undefined) {
      toInsert.push(entry);
      continue;
    }
    const sameContent =
      hit.source === entry.draft.source && sameWeight(hit.weight, entry.draft.weight);
    // ★ 内容一样但「是哪一批拍的」不一样时也要更新：一行必须指得出最近一次
    // 确认它的导入。不传 batchIds 的调用（老脚本、测试）不去动 `batch_id` ——
    // 它们不知道自己是哪一批，硬写会把已有归属抹掉。`page_hash` 不受影响：
    // 它是**页自身的属性**，谁算都一样。
    const sameBatch =
      entry.batchId === null ||
      (hit.batch_id === entry.batchId && hit.page_hash === entry.pageHash);
    if (sameContent && sameBatch) {
      report.unchanged += 1;
      continue;
    }
    toUpdate.push(entry);
  }

  // ★ 只删「本模块生成的那三档」里重算后不再成立的行。
  // `manual` 行是人挂的判断，本模块没有资格推翻 —— 这条判据写在这里，
  // 不是靠调用方记得传一个开关。
  const toDelete: string[] = [];
  for (const [key, row] of existing) {
    if (!(GENERATED_SOURCES as readonly string[]).includes(row.source)) continue;
    if (desired.has(key)) continue;
    toDelete.push(key);
  }

  report.insert = toInsert.length;
  report.update = toUpdate.length;
  report.stale = toDelete.length;

  if (!execute) return report;

  // ── 5. 写库 ───────────────────────────────────────────────────
  //
  // 顺序：先 upsert、再删多余。反过来会让「一页刚改完」这段时间里它的挂载
  // 短暂为空 —— 而读方（知识点级读数、复习卡）随时可能在读。
  for (const entry of toInsert) {
    await queryable.query(
      `INSERT INTO xq_concept_occurrence
         (concept_id, stage_id, scene_id, weight, source, batch_id, page_hash,
          first_seen_at, last_seen_at, stale_since)
       VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, now(), now(), NULL)
       ON CONFLICT (concept_id, stage_id, scene_id)
       DO UPDATE SET weight = EXCLUDED.weight,
                     source = EXCLUDED.source,
                     batch_id = coalesce(EXCLUDED.batch_id, xq_concept_occurrence.batch_id),
                     page_hash = coalesce(EXCLUDED.page_hash, xq_concept_occurrence.page_hash),
                     last_seen_at = now(),
                     stale_since = NULL`,
      [
        entry.conceptId,
        entry.draft.stageId,
        entry.draft.sceneId,
        entry.draft.weight,
        entry.draft.source,
        entry.batchId,
        entry.pageHash,
      ],
    );
  }
  for (const entry of toUpdate) {
    await queryable.query(
      `UPDATE xq_concept_occurrence
          SET weight = $4,
              source = $5,
              batch_id = coalesce($6::uuid, batch_id),
              page_hash = coalesce($7, page_hash),
              last_seen_at = now(),
              stale_since = NULL
        WHERE concept_id = $1 AND stage_id = $2 AND scene_id = $3`,
      [
        entry.conceptId,
        entry.draft.stageId,
        entry.draft.sceneId,
        entry.draft.weight,
        entry.draft.source,
        entry.batchId,
        entry.pageHash,
      ],
    );
  }
  for (const key of toDelete) {
    const row = existing.get(key);
    if (row === undefined) continue;
    await queryable.query(
      `DELETE FROM xq_concept_occurrence
        WHERE concept_id = $1 AND stage_id = $2 AND scene_id = $3
          AND source IN ('keypoint', 'title', 'body')`,
      [row.concept_id, row.stage_id, row.scene_id],
    );
  }

  return report;
}
