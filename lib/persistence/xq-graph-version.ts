/**
 * 学情（xq）的**图谱版本推进流程**：冻结旧版 → 开新版 → 给新概念写 `created_in`。
 *
 * ## 为什么需要这一层（而它之前一条都没写）
 *
 * 迁移 `3 graph-version` 与 `4 concept-expand` 已经把**结构**建好：
 * `xq_graph_version` 有一行 `1 baseline` 未冻结、`xq_concept` 有 `created_in`、
 * 偏索引 `xq_graph_version_one_open` 挡住第二个未冻结版本。规格 `SR-F11.4` 因此
 * 把「版本化」标成落地了 —— 但同一节紧跟着写死一句：**「版本的推进流程一条都没写」**。
 *
 * 那不是留白，是一个具体缺口：没有任何代码能把第 1 版冻结、开第 2 版、再让
 * 新进来的概念落在第 2 版上。而 `xq_graph_version` 的 CHECK 与偏索引此时只保证
 * 「不会有两个开放版本」，不保证「有人真的会推进」—— 一条永远不推进的版本链
 * 与一张没有版本的表，在「这个概念是哪版进的图」这个问法上给出同样的答案：
 * 都是 1。
 *
 * ## 为什么「推进」必须带 `from`（比较并交换），不能只给 label
 *
 * 两个管理员（或同一个人两个页签）同时点「开新版」时，若 SQL 只写
 * `max(version) + 1`，两条都会成功：第一版冻结、开出第 2 版，第二版再冻结第 2 版、
 * 开出第 3 版 —— 中间那一版**一秒钟都没开放过**，而它的 `label` 已经写进历史。
 * 版本历史是可重放的批号（见 `xq-learner.ts` 的注释），这种空洞无法事后解释。
 *
 * 所以 `advanceGraphVersion()` 要调用方**说出它以为当前是哪一版**：`from` 不是
 * 当前开放版本就整条不生效，回 `not-current` 并把现状给它 —— 前端刷新一次再来。
 * 这是乐观锁，不是礼貌性校验。
 *
 * ## 为什么 `created_in` 只写一次
 *
 * `xq_concept_retire_order` 允许概念从第 2 版退役，但 `created_in` 记的是
 * 「它**哪一版进来的**」—— 那是历史事实，重写它等于篡改历史。所以
 * `assignConceptsToVersion()` 只碰 `created_in IS NULL` 的行，已经归属的
 * 一行都不动，并把跳过的条数如实报出来（不静默成功）。
 *
 * 这也让它是**幂等**的：同一次导入重跑，第二次全部命中「已有归属」，写 0 行。
 *
 * ## 为什么错误分三种而不是一种
 *
 * `not-found`（那个版本根本不存在）、`already-frozen`（存在但已经关了）与
 * `not-current`（存在且开着，但不是最新的那个）在运维上是三件不同的事：
 * 第一种多半是传错了数字，第二种说明有人先推进了，第三种说明库里有多个
 * 版本行而最新那个不是你以为的。合成一个 `conflict` 就再也分不出该查什么。
 */
import type { Queryable } from '@openmaic/storage/document/pg';

/** 一版图谱：批号（不是时间戳）+ 标签 + 冻结时刻 + 落在这版上的概念数。 */
export interface GraphVersion {
  version: number;
  label: string;
  note: string | null;
  createdAt: Date;
  frozenAt: Date | null;
  /** `xq_concept.created_in = version` 的行数。 */
  concepts: number;
}

/** 推进失败的原因 —— 三种，各有各的查法（见文件头最后一节）。 */
export type GraphVersionConflict = 'not-found' | 'already-frozen' | 'not-current';

export type AdvanceGraphVersionResult =
  | { ok: true; version: GraphVersion }
  | { ok: false; reason: GraphVersionConflict; current: GraphVersion | null };

export interface AssignConceptsResult {
  /** 这次真正写进去的行数。 */
  assigned: number;
  /** 已经有归属、因此一行没动的概念数。 */
  alreadyAssigned: number;
  /** 传进来但库里不存在的概念 id（不静默丢）。 */
  missing: readonly string[];
}

const READ_VERSIONS_SQL = `
SELECT v.version,
       v.label,
       v.note,
       v.created_at,
       v.frozen_at,
       count(c.id)::int AS concepts
  FROM xq_graph_version v
  LEFT JOIN xq_concept c ON c.created_in = v.version
 GROUP BY v.version, v.label, v.note, v.created_at, v.frozen_at
 ORDER BY v.version`;

