/**
 * 学情事件的**浏览器侧发送端**。
 *
 * ## 为什么翻页要单独发一条请求
 *
 * 翻页在客户端是纯状态变更：`lib/store/stage.ts` 的 `setCurrentSceneId` 只写
 * zustand 并标脏，不发任何网络请求。所以「他看了哪几页」这件事，服务端
 * 从来没有机会知道 —— 除非这里显式发。
 *
 * 为什么不是 runtime record：`runtime_records` 是「一次 append = 一个动作」
 * 的可回放日志，payload 校验表里 `playback` 连 skeleton 都没有；硬塞一条
 * 「翻页记录」会让 quiz 探针那层的 `isGradableQuizRecord` 之外多出一类
 * 语义完全不同的行。事件流与记录流是两条线，别混。
 *
 * ## 为什么会话懒开
 *
 * 学习者进入播放态但没翻页时，不该有一个「已经坐下学习」的会话 —— 那会让
 * 「今天学了 N 次」变成「今天打开了 N 次页面」。所以第一次真正翻页时才发
 * `session_started`，并把服务端回的 `sessionId` 记住，后续事件都挂它。
 *
 * ## 为什么失败不抛
 *
 * 与探针不同的地方：探针是答题的副产品，失败只记日志；事件是学习者行为的
 * 记录。但两者有一个共同点 —— **没记上学情不该让人用不了产品**。
 * 这里失败只 `console.warn`，下一事件照发（服务端接得上就接得上）。
 * 幂等键由服务端按 `(kind, stage, scene, question, session, occurredAt)` 派生，
 * 所以本端**重试时复用的必须是同一个 payload**（同一个 `occurredAt`）；
 * 重新取一次 `now()` 再发就成了「另一个时刻的另一次浏览」。
 *
 * ## 为什么串行
 *
 * 三个页签几乎同时在同一个 tick 里发出（快速连点、或侧边栏一次跳好几页），
 * 并发发 `session_started` 会建出两个会话。这里把请求排成一条链，
 * 保证「先开会话、再发事件」的顺序，且开会话只发生一次。
 */

/** 服务端的学情事件端点（`app/api/persistence/[...path]/route.ts` → `xq/events`）。 */
export const XQ_EVENT_ENDPOINT = '/api/persistence/xq/events';

/** 一条要发出去的事件。字段与服务端的 `XqEventInput` 同名同义。 */
export interface XqEventRequest {
  kind: string;
  stageId: string;
  sceneId?: string;
  questionId?: string;
  occurredAt: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
  endReason?: string;
  /**
   * 幂等键。不填时服务端按 `(kind, stage, scene, question, session, occurredAt)`
   * 派生 —— 那条规则对「翻页」「开会话」够用，因为它们本来就**一次一件事**。
   *
   * 但「同一道题的第一次作答」不是一次性的：他会改三次答案，三次的
   * `occurredAt` 都不同，派生出来就是三条 `answer_attempted`。而我们要的是
   * 「这道题他动过手」这一条事实。所以这类事件由调用方给一个**与时间无关**
   * 的键（`answer_attempted:<attemptId>:<questionId>`），重发也落在同一行。
   */
  dedupeKey?: string;
  /**
   * 只在 `hint_requested` 上必填（服务端的 DDL 有 CHECK 兜着）。
   *
   * 这个字段是**必填**而不是可选：`instrumental`（问「怎么想」）与
   * `executive`（问「直接给答案」）与成绩的关系方向相反，
   * 事后再从文本反推类型不可靠。调用方宁可不发这条事件，也不要空着发。
   */
  hintSubtype?: 'instrumental' | 'executive';
}

export interface XqEventClientDeps {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** 注入「现在」，测试里钉得住 `occurredAt`。 */
  now?: () => Date;
  /** 日志出口，默认 `console.warn`。 */
  logFailure?: (message: string, error?: unknown) => void;
}

