/**
 * 学情（xq）的**事件写入口**：把「这一刻发生了什么」落进 `xq_event` / `xq_session`。
 *
 * ## 为什么事件与探针证据是两个入口
 *
 * `xq-probe-recorder.ts` 写的是**结论**（`xq_probe_item`：这道题答对还是答错），
 * 它挂在 runtime append 上，因为「答完了」这件事在那边才有确定的对错。
 * 本文件写的是**过程**（翻到哪一页、什么时候开的会话、什么时候结束），
 * 它在 runtime append 里**根本不存在** —— 翻页不发任何网络请求
 * （`lib/store/stage.ts` 的 `setCurrentSceneId` 只写 zustand 与标脏）。
 *
 * 所以两者的锚点不同：探针挂在「写成功了」上，事件挂在「学习者做了」上。
 * 把翻页硬塞进 `appendRecord` 只会得到一条「翻页也算一次 append」的假记录 ——
 * 而 runtime 的 payload 校验表里 `playback` 连 skeleton 都没有。
 *
 * ## 为什么先查重再插会话
 *
 * `xq_session.session_id` **等于本会话第一条事件的 `event_id`**（DDL 注释：
 * 不发明第二个 ID 生成器）。而「同一次开始被投递两次」必须先被 `dedupe_key`
 * 挡在事件表上，否则第二次投递会再建一个会话 —— 两个会话都声称自己是
 * 「这次坐下学习」，此后所有统计都翻倍。
 *
 * 顺序因此是：按 `dedupe_key` 查已有事件 → 有就原样返回 → 没有才建会话、
 * 再插事件。查与插之间没有事务保护，但两条语句都幂等：
 * 并发下最坏是其中一个撞 `xq_session_pkey` 或 `xq_event_dedupe_key_key`，
 * 调用方重试一次拿到 `duplicate: true`，与串行的结果一致。
 *
 * ## 为什么本地日期是「减四小时」
 *
 * 凌晨两点还在学，那次学习属于**前一天**。`local_day` 与 `seq_no` 一起构成
 * 会话的当日序号（`UNIQUE (local_day, seq_no)`），边界定在 04:00 而不是 00:00，
 * 否则一次跨午夜的连续学习会被切成两个「第 1 次」。
 * 这是产品默认值，不是研究结论（M 文档第 18 条诚实清单里写着）。
 *
 * ## 为什么不在这里判定
 *
 * 本文件只写事实：不读 `xq_cell_state`、不算掌握度、不排期、不改先前写过的行。
 * 状态是从事件与探针**派生**的缓存，派生逻辑在 `xq-learner-store.ts` 与
 * `learner-state.ts` 里；事件层一旦开始判定，「同一件事两种结论」就有了两个源头，
 * 而且后一个永远不知道自己错了。
 *
 * 三处具体的克制：
 *
 * 一是**不补算派生量**。`xq_session` 上有 `active_ms` / `wall_ms` / `probe_n` /
 * `self_report` 四列，本文件一个都不写 —— 它们要跨事件配对才算得出来
 * （四个空闲阈值见 N3 §4.4），放在写入路径上就得为每条事件重算全表。
 * 今天这四列是空的，这是**已知缺口**而不是遗漏：谁要算，应该写一个独立的
 * 汇总器去读事件，而不是让「记一条事实」顺带做统计。
 *
 * 二是**不回头改**。撤销靠再写一条 `kind='voided'` 的事件（`voided_by`
 * 指向它），不靠 UPDATE。`xq_event` 是只追加的，所以「刚才那条写错了」
 * 也只能是新的一条事实。
 *
 * 三是**不拿 `dwell_ms` 做任何判断**。它只是诊断标签（DDL 注释原文：
 * 「不进任何判定式」）—— 停留久不等于学会了，发呆也算停留。
 *
 * ## 为什么提示分型是必填而不是可选
 *
 * `hint_subtype` 在 DDL 里就是「`hint_requested` 时 NOT NULL」，但这条约束
 * 从 S5 建表起一直没有写入路径 —— `XqEventInput` 里没有这个字段、
 * `INSERT_EVENT_SQL` 的列清单里也没有它，于是想记一次「他求了提示」只会
 * 撞一个约束名。结果是：十六个 kind 里唯一一个**带符号方向**的事件
 * （`instrumental` 与成绩正相关、`executive` 强负相关）从未被写进去过。
 *
 * 现在补上，并且两条都挡在发 SQL 之前：该有没有、不该有却有。
 * 事后再从对话文本反推类型不可靠（同一个人问「这步为什么错」与
 * 「直接告诉我答案」在字面上可能只差几个字），所以宁可写不进去也不许留空。
 */
