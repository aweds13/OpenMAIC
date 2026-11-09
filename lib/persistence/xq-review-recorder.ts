/**
 * 学情（xq）的**复习结果入口**：把「这一关做完了」落成一条事实，再关掉那一关。
 *
 * ## 为什么需要它
 *
 * `XqLearnerStore.recordReviewOutcome()` 早就能写，但**没有任何生产调用方** ——
 * 全仓引用只在它自己的测试里。于是复习闭环只有入口没有出口：
 * `xq_review_schedule` 里排进去的关，`due_at` 到点后会一直显示成
 * 「今天到期的复习」，谁也消不掉。2026-11-09 那次回填写进去 20 关（5 道题 ×
 * 四关），第二天就会全部到期。
 *
 * 本文件把那一步接上：一个 HTTP 路由（`POST /api/persistence/xq/reviews`）
 * 调到这里，它做三件事 —— 确认这一关存在、写一条 `review_passed` /
 * `review_failed` 事件、关掉（或重置）那一关。
 *
 * ## 为什么顺序是「先事件，后排期」
 *
 * M 文档 §8.3 定的方向只有一条：**事件 → 状态 → 状态块**。
 * `xq_review_schedule` 是**计划**（派生出来的），`xq_event` 是**事实**。
 * 反过来写会有一个看不见的坏结果：排期关掉了，但「他这次做错了」这件事
 * 没人记 —— 而 P5 的四关重置降级规则正是靠 `review_failed` 的计数才算得出
 * （M §3.2 分歧四末段）。事实丢了就再也补不回来；排期丢了重跑一次就有。
 *
 * 所以：先查这一关在不在（不在就直接报，别写假事实）→ 写事件 → 改排期。
 * 事件写成功、排期写失败时，调用方重试一次即可：事件按 `dedupe_key` 去重，
 * 排期那一句本身也是幂等的。
 *
 * ## 为什么 `skip` 不写事件
 *
 * 十六个 kind 里没有 `review_skipped`。`skip` 的语义是「现在不做，但别当我
 * 做错了」—— 它不是一次学习行为，写成 `review_passed` 会骗状态层，
 * 写成 `review_failed` 会让 P5 的失败计数虚高。只改排期，不写事实。
 *
 * ## 重试必须复用同一个 `occurredAt`
 *
 * 幂等键由 `deriveDedupeKey()` 从 `kind / stage / scene / 题 / 时刻` 派生。
 * 重试时若重新取 `now()`，那一刻就变成了另一件事 —— 库里会有两条
 * 「同一关失败」，P5 的计数跟着翻倍。这条与 `lib/learning/xq-event-client.ts`
 * 里「重试复用同一 body」是同一条约束。
 *
 * 反过来，**真的又错一次**（第一关重排后又做错）本来就是两件事：
 * 时刻不同 ⇒ 键不同 ⇒ 两条事件。这正是 P5 要数的东西。
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { recordXqEvent, type XqEventKind } from './xq-event-recorder';
import { XqLearnerStore } from './xq-learner-store';

/** 复习的三种结果。与 `recordReviewOutcome` 的入参一致。 */
export const XQ_REVIEW_OUTCOMES = ['pass', 'fail', 'skip'] as const;
export type XqReviewOutcome = (typeof XQ_REVIEW_OUTCOMES)[number];

export interface XqReviewInput {
  stageId: string;
  sceneId: string;
  questionId: string;
  /** 这一关挂的概念。回填时算出来的那个；取不到就空串。 */
  concept: string;
  /** 第几关（1..4）。 */
  round: number;
  outcome: XqReviewOutcome;
  /** 学习者做完这一关的时刻（ISO 串）。重试必须复用同一个值。 */
  occurredAt: string;
  /** 这条事件属于哪个会话。`xq_event.session_id` 是 NOT NULL。 */
  sessionId: string;
}

export interface XqReviewResult {
  /** 那一关是否真的被关掉/重置了（`skip` 也算关掉）。 */
  recorded: boolean;
  /** 写进去的事件 id；`skip` 时为 `null`。 */
  eventId: string | null;
  /** 重复投递时事件没再插一行。 */
  duplicate: boolean;
}

