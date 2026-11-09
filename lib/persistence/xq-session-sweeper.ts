/**
 * 学情（xq）的**会话收尾器**：把「开着但早就没人动了」的会话关掉。
 *
 * ## 为什么需要它
 *
 * 会话的关闭今天有两条路径，都靠浏览器：
 *
 *   1. 播放态组件的 `teardown()`（点返回、切编辑态）；
 *   2. `pagehide`（关标签页、导航离开）—— 请求带 `keepalive` 才发得出去。
 *
 * 两条都在客户端。而**断电、浏览器崩溃、进程被杀、`keepalive` 被中间层截掉**
 * 这四种情况下，浏览器不会再跑任何代码 —— 会话在库里就永远
 * `ended_at IS NULL`。后果不是"数据脏了一点"：`/sessions` 的合计只累加
 * **已结束**的会话（进行中那一个的活跃毫秒会越算越小，算进去会让合计倒退），
 * 所以一个永远开着的会话会把那次学习永久地从"今天学了多久"里抹掉。
 *
 * 服务端是唯一能在客户端不打招呼就消失之后还活着的东西，所以收尾必须在这里。
 *
 * ## 为什么用「上一条事件距今多久」而不是「会话开了多久」
 *
 * 一个人可能开着页面读了 3 小时（那是**一次**学习，不该被切断），
 * 也可能翻了一页就走了（那一次该在 30 分钟后收掉）。判据落在**最后一条事件**
 * 上，与 `xq-session-digest.ts` 算 `active_ms` 用的是同一组分档常量 ——
 * 两处用不同的阈值会出现"这次学习被算成 25 分钟，却被 30 分钟后关掉"这种
 * 自相矛盾（25 分钟 < 30 分钟，说明中间有一段被截断的静默）。
 *
 * ## 为什么 `end_reason` 是 `idle_*` 而不是 `crash`
 *
 * 收尾器**分不出**这人是关掉了浏览器、断电了，还是只是睡着了没关页面。
 * 三档 `idle_5m` / `idle_30m` / `idle_60m` 正好表达"哪一档阈值判的"，
 * 而它们都是事实（"最后一条事件之后静默了 N 分钟"），不带推测。
 * `crash` 留给真正知道那是崩溃的调用方（今天没有）。
 *
 * ## 收尾时刻取的是「最后一条事件」，不是「现在」
 *
 * `recordXqEvent` 会把 `ended_at` 写成传进去的 `occurredAt`。这里传的是
 * **最后一条事件的时刻**，于是 `wall_ms` 是「他真正在动的那一段」，
 * 不包含之后那段静默 —— 那一段没有任何证据说明他在学，把它算进墙钟
 * 会让「这次学了 3 小时」变成一句没有根据的话。
 *
 * 副作用是收尾之后 `ended_at` 比 `now()` 早（可以早一个钟头）。这是刻意的：
 * 收尾器是**事后补记**「那次在什么时候结束的」，不是「我们在什么时候发现」。
 * `recorded_at` 才是后者，而它由数据库默认值写，不需要这里操心。
 *
 * ## 它不写"假事件"
 *
 * 收尾靠一条真事件：`kind='session_abandoned'` + 正常的幂等键。
 * 于是它与浏览器发来的 `session_ended` 走**同一条**路径（同一条 SQL、同一份
 * `CLOSE_SESSION_SQL`），不发明第二套关闭逻辑；重跑两次也只落一条
 * （幂等键由 `sessionId + 时刻` 派生，而时刻取的是**最后一条事件的时刻**，
 * 不是 `now()` —— 后者每次重跑都不同，那就等于没有幂等）。
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { ACTIVE_GAP_CAP_MS_AFTER_PAGE, ACTIVE_GAP_CAP_MS_DEFAULT } from './xq-session-digest';
import { recordXqEvent, type XqEndReason } from './xq-event-recorder';

/** 一次最多收几张 —— 与其它读侧一致。 */
export const SESSION_SWEEP_LIMIT = 200;

/**
 * 一句 SQL 把"该收的"挑出来。
 *
 * `last_kind` / `last_at` 用 `DISTINCT ON` 取最后一条 —— 直接在 `HAVING` 里
 * 写 `max(occurred_at)` 拿不到最后那条的 `kind`，而分档正靠它。
 *
 * 参数：`$1` = 默认阈值（其余动作），`$2` = 翻页之后的阈值，`$3` = 条数，
 * `$4` = 「现在」。
 *
 * ★ 第四个别用 `now()`：注入的 `now` 必须**同时**决定「谁该收」与「静默了多久」，
 * 否则两个数会来自两只钟表 —— 判据随真实时间漂，而 `idleMs` 报的是另一件事。
 * （第一版就是这么写的，被「静默 59 分钟不该收」那条判据抓出来。）
 */
