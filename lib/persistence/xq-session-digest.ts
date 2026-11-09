/**
 * 学情（xq）的**事件读侧**：把只追加的事件流折成「这次学了多久、今天学了什么」。
 *
 * ## 为什么要有一个独立汇总器，而不是写入时顺手算
 *
 * `xq_session` 上有 `active_ms` / `wall_ms` 两列，从建表那天起一直是空的。
 * 空着不是因为忘了 —— `xq-event-recorder.ts` 的文件头写着为什么不在写入路径上算：
 * 活跃时长要**跨事件配对**（相邻两条的间隔、按上一条的动作类型取不同上限），
 * 挂在「记一条事实」上就得为每条事件重扫该会话的全部历史。
 *
 * 所以本文件是那条注释承诺的那个汇总器：**只读事件、不改任何行**。
 * 它也不回写 `xq_session.active_ms` —— 事件还在增长，今天算出的 42 分钟
 * 明天就该变了；把它落库就得在每条新事件之后重算一遍，这正是要避免的事。
 * 需要的时候现算：一次 `lag()` 窗口函数，SQL 侧就把间隔配好了。
 *
 * ## 为什么 `active_ms` 不是「最后一条减第一条」
 *
 * 中间可能是他去吃饭了。`wall_ms` 才是「挂钟过了多久」，`active_ms` 是
 * 「其中多少算在学」。两者都给，是因为**分开看才有意义**：
 * 一次 3 小时的会话里只有 25 分钟活跃，与一次 25 分钟的会话，
 * 对「今天学了没」是同一件事，对「他是不是开着页面走了」不是。
 *
 * 上限按**上一条事件是什么**分档（N3 §4.4 的条件阈值）：
 *
 *   - 上一条是 `page_viewed` ⇒ **60 分钟**。翻页之后可能是真的在读那一页 ——
 *     阅读型的第二峰在 5–10 分钟，只有 60 分钟装得下。
 *   - 其余 ⇒ **30 分钟**。与 LA 惯例对齐的默认值。
 *
 * ## 缺口：5 分钟那一档没有实现，因为事件里没有证据
 *
 * N3 §4.4 还有第三档：「上一动作是导航/翻页 ⇒ 5 分钟」，理由是快速点过三页
 * 不该把两次学习并成一次。但 `page_viewed` **不区分「在读这一页」与「正在翻过去」** ——
 * 要分就得知道这一页停留了多久，而那正是 `dwell_ms`；今天没有任何写入方
 * 给它赋值（`grep` 只有定义与 DDL）。所以这一档**故意没做**：凭「翻页」两个字
 * 判成 5 分钟，会把真的读了 50 分钟讲义的人砍成 5 分钟，方向是错的。
 *
 * ## 撤销：两条判据都要过，因为 `voided_by` 今天没有写入方
 *
 * 一条事件被撤销之后不该继续出现在计数里。DDL 给了两种痕迹，
 * 这里两条都排掉：`kind = 'voided'`（撤销本身也是一条事件，不是被撤销的那条），
 * 以及 `voided_by IS NOT NULL`（被撤销的那条，指针指向撤销它的事件）。
 *
 * ★ **但今天没有任何代码写 `voided_by`**（`grep` 只命中 DDL 那一行）——
 * 撤销在库里只能靠一条 `kind='voided'` 加人工对账。所以上面前半条判据是真的、
 * 后半条是**预备**的：等有人写撤销时才生效，且那时不需要改本文件。
 *
 * ## 这些数字没有一条是「学习效果」的剂量参数
 *
 * N3 §4.4 末尾原话：「以上阈值没有一条是『多长才算有效学习』的实证结论 ——
 * 它们全是切分参数，不是剂量参数。」所以本模块的产出**只该给人看与做诊断**，
 * 不许进 `learner-state-render.ts` 的状态块：状态块里的每个数字模型都会当真，
 * 而「今天学了 42 分钟」既不构成会也不构成不会，还会因为每分钟都在变
 * 而破坏前缀缓存（渲染器第 1 条与第 5 条硬约束）。
 */
import type { Queryable } from '@openmaic/storage/document/pg';

/**
 * 相邻两条事件间隔的上限，按**上一条**事件的类型取。
 *
 * 60 分钟给翻页之后（可能真在读那一页），30 分钟给其余。
 * 两个都是产品默认值，不是研究结论（N3 §4.4 的诚实说明）。
 */
export const ACTIVE_GAP_CAP_MS_AFTER_PAGE = 60 * 60 * 1000;

/** 见 `ACTIVE_GAP_CAP_MS_AFTER_PAGE`。 */
export const ACTIVE_GAP_CAP_MS_DEFAULT = 30 * 60 * 1000;

/** 一次最多回多少个会话。按 `seq_no` 倒序，最近的在前。 */
export const SESSION_DIGEST_LIMIT = 50;

