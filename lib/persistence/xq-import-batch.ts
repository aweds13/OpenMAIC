/**
 * 导入批次：把「一次导入」变成一个可以在库里指着说的东西。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * `xq_graph_version` 在 2026-11-10 之后能推进了（`scripts/advance-graph-version.ts`），
 * 但推进与「导入了什么」之间没有任何连接：版号从 1 涨到 2，库里却没有任何一行
 * 说得出这次涨版是因为哪个文件、哪个抽取器、哪一门课。三张导入表
 * （`xq_intake_task` / `xq_alignment_unit` / `xq_intake_proposal`）至今 0 行，
 * 也就是说**一次导入都还没发生过** —— 版本链上只有 `baseline`。
 *
 * `xq_import_batch` 就是那条连接：一次导入 = 一批 = 一个内容哈希 + 一个抽取器 +
 * 一个图谱版本。它同时回答了「重导会不会重复」这个必须回答的问题。
 *
 * ── 为什么幂等键是五个字段而不是一个 ────────────────────────────
 *
 * | 只用 | 会怎么坏 |
 * |---|---|
 * | `stage_id` | 课程改版（同一门课换了内容）会被当成重复导入，新的那一版永远进不来 |
 * | `content_hash` | 同一份内容用两个抽取器重抽会撞车，而换抽取器**必须**重建投影 |
 * | `(stage_id, content_hash)` | 同上，少一个维度就少一种「合法的新批次」 |
 * | 再加 `graph_version` | 同一个文件在同一版图上导两次确实是同一批；跨版图重导是**新一批**，因为边与概念归属都变了 |
 *
 * 所以键是 `(stage_id, source_graph, content_hash, extractor, graph_version)`，
 * 且 `UNIQUE NULLS NOT DISTINCT` —— `source_graph` 对自有课程是 `NULL`，而 PG
 * 默认把 NULL 视为互不相等，不加这一条，自有课程每导一次都会新开一批。
 *
 * ── 内容哈希是怎么算的，以及它测不到什么 ────────────────────────
 *
 * 对象是**这门课所有页**：`(scene_id, scene_order, data)` 按 `scene_order` 排序后
 * 拼成规范化 JSON（键按码点排序，这样同一份数据由不同插入顺序写成也得到同一个
 * 哈希），取 sha256 十六进制。
 *
 * ★ 它测的是「逐课」而不是「逐页」：一门课的第二版改了 3 页，整门课的哈希
 * 完全不同 ⇒ 判为新批次。这是**想要的**（增量），但它回答不了「这两批里有多少
 * 页是一样的」。那个问题靠逐页 `pageHashOf()` + 读时比对 `stale_since`，
 * 不靠批次哈希。把两个问题混成一个，会让「改了 3 页」被当成「整门课作废」。
 *
 * ── 为什么状态是 open / applied / abandoned 三个 ─────────────────
 *
 * 批次开出来到落定之间，写 occurrence 随时可能失败。让它在 `open` 期间可重试、
 * 落定时一次性写 `applied_at`，比「一把梭成功或什么都不留」更接近真实：
 * 半途而废的一批应该能被看见并被标成 `abandoned`，而不是消失。
 *
 * `xq_import_batch_applied_pair` 那条 CHECK 是双向的：`status='applied'` 当且仅当
 * `applied_at IS NOT NULL`。单向约束挡不住「status 还是 open 但已经填了 applied_at」
 * 那种半截状态，而那种行会让「这批到底落没落定」永远说不清。
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

/** `xq_import_batch.origin` 的四个取值。 */
export const IMPORT_ORIGINS = [
  'own-course',
  'foreign-course',
  'material',
  'external-graph',
] as const;
export type ImportOrigin = (typeof IMPORT_ORIGINS)[number];

/** `xq_import_batch.status` 的三个取值。 */
export const IMPORT_BATCH_STATUSES = ['open', 'applied', 'abandoned'] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export interface ImportBatch {
  batchId: string;
  stageId: string;
  origin: ImportOrigin;
  sourceGraph: string | null;
  sourceRef: string | null;
  contentHash: string;
  extractor: string;
  graphVersion: number;
  status: ImportBatchStatus;
  createdAt: Date;
  appliedAt: Date | null;
}

/** 算内容哈希时要喂进去的一页 —— 只要这三样，其余列不影响「这份内容是什么」。 */
export interface PageContentInput {
  sceneId: string;
  sceneOrder: number;
  data: unknown;
}

export interface OpenImportBatchInput {
  stageId: string;
  origin: ImportOrigin;
  /** `origin === 'external-graph'` 时必填，其余必须为空（库里有双向 CHECK）。 */
  sourceGraph?: string;
  sourceRef?: string;
  contentHash: string;
  extractor: string;
  graphVersion: number;
}

