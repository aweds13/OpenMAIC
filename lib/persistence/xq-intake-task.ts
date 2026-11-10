/**
 * 一次「我要学点什么」的**写入与收口**：任务一行，对齐单元若干行。
 *
 * ## 为什么任务与单元是两张表、而不是一张
 *
 * 任务是「这一趟为什么来」（用户原话 + 来源 + 能信到什么程度），单元是
 * 「这一趟被切成哪些值得先教的东西」。一次任务有 N 个单元，而 `confidence`
 * 这个判断**只能在一批单元都算完之后才成立**（要看有几格是实测的）。塞进
 * 一张表就变成「每个单元抄一份任务级结论」，两处一漂就没人知道该信哪份。
 *
 * ## 为什么 `confidence` 是纯规则算的，不是模型说的
 *
 * 三档（`probe-backed` / `band-only` / `guess`）直接决定「能不能据此跳过」。
 * 让模型来说这个词，等于让最想推进流程的那一方决定「证据够不够」——
 * 而这条链上唯一会让用户受损的动作就是跳过。所以这里是三步 if：
 *
 *   1. `known` / `not-learned` 且 `proxy=false` 的单元 **≥ 2** ⇒ `probe-backed`
 *   2. 至少一个单元 `anchor='course-band'` 且票比 **≥ 1.5** ⇒ `band-only`
 *   3. 其余 ⇒ `guess`
 *
 * 第 1 条那个「≥ 2」不是随便取的：单个格子可能是运气（一道题猜对），
 * 两个独立格子同向才勉强算证据。这个数**没有被任何研究标定过**，所以它写在
 * 常量里、写在注释里，而不是散在判断里。
 *
 * ## 为什么 `proxy` 必须在数据层，且 `known` 不许是代理证据
 *
 * 「这一格会」这个结论有两个来源：真答过题，和从别处推的（课程带、keyPoint
 * 覆盖率）。后者在我们实测里常常是错的（`ratio=1.38 < 1.5` 的那些章）。
 * 下游若只看到 `tri='known'`，它无法分辨这两种，于是「按代理证据跳过」
 * 一定会发生。所以 `proxy` 是一个独立的布尔列，而这里再钉一层：
 * **`tri` 是 `known` / `not-learned` 时 `proxy` 必须是 false** ——
 * 代理证据只能推出 `half` 或 `unknown`。
 *
 * ## 为什么写入必须给事务
 *
 * 任务行与单元行要么一起出现，要么都不出现。只有任务没有单元，这份对齐
 * 就是「一个什么都没说的目标」，而它与「单元还没算」长得一模一样。
 * 所以 `beginIntake` 收 `WithTransaction` 而不是 `Queryable` —— 不给事务
 * 就没有这个函数，不做「退化成串行执行」那种宽容。
 */
import { randomUUID } from 'node:crypto';

import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';

export const INTAKE_KINDS = ['course', 'outline', 'utterance'] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

export const INTAKE_CONFIDENCES = ['probe-backed', 'band-only', 'guess'] as const;
export type IntakeConfidence = (typeof INTAKE_CONFIDENCES)[number];

export const INTAKE_STATUSES = ['open', 'teaching', 'done', 'abandoned'] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/** 收口时才允许的两个终态；`open` 不能通过 `closeIntake` 写回去。 */
export const CLOSABLE_INTAKE_STATUSES = ['teaching', 'done', 'abandoned'] as const;
export type ClosableIntakeStatus = (typeof CLOSABLE_INTAKE_STATUSES)[number];

export const ALIGNMENT_TRI = ['known', 'half', 'not-learned', 'unknown'] as const;
export type AlignmentTri = (typeof ALIGNMENT_TRI)[number];

export const ALIGNMENT_ANCHORS = ['probe', 'course-band', 'keypoint-weak'] as const;
export type AlignmentAnchor = (typeof ALIGNMENT_ANCHORS)[number];

export const ALIGNMENT_UNIT_KINDS = ['cell', 'chapter', 'keypoint'] as const;
export type AlignmentUnitKind = (typeof ALIGNMENT_UNIT_KINDS)[number];