export interface XqSessionDigest {
  readonly sessionId: string;
  readonly startedAt: Date;
  /** 会话还没关时是 `null` —— 「还没结束」与「结束了但没记原因」是两件事。 */
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  /** 当天第几次（`xq_session.seq_no`）。 */
  readonly seqNo: number;
  /** 事件条数，不含 `voided`。 */
  readonly eventCount: number;
  /** 翻到过几页（`page_viewed` 的 distinct `scene_id`）。 */
  readonly pageCount: number;
  /** 扣掉超时之后的活跃毫秒数。 */
  readonly activeMs: number;
  /** 挂钟毫秒数：`ended_at - started_at`。会话没关时是 `null`。 */
  readonly wallMs: number | null;
  /** 求过几次提示，按分型分开 —— 两种与成绩的关系方向相反，合成一个数就没法用了。 */
  readonly hints: { readonly instrumental: number; readonly executive: number };
  /** 答过（动过手）与交卷的次数。 */
  readonly answers: { readonly attempted: number; readonly submitted: number };
}

const SESSION_DIGEST_SQL = `WITH scoped AS (
  SELECT s.session_id, s.started_at, s.ended_at, s.end_reason, s.seq_no
    FROM xq_session s
   WHERE ($1::date IS NULL OR s.local_day = $1::date)
   ORDER BY s.seq_no DESC, s.started_at DESC
   LIMIT $2
), ordered AS (
  SELECT e.session_id, e.occurred_at, e.kind, e.scene_id, e.hint_subtype,
         lag(e.occurred_at) OVER w AS prev_at,
         lag(e.kind)        OVER w AS prev_kind
    FROM xq_event e
    JOIN scoped USING (session_id)
   WHERE e.kind <> 'voided' AND e.voided_by IS NULL
  WINDOW w AS (PARTITION BY e.session_id ORDER BY e.occurred_at, e.event_id)
)
SELECT scoped.session_id, scoped.started_at, scoped.ended_at, scoped.end_reason,
       scoped.seq_no,
       count(o.occurred_at) AS event_count,
       count(DISTINCT o.scene_id) FILTER (WHERE o.kind = 'page_viewed') AS page_count,
       coalesce(sum(
         CASE WHEN o.prev_at IS NULL THEN 0
              ELSE greatest(0, least(
                     (extract(epoch FROM (o.occurred_at - o.prev_at)) * 1000)::float8,
                     CASE WHEN o.prev_kind = 'page_viewed'
                          THEN $3::float8 ELSE $4::float8 END))
         END), 0)::float8 AS active_ms,
       count(*) FILTER (WHERE o.kind = 'hint_requested'
                          AND o.hint_subtype = 'instrumental') AS hint_instrumental,
       count(*) FILTER (WHERE o.kind = 'hint_requested'
                          AND o.hint_subtype = 'executive') AS hint_executive,
       count(*) FILTER (WHERE o.kind = 'answer_attempted')  AS answers_attempted,
       count(*) FILTER (WHERE o.kind = 'answer_submitted') AS answers_submitted
  FROM scoped
  LEFT JOIN ordered o USING (session_id)
 GROUP BY scoped.session_id, scoped.started_at, scoped.ended_at,
          scoped.end_reason, scoped.seq_no
 ORDER BY scoped.seq_no DESC, scoped.started_at DESC`;

interface DigestRow extends Record<string, unknown> {
  session_id: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  end_reason: string | null;
  seq_no: number | string;
  event_count: number | string;
  page_count: number | string | null;
  active_ms: number | string | null;
  hint_instrumental: number | string;
  hint_executive: number | string;
  answers_attempted: number | string;
  answers_submitted: number | string;
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/** 数字列在 PGlite 与 node-postgres 里都可能回字符串（`numeric` / `bigint`）。 */
function asNumber(value: number | string | null): number {
  if (value === null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 折出会话摘要。
 *
 * `day` 是**学习日**（`yyyy-mm-dd`，04:00 边界，见 `xq_session.local_day`）。
 * 省略则跨全部日期，取最近 `limit` 个会话 —— 省略不是「今天」：
 * 「今天」在不同时区是不同的字符串，让调用方显式给，比在这里猜安全。
 *
 * 只读，不改任何行。
 */
export async function digestSessions(
  queryable: Queryable,
  options: { day?: string; limit?: number } = {},
): Promise<XqSessionDigest[]> {
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.trunc(options.limit as number))
    : SESSION_DIGEST_LIMIT;

  const { rows } = await queryable.query<DigestRow>(SESSION_DIGEST_SQL, [
    options.day ?? null,
    limit,
    ACTIVE_GAP_CAP_MS_AFTER_PAGE,
    ACTIVE_GAP_CAP_MS_DEFAULT,
  ]);

  return rows.map((row) => {
    const startedAt = asDate(row.started_at) ?? new Date(0);
    const endedAt = asDate(row.ended_at);
    const wallMs = endedAt === null ? null : Math.max(0, endedAt.getTime() - startedAt.getTime());
    return {
      sessionId: row.session_id,
      startedAt,
      endedAt,
      endReason: row.end_reason,
      seqNo: asNumber(row.seq_no),
      eventCount: asNumber(row.event_count),
      pageCount: asNumber(row.page_count),
      activeMs: Math.round(asNumber(row.active_ms)),
      wallMs,
      hints: {
        instrumental: asNumber(row.hint_instrumental),
        executive: asNumber(row.hint_executive),
      },
      answers: {
        attempted: asNumber(row.answers_attempted),
        submitted: asNumber(row.answers_submitted),
      },
    };
  });
}
