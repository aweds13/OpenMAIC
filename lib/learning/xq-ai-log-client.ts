/**
 * 对话日志的**浏览器侧客户端**：读「他在这道题上问过 AI 什么」。
 *
 * ## 为什么它自己一层，不复用复习那个
 *
 * 复习客户端管的是「到期了要做什么」，返回的东西会立刻改变屏幕上的
 * 待办数量；这里读的是一份**历史**，失败就只是没读到历史。
 * 两者共用同一个 URL 前缀但不同资源，合成一个客户端只会让
 * 「读失败」的语义在两处不一致。
 *
 * ## 为什么读失败与「没有记录」必须分开
 *
 * 与复习列表同一条理由，但后果更重：一份空的对话日志看起来像
 * 「他从来没用过 AI」。把网络失败画成「没有记录」会让这个页面
 * 在最需要它的时候（排查「为什么学情里什么都没有」）说出错误结论。
 * 所以这里回 `{ ok: false }` 而不是空数组。
 *
 * ## 为什么不做分页
 *
 * 服务端一次最多回 100 条（`AI_LOG_LIMIT`）。与复习队列一样，
 * 这是**全部**而不是第一页：假装支持翻页比不支持更糟。
 */

/** 对话日志端点。 */
export const XQ_AI_LOG_ENDPOINT = '/api/persistence/xq/ai-log';

/** 一条轮次（服务端 `XqAiLogTurn` 的 JSON 形态）。 */
export interface XqAiLogTurn {
  readonly recordId: string;
  readonly runtimeSessionId: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly role: string;
  readonly text: string;
  readonly truncated: boolean;
}

/** 一条提问，以及它在对话里配到的轮次。 */
export interface XqAiLogEntry {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly stageId: string;
  readonly sceneId: string;
  readonly questionId: string;
  readonly hintSubtype: string;
  readonly stem: string;
  /**
   * 配到的记录散在几代里。
   *
   * `1` = 都在同一代。`>1` = 时间窗跨了代（服务端已按 base id 归并过）。
   * ★ 界面必须把它显示出来：一场对话在库里是几行不该是隐藏知识，
   * 否则「为什么这里只看到半场」永远查不出来。
   */
  readonly generations: number;
  readonly turns: readonly XqAiLogTurn[];
}

export interface XqAiLogResult {
  readonly ok: boolean;
  readonly entries: readonly XqAiLogEntry[];
}

export interface XqAiLogClientDeps {
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly logFailure?: (message: string, error?: unknown) => void;
}

export interface XqAiLogClient {
  /** 读最近的学习日（不给 `day` 就跨全部日期，最近的在前）。 */
  read(options?: { day?: string; limit?: number }): Promise<XqAiLogResult>;
}

function defaultLogFailure(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message);
  else console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

/** 收敛一条未知形状的轮次。缺关键字段就整条丢 —— 半个轮次不如没有。 */
function asTurn(raw: unknown): XqAiLogTurn | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { recordId, runtimeSessionId, createdAt, text } = value;
  if (typeof recordId !== 'string' || recordId === '') return null;
  if (typeof runtimeSessionId !== 'string') return null;
  if (typeof createdAt !== 'string' || createdAt === '') return null;
  if (typeof text !== 'string') return null;
  const generation = typeof value.generation === 'number' ? value.generation : 0;
  return {
    recordId,
    runtimeSessionId,
    generation: Number.isFinite(generation) ? generation : 0,
    createdAt,
    role: typeof value.role === 'string' ? value.role : '',
    text,
    truncated: value.truncated === true,
  };
}

/** 收敛一条未知形状的提问。只缺标注的字段回空串，缺身份的整条丢。 */
function asEntry(raw: unknown): XqAiLogEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { eventId, occurredAt, stageId, sceneId, questionId } = value;
  if (typeof eventId !== 'string' || eventId === '') return null;
  if (typeof occurredAt !== 'string' || occurredAt === '') return null;
  if (typeof stageId !== 'string' || stageId === '') return null;
  if (typeof sceneId !== 'string' || sceneId === '') return null;
  if (typeof questionId !== 'string' || questionId === '') return null;
  const turns = Array.isArray(value.turns)
    ? value.turns.map(asTurn).filter((turn): turn is XqAiLogTurn => turn !== null)
    : [];
  const generations = typeof value.generations === 'number' ? value.generations : 0;
  return {
    eventId,
    occurredAt,
    stageId,
    sceneId,
    questionId,
    hintSubtype: typeof value.hintSubtype === 'string' ? value.hintSubtype : '',
    stem: typeof value.stem === 'string' ? value.stem : '',
    generations: Number.isFinite(generations) ? generations : 0,
    turns,
  };
}

/**
 * 造一个客户端。
 *
 * `fetchImpl` 与 `logFailure` 可注入是为了让判据不必真的发请求 ——
 * 仓里没有 `@testing-library/react`，组件层只测纯函数与收敛逻辑。
 */
export function createXqAiLogClient(deps: XqAiLogClientDeps = {}): XqAiLogClient {
  const endpoint = deps.endpoint ?? XQ_AI_LOG_ENDPOINT;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const logFailure = deps.logFailure ?? defaultLogFailure;

  const read: XqAiLogClient['read'] = async (options = {}) => {
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
      logFailure('xq ai log: read failed before reaching the server', error);
      return { ok: false, entries: [] };
    }

    if (!response.ok) {
      logFailure(`xq ai log: read refused with ${response.status}`);
      return { ok: false, entries: [] };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // 200 却不是 JSON 仍然是「没读到」，不是「没有记录」。
      logFailure('xq ai log: response was not JSON', error);
      return { ok: false, entries: [] };
    }

    const rawEntries =
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { entries?: unknown }).entries)
        ? (payload as { entries: unknown[] }).entries
        : [];
    const entries = rawEntries
      .map(asEntry)
      .filter((entry): entry is XqAiLogEntry => entry !== null);
    return { ok: true, entries };
  };

  return { read };
}

/**
 * 一条提问配到了几轮对话。空数组时是「没找到那场对话」，
 * 与「找到了但内容为空」不同 —— 界面要说不同的话。
 */
export function turnSummary(entry: XqAiLogEntry): {
  readonly answered: boolean;
  readonly userTurns: number;
  readonly assistantTurns: number;
} {
  let userTurns = 0;
  let assistantTurns = 0;
  for (const turn of entry.turns) {
    if (turn.role === 'user') userTurns += 1;
    else if (turn.role === 'assistant') assistantTurns += 1;
  }
  return { answered: entry.turns.length > 0, userTurns, assistantTurns };
}
