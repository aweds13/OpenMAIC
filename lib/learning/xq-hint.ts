/**
 * 「问 AI」这一个动作的完整链路：记事件 + 发消息。
 *
 * ## 为什么这两件事必须在一个函数里
 *
 * 提问闸（`lib/persistence/xq-hint-gate.ts`）在**服务端**挡：没有更早的
 * `answer_attempted` / `answer_submitted` 就回 409 `ANSWER_FIRST`。
 * 而「发消息」是不可撤销的 —— 一旦模型开始回答，这条提问就已经发生了，
 * 事后再补记一条事件只会得到两种结果：记成 `executive`（撒谎，把
 * instrumental 记成了求答案）或者记不上（学情断掉）。
 *
 * 所以顺序是**先记事件、成功了才发消息**：闸的拒绝发生在消息发出之前，
 * 学生看到的是「先写下你的想法」，而不是「AI 已经答了一半才跳出来拦」。
 *
 * ## 为什么分型由调用方显式给
 *
 * 这里不猜。`instrumental` 与 `executive` 与成绩的相关方向相反
 * （`N3` §5.4），从文本反推类型不可靠 —— 让 UI 上是两个按钮，就记两个值。
 *
 * ## 为什么失败不抛
 *
 * 「记不上学情」与「问不了问题」是两件不同严重度的事。前者应该只
 * `console.warn`（由发送端自己写），后者必须让学生看见原因。
 * 所以这里返回一个结果对象，由界面决定说什么，而不是抛异常。
 */
import { getXqEventClient } from '@/lib/learning/xq-event-client';
import { buildHintPrompt } from '@/lib/learning/xq-hint-prompt';

/**
 * 闸的拒绝码。与服务端 `ANSWER_FIRST_CODE` 同一个字面量。
 *
 * ★ 这里不 import 服务端那份：`lib/persistence/xq-hint-gate.ts` 引
 * `@openmaic/storage/runtime/pg`，把它拖进浏览器 bundle 只为拿一个字符串
 * 不值得。两处漂移的风险由一条测试兜着（它断言两边字面量相等）。
 */
const ANSWER_FIRST_CODE = 'ANSWER_FIRST';

/** 提示的两类。与服务端 `XQ_HINT_SUBTYPES` 同名同义。 */
export type XqHintSubtype = 'instrumental' | 'executive';

/** 问一次需要的坐标。`questionId` 必填 —— 页面级提问不进闸，也不该走这条路。 */
export interface XqHintTarget {
  readonly stageId: string;
  readonly sceneId: string;
  readonly questionId: string;
  readonly stem: string;
}

export interface XqHintResult {
  /**
   * `sent` 消息已发出；`refused` 闸挡住了；`unsent` 事件记上了但消息没发出去
   * （模型没配好、会话开不起来）；`failed` 事件就没记上。
   */
  readonly status: 'sent' | 'refused' | 'unsent' | 'failed';
  /** 闸挡住时服务端回的码，其它情况为 `''`。 */
  readonly code: string;
}

export interface XqHintDeps {
  /** 发消息。由播放态把 `chatAreaRef.current.sendMessage` 包一层传进来。 */
  readonly send: (content: string) => Promise<void> | void;
  /** 消息模板（含 `{{stem}}`），由界面按当前语言取。 */
  readonly template: string;
  /** 记事件。默认走进程级发送端；测试注入。 */
  readonly record?: (input: {
    kind: string;
    stageId: string;
    sceneId: string;
    questionId: string;
    occurredAt: string;
    hintSubtype: XqHintSubtype;
    payload: Record<string, unknown>;
  }) => Promise<{ ok: boolean; code?: string }>;
  /** 注入「现在」。 */
  readonly now?: () => Date;
  readonly logFailure?: (message: string, error?: unknown) => void;
}

/**
 * 默认记事件：走 `xq-event-client`，把拒绝码原样带回来。
 *
 * 发送端在 4xx 时会读响应体的 `error.code`，所以「闸挡住」（`ANSWER_FIRST`）
 * 与「请求本身不对」在这里就能分开 —— 界面该说的话完全不同：
 * 前者是「先写下你的想法」，后者是「这次提问没记上」。
 */
const defaultRecord: NonNullable<XqHintDeps['record']> = async (input) => {
  const result = await getXqEventClient().recordEvent({
    kind: input.kind,
    stageId: input.stageId,
    sceneId: input.sceneId,
    questionId: input.questionId,
    occurredAt: input.occurredAt,
    hintSubtype: input.hintSubtype,
    payload: input.payload,
  });
  return result.ok
    ? { ok: true }
    : { ok: false, ...(result.code === undefined ? {} : { code: result.code }) };
};

/**
 * 问一次。
 *
 * 调用方要保证 `target.questionId` 非空字符串 —— 空题号在这次链路里
 * 没有意义（`hintGateApplies` 也豁免它，等于绕开闸）。
 */
export async function askForHint(
  target: XqHintTarget,
  subtype: XqHintSubtype,
  deps: XqHintDeps,
): Promise<XqHintResult> {
  const logFailure =
    deps.logFailure ??
    ((m: string, e?: unknown) => {
      if (e === undefined) console.warn(m);
      else console.warn(`${m}: ${e instanceof Error ? e.message : String(e)}`);
    });
  const record = deps.record ?? defaultRecord;
  const now = deps.now ?? (() => new Date());

  let recorded: { ok: boolean; code?: string };
  try {
    recorded = await record({
      kind: 'hint_requested',
      stageId: target.stageId,
      sceneId: target.sceneId,
      questionId: target.questionId,
      occurredAt: now().toISOString(),
      hintSubtype: subtype,
      // 题干进 payload 是为了事后能看出「他问的是哪一句」—— 题面可能被改
      // 也可能被删，而事件是事实。不截断：payload 不是上下文，不进模型。
      payload: { stem: target.stem, subtype },
    });
  } catch (error) {
    logFailure('xq hint: failed to record the request', error);
    return { status: 'failed', code: '' };
  }

  if (!recorded.ok) {
    const code = recorded.code ?? '';
    // 闸挡住是**预期的正常结果**，不是错误：学生没答过就想问 instrumental。
    // 其余（网络、形状、服务端 500）才是「这次没记上」。
    return { status: code === ANSWER_FIRST_CODE ? 'refused' : 'failed', code };
  }

  try {
    await deps.send(buildHintPrompt(deps.template, target.stem));
  } catch (error) {
    logFailure('xq hint: recorded but the message was not sent', error);
    return { status: 'unsent', code: '' };
  }

  return { status: 'sent', code: '' };
}