export const ALIGNMENT_PRIORITIES = ['core', 'important', 'advanced', 'optional'] as const;
export type AlignmentPriority = (typeof ALIGNMENT_PRIORITIES)[number];

/**
 * 排序权重（四档 → 4/3/2/1）。
 *
 * ★ 导出的不是为了复用，是为了**只写一份**：排序函数用它，将来的界面也用
 * 它排；两处各写一个 `core: 4` 的映射，改档那天必然漏一处。
 */
export const PRIORITY_WEIGHT: Readonly<Record<AlignmentPriority, number>> = {
  core: 4,
  important: 3,
  advanced: 2,
  optional: 1,
};

/** `probe-backed` 需要几个独立的实测单元。★ 未被标定，见文件头。 */
export const PROBE_BACKED_MIN_UNITS = 2;

/** `band-only` 需要的票比下限。★ 与 D 文档 §B3 的 1.5 一致，未被独立标定。 */
export const BAND_ONLY_MIN_VOTE_RATIO = 1.5;

/** 一次读取最多回多少条任务（与提案队列取同一个上限）。 */
export const INTAKE_READ_LIMIT = 100;

/** 一个待写的对齐单元。`ord` 与 `idx` 由 `orderUnits()` 分配，调用方不填。 */
export interface AlignmentUnitInput {
  readonly unitId: string;
  readonly label: string;
  readonly unitKind: AlignmentUnitKind;
  readonly stageId?: string | null;
  readonly sceneId?: string | null;
  readonly chapterId?: string | null;
  readonly keyPoint?: string | null;
  readonly tri: AlignmentTri;
  readonly n?: number;
  readonly k?: number;
  readonly lb5?: number | null;
  readonly ub95?: number | null;
  readonly anchor: AlignmentAnchor;
  readonly proxy: boolean;
  readonly priority?: AlignmentPriority;
  readonly knLevel?: number | null;
  readonly chapterVoteRatio?: number | null;
  readonly evidence?: readonly string[];
  readonly blockedBy?: readonly string[];
}

export interface IntakeUnit extends AlignmentUnitInput {
  readonly taskId: string;
  readonly idx: number;
  readonly ord: number;
}