export interface OpenImportBatchResult {
  batch: ImportBatch;
  /** `false` 表示这一批已经存在（同一份内容 + 同一个抽取器 + 同一个版图）—— 幂等命中。 */
  created: boolean;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 把任意 JSON 值写成**键有序**的规范串。
 *
 * `JSON.stringify` 保留插入顺序，而 jsonb 往返之后键序可能变（PG 的 jsonb 自己
 * 就按长度 + 字节重排）。同一份页数据经两次读写可能得到两种字符串 ⇒ 哈希不稳。
 * 这里递归按键的码点排序，数组保持顺序（顺序是语义）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 一门课的内容哈希：所有页按 `scene_order` 排序后拼规范 JSON，取 sha256。
 *
 * ★ 排序键是 `scene_order` 而不是 `scene_id`：页 id 是随机串（`scene-chTrlXFTBpZs`）
 * 或序号（`scene-p3`），只按 id 排会让「同两页交换了顺序」算出**相同**的哈希 ——
 * 而顺序变了就是内容变了（大纲顺序是课程的一部分）。`sceneOrder` 相同时再用
 * id 兜底，保证排序是全序（有重复 order 的页在真库里存在）。
 */
export function contentHashOfPages(pages: readonly PageContentInput[]): string {
  const sorted = [...pages].sort((a, b) =>
    a.sceneOrder === b.sceneOrder
      ? a.sceneId < b.sceneId
        ? -1
        : a.sceneId > b.sceneId
          ? 1
          : 0
      : a.sceneOrder - b.sceneOrder,
  );
  const payload = sorted.map((page) => ({
    sceneId: page.sceneId,
    sceneOrder: page.sceneOrder,
    data: page.data,
  }));
  return sha256(canonicalJson(payload));
}

/**
 * 一页的指纹。用途只有一个：页被重生成之后，不重跑抽取也能知道
 * 「这条 occurrence 的证据基础变了」（`page_hash <> 当前页的 page_hash` ⇒ 置
 * `stale_since`）。这是读时校验，不是触发器 —— 触发器会让每次写页都变慢，
 * 而判据只需要在「谁要读这批」时成立。
 */
export function pageHashOf(data: unknown): string {
  return sha256(canonicalJson(data));
}

const SELECT_BATCH_COLUMNS = `batch_id::text AS batch_id, stage_id, origin, source_graph, source_ref,
       content_hash, extractor, graph_version, status, created_at, applied_at`;

const INSERT_BATCH_SQL = `INSERT INTO xq_import_batch
    (stage_id, origin, source_graph, source_ref, content_hash, extractor, graph_version)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (stage_id, source_graph, content_hash, extractor, graph_version) DO NOTHING
  RETURNING ${SELECT_BATCH_COLUMNS}`;

const SELECT_BATCH_BY_KEY_SQL = `SELECT ${SELECT_BATCH_COLUMNS}
  FROM xq_import_batch
 WHERE stage_id = $1
   AND source_graph IS NOT DISTINCT FROM $2
   AND content_hash = $3
   AND extractor = $4
   AND graph_version = $5`;

const APPLY_BATCH_SQL = `UPDATE xq_import_batch
   SET status = 'applied', applied_at = now()
 WHERE batch_id = $1::uuid AND status = 'open'
 RETURNING ${SELECT_BATCH_COLUMNS}`;

const ABANDON_BATCH_SQL = `UPDATE xq_import_batch
   SET status = 'abandoned'
 WHERE batch_id = $1::uuid AND status = 'open'
 RETURNING ${SELECT_BATCH_COLUMNS}`;

const READ_BATCHES_SQL = `SELECT ${SELECT_BATCH_COLUMNS}
  FROM xq_import_batch
 WHERE ($1::text IS NULL OR stage_id = $1)
 ORDER BY created_at DESC, batch_id
 LIMIT $2`;

const READ_BATCH_BY_ID_SQL = `SELECT ${SELECT_BATCH_COLUMNS}
  FROM xq_import_batch
 WHERE batch_id = $1::uuid`;

interface BatchRow extends Record<string, unknown> {
  batch_id: unknown;
  stage_id: unknown;
  origin: unknown;
  source_graph: unknown;
  source_ref: unknown;
  content_hash: unknown;
  extractor: unknown;
  graph_version: unknown;
  status: unknown;
  created_at: unknown;
  applied_at: unknown;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function asBatch(row: BatchRow): ImportBatch | null {
  const batchId = asText(row.batch_id);
  const stageId = asText(row.stage_id);
  const origin = asText(row.origin);
  const contentHash = asText(row.content_hash);
  const extractor = asText(row.extractor);
  const status = asText(row.status);
  const graphVersion =
    typeof row.graph_version === 'number' ? row.graph_version : Number(row.graph_version);
  const createdAt = asDate(row.created_at);
  if (
    batchId === null ||
    stageId === null ||
    contentHash === null ||
    extractor === null ||
    createdAt === null ||
    !Number.isInteger(graphVersion) ||
    !(IMPORT_ORIGINS as readonly string[]).includes(origin ?? '') ||
    !(IMPORT_BATCH_STATUSES as readonly string[]).includes(status ?? '')
  ) {
    return null;
  }
  return {
    batchId,
    stageId,
    origin: origin as ImportOrigin,
    sourceGraph: asText(row.source_graph),
    sourceRef: asText(row.source_ref),
    contentHash,
    extractor,
    graphVersion,
    status: status as ImportBatchStatus,
    createdAt,
    appliedAt: asDate(row.applied_at),
  };
}

/**
 * 开一批（或认出已经存在的那一批）。
 *
 * 返回 `created: false` 不是错误，是幂等命中 —— 同一份内容、同一个抽取器、
 * 同一个版图再导一次，就不该新开批。
 */
export async function openImportBatch(
  queryable: Queryable,
  input: OpenImportBatchInput,
): Promise<OpenImportBatchResult> {
  if (input.stageId.trim() === '') throw new RangeError('xq: import batch needs a stageId');
  if (!HASH_PATTERN.test(input.contentHash)) {
    throw new RangeError('xq: import batch contentHash must be 64 lowercase hex chars');
  }
  if (input.extractor.trim() === '')
    throw new RangeError('xq: import batch needs an extractor name');
  if (!Number.isInteger(input.graphVersion) || input.graphVersion < 1) {
    throw new RangeError('xq: import batch needs a positive graphVersion');
  }
  const external = input.origin === 'external-graph';
  if (external && (input.sourceGraph ?? '').trim() === '') {
    throw new RangeError('xq: external-graph batches need a sourceGraph');
  }

  const { rows } = await queryable.query<BatchRow>(INSERT_BATCH_SQL, [
    input.stageId,
    input.origin,
    external ? (input.sourceGraph as string) : null,
    input.sourceRef ?? null,
    input.contentHash,
    input.extractor,
    input.graphVersion,
  ]);
  if (rows.length > 0) {
    const batch = asBatch(rows[0]);
    if (batch === null)
      throw new RangeError('xq: import batch row came back in an unexpected shape');
    return { batch, created: true };
  }

  const existing = await queryable.query<BatchRow>(SELECT_BATCH_BY_KEY_SQL, [
    input.stageId,
    external ? (input.sourceGraph as string) : null,
    input.contentHash,
    input.extractor,
    input.graphVersion,
  ]);
  const batch = existing.rows.length > 0 ? asBatch(existing.rows[0]) : null;
  if (batch === null) {
    // 插入被冲突挡下、按同样的键又查不到 —— 只可能是并发删除或约束口径不一致。
    throw new RangeError('xq: import batch conflicted but could not be read back');
  }
  return { batch, created: false };
}

async function transitionBatch(
  queryable: Queryable,
  sql: string,
  batchId: string,
): Promise<{ ok: boolean; batch: ImportBatch | null }> {
  const { rows } = await queryable.query<BatchRow>(sql, [batchId]);
  if (rows.length > 0) return { ok: true, batch: asBatch(rows[0]) };
  const current = await queryable.query<BatchRow>(READ_BATCH_BY_ID_SQL, [batchId]);
  return { ok: false, batch: current.rows.length > 0 ? asBatch(current.rows[0]) : null };
}

/** 把一批标成落定。已经落定的批次会原样回来（`ok: false`），不重复写时刻。 */
export async function applyImportBatch(
  queryable: Queryable,
  batchId: string,
): Promise<{ ok: boolean; batch: ImportBatch | null }> {
  return transitionBatch(queryable, APPLY_BATCH_SQL, batchId);
}

/** 放弃一批。只对 `open` 生效 —— 已落定的批次不该被改成放弃。 */
export async function abandonImportBatch(
  queryable: Queryable,
  batchId: string,
): Promise<{ ok: boolean; batch: ImportBatch | null }> {
  return transitionBatch(queryable, ABANDON_BATCH_SQL, batchId);
}

/** 按批次时间倒序读。`stageId` 不给就是全库，`limit` 非正数回空数组。 */
export async function readImportBatches(
  queryable: Queryable,
  options: { stageId?: string; limit?: number } = {},
): Promise<ImportBatch[]> {
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.trunc(options.limit as number))
    : 50;
  if (limit === 0) return [];
  const { rows } = await queryable.query<BatchRow>(READ_BATCHES_SQL, [
    options.stageId ?? null,
    limit,
  ]);
  const batches: ImportBatch[] = [];
  for (const row of rows) {
    const batch = asBatch(row);
    if (batch !== null) batches.push(batch);
  }
  return batches;
}
