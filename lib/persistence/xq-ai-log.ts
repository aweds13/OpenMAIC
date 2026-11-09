/**
 * 学情（xq）的**对话日志读侧**：把「他在哪道题上问过 AI」从两个地方拼回来。
 *
 * ## 为什么这件事需要一份专门的读法
 *
 * 对话内容与提问事实**分别存在两个地方**，这是刻意的（`M` §11.3 ①）：
 *
 *   - `runtime_records` 存**内容**（他说了什么、AI 答了什么），
 *     有上限（200 条消息 / 256 条记录），超了会滚动。
 *   - `xq_event` 存**事实**（问过、哪一类、在哪道题上），只追加、不进正文。
 *
 * 两边靠 `(stage_id, scene_id, question_id)` 与 `RuntimeRecord.subAnchor` 对上。
 * 在那之前 chat 记录从来没写过 `subAnchor`（真库 31 条 chat 记录，带锚点 0 条），
 * 所以「他在这道题上问过什么」永远只能按页归并 —— 一页八道题混成一堆。
 *
 * ## ★ 滚动是这份读法最容易静默读错的地方
 *
 * 一场**逻辑对话**在库里可能不止一行 `runtime_sessions`：记录数超过
 * `MAX_RUNTIME_RECORDS_PER_CHAT_SESSION = 256` 时，写入侧会开新一代，
 * id 是 `chat:<stage>:<learner>:<session>:generation:<n>`。
 *
 * 按 `session_id` 读会**读到半场而看不出是半场** —— 它不报错、不抛异常，
 * 只是少了一半。这与「读失败」是两回事：读失败会 `ok:false`，静默截断
 * 会给出一个看起来完整的答案。所以本文件一律按 **base id**
 * （`split_part(session_id, ':generation:', 1)`）归并，并把「滚过几次」
 * 单独交出去（`generations`），让人能看见自己读的是几行。
 *
 * ## 为什么按时间邻近配对话，而不是存一个显式 id
 *
 * 存 `hint_requested.payload.chat_record_id` 当然更精确，但记录会因为滚动
 * 换 `session_id`、会因为压缩被替换成摘要 —— 存下来的 id 会**变成孤儿且
 * 不报错**。三元组 + 时间窗不会：它对不上就是「没找到」，能数出来。
 *
 * 时间窗取 **5 分钟**。这是产品默认值（与 `N3` §4.4 的空闲阈值同一量级），
 * 不是研究结论。宽一点会把「问完之后又聊了别的」也并进来，
 * 窄一点会把「问了、想了想、接着说」切成两段。
 *
 * ## 只读
 *
 * 本文件不写任何行，也不回写 `xq_event` 或 `runtime_records`。
 */
import type { Queryable } from '@openmaic/storage/document/pg';

/**
 * 提问与对话记录之间允许的最大间隔。
 *
 * 5 分钟：产品默认值，不是研究结论。见文件头「为什么按时间邻近配对话」。
 */
export const AI_LOG_PROXIMITY_MS = 5 * 60 * 1000;

/** 一次最多回多少条提问。最近的在前。 */
export const AI_LOG_LIMIT = 100;

/** 每一条提问在对话里找到的原文（截断后）。 */
export interface XqAiLogTurn {
  /** `runtime_records.id` —— 要回看全文时用它。 */
  readonly recordId: string;
  /** `runtime_records.session_id`（可能带 `:generation:<n>`）。 */
  readonly runtimeSessionId: string;
  /** 这一代是第几代。`0` = 没滚动过。 */
  readonly generation: number;
  readonly createdAt: Date;
  /** 说话的哪一方。`user` / `assistant` / 未知时 `''`。 */
  readonly role: string;
  /** 正文，已截断到 `AI_LOG_TEXT_MAX_CHARS`。 */
  readonly text: string;
  /** 原文是否被截断。 */
  readonly truncated: boolean;
}

