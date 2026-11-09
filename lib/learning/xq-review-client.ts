/**
 * 学情复习的**浏览器侧客户端**：读到期队列、交一次复习结果。
 *
 * ## 为什么它是独立于 `xq-event-client` 的一层
 *
 * 事件发送端管的是「只追加的事实」（翻页、答题、提示），它的失败处理是
 * 静默重试一次然后放手 —— 少一条浏览记录不影响任何人。复习不一样：
 * 这两个请求的结果**立刻决定屏幕上显示什么**（列表少一条、那一关
 * 从「到期」变成「已完成」）。调用方需要知道成没成，所以这里回结果对象，
 * 而不是像事件那样一路 `void`。
 *
 * 两个端点共用同一个 URL（`/api/persistence/xq/reviews`），按方法分开：
 * `GET` 读队列、`POST` 交结果。这是服务端定的形状（见 route 里的
 * `handleXqReviewQueue` / `handleXqReview`），客户端照抄。
 *
 * ## 为什么读侧要把分页说清
 *
 * 服务端一次最多回 50 条（`DUE_REVIEW_CARD_LIMIT`）。这个上限不是分页的
 * 第一页，而是**全部**：再多就不列了。所以这里**不实现翻页** ——
 * 假装支持翻页比不支持更糟（用户会以为后面还有）。真要超过 50 条，
 * 那是「该先做哪一道」的产品问题，不是列表长度问题。
 *
 * ## 为什么提交失败不重试
 *
 * `POST` 的语义是「这一关我做完了」。重复提交同一结果在服务端是幂等的
 * （`dedupe_key` 由 `occurredAt` 派生），但**客户端自动重试会让
 * `occurredAt` 变**——那就成了「他又做了一遍」，而排期会被重置到下一次。
 * 所以这里失败就返回失败，由界面让人再点一次（那时是新的动作，
 * 新的时刻，本来就该是新的一条）。
 */

/** 复习的两个端点（同一个 URL，按方法分）。 */
export const XQ_REVIEW_QUEUE_ENDPOINT = '/api/persistence/xq/reviews';

/** 一次复习的三种结果，与服务端的 `XQ_REVIEW_OUTCOMES` 一致。 */
export const XQ_REVIEW_OUTCOMES_CLIENT = ['pass', 'fail', 'skip'] as const;
export type XqReviewOutcomeClient = (typeof XQ_REVIEW_OUTCOMES_CLIENT)[number];

/** 读到的一条到期卡片。字段与服务端的 `DueReviewCard` 同名同义（`dueAt` 是 ISO 串）。 */
export interface XqDueReviewCard {
  readonly stageId: string;
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly questionId: string;
  readonly questionStem: string;
  readonly concept: string;
  readonly round: number;
  readonly dueAt: string;
  /**
   * 这个概念现在的三态读数，服务端顺带给的。
   *
   * `null` 是**「这个概念没有可判的证据」**，不是「他不会」——
   * 卡片上不许把这两件事画成同一句。今天真库上绝大多数卡都是 `null`：
   * 只有 14 个概念吃到过证据，而每题至少三题才够判。
   */
  readonly mastery: XqCardMastery | null;
}

/** 一张卡上顺带显示的概念读数。只有 `tri` 是判据，其余是让人能看出凭据多少。 */
export interface XqCardMastery {
  /** `known` / `not-learned` / `unknown` —— 与 `xq_cell_state.tri` 同一套三态。 */
  readonly tri: string;
  /** 加权题数（同一题重测算 0.5）。 */
  readonly n: number;
  /** 去重后的题目个数 —— 与 `n` 不是一回事。 */
  readonly questions: number;
}

/** 交一次复习结果的入参。`sessionId` 由调用方给（它属于哪一次坐下学习）。 */
export interface XqReviewSubmission {
  readonly stageId: string;
  readonly sceneId: string;
  readonly questionId: string;
  readonly concept: string;
  readonly round: number;
  readonly outcome: XqReviewOutcomeClient;
  readonly sessionId: string;
}

export interface XqReviewWriteResult {
  readonly ok: boolean;
  /** 服务端已有一条同键事实（重投）；界面该怎么显示就怎么显示，不必重放。 */
  readonly duplicate: boolean;
  /** `skip` 时服务端不写事件，这里就是 `null`。 */
  readonly eventId: string | null;
}

export interface XqReviewQueueResult {
  readonly ok: boolean;
  readonly cards: readonly XqDueReviewCard[];
}

export interface XqReviewClientDeps {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  logFailure?: (message: string, error?: unknown) => void;
}

export interface XqReviewClient {
  /** 读现在到期的关。最多 50 条，不分页。 */
  listDue(): Promise<XqReviewQueueResult>;
  /** 交一次复习结果。`occurredAt` 由调用方注入，重放时要复用同一个。 */
  record(input: XqReviewSubmission & { readonly occurredAt: string }): Promise<XqReviewWriteResult>;
}

const EMPTY_QUEUE: XqReviewQueueResult = { ok: false, cards: [] };
const FAILED_WRITE: XqReviewWriteResult = { ok: false, duplicate: false, eventId: null };

function defaultLogFailure(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message);
  else console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * 一张卡的身份：`(stage, scene, question, round)`。
 *
 * ★ 必须带 `round`。同一道题的第 1 关与第 3 关可以同时到期（上一关做错、
 * 后面几关仍按原时刻排着），只按题目去重会把其中一关吞掉 —— 那一关就
 * 永远不会被关掉，第二天还在列表里。
 */