const READ_ONE_VERSION_SQL = `
SELECT v.version,
       v.label,
       v.note,
       v.created_at,
       v.frozen_at,
       count(c.id)::int AS concepts
  FROM xq_graph_version v
  LEFT JOIN xq_concept c ON c.created_in = v.version
 WHERE v.version = $1
 GROUP BY v.version, v.label, v.note, v.created_at, v.frozen_at`;

/**
 * 冻结 `from` 并开出 `from + 1`，**一条语句**。
 *
 * 为什么必须一条：冻结与新建之间只要隔一次往返，就有「冻结了但没开新的」
 * 窗口 —— 那段时间里 `created_in` 无处可写，而 `one_open` 偏索引恰好允许
 * 零个开放版本（它是唯一索引，不是 CHECK）。一次成或一次都不成。
 */
const ADVANCE_SQL = `
WITH target AS (
  SELECT version FROM xq_graph_version WHERE version = $1 AND frozen_at IS NULL
), frozen AS (
  UPDATE xq_graph_version
     SET frozen_at = now()
   WHERE version IN (SELECT version FROM target)
  RETURNING version
), created AS (
  INSERT INTO xq_graph_version (version, label, note)
  SELECT $1 + 1, $2, $3 FROM frozen
  RETURNING version
)
SELECT (SELECT count(*)::int FROM frozen) AS frozen_n,
       (SELECT version FROM created) AS created_version`;

const ASSIGN_SQL = `
UPDATE xq_concept
   SET created_in = $2,
       updated_at = now()
 WHERE id = ANY($1::text[])
   AND created_in IS NULL
RETURNING id`;

const EXISTING_CONCEPTS_SQL = `SELECT id FROM xq_concept WHERE id = ANY($1::text[])`;

const ASSIGNED_CONCEPTS_SQL = `
SELECT id FROM xq_concept
 WHERE id = ANY($1::text[])
   AND created_in IS NOT NULL`;