/** 一次发送的结果，调用方一般不关心（发送端自己重试一次）。 */
export interface XqEventSendResult {
  ok: boolean;
  duplicate: boolean;
  sessionId?: string;
  /**
   * 被服务端拒绝时的错误码（响应体里的 `error.code`），例如提问闸的
   * `ANSWER_FIRST`。只有 4xx 才有 —— 5xx 是服务端自己坏了，码对它没意义。
   *
   * ★ 这个字段是**给界面看的**：闸挡住时学生必须看到「先写下你的想法」，
   * 而不是笼统的「发送失败」—— 前者可行动，后者只能重试。
   */
  code?: string;
}

export interface XqEventClient {
  /**
   * 记一次翻页。第一次调用会先把会话开起来。
   *
   * 同一个 `(stageId, sceneId)` 连续两次调用只发一次 —— React StrictMode 的
   * 双挂载、热更新重跑副作用都会让同一页被记两遍，而那不是「他又看了一遍」。
   * 中间翻去别的页再翻回来算新的一次（`lastScene` 已被覆盖），这才是真的重看。
   */
  viewPage(stageId: string, sceneId: string): Promise<XqEventSendResult>;
  /** 主动结束会话（离开播放态、切课）。没开过会话就什么都不做。 */
  endSession(stageId: string, endReason?: string): Promise<XqEventSendResult>;
  /** 其它事件（答题、复习、提示）。会话没开时不发 —— 没有会话的事件挂不上去。 */
  recordEvent(event: Omit<XqEventRequest, 'sessionId'>): Promise<XqEventSendResult>;
  /**
   * 取这门课当前的会话 id（没有就开一个）。
   *
   * 给那些**不经过这个客户端发请求**的调用方用：交复习结果走的是
   * `/xq/reviews`（它不只追加事件，还要关排期，顺序必须在服务端一处），
   * 但那条事实同样要挂在会话上。共用同一张会话表，两条链才不会各开一个会话。
   */
  sessionFor(stageId: string): Promise<string | undefined>;
}

const FAILURE_NOOP: XqEventSendResult = { ok: false, duplicate: false };

function defaultLogFailure(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message);
  else console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * 造一个发送端。
 *
 * 每个实例自己记会话（按 stageId 分开）：同一个人在同一个页面里同时看两门课
 * 的播放态不该共用会话，而按 `stageId` 作键天然就是「这门课这次的会话」。
 */
/**
 * 进程级的默认实例：一个页面里所有调用点共用同一条会话表。
 *
 * 懒得注入的调用方（React 组件）用它；测试与脚本自己 `createXqEventClient`。
 * 惰性建，且只在浏览器里建（服务端渲染时 `fetch` 指向自己没意义）。
 */
let shared: XqEventClient | undefined;

export function getXqEventClient(): XqEventClient {
  shared ??= createXqEventClient();
  return shared;
}

/** 测试用：丢掉进程级实例，让下一个人重新建。 */
export function resetXqEventClient(): void {
  shared = undefined;
}