export function reviewCardKey(card: XqDueReviewCard): string {
  return [card.stageId, card.sceneId, card.questionId, String(card.round)].join('\u0000');
}

/** 一组到期关：同一页、同一门课。 */
export interface XqDueReviewGroup {
  readonly stageId: string;
  readonly sceneId: string;
  /** 页标题；页被删或标题为空时退回 `sceneId`。 */
  readonly title: string;
  readonly cards: readonly XqDueReviewCard[];
}

/**
 * 把到期卡片按「哪一页」归组，顺序沿用入参（服务端已按 `due_at` 升序排过）。
 *
 * ★ 键是 `(stageId, sceneId)` 而不是 `sceneId`：库里 234 页有 35 个 scene id
 * 跨课程复用（34 个连页类型都不同），只按 scene id 归组会把两门课的同名页
 * 并成一张卡 —— 那种错看不出来，但点进去会到另一门课。
 */
export function groupCardsByScene(cards: readonly XqDueReviewCard[]): readonly XqDueReviewGroup[] {
  const groups = new Map<string, { group: XqDueReviewGroup; cards: XqDueReviewCard[] }>();
  for (const card of cards) {
    const key = `${card.stageId}\u0000${card.sceneId}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.cards.push(card);
      continue;
    }
    groups.set(key, {
      group: { stageId: card.stageId, sceneId: card.sceneId, title: '', cards: [] },
      cards: [card],
    });
  }
  const out: XqDueReviewGroup[] = [];
  for (const entry of groups.values()) {
    const title =
      entry.cards[0].sceneTitle !== '' ? entry.cards[0].sceneTitle : entry.group.sceneId;
    out.push({ ...entry.group, title, cards: entry.cards });
  }
  return out;
}

/** 把服务端回的未知形状收敛成卡片；任何一条缺关键字段就整条丢掉（别显示半张卡）。 */
function asCard(raw: unknown): XqDueReviewCard | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  const strings = ['stageId', 'sceneId', 'questionId'] as const;
  for (const key of strings) {
    if (typeof row[key] !== 'string' || row[key] === '') return undefined;
  }
  if (typeof row.round !== 'number' || !Number.isInteger(row.round)) return undefined;
  if (typeof row.dueAt !== 'string') return undefined;
  return {
    stageId: row.stageId as string,
    sceneId: row.sceneId as string,
    questionId: row.questionId as string,
    sceneTitle: typeof row.sceneTitle === 'string' ? row.sceneTitle : '',
    questionStem: typeof row.questionStem === 'string' ? row.questionStem : '',
    concept: typeof row.concept === 'string' ? row.concept : '',
    round: row.round,
    dueAt: row.dueAt,
    mastery: asMastery(row.mastery),
  };
}

/**
 * 概念读数。形状不对就回 `null`（＝「没有」），不让半个读数上卡片 ——
 * 一个 `tri` 是真的、`n` 是编的读数，比没有读数更坏。
 */
function asMastery(raw: unknown): XqCardMastery | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.tri !== 'string' || row.tri === '') return null;
  if (typeof row.n !== 'number' || !Number.isFinite(row.n)) return null;
  if (typeof row.questions !== 'number' || !Number.isFinite(row.questions)) return null;
  return { tri: row.tri, n: row.n, questions: row.questions };
}

export function createXqReviewClient(deps: XqReviewClientDeps = {}): XqReviewClient {
  const endpoint = deps.endpoint ?? XQ_REVIEW_QUEUE_ENDPOINT;
  const fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const logFailure = deps.logFailure ?? defaultLogFailure;

  return {
    listDue: async () => {
      if (fetchImpl === undefined) return EMPTY_QUEUE;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          // 读失败就是读失败：回空列表会让界面显示「今天没有要复习的」，
          // 那是在撒谎 —— 调用方拿 `ok: false` 才能区分「空」与「没读到」。
          logFailure(`xq review queue: refused with ${response.status}`);
          return EMPTY_QUEUE;
        }
        const payload = (await response.json().catch(() => null)) as { reviews?: unknown } | null;
        const rows = Array.isArray(payload?.reviews) ? payload.reviews : [];
        const cards = rows
          .map(asCard)
          .filter((card): card is XqDueReviewCard => card !== undefined);
        return { ok: true, cards };
      } catch (error) {
        logFailure('xq review queue: failed to read', error);
        return EMPTY_QUEUE;
      }
    },

    record: async (input) => {
      if (fetchImpl === undefined) return FAILED_WRITE;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            stageId: input.stageId,
            sceneId: input.sceneId,
            questionId: input.questionId,
            concept: input.concept,
            round: input.round,
            outcome: input.outcome,
            occurredAt: input.occurredAt,
            sessionId: input.sessionId,
          }),
        });
        if (!response.ok) {
          logFailure(`xq review: ${input.outcome} refused with ${response.status}`);
          return FAILED_WRITE;
        }
        const payload = (await response.json().catch(() => null)) as {
          duplicate?: unknown;
          eventId?: unknown;
        } | null;
        return {
          ok: true,
          duplicate: payload?.duplicate === true,
          eventId: typeof payload?.eventId === 'string' ? payload.eventId : null,
        };
      } catch (error) {
        logFailure('xq review: failed to send', error);
        return FAILED_WRITE;
      }
    },
  };
}