export interface IntakeTask {
  readonly taskId: string;
  readonly goal: string;
  readonly kind: IntakeKind;
  readonly status: IntakeStatus;
  readonly confidence: IntakeConfidence;
  readonly sourceRefs: unknown;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

/** 一次读回的完整对齐：任务 + 全部单元（按 `ord` 升序）。 */
export interface IntakeReport {
  readonly task: IntakeTask;
  readonly units: readonly IntakeUnit[];
}

export interface BeginIntakeInput {
  /** 用户原话，不加工。 */
  readonly goal: string;
  readonly kind: IntakeKind;
  readonly sourceRefs: unknown;
  readonly units: readonly AlignmentUnitInput[];
  /** 显式给 id 时用于重放；省略则新生成。 */
  readonly taskId?: string;
}

export interface BeginIntakeResult {
  readonly task: IntakeTask;
  readonly units: readonly IntakeUnit[];
  readonly created: boolean;
}

export interface CloseIntakeInput {
  readonly taskId: string;
  readonly status: ClosableIntakeStatus;
}

export interface CloseIntakeResult {
  readonly ok: boolean;
  readonly reason?: 'not-found' | 'already-closed';
  readonly task?: IntakeTask;
}

/**
 * 一个新的任务 id。
 *
 * 形如 `t_` + 12 位十六进制 —— 与概念 id（`c_` + 12 位）**不同前缀**：
 * 两者会出现在同一份日志里，前缀一样就得靠上下文分辨那是哪一个。
 */
export function newIntakeTaskId(): string {
  return `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * 按 D 文档 §B3 的三步规则算 `confidence`。纯函数，不查库。
 */
export function deriveIntakeConfidence(units: readonly AlignmentUnitInput[]): IntakeConfidence {
  const measured = units.filter(
    (unit) => !unit.proxy && (unit.tri === 'known' || unit.tri === 'not-learned'),
  );
  if (measured.length >= PROBE_BACKED_MIN_UNITS) return 'probe-backed';

  const banded = units.filter(
    (unit) =>
      unit.anchor === 'course-band' &&
      typeof unit.chapterVoteRatio === 'number' &&
      unit.chapterVoteRatio >= BAND_ONLY_MIN_VOTE_RATIO,
  );
  if (banded.length > 0) return 'band-only';

  return 'guess';
}

/**
 * 建议学习顺序：先排「不会的」，再排「不知道的」，最后才是「会的」。
 *
 * ★ 不按 tri 的字母序、也不按插入顺序 —— 照插入顺序会先塞「你已经会的」，
 * 因为那最容易讲。这是所有教学系统最常见的浪费。
 */
export function orderUnits(
  taskId: string,
  units: readonly AlignmentUnitInput[],
): readonly IntakeUnit[] {
  const triRank: Record<AlignmentTri, number> = {
    'not-learned': 0,
    unknown: 1,
    half: 2,
    known: 3,
  };
  const sorted = [...units].sort((a, b) => {
    const byTri = triRank[a.tri] - triRank[b.tri];
    if (byTri !== 0) return byTri;
    const byPriority =
      PRIORITY_WEIGHT[b.priority ?? 'important'] - PRIORITY_WEIGHT[a.priority ?? 'important'];
    if (byPriority !== 0) return byPriority;
    const byLevel = (a.knLevel ?? Number.MAX_SAFE_INTEGER) - (b.knLevel ?? Number.MAX_SAFE_INTEGER);
    if (byLevel !== 0) return byLevel;
    // 最后按 unitId 的码点序兜底 —— 不用 localeCompare（随 ICU 版本变）。
    return a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0;
  });
  return sorted.map((unit, index) => ({ ...unit, taskId, idx: index, ord: index }));
}

/** 一格三态（`xq_cell_state` 或渲染器里的同形结构）。 */
export interface CellStateLike {
  readonly stageId: string;
  readonly sceneId: string;
  readonly tri: 'known' | 'not-learned' | 'unknown';
  readonly n: number;
  readonly k: number;
  readonly lb5?: number | null;
  readonly ub95?: number | null;
  readonly title?: string | null;
}

/**
 * 把现有三态格子折成对齐单元。
 *
 * ★ `proxy = n === 0`：没有一条作答记录的格子，它的 `unknown` 是**推的**
 * （从「这一页没题」或「题太少」推出来的），不是答出来的。这一条让
 * 「零作答的格子」永远不会变成 `probe-backed` 的分子。
 *
 * ★ `label` 取页标题；没有标题就退回 `stageId/sceneId` —— 不编一个
 * 「第 3 页」这种不知道从哪来的名字。
 */
export function unitsFromCellStates(
  taskId: string,
  cells: readonly CellStateLike[],
): readonly AlignmentUnitInput[] {
  return cells.map((cell) => {
    const evidence =
      cell.n > 0
        ? [`probe: ${cell.stageId}/${cell.sceneId} ${cell.k}/${cell.n} correct`]
        : [`none: ${cell.stageId}/${cell.sceneId} 没有任何作答记录`];
    return {
      unitId: `${taskId}:${cell.stageId}:${cell.sceneId}`,
      label: cell.title?.trim() ? cell.title : `${cell.stageId}/${cell.sceneId}`,
      unitKind: 'cell' as const,
      stageId: cell.stageId,
      sceneId: cell.sceneId,
      tri: cell.tri,
      n: cell.n,
      k: cell.k,
      lb5: cell.lb5 ?? null,
      ub95: cell.ub95 ?? null,
      anchor: cell.n > 0 ? ('probe' as const) : ('keypoint-weak' as const),
      proxy: cell.n === 0,
      priority: 'important' as const,
      knLevel: null,
      chapterVoteRatio: null,
      evidence,
      blockedBy: [],
    };
  });
}

/**
 * 校验一个单元的字段组合是否自洽。抛 `RangeError`，没有「宽容模式」。
 */
function assertUnit(unit: AlignmentUnitInput, index: number): void {
  const where = `xq: alignment unit #${index} (${unit.unitId || '空 id'})`;
  if (!unit.unitId.trim()) throw new RangeError(`xq: alignment unit #${index} has an empty unitId`);
  if (!unit.label.trim()) throw new RangeError(`${where} has an empty label`);
  if (!(ALIGNMENT_UNIT_KINDS as readonly string[]).includes(unit.unitKind)) {
    throw new RangeError(`${where} has an unknown unitKind: ${unit.unitKind}`);
  }
  if (!(ALIGNMENT_TRI as readonly string[]).includes(unit.tri)) {
    throw new RangeError(`${where} has an unknown tri: ${unit.tri}`);
  }
  if (!(ALIGNMENT_ANCHORS as readonly string[]).includes(unit.anchor)) {
    throw new RangeError(`${where} has an unknown anchor: ${unit.anchor}`);
  }
  if (unit.unitKind === 'cell' && (!unit.stageId || !unit.sceneId)) {
    throw new RangeError(`${where} is a cell unit but has no stageId/sceneId`);
  }
  if (unit.unitKind === 'chapter' && !unit.chapterId) {
    throw new RangeError(`${where} is a chapter unit but has no chapterId`);
  }
  if (unit.unitKind === 'keypoint' && !unit.keyPoint) {
    throw new RangeError(`${where} is a keypoint unit but has no keyPoint`);
  }
  // ★ 代理证据不许当跳过依据 —— 在写入口就把这条钉死。
  if (unit.proxy && (unit.tri === 'known' || unit.tri === 'not-learned')) {
    throw new RangeError(
      `${where} claims tri=${unit.tri} from proxy evidence; proxy can only say half/unknown`,
    );
  }
  if ((unit.n ?? 0) < 0 || (unit.k ?? 0) < 0) {
    throw new RangeError(`${where} has a negative n or k`);
  }
  if ((unit.k ?? 0) > (unit.n ?? 0)) {
    throw new RangeError(`${where} has k > n (${unit.k} > ${unit.n})`);
  }
}

const INSERT_TASK_SQL = `INSERT INTO xq_intake_task (task_id, goal, kind, source_refs, confidence, status)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'open')
  ON CONFLICT (task_id) DO NOTHING
  RETURNING task_id`;

const SELECT_TASK_SQL = `SELECT task_id, goal, kind, status, confidence, source_refs, created_at, closed_at
  FROM xq_intake_task`;

const INSERT_UNIT_SQL = `INSERT INTO xq_alignment_unit (
    task_id, unit_id, idx, label, unit_kind, stage_id, scene_id, chapter_id, key_point,
    tri, n, k, lb5, ub95, anchor, proxy, priority, kn_level, ord, evidence, blocked_by
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb)
  ON CONFLICT (task_id, unit_id) DO NOTHING
  RETURNING unit_id`;

const SELECT_UNITS_SQL = `SELECT task_id, unit_id, idx, label, unit_kind, stage_id, scene_id, chapter_id,
       key_point, tri, n, k, lb5, ub95, anchor, proxy, priority, kn_level, ord, evidence, blocked_by
  FROM xq_alignment_unit
 WHERE task_id = $1
 ORDER BY ord, unit_id`;

const CLOSE_TASK_SQL = `UPDATE xq_intake_task
     SET status = $2,
         closed_at = CASE WHEN $2 = 'teaching' THEN NULL ELSE now() END
   WHERE task_id = $1 AND status IN ('open', 'teaching')
  RETURNING task_id`;

/**
 * 开一次任务：任务行 + 全部单元行，**一个事务**。
 *
 * 重放同一个 `taskId` 时不会写第二份：任务行冲突就返回已存在的那一行，
 * `created: false`。这条是为了让「上一步超时了，重跑一次」不会留下两份对齐。
 */
export async function beginIntake(
  transaction: WithTransaction,
  input: BeginIntakeInput,
): Promise<BeginIntakeResult> {
  if (!input.goal.trim()) throw new RangeError('xq: an intake task needs a goal');
  if (!(INTAKE_KINDS as readonly string[]).includes(input.kind)) {
    throw new RangeError(`xq: unknown intake kind: ${input.kind}`);
  }
  if (input.sourceRefs === undefined || input.sourceRefs === null) {
    throw new RangeError('xq: an intake task needs sourceRefs (even if it is an empty object)');
  }
  input.units.forEach((unit, index) => assertUnit(unit, index));

  const taskId = input.taskId?.trim() ? input.taskId.trim() : newIntakeTaskId();
  const confidence = deriveIntakeConfidence(input.units);
  const units = orderUnits(taskId, input.units);

  return transaction(async (tx) => {
    const inserted = await tx.query<{ task_id: string }>(INSERT_TASK_SQL, [
      taskId,
      input.goal.trim(),
      input.kind,
      JSON.stringify(input.sourceRefs),
      confidence,
    ]);
    const created = inserted.rows.length > 0;

    if (created) {
      for (const unit of units) {
        await tx.query(INSERT_UNIT_SQL, [
          taskId,
          unit.unitId,
          unit.idx,
          unit.label,
          unit.unitKind,
          unit.stageId ?? null,
          unit.sceneId ?? null,
          unit.chapterId ?? null,
          unit.keyPoint ?? null,
          unit.tri,
          unit.n ?? 0,
          unit.k ?? 0,
          unit.lb5 ?? null,
          unit.ub95 ?? null,
          unit.anchor,
          unit.proxy,
          unit.priority ?? 'important',
          unit.knLevel ?? null,
          unit.ord,
          JSON.stringify(unit.evidence ?? []),
          JSON.stringify(unit.blockedBy ?? []),
        ]);
      }
    }

    const task = await readIntakeIn(tx, taskId);
    if (!task) throw new Error(`xq: intake ${taskId} vanished inside its own transaction`);
    return { task: task.task, units: task.units, created };
  });
}

async function readIntakeIn(queryable: Queryable, taskId: string): Promise<IntakeReport | null> {
  const taskRows = await queryable.query<Record<string, unknown>>(
    `${SELECT_TASK_SQL} WHERE task_id = $1`,
    [taskId],
  );
  const task = asTask(taskRows.rows[0]);
  if (!task) return null;
  const unitRows = await queryable.query<Record<string, unknown>>(SELECT_UNITS_SQL, [taskId]);
  return {
    task,
    units: unitRows.rows.map(asUnit).filter((unit): unit is IntakeUnit => unit !== null),
  };
}

/** 读一次对齐（任务 + 单元）。任务不存在回 `null`，不抛。 */
export async function readIntake(
  queryable: Queryable,
  taskId: string,
): Promise<IntakeReport | null> {
  return readIntakeIn(queryable, taskId);
}

/**
 * 收口：`teaching`（这一趟讲起来了）/ `done` / `abandoned`。
 *
 * ★ `teaching` 把 `closed_at` 写回 NULL —— 「讲到一半」不是结束，
 * 下次开工还要能按 `xq_session_open_idx` 那套逻辑找回来。
 */
export async function closeIntake(
  queryable: Queryable,
  input: CloseIntakeInput,
): Promise<CloseIntakeResult> {
  if (!(CLOSABLE_INTAKE_STATUSES as readonly string[]).includes(input.status)) {
    throw new RangeError(`xq: ${input.status} is not a closable intake status`);
  }
  const updated = await queryable.query<{ task_id: string }>(CLOSE_TASK_SQL, [
    input.taskId,
    input.status,
  ]);
  const report = await readIntakeIn(queryable, input.taskId);
  if (updated.rows.length === 1) {
    return report ? { ok: true, task: report.task } : { ok: false, reason: 'not-found' };
  }
  if (!report) return { ok: false, reason: 'not-found' };
  // 行在、但状态已经是终态 —— 与「没有这一行」是两件事，分开说。
  return { ok: false, reason: 'already-closed', task: report.task };
}

/** 列任务，最近的在前。默认只列没结束的（`open` / `teaching`）。 */
export async function readIntakes(
  queryable: Queryable,
  options: { status?: IntakeStatus | 'active'; limit?: number } = {},
): Promise<readonly IntakeTask[]> {
  const limit = Number.isFinite(options.limit)
    ? Math.trunc(options.limit as number)
    : INTAKE_READ_LIMIT;
  if (limit <= 0) return [];
  const capped = Math.min(limit, INTAKE_READ_LIMIT);
  const status = options.status ?? 'active';
  const clause = status === 'active' ? `WHERE status IN ('open', 'teaching')` : `WHERE status = $1`;
  const params = status === 'active' ? [] : [status];
  const rows = await queryable.query<Record<string, unknown>>(
    `${SELECT_TASK_SQL} ${clause} ORDER BY created_at DESC, task_id LIMIT ${capped}`,
    params,
  );
  return rows.rows.map(asTask).filter((task): task is IntakeTask => task !== null);
}

function asTask(row: Record<string, unknown> | undefined): IntakeTask | null {
  if (!row) return null;
  const taskId = typeof row.task_id === 'string' ? row.task_id : '';
  const goal = typeof row.goal === 'string' ? row.goal : '';
  const kind = typeof row.kind === 'string' ? row.kind : '';
  const status = typeof row.status === 'string' ? row.status : '';
  const confidence = typeof row.confidence === 'string' ? row.confidence : '';
  if (!taskId || !goal) return null;
  if (!(INTAKE_KINDS as readonly string[]).includes(kind)) return null;
  if (!(INTAKE_STATUSES as readonly string[]).includes(status)) return null;
  if (!(INTAKE_CONFIDENCES as readonly string[]).includes(confidence)) return null;
  return {
    taskId,
    goal,
    kind: kind as IntakeKind,
    status: status as IntakeStatus,
    confidence: confidence as IntakeConfidence,
    sourceRefs: row.source_refs ?? null,
    createdAt: asDate(row.created_at) ?? new Date(0),
    closedAt: asDate(row.closed_at),
  };
}

function asUnit(row: Record<string, unknown>): IntakeUnit | null {
  const taskId = typeof row.task_id === 'string' ? row.task_id : '';
  const unitId = typeof row.unit_id === 'string' ? row.unit_id : '';
  const label = typeof row.label === 'string' ? row.label : '';
  const unitKind = typeof row.unit_kind === 'string' ? row.unit_kind : '';
  const tri = typeof row.tri === 'string' ? row.tri : '';
  const anchor = typeof row.anchor === 'string' ? row.anchor : '';
  if (!taskId || !unitId || !label) return null;
  if (!(ALIGNMENT_UNIT_KINDS as readonly string[]).includes(unitKind)) return null;
  if (!(ALIGNMENT_TRI as readonly string[]).includes(tri)) return null;
  if (!(ALIGNMENT_ANCHORS as readonly string[]).includes(anchor)) return null;
  const evidence = Array.isArray(row.evidence)
    ? row.evidence.filter((item): item is string => typeof item === 'string')
    : [];
  const blockedBy = Array.isArray(row.blocked_by)
    ? row.blocked_by.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    taskId,
    unitId,
    label,
    unitKind: unitKind as AlignmentUnitKind,
    stageId: asText(row.stage_id),
    sceneId: asText(row.scene_id),
    chapterId: asText(row.chapter_id),
    keyPoint: asText(row.key_point),
    tri: tri as AlignmentTri,
    n: asNumber(row.n),
    k: asNumber(row.k),
    lb5: asNumberOrNull(row.lb5),
    ub95: asNumberOrNull(row.ub95),
    anchor: anchor as AlignmentAnchor,
    proxy: row.proxy === true,
    priority: (asText(row.priority) as AlignmentPriority | null) ?? 'important',
    knLevel: asNumberOrNull(row.kn_level),
    idx: asNumber(row.idx),
    ord: asNumber(row.ord),
    evidence,
    blockedBy,
  };
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