export function createXqEventClient(deps: XqEventClientDeps = {}): XqEventClient {
  const endpoint = deps.endpoint ?? XQ_EVENT_ENDPOINT;
  const fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const now = deps.now ?? (() => new Date());
  const logFailure = deps.logFailure ?? defaultLogFailure;

  /** stageId → 会话 id（已经开好的）。 */
  const sessions = new Map<string, string>();
  /** stageId → 最后一次记过的 page —— 相邻重复不发（StrictMode 双挂载）。 */
  const lastScene = new Map<string, string>();
  /** 正在开的那次：并发调用共用同一个 Promise，避免建出两个会话。 */
  const opening = new Map<string, Promise<string | undefined>>();
  /** 请求链：保证「先开会话、再发事件」，并让重试不交错。 */
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    const next = chain.then(work, work).catch((error: unknown) => {
      logFailure('xq events: queued work failed', error);
      return fallback;
    });
    chain = next;
    return next;
  };

  const post = async (body: XqEventRequest): Promise<XqEventSendResult> => {
    if (fetchImpl === undefined) return FAILURE_NOOP;
    // 重试复用**同一个 body**：服务端的幂等键由 occurredAt 派生，
    // 重新取一个 now() 就是另一件事了。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          // ★ `keepalive` 是给「页面正在卸载」那一种请求用的：关标签页时
          // 普通 fetch 会被浏览器掐掉，于是 `session_ended` 永远发不出去，
          // 那个会话在库里就一直开着。事件体都很小，64 KB 的上限碰不到。
          keepalive: true,
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          // 4xx 是请求本身不对，重发也一样 —— 不浪费第二次。
          if (response.status < 500) {
            // 把码带回去。闸（409 ANSWER_FIRST）是**唯一**一种「拒绝也是
            // 正常结果」的情况：界面要按码说「先写下你的想法」，而不是
            // 说「发送失败」。其它 4xx 的码调用方多数不看，顺手带着。
            const refused = (await response.json().catch(() => null)) as {
              error?: { code?: unknown };
            } | null;
            const code = typeof refused?.error?.code === 'string' ? refused.error.code : undefined;
            logFailure(
              code === undefined
                ? `xq events: ${body.kind} refused with ${response.status}`
                : `xq events: ${body.kind} refused with ${response.status} ${code}`,
            );
            return { ok: false, duplicate: false, ...(code === undefined ? {} : { code }) };
          }
          continue;
        }
        const payload = (await response.json().catch(() => null)) as {
          sessionId?: unknown;
          duplicate?: unknown;
        } | null;
        return {
          ok: true,
          duplicate: payload?.duplicate === true,
          ...(typeof payload?.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
        };
      } catch (error) {
        if (attempt === 1) {
          logFailure(`xq events: failed to send ${body.kind}`, error);
          return FAILURE_NOOP;
        }
      }
    }
    // 两次 5xx：服务端确实收不下，别静默 —— 少一条事件是小事，
    // 「以为记上了其实没有」是大事。
    logFailure(`xq events: ${body.kind} failed twice with 5xx`);
    return FAILURE_NOOP;
  };

  const openSession = (stageId: string): Promise<string | undefined> => {
    const known = sessions.get(stageId);
    if (known !== undefined) return Promise.resolve(known);
    const inFlight = opening.get(stageId);
    if (inFlight !== undefined) return inFlight;
    const started = post({
      kind: 'session_started',
      stageId,
      occurredAt: now().toISOString(),
    })
      .then((result) => {
        const sessionId = result.sessionId;
        if (result.ok && sessionId !== undefined) sessions.set(stageId, sessionId);
        return sessionId;
      })
      .finally(() => {
        opening.delete(stageId);
      });
    opening.set(stageId, started);
    return started;
  };

  return {
    viewPage: (stageId: string, sceneId: string) =>
      enqueue(async () => {
        // 同一个 (stage, scene) 连续两次不重发：StrictMode 双挂载与热更新
        // 重跑副作用都会让同一页被记两遍，而那不是「他又看了一遍」。
        const last = lastScene.get(stageId);
        if (last === sceneId) return FAILURE_NOOP;
        const sessionId = await openSession(stageId);
        if (sessionId === undefined) return FAILURE_NOOP;
        // 先记下再发：即便这次发失败，也不要让同一个 effect 重跑时连发几次
        // 同一页（失败的是网络，不是「他在看这一页」这个事实）。
        lastScene.set(stageId, sceneId);
        return await post({
          kind: 'page_viewed',
          stageId,
          sceneId,
          sessionId,
          occurredAt: now().toISOString(),
        });
      }, FAILURE_NOOP),

    endSession: (stageId: string, endReason?: string) =>
      enqueue(async () => {
        const sessionId = sessions.get(stageId);
        if (sessionId === undefined) return FAILURE_NOOP;
        const result = await post({
          kind: 'session_ended',
          stageId,
          sessionId,
          occurredAt: now().toISOString(),
          ...(endReason === undefined ? {} : { endReason }),
        });
        if (result.ok) {
          sessions.delete(stageId);
          // 会话关了，下一次翻页是另一次坐下学习 —— 即使又落在同一页，
          // 那也是新会话里的第一次浏览。
          lastScene.delete(stageId);
        }
        return result;
      }, FAILURE_NOOP),

    recordEvent: (event: Omit<XqEventRequest, 'sessionId'>) =>
      enqueue(async () => {
        const sessionId = await openSession(event.stageId);
        if (sessionId === undefined) return FAILURE_NOOP;
        return await post({ ...event, sessionId });
      }, FAILURE_NOOP),

    sessionFor: (stageId: string) => openSession(stageId),
  };
}