/** 一条提问，以及它在对话里配到的那些轮次。 */
export interface XqAiLogEntry {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly stageId: string;
  readonly sceneId: string;
  readonly questionId: string;
  /** `instrumental` / `executive`。这两个与成绩的关系方向相反。 */
  readonly hintSubtype: string;
  /** 题干（写事件时存进 `payload.stem` 的那份）。 */
  readonly stem: string;
  /** 配到的轮次，按时间正序。空数组 = 「记了问，但找不到那场对话」。 */
  readonly turns: readonly XqAiLogTurn[];
  /**
   * 配到的记录分布在几代里。
   *
   * `1` = 这一批轮次都在同一代（多数情况，包括没滚过的）。
   * `>1` = 时间窗跨了代 —— 读侧已按 base id 归并过，这里的数只是把
   * 「他这几句话散在几行里」显式交出去，不让它变成隐藏知识。
   */
  readonly generations: number;
}

const AI_LOG_SQL = `WITH asks AS (
  SELECT e.event_id, e.occurred_at, e.stage_id, e.scene_id, e.question_id,
         e.hint_subtype, coalesce(e.payload->>'stem', '') AS stem
    FROM xq_event e
    -- ★ 学习日读**已经落库的那一列**，不在这里现算。
    -- xq_session.local_day 是 localDayOf() 按 04:00 边界算好写进去的；
    -- 在 SQL 里按日历日现算一遍，同一个 day 参数在 /xq/sessions（读 local_day）
    -- 与这里（现算）指向不同的日期 —— 凌晨两点那一条会在会话摘要里属昨天、
    -- 在对话日志里属今天。一条事实只许有一处投影。
    -- ★ 这一段注释里不许出现反引号：它会终止外层的模板字符串。
    JOIN xq_session s ON s.session_id = e.session_id
   WHERE e.kind = 'hint_requested'
     AND e.question_id IS NOT NULL
     AND e.question_id <> ''
     AND ($1::date IS NULL OR s.local_day = $1::date)
   ORDER BY e.occurred_at DESC
   LIMIT $2
), matched AS (
  -- 只认对话消息。同一个会话里还有 'chat_session_state' 之类的记录，
  -- 它们的 payload 里没有 role/content，混进来会产出空壳轮次。
  SELECT a.event_id,
         r.id            AS record_id,
         r.session_id    AS runtime_session_id,
         r.created_at    AS record_created_at,
         coalesce(r.data->'payload'->>'role', '') AS role,
         coalesce(r.data->'payload'->>'content',
                  r.data->>'content', '') AS body,
         (r.created_at)::timestamptz AS record_created_at_ts
    FROM asks a
    JOIN runtime_records r
      ON r.scene_id = a.scene_id
     AND r.data->>'subAnchor' = a.question_id
     AND r.data->'payload'->>'kind' = 'chat_message'
     -- ★ runtime_records.created_at 是 TEXT（ISO 串），xq_event.occurred_at 是
     -- timestamptz。直接比会报 operator does not exist: text >= timestamptz。
     -- 把文本那侧显式转过去 —— 让另一侧转字符串则是自找时区漏洞。
     AND (r.created_at)::timestamptz >= a.occurred_at
     AND (r.created_at)::timestamptz <= a.occurred_at + ($3::float8 / 1000) * interval '1 second'
    JOIN runtime_sessions s
      ON s.id = r.session_id
     AND s.kind = 'chat'
     AND s.stage_id = a.stage_id
), gen AS (
  -- 配到的记录分布在几代里。按 base id 归并是滚动安全的读法，
  -- 这个数只是把「他在几代里说过话」显式交出去。
  SELECT m.event_id,
         count(DISTINCT m.runtime_session_id) AS generations
    FROM matched m
   GROUP BY m.event_id
)
SELECT a.event_id, a.occurred_at, a.stage_id, a.scene_id, a.question_id,
       a.hint_subtype, a.stem,
       coalesce(g.generations, 0) AS generations,
       m.record_id, m.runtime_session_id, m.record_created_at_ts AS record_created_at,
       m.role, m.body
  FROM asks a
  LEFT JOIN gen g ON g.event_id = a.event_id
  LEFT JOIN matched m ON m.event_id = a.event_id
 ORDER BY a.occurred_at DESC, m.record_created_at, m.record_id`;

/** 正文截断长度。够看清问了什么，不会把整段对话搬进内存。 */
export const AI_LOG_TEXT_MAX_CHARS = 400;