/** 这一关在不在。不在就别写事实 —— 一条指向不存在关卡的 `review_failed` 只会污染计数。 */
const ROUND_EXISTS_SQL = `SELECT 1
  FROM xq_review_schedule
 WHERE stage_id = $1 AND scene_id = $2 AND question_id = $3 AND concept = $4
   AND round = $5`;

/** 排期表没有这一关。路由层把它翻成 404。 */
export class XqReviewRoundMissingError extends Error {
  constructor(input: XqReviewInput) {
    super(
      `xq: no review round ${input.round} to record ` +
        `(stage=${input.stageId} scene=${input.sceneId} ` +
        `question=${input.questionId} concept=${JSON.stringify(input.concept)})`,
    );
    this.name = 'XqReviewRoundMissingError';
  }
}

/** `pass` → `review_passed`，`fail` → `review_failed`，`skip` → 没有事件。 */
function eventKindOf(outcome: XqReviewOutcome): XqEventKind | null {
  if (outcome === 'pass') return 'review_passed';
  if (outcome === 'fail') return 'review_failed';
  return null;
}

/**
 * 记一次复习结果。顺序见文件头：查在不在 → 写事实 → 改排期。
 *
 * 抛：`XqReviewRoundMissingError`（这一关不存在）、`RangeError`（时间戳非法，
 * 由 `recordXqEvent` 抛）、驱动错误原样抛出。
 */
export async function recordXqReview(
  queryable: Queryable,
  input: XqReviewInput,
): Promise<XqReviewResult> {
  // 先解析一次：幂等键里要用**归一化后**的时刻。同一次复习用 `Z` 写还是用
  // `+08:00` 写是同一个瞬间，若把原始字符串拼进键，两次不同格式的投递会被
  // 当成两件事 —— 而复投正是这个键存在的理由。
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new RangeError(`xq: review occurredAt is not a valid timestamp: ${input.occurredAt}`);
  }

  const exists = await queryable.query(ROUND_EXISTS_SQL, [
    input.stageId,
    input.sceneId,
    input.questionId,
    input.concept,
    input.round,
  ]);
  if (exists.rows.length === 0) throw new XqReviewRoundMissingError(input);

  const kind = eventKindOf(input.outcome);
  let eventId: string | null = null;
  let duplicate = false;
  if (kind !== null) {
    const event = await recordXqEvent(queryable, {
      kind,
      stageId: input.stageId,
      sceneId: input.sceneId,
      questionId: input.questionId,
      occurredAt: input.occurredAt,
      sessionId: input.sessionId,
      payload: { round: input.round, outcome: input.outcome, concept: input.concept },
      // ★ 幂等键必须带 round 与 concept。
      //
      // `recordXqEvent` 的默认派生是 `(kind, stage, scene, question, session, occurredAt)`——
      // 里面**没有 round**。而同一道题的四关完全可能在同一个时刻被点到（人一次点完，
      // 或者客户端把四个按钮的回调一起发出去）：那一刻四条请求派生出的键一模一样，
      // 于是第 2、3、4 关的事件被当成「第 1 关的重复投递」丢掉，**但排期照样关掉**。
      // 结果是一条事件、四行 `done_at` —— 库里说「他复习了 1 次」，界面说「四关都过了」。
      //
      // 加上 round 之后，一件事仍然只记一次（重投同一关仍然命中同一个键），
      // 但不同关不会再互相吃掉。
      dedupeKey:
        `review:${input.sessionId}:${input.stageId}:${input.sceneId}:` +
        `${input.questionId}:${input.round}:${input.concept}:${occurredAt.toISOString()}`,
    });
    eventId = event.eventId;
    duplicate = event.duplicate;
  }

  // 失败计数要按**这一次之前**数，所以把这一刻传下去。用 `occurredAt` 而不是真实
  // 时钟：重放同一批事件时「第几次失败」必须算出同一个答案，否则同一份历史重跑
  // 两次会得到两套排期。
  const store = new XqLearnerStore({ queryable });
  await store.recordReviewOutcome(
    input.stageId,
    input.sceneId,
    input.questionId,
    input.concept,
    input.round,
    input.outcome,
    occurredAt,
  );

  return { recorded: true, eventId, duplicate };
}