import { randomUUID } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

/** 学习日的边界：04:00 之前算前一天。 */
export const STUDY_DAY_BOUNDARY_HOUR = 4;

/**
 * `xq_event.kind` 的十六个取值，与 DDL 里的 CHECK 逐字一致。
 *
 * 这里重复一份是为了让调用方在编译期就被挡住；两处若分叉，
 * 第一条写不进去的事件会在运行时报一个 PostgreSQL 约束名，
 * 而不是在改代码时被 TypeScript 指出来。
 */
export const XQ_EVENT_KINDS = [
  'session_started',
  'session_ended',
  'session_abandoned',
  'page_viewed',
  'page_skipped',
  'page_revisited',
  'page_completed',
  'answer_submitted',
  'answer_attempted',
  'hint_requested',
  'note_written',
  'search_performed',
  'review_due_opened',
  'review_passed',
  'review_failed',
  'voided',
] as const;

export type XqEventKind = (typeof XQ_EVENT_KINDS)[number];

/** 会话结束方式，与 `xq_session.end_reason` 的 CHECK 逐字一致。 */
export const XQ_END_REASONS = [
  'terminated',
  'idle_5m',
  'idle_60m',
  'idle_30m',
  'day_boundary',
  'abandoned',
  'crash',
] as const;

export type XqEndReason = (typeof XQ_END_REASONS)[number];

/**
 * 求提示的两种子类型，与 `xq_event.hint_subtype` 的 CHECK 逐字一致。
 *
 * `instrumental` 是「这条提示该怎么说」—— 要的是方法与线索；
 * `executive` 是「直接告诉我下一步做什么」—— 要的是执行结果。
 * 两者与成绩的关系**方向相反**（instrumental 正相关、executive 强负相关），
 * 所以宁可写不进去，也不许留空：事后再从对话文本反推类型，实测不可靠。
 */
export const XQ_HINT_SUBTYPES = ['instrumental', 'executive'] as const;

export type XqHintSubtype = (typeof XQ_HINT_SUBTYPES)[number];

/**
 * 一条要写进去的事件。
 *
 * `occurredAt` 是**客户端时钟**（现实里发生的时刻），不是服务端收到的时刻 ——
 * 两者在 `xq_event` 里是两列（`occurred_at` / `recorded_at`），后者由
 * `DEFAULT now()` 填。把客户端时间当记账时间，回填与时钟漂移就再也分不开。
 */
export interface XqEventInput {
  kind: XqEventKind;
  stageId: string;
  sceneId?: string;
  questionId?: string;
  occurredAt: string;
  /**
   * 会话 id。`session_started` 必须不带（它自己产生 id），
   * 其余 kind 必须带 —— 没有会话的事件在表里挂不上去。
   */
  sessionId?: string;
  /** 幂等键。同一件事被投递两次时它必须相等；不填则每次都是新事件。 */
  dedupeKey?: string;
  dwellMs?: number;
  payload?: Record<string, unknown>;
  source?: 'self' | 'model' | 'system' | 'import';
  /** 只在 `session_ended` / `session_abandoned` 上有意义。 */
  endReason?: XqEndReason;
  /**
   * 只在 `hint_requested` 上必填 —— DDL 里有 CHECK 兜着
   * （`kind <> 'hint_requested' OR hint_subtype IS NOT NULL`）。
   * 其余 kind 带它就是写错行，见 `recordXqEvent` 的校验。
   */
  hintSubtype?: XqHintSubtype;
}

