/**
 * 学习会话的**浏览器侧客户端**：读「今天学了多久」。
 *
 * ## 为什么它自己一层
 *
 * 与其他三个客户端同一条分工：一个端点一个客户端（复习管待办、对话日志管
 * 历史、这里管时长）。合成一个大客户端只会让「读失败」的语义在三处不一致。
 *
 * ## 为什么时长要分「活跃」与「挂钟」两个数
 *
 * 服务端已经从事件间隔里扣掉了超时（`activeMs`），`wallMs` 是挂钟。
 * 一次三小时的会话里只有二十五分钟活跃，与一次二十五分钟的会话，
 * 对「今天学了没」是同一件事，对「他是不是开着页面走了」不是。
 *
 * ★ 这两个数**只给人看**。它们不进 `learner-state-render.ts` 的状态块：
 * N3 §4.4 的阈值全是**切分参数**不是**剂量参数**，「今天学了 42 分钟」
 * 既不构成会也不构成不会，还会因为每分钟都在变而破坏前缀缓存。
 *
 * ## 为什么读失败不说成「今天没学」
 *
 * 与其他两个读客户端同一条理由，这里后果同样重：一份空的会话列表看起来像
 * 「他今天没学习」。把网络失败画成那样，会让人在真正的原因是服务端没起来时
 * 去怀疑自己的自律。所以回 `{ ok: false }` 而不是空数组。
 *
 * ## 为什么不做分页
 *
 * 服务端一次最多回 50 个会话（`SESSION_DIGEST_LIMIT`）。这是**全部**而不是
 * 第一页 —— 与复习队列、对话日志一致。
 */

/** 会话汇总端点。 */
export const XQ_SESSIONS_ENDPOINT = '/api/persistence/xq/sessions';

/** 一个会话的 JSON 形态（服务端 `XqSessionDigest`，两个时间字段是 ISO 串）。 */
export interface XqSessionDigestView {
  readonly sessionId: string;
  readonly startedAt: string;
  /** 会话还没关时是 `null`。 */
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly seqNo: number;
  readonly eventCount: number;
  readonly pageCount: number;
  readonly activeMs: number;
  /** 挂钟毫秒数。会话没关时是 `null` —— 「还没结束」与「结束了但没记时长」不同。 */
  readonly wallMs: number | null;
  readonly hints: { readonly instrumental: number; readonly executive: number };
  readonly answers: { readonly attempted: number; readonly submitted: number };
}

export interface XqSessionsResult {
  readonly ok: boolean;
  readonly sessions: readonly XqSessionDigestView[];
}

export interface XqSessionsClientDeps {
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly logFailure?: (message: string, error?: unknown) => void;
}

export interface XqSessionsClient {
  /** 读会话汇总。不给 `day` 就跨全部学习日，最近的在前。 */
  read(options?: { day?: string; limit?: number }): Promise<XqSessionsResult>;
}

function defaultLogFailure(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message);
  else console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function countOf(raw: unknown, key: string): number {
  if (typeof raw !== 'object' || raw === null) return 0;
  return finiteOr((raw as Record<string, unknown>)[key], 0);
}

/** 收敛一个未知形状的会话。缺身份的整条丢 —— 一个没有 id 的会话没法点进去。 */
function asSession(raw: unknown): XqSessionDigestView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { sessionId, startedAt } = value;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (typeof startedAt !== 'string' || startedAt === '') return null;
  const endedAt = typeof value.endedAt === 'string' && value.endedAt !== '' ? value.endedAt : null;
  const wallMs =
    typeof value.wallMs === 'number' && Number.isFinite(value.wallMs) ? value.wallMs : null;
  return {
    sessionId,
    startedAt,
    endedAt,
    endReason:
      typeof value.endReason === 'string' && value.endReason !== '' ? value.endReason : null,
    seqNo: finiteOr(value.seqNo, 0),
    eventCount: finiteOr(value.eventCount, 0),
    pageCount: finiteOr(value.pageCount, 0),
    activeMs: finiteOr(value.activeMs, 0),
    wallMs,
    hints: {
      instrumental: countOf(value.hints, 'instrumental'),
      executive: countOf(value.hints, 'executive'),
    },
    answers: {
      attempted: countOf(value.answers, 'attempted'),
      submitted: countOf(value.answers, 'submitted'),
    },
  };
}

/** 造一个客户端。`fetchImpl` / `logFailure` 可注入，组件层只测纯逻辑。 */
export function createXqSessionsClient(deps: XqSessionsClientDeps = {}): XqSessionsClient {
  const endpoint = deps.endpoint ?? XQ_SESSIONS_ENDPOINT;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const logFailure = deps.logFailure ?? defaultLogFailure;

  const read: XqSessionsClient['read'] = async (options = {}) => {
    const params = new URLSearchParams();
    if (options.day !== undefined && options.day !== '') params.set('day', options.day);
    if (options.limit !== undefined && Number.isFinite(options.limit)) {
      params.set('limit', String(Math.trunc(options.limit)));
    }
    const query = params.toString();
    const url = query === '' ? endpoint : `${endpoint}?${query}`;

    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch (error) {
      logFailure('xq sessions: read failed before reaching the server', error);
      return { ok: false, sessions: [] };
    }

    if (!response.ok) {
      logFailure(`xq sessions: read refused with ${response.status}`);
      return { ok: false, sessions: [] };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      logFailure('xq sessions: response was not JSON', error);
      return { ok: false, sessions: [] };
    }

    const rawSessions =
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { sessions?: unknown }).sessions)
        ? (payload as { sessions: unknown[] }).sessions
        : [];
    const sessions = rawSessions
      .map(asSession)
      .filter((session): session is XqSessionDigestView => session !== null);
    return { ok: true, sessions };
  };

  return { read };
}

/** 把一个会话折成一行能读的字：`12 分钟 · 8 条事件 · 3 页`。 */
export function sessionSummary(session: XqSessionDigestView): {
  readonly minutes: number;
  readonly pages: number;
  readonly open: boolean;
} {
  return {
    minutes: Math.max(0, Math.round(session.activeMs / 60_000)),
    pages: session.pageCount,
    // 「还没关」不是「结束了但没时长」—— 只有 endedAt 为 null 才算开着。
    open: session.endedAt === null,
  };
}

/** 一天的合计：只累加**已结束**的会话（还在进行中的那个数只会越算越小）。 */
export function totalActiveMs(sessions: readonly XqSessionDigestView[]): number {
  let total = 0;
  for (const session of sessions) {
    if (session.endedAt === null) continue;
    total += Math.max(0, session.activeMs);
  }
  return total;
}