function asRow(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asVersionNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

/**
 * 一行版本。形状不对就整条丢 —— 半个版本（有号没标签、有标签没冻结时刻）
 * 读进内存只会让上层用 `undefined` 拼出一条看起来成立的输出。
 */
function asGraphVersion(raw: unknown): GraphVersion | null {
  const row = asRow(raw);
  const version = asVersionNumber(row.version);
  const label = asText(row.label);
  const createdAt = asDate(row.created_at);
  if (version === null || label === null || createdAt === null) return null;
  const frozenAt = asDate(row.frozen_at);
  const concepts = Number(row.concepts);
  return {
    version,
    label,
    note: asText(row.note),
    createdAt,
    frozenAt,
    concepts: Number.isFinite(concepts) && concepts >= 0 ? Math.trunc(concepts) : 0,
  };
}

/** 全部版本，按号升序。读到空表回空数组 —— 那是「还没版本化」，不是错误。 */
export async function readGraphVersions(queryable: Queryable): Promise<GraphVersion[]> {
  const { rows } = await queryable.query(READ_VERSIONS_SQL);
  const versions: GraphVersion[] = [];
  for (const row of rows as readonly unknown[]) {
    const parsed = asGraphVersion(row);
    if (parsed !== null) versions.push(parsed);
  }
  return versions;
}

/**
 * 当前**开放**的那一版（`frozen_at IS NULL`）。
 *
 * 偏索引保证最多一个；真出现多个（索引被手工删过）时回**号最大的那个**并
 * 由 `advanceGraphVersion()` 的比较并交换拦住后续推进 —— 这里不抛，
 * 因为读侧不该因为历史脏了就连「现在是什么情况」都不肯说。
 */
export function openGraphVersion(versions: readonly GraphVersion[]): GraphVersion | null {
  let open: GraphVersion | null = null;
  for (const version of versions) {
    if (version.frozenAt !== null) continue;
    if (open === null || version.version > open.version) open = version;
  }
  return open;
}

/**
 * 冻结 `from` 那一版，开出 `from + 1`。
 *
 * `from` 必须是**当前开放**的那一版；否则整条不生效并回原因（见文件头）。
 * 返回新版本行（带上此刻的概念数 0）。
 */
export async function advanceGraphVersion(
  queryable: Queryable,
  input: { from: number; label: string; note?: string | null },
): Promise<AdvanceGraphVersionResult> {
  if (!Number.isInteger(input.from) || input.from < 1) {
    throw new RangeError(`xq: graph version to advance must be a positive integer: ${input.from}`);
  }
  const label = input.label.trim();
  if (label === '') {
    throw new RangeError('xq: a new graph version needs a non-empty label');
  }

  const versions = await readGraphVersions(queryable);
  const current = openGraphVersion(versions);
  const target = versions.find((version) => version.version === input.from) ?? null;

  if (target === null) return { ok: false, reason: 'not-found', current };
  if (target.frozenAt !== null) return { ok: false, reason: 'already-frozen', current };
  if (current === null || current.version !== input.from) {
    return { ok: false, reason: 'not-current', current };
  }

  const { rows } = await queryable.query(ADVANCE_SQL, [input.from, label, input.note ?? null]);
  const result = asRow((rows as readonly unknown[])[0]);
  const frozenCount = Number(result.frozen_n);
  const createdVersion = asVersionNumber(result.created_version);

  // 两条断言式返回，而不是「假定成功」：
  //   · `frozen_n !== 1` ⇒ 比较并交换在 SQL 那一刻输了（另一进程抢先），
  //     整条语句什么都没写，回 `not-current` 让调用方重读。
  //   · 建出来的号不是 `from + 1` ⇒ 说明有人手工插过行，此时**不能**回成功，
  //     否则调用方会拿着一个错的版本号去写 `created_in`。
  if (frozenCount !== 1 || createdVersion === null || createdVersion !== input.from + 1) {
    const reread = await readGraphVersions(queryable);
    return { ok: false, reason: 'not-current', current: openGraphVersion(reread) };
  }

  const { rows: one } = await queryable.query(READ_ONE_VERSION_SQL, [createdVersion]);
  const created = asGraphVersion((one as readonly unknown[])[0]);
  if (created === null) {
    throw new Error(`xq: graph version ${createdVersion} vanished right after being created`);
  }
  return { ok: true, version: created };
}

/**
 * 把还没归属的概念钉到 `version` 上。
 *
 * 只碰 `created_in IS NULL` 的行：`created_in` 是「它哪一版进来的」，那是
 * 历史事实，重写它等于篡改历史。已经归属的一行不动，并把跳过的条数报出来。
 *
 * 目标版本必须**存在**（FK 会拒，但这里先查一次给出人话）且必须**开放**
 * —— 往已冻结的版本里塞新概念等于说「这一版的历史还在长」，与「冻结」自相矛盾。
 */
export async function assignConceptsToVersion(
  queryable: Queryable,
  input: { version: number; conceptIds: readonly string[] },
): Promise<AssignConceptsResult> {
  const ids = [...new Set(input.conceptIds.filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return { assigned: 0, alreadyAssigned: 0, missing: [] };

  const versions = await readGraphVersions(queryable);
  const target = versions.find((version) => version.version === input.version) ?? null;
  if (target === null) {
    throw new RangeError(`xq: graph version ${input.version} does not exist`);
  }
  if (target.frozenAt !== null) {
    throw new RangeError(
      `xq: graph version ${input.version} is frozen; new concepts cannot join it`,
    );
  }

  const { rows: existing } = await queryable.query(EXISTING_CONCEPTS_SQL, [ids]);
  const present = new Set(
    (existing as readonly unknown[])
      .map((row) => asRow(row).id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const missing = ids.filter((id) => !present.has(id));
  const inLibrary = ids.filter((id) => present.has(id));

  if (inLibrary.length === 0) return { assigned: 0, alreadyAssigned: 0, missing };

  // ★ 先数「已有归属」，再写。反过来的话刚写进去的那批也会被算成
  //   「已归属、没动」，于是 `assigned + alreadyAssigned` 会大于输入条数 ——
  //   那不是计数偏差，是这两个数字在说不同的时间点。
  const { rows: already } = await queryable.query(ASSIGNED_CONCEPTS_SQL, [inLibrary]);
  const alreadyCount = (already as readonly unknown[]).length;
  const { rows: assigned } = await queryable.query(ASSIGN_SQL, [inLibrary, input.version]);
  const assignedCount = (assigned as readonly unknown[]).length;

  return { assigned: assignedCount, alreadyAssigned: alreadyCount, missing };
}