/** 写完回什么。调用方只用来打日志与继续发后续事件。 */
export interface XqEventResult {
  eventId: string;
  sessionId: string;
  /** true 表示这条事件已经存在（`dedupe_key` 撞上了），本次没有新增行。 */
  duplicate: boolean;
}

/** 会话当日序号的取法：`max(seq_no) + 1`，与 `UNIQUE (local_day, seq_no)` 一起用。 */
const NEXT_SESSION_SEQ_SQL = `SELECT coalesce(max(seq_no), 0) + 1 AS next_seq
   FROM xq_session
  WHERE local_day = $1::date`;

const INSERT_SESSION_SQL = `INSERT INTO xq_session
  (session_id, started_at, seq_no, local_day)
VALUES ($1, $2::timestamptz, $3, $4::date)`;

const INSERT_EVENT_SQL = `INSERT INTO xq_event
  (event_id, session_id, occurred_at, kind, stage_id, scene_id, question_id,
   dwell_ms, hint_subtype, payload, dedupe_key, source)
VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
ON CONFLICT (dedupe_key) DO NOTHING
RETURNING event_id`;

const SELECT_EVENT_BY_DEDUPE_SQL = `SELECT event_id, session_id
   FROM xq_event
  WHERE dedupe_key = $1`;

const CLOSE_SESSION_SQL = `UPDATE xq_session
   SET ended_at = $2::timestamptz,
       end_reason = $3,
       event_n = (SELECT count(*) FROM xq_event WHERE session_id = $1),
       scene_n = (SELECT count(DISTINCT scene_id) FROM xq_event
                   WHERE session_id = $1 AND kind = 'page_viewed' AND scene_id IS NOT NULL)
 WHERE session_id = $1`;

/**
 * 一个时刻属于哪个学习日（`yyyy-mm-dd`，本地时区）。
 *
 * 用本地时区而不是 UTC：学习者说的「今天」是他所在时区的今天。
 * 减 `STUDY_DAY_BOUNDARY_HOUR` 小时再取日期，就把 00:00–03:59 归到前一天。
 */