interface AiLogRow extends Record<string, unknown> {
  event_id: string;
  occurred_at: Date | string;
  stage_id: string;
  scene_id: string;
  question_id: string;
  hint_subtype: string | null;
  stem: string | null;
  generations: number | string | null;
  record_id: string | null;
  runtime_session_id: string | null;
  record_created_at: Date | string | null;
  role: string | null;
  body: string | null;
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function asNumber(value: number | string | null): number {
  if (value === null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 按**码点**截断。
 *
 * 按 UTF-16 码元切会切出孤立代理项（`𝔸` / `∑` 在数学题里很常见），
 * 前端拿到会显示成 `�`。
 */
function truncate(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= AI_LOG_TEXT_MAX_CHARS) return { text, truncated: false };
  return { text: `${chars.slice(0, AI_LOG_TEXT_MAX_CHARS).join('')}…`, truncated: true };
}

/** `chat:<...>:generation:<n>` 里取 n；没有就是 0。 */
function generationOf(runtimeSessionId: string): number {
  const marker = ':generation:';
  const at = runtimeSessionId.lastIndexOf(marker);
  if (at < 0) return 0;
  const parsed = Number(runtimeSessionId.slice(at + marker.length));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * 读出提问日志。
 *
 * `day` 是**学习日**（`yyyy-mm-dd`）。省略则跨全部日期 —— 省略不是「今天」，
 * 与 `digestSessions()` 同一口径。
 *
 * ★ 时区：`day` 直接读 `xq_session.local_day`（`localDayOf()` 按 04:00 边界
 * 算好落库的那一列），**不在这里现算**。此前这里写的是
 * `(occurred_at AT TIME ZONE 'Asia/Shanghai')::date` —— 那是**日历日**，
 * 与 `local_day` 不是同一个概念：凌晨两点那一次在会话摘要里属昨天、
 * 在对话日志里属今天，而同一个 `day` 参数被两个端点解释成两个答案。
 * 判据 `tests/persistence/xq-ai-log.test.ts` 的「day 是学习日」那一条钉住它。
 *
 * 只读，不改任何行。
 */
export async function readAiLog(
  queryable: Queryable,
  options: { day?: string; limit?: number } = {},
): Promise<XqAiLogEntry[]> {
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.trunc(options.limit as number))
    : AI_LOG_LIMIT;

  const { rows } = await queryable.query<AiLogRow>(AI_LOG_SQL, [
    options.day ?? null,
    limit,
    AI_LOG_PROXIMITY_MS,
  ]);

  // 一条提问可能配到多轮，按 event_id 归并。Map 迭代顺序 = 首次插入顺序，
  // 而 SQL 已按 occurred_at DESC 排好，所以输出顺序是稳定的。
  const byEvent = new Map<string, { entry: Omit<XqAiLogEntry, 'turns'>; turns: XqAiLogTurn[] }>();
  for (const row of rows) {
    let grouped = byEvent.get(row.event_id);
    if (grouped === undefined) {
      grouped = {
        entry: {
          eventId: row.event_id,
          occurredAt: asDate(row.occurred_at) ?? new Date(0),
          stageId: row.stage_id,
          sceneId: row.scene_id,
          questionId: row.question_id,
          hintSubtype: row.hint_subtype ?? '',
          stem: row.stem ?? '',
          generations: asNumber(row.generations),
        },
        turns: [],
      };
      byEvent.set(row.event_id, grouped);
    }
    // LEFT JOIN 的「没配上」那一行：record_id 为 null，不是一轮对话。
    if (row.record_id === null || row.runtime_session_id === null) continue;
    const createdAt = asDate(row.record_created_at);
    if (createdAt === null) continue;
    const body = truncate(row.body ?? '');
    grouped.turns.push({
      recordId: row.record_id,
      runtimeSessionId: row.runtime_session_id,
      generation: generationOf(row.runtime_session_id),
      createdAt,
      role: row.role ?? '',
      text: body.text,
      truncated: body.truncated,
    });
  }

  return [...byEvent.values()].map(({ entry, turns }) => ({ ...entry, turns }));
}
