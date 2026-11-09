/**
 * 答题这件事的**事件侧**记录：`answer_attempted` 与 `answer_submitted`。
 *
 * ## 为什么答题已经有 `xq_probe_item`，还要再写事件
 *
 * 探针表（`xq_probe_item`）记的是**结论**：这道题对不对、什么时候答的。
 * 它在判分完成后才有值，因为「对不对」要等判分。
 *
 * 但提问闸（M 文档 §10）要判的是**顺序**，不是结论：「他先动过手了吗」。
 * 一个学生把答案写了一半就卡住、还没提交就来问，探针表里一行都没有 ——
 * 那时闸会把他挡在门外，而他恰好是最该问的那类人。所以需要一条
 * 「他动过手」的事实，它必须**在提交之前**就能落库。
 *
 * 两条事件的差别就是 `N3` verb 表里 `attempted` 与 `answered` 的差别：
 * `answer_attempted` 是「动过手」（写了一半、选了又改、写到一半放弃），
 * `answer_submitted` 是「交卷了」（判分完成，带 `correct`）。
 *
 * ## 为什么不是一道题一条卷级别的事件
 *
 * E 文档（`E-工程实践调研.md` §2.2）把 `answer_submitted` 设计成
 * 「一次交卷、一事件多 result」。我们**故意不照抄**：`xq_event` 有
 * `question_id` 这一列，而闸的判据是题目级的
 * （`(stage_id, scene_id, question_id)` 上的先后）。若写成卷级事件，
 * 判据就得去 `payload.results[]` 里挖数组 —— 那是一张表里的第二套模式，
 * SQL 写不出来，只能拿回应用层判。一题一行，闸就是一句 SQL。
 *
 * 代价是行数：一页八题交一次卷写八行。可接受 —— 事件是只追加的事实流，
 * 行数不是它的问题；「判据写不出来」才是。
 *
 * ## 为什么幂等键不能由 `occurredAt` 派生
 *
 * 服务端默认键是 `(kind, stage, scene, question, session, occurredAt)`。
 * 对翻页够用（一次浏览一个时刻），对答题**不够**：他会把同一个答案改三遍，
 * 三个时刻派生三个键，于是「他动过手」变成三行，闸的判据虽然还对，
 * 但「这道题他试了几次」这个数就不能再拿行数当答案了。
 *
 * 所以这里显式给键，且**与时间无关**：`answer_attempted:<attemptId>:<questionId>`。
 * 同一个会话里同一道题无论改几次都落在同一行（服务端 `ON CONFLICT DO NOTHING`）。
 * `attemptId` 进键是必须的 —— 重做一遍（`persistQuizRetry` 会换一个
 * `:retry:N` 的 attemptId）是**另一次**尝试，不能被上一轮的键吃掉。
 *
 * ## 为什么失败不抛
 *
 * 与 `xq-event-client.ts` 同一条：没记上学情不该让人做不了题。
 * 这里连日志都由发送端负责（它自己 `console.warn`），本模块只负责
 * 「什么时候发、发什么键」。
 */
import { getXqEventClient } from '@/lib/learning/xq-event-client';

/** 一次答题所处的坐标。缺任何一项都不发 —— 发出去的事件挂不上任何页。 */
export interface XqAnswerContext {
  readonly stageId: string;
  readonly sceneId: string;
  /** 本轮作答的 id（`quiz-attempt:...`，重做会带 `:retry:N`）。 */
  readonly attemptId: string;
}

/** 幂等键：同一轮里同一道题只一行。 */
export function answerAttemptDedupeKey(attemptId: string, questionId: string): string {
  return `answer_attempted:${attemptId}:${questionId}`;
}

export function answerSubmittedDedupeKey(attemptId: string, questionId: string): string {
  return `answer_submitted:${attemptId}:${questionId}`;
}

/** 一个够发事件的完整坐标。 */
export interface XqAnswerTarget extends XqAnswerContext {
  readonly questionId: string;
}

/**
 * 把「可能不全的坐标 + 可能空的题号」收成一个确定可发的坐标。
 *
 * 用返回 `undefined` 而不是类型守卫：需要窄化的是**两个参数合起来**的结果，
 * TypeScript 的 `x is T` 只能窄化其中一个，调用处还得再断言一次题号 ——
 * 那等于没窄化。空串与 `undefined` 一样算缺。
 */
export function resolveAnswerTarget(
  context: Partial<XqAnswerContext> | undefined,
  questionId: string | undefined,
): XqAnswerTarget | undefined {
  if (context === undefined) return undefined;
  if (questionId === undefined || questionId === '') return undefined;
  const { stageId, sceneId, attemptId } = context;
  if (typeof stageId !== 'string' || stageId === '') return undefined;
  if (typeof sceneId !== 'string' || sceneId === '') return undefined;
  if (typeof attemptId !== 'string' || attemptId === '') return undefined;
  return { stageId, sceneId, attemptId, questionId };
}

/**
 * 记「这道题他动过手」。在答案**第一次变得非空**时调，不要每次输入都调
 * （幂等键能兜住重复，但没必要为每一次按键发一个请求）。
 *
 * `charCount` 只作诊断：它能区分「写了一个字就放弃」与「写了两百字才卡住」，
 * 而这两件事在闸上是一样的（都算动过手），但在复盘时完全不是一件事。
 * 它不进任何判定式 —— 与 `dwell_ms` 同一条纪律。
 */
export function recordAnswerAttempt(
  context: Partial<XqAnswerContext> | undefined,
  questionId: string | undefined,
  charCount?: number,
): void {
  const target = resolveAnswerTarget(context, questionId);
  if (target === undefined) return;
  void getXqEventClient().recordEvent({
    kind: 'answer_attempted',
    stageId: target.stageId,
    sceneId: target.sceneId,
    questionId: target.questionId,
    occurredAt: new Date().toISOString(),
    dedupeKey: answerAttemptDedupeKey(target.attemptId, target.questionId),
    ...(typeof charCount === 'number' && Number.isFinite(charCount) && charCount >= 0
      ? { payload: { char_count: Math.trunc(charCount) } }
      : {}),
  });
}

/**
 * 记「这道题交卷了」，判分完成后逐题调一次。
 *
 * `correct` 允许是三态：判分服务挂了时 `quiz-view` 会给 `correct: null`
 * （半分保底）。那时**仍然要发** —— 「他交了卷但没判出来」是一个事实，
 * 而「没发」意味着闸会认为他没交过。`correct` 落进 payload 而不是
 * 事件的 `correct` 列：后者 DDL 允许 NULL，但我们的写入器没开这个口子，
 * 且这个字段本来就该由探针表做权威（同一条事实两个权威 = 两个真相）。
 */
export function recordAnswerSubmitted(
  context: Partial<XqAnswerContext> | undefined,
  questionId: string | undefined,
  correct: boolean | null,
): void {
  const target = resolveAnswerTarget(context, questionId);
  if (target === undefined) return;
  void getXqEventClient().recordEvent({
    kind: 'answer_submitted',
    stageId: target.stageId,
    sceneId: target.sceneId,
    questionId: target.questionId,
    occurredAt: new Date().toISOString(),
    dedupeKey: answerSubmittedDedupeKey(target.attemptId, target.questionId),
    payload: { correct },
  });
}