export function localDayOf(now: Date): string {
  const shifted = new Date(now.getTime() - STUDY_DAY_BOUNDARY_HOUR * 60 * 60 * 1000);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function asIsoOrNull(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 写一条事件。
 *
 * 抛：`occurredAt` 不是有效时间时抛 `RangeError`（在发 SQL 之前）；
 * `session_started` 带了 `sessionId`、或其余 kind 没带，抛 `RangeError`。
 * 驱动错误（约束冲突、连接失败）原样抛出 —— 事件写不进去是**真失败**，
 * 与探针证据不同：调用方是显式发来的，它需要知道没写成功。
 */
export async function recordXqEvent(
  queryable: Queryable,
  input: XqEventInput,
): Promise<XqEventResult> {
  const occurredAt = asIsoOrNull(input.occurredAt);
  if (occurredAt === null) {
    throw new RangeError(`xq: event ${input.kind} has an invalid occurredAt (${input.occurredAt})`);
  }
  if (input.stageId === '') {
    throw new RangeError(`xq: event ${input.kind} has no stageId`);
  }
  const startsSession = input.kind === 'session_started';
  if (startsSession && input.sessionId !== undefined) {
    throw new RangeError('xq: session_started must not carry a sessionId (it produces one)');
  }
  if (!startsSession && input.sessionId === undefined) {
    throw new RangeError(`xq: event ${input.kind} needs a sessionId`);
  }
  // 提示分型：说「要提示」就必须说哪一类，反之不许挂在别的 kind 上。
  // 前者 DDL 也有 CHECK，但那要等到 INSERT 才报一个约束名；后者 DDL 不拦
  // （列本身合法，只是挂错了行），两条都在这里挡掉更好读。
  if (input.kind === 'hint_requested' && input.hintSubtype === undefined) {
    throw new RangeError('xq: hint_requested needs a hintSubtype (instrumental or executive)');
  }
  if (input.kind !== 'hint_requested' && input.hintSubtype !== undefined) {
    throw new RangeError(`xq: event ${input.kind} must not carry a hintSubtype`);
  }

  // 幂等键不交给调用方：浏览器重发同一条事件时**必须**被认出来，
  // 而「每次都由客户端记得带 dedupeKey」是一条迟早会破的约定。
  // 派生只依赖调用方本来就稳定带过来的字段（kind / stage / scene / 时刻），
  // 所以重试与首次投递算出来是同一个键。
  const dedupeKey = input.dedupeKey ?? deriveDedupeKey(input, occurredAt);

  // 先查重：同一次开始被投递两次时，第二次不许再建一个会话。
  const { rows } = await queryable.query<{ event_id: string; session_id: string }>(
    SELECT_EVENT_BY_DEDUPE_SQL,
    [dedupeKey],
  );
  const existing = rows[0];
  if (existing !== undefined) {
    return { eventId: existing.event_id, sessionId: existing.session_id, duplicate: true };
  }

  const eventId = randomUUID();
  const sessionId = startsSession ? eventId : (input.sessionId as string);

  if (startsSession) {
    const day = localDayOf(occurredAt);
    const { rows } = await queryable.query<{ next_seq: number }>(NEXT_SESSION_SEQ_SQL, [day]);
    const nextSeq = Number(rows[0]?.next_seq ?? 1);
    await queryable.query(INSERT_SESSION_SQL, [eventId, occurredAt.toISOString(), nextSeq, day]);
  }

  const payload = input.payload ?? {};
  const { rows: inserted } = await queryable.query<{ event_id: string }>(INSERT_EVENT_SQL, [
    eventId,
    sessionId,
    occurredAt.toISOString(),
    input.kind,
    input.stageId,
    input.sceneId ?? null,
    input.questionId ?? null,
    input.dwellMs ?? null,
    input.hintSubtype ?? null,
    JSON.stringify(payload),
    dedupeKey,
    input.source ?? 'self',
  ]);

  if (inserted.length === 0) {
    // 并发下另一个请求刚写进去：以它为准。
    const { rows: winners } = await queryable.query<{ event_id: string; session_id: string }>(
      SELECT_EVENT_BY_DEDUPE_SQL,
      [dedupeKey],
    );
    const winner = winners[0];
    if (winner !== undefined) {
      return { eventId: winner.event_id, sessionId: winner.session_id, duplicate: true };
    }
    return { eventId, sessionId, duplicate: false };
  }

  if (input.kind === 'session_ended' || input.kind === 'session_abandoned') {
    await queryable.query(CLOSE_SESSION_SQL, [
      sessionId,
      occurredAt.toISOString(),
      input.endReason ?? (input.kind === 'session_abandoned' ? 'abandoned' : 'terminated'),
    ]);
  }

  return { eventId, sessionId, duplicate: false };
}

/**
 * 一条事件的幂等键。
 *
 * 只用调用方本来就稳定带来的字段：`kind`、`stage_id`、`scene_id`、`question_id`、
 * `occurred_at`、`sessionId`。刻意**不用随机 id、不用服务端时刻** ——
 * 那两个每次重发都会变，键就永远撞不上，幂等等于没有。
 *
 * 语义上它说的是「同一件事」：同一会话里同一页、同一时刻的一次浏览。
 * 隔一分钟再看一次同一页是**两件事**（`occurred_at` 不同），这正确 ——
 * 重复投递是同一条消息被送了两遍，不是重复学习。
 */
export function deriveDedupeKey(input: XqEventInput, occurredAt: Date): string {
  const parts = [
    input.kind,
    input.stageId,
    input.sceneId ?? '',
    input.questionId ?? '',
    input.sessionId ?? '',
    occurredAt.toISOString(),
  ];
  return parts.join(':');
}