const STALE_SESSIONS_SQL = `WITH last AS (
  SELECT DISTINCT ON (e.session_id)
         e.session_id, e.kind, e.occurred_at, e.stage_id
    FROM xq_event e
   WHERE e.kind <> 'voided' AND e.voided_by IS NULL
   ORDER BY e.session_id, e.occurred_at DESC, e.event_id DESC
)
SELECT s.session_id,
       l.stage_id,
       l.kind AS last_kind,
       l.occurred_at AS last_at
  FROM xq_session s
  JOIN last l ON l.session_id = s.session_id
 WHERE s.ended_at IS NULL
   AND l.occurred_at <= $4::timestamptz - make_interval(secs => CASE WHEN l.kind = 'page_viewed' THEN $2::float8 ELSE $1::float8 END / 1000.0)
 ORDER BY l.occurred_at
 LIMIT $3`;

interface StaleRow extends Record<string, unknown> {
  session_id: string;
  /** `xq_event.stage_id` 可空（DDL 不强制）—— 空的那种跳过，见下。 */
  stage_id: string | null;
  last_kind: string;
  last_at: Date | string;
}

/** 收掉的那一次会话 —— 只留下诊断需要的东西。 */
export interface SweptSession {
  sessionId: string;
  stageId: string;
  /** 最后一条事件之后静默了多久（拿它判的档）。 */
  idleMs: number;
  endReason: XqEndReason;
}

/**
 * 把静默过久的会话关掉。
 *
 * 返回收掉的那几次。**不抛**：这是后台收尾，一次失败不该让调度它的地方炸；
 * 失败逐条记日志后继续处理下一张。
 *
 * `now` 可注入 —— 与其它写入器一致，判据不该随真实钟表漂。
 */
export async function sweepStaleSessions(
  queryable: Queryable,
  options: { now?: () => Date; limit?: number; logFailure?: (m: string, e?: unknown) => void } = {},
): Promise<SweptSession[]> {
  const now = options.now ?? (() => new Date());
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.trunc(options.limit as number))
    : SESSION_SWEEP_LIMIT;
  if (limit === 0) return [];

  const at = now();
  const { rows } = await queryable.query<StaleRow>(STALE_SESSIONS_SQL, [
    ACTIVE_GAP_CAP_MS_DEFAULT,
    ACTIVE_GAP_CAP_MS_AFTER_PAGE,
    Math.min(limit, SESSION_SWEEP_LIMIT),
    at.toISOString(),
  ]);

  const swept: SweptSession[] = [];
  for (const row of rows) {
    // `stage_id` 可空是 DDL 的既成事实。收尾事件必须带它（否则那条事实
    // 不属于任何一门课，读侧没法归位），所以空的那种**跳过而不是补一个空串**：
    // 空串会写出 stage_id = '' 的行，比不收更糟。
    if (row.stage_id === null || row.stage_id === '') continue;
    const lastAt = row.last_at instanceof Date ? row.last_at : new Date(row.last_at);
    if (Number.isNaN(lastAt.getTime())) continue;
    const idleMs = Math.max(0, at.getTime() - lastAt.getTime());
    const cap =
      row.last_kind === 'page_viewed' ? ACTIVE_GAP_CAP_MS_AFTER_PAGE : ACTIVE_GAP_CAP_MS_DEFAULT;
    const endReason: XqEndReason = cap === ACTIVE_GAP_CAP_MS_AFTER_PAGE ? 'idle_60m' : 'idle_30m';
    try {
      // 幂等键不交给派生：派生用的是 `occurredAt`，而这里必须用
      // **最后一条事件的时刻**（重跑时才撞得上同一个键）。显式给一个
      // 与 `now()` 无关的键，重跑两次也只会落一条。
      await recordXqEvent(queryable, {
        kind: 'session_abandoned',
        stageId: row.stage_id,
        sessionId: row.session_id,
        occurredAt: lastAt.toISOString(),
        endReason,
        dedupeKey: `sweep:${row.session_id}:${lastAt.toISOString()}`,
      });
      swept.push({ sessionId: row.session_id, stageId: row.stage_id, idleMs, endReason });
    } catch (error) {
      (options.logFailure ?? defaultLogFailure)(
        `xq: failed to sweep session ${row.session_id} (idle ${Math.round(idleMs / 60000)}m)`,
        error,
      );
    }
  }
  return swept;
}

/**
 * 一个随手可用的幂等键生成器 —— 只给测试与诊断用。
 *
 * 放在这里而不是内联，是为了让"键长什么样"在文件里能一眼看到：
 * 它与 `recordXqEvent` 内部那条派生规则**刻意不同**（那条含 `occurredAt`，
 * 而它的 `occurredAt` 每次重跑都会变）。
 */
export function sweepDedupeKey(sessionId: string, lastAt: Date): string {
  return `sweep:${sessionId}:${lastAt.toISOString()}`;
}

function defaultLogFailure(message: string, error?: unknown): void {
  // 与其它写入器一致的降级：写成一行 warn，不冒泡。
  console.warn(
    error === undefined
      ? message
      : `${message}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
