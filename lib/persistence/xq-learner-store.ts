/**
 * 学情（xq）的**写入层**：把「答过一次题」落成事实、把事实折成状态、把错题排成四关。
 *
 * ## 为什么同一份事实只落 `xq_probe_item`，而 `xq_cell_state` 是缓存
 *
 * `xq_probe_item` 一行 = 一次可复核的观测：谁（`task_id`）在哪一页
 * （`stage_id` + `scene_id`）哪道题（`question_id`）什么时候答的、对没对、
 * 答之前多自信。它是**唯一**记着「发生过什么」的地方，只追加、不更新
 * （唯一的例外是 `counted_n`：同题重测把 1.0 降成 0.5，表示这条证据只值半题）。
 *
 * `xq_cell_state` 一页一格，存的是 `classifyEvidence()` 从上面那些行算出来的
 * 三态判定。**它可以整表删掉重算，不丢任何事实** —— 这就是「缓存」的定义，
 * 也是这里唯一该有的分工。反过来做（把判定当成事实存、再拿判定去反推证据）
 * 会在第一次调阈值时全部作废：阈值是 `xq-mastery.ts` 里的常量，改一次就该
 * 全部重算，而「谁哪天答错了第 3 题」不该跟着变。
 *
 * 复习排期（`xq_review_schedule`）也不是第四份事实：它由「这道题错了」推出来，
 * 四行 1/3/7/15 天。它单独存是因为**日期要能被改**（做错回第 1 关会重排），
 * 而观测日期不能。
 *
 * ## 三条实现上的硬约束
 *
 * 1. **任何按页的读写都带 `stage_id`**。`document_scenes` 的主键是
 *    `(stage_id, id)`；实测全库 234 行 / 112 个不同 scene id，其中 35 个 id 跨
 *    stage 复用、34 个连类型都不同 —— 只按 `scene_id` 读写会把两门课的题算成一题。
 * 2. **`numeric` 从 pg 里读出来是 string**，必须 `Number()` 之后才能进
 *    `classifyEvidence()`。忘了这一步，加法会变成字符串拼接（`"1.0" + "0.5"`
 *    得到 `"1.00.5"`），`n < MIN_ITEMS_FOR_VERDICT` 的判定会静默失效。
 * 3. **同题重测的判定在 SQL 里做**（`EXISTS` 子查询），不在 JS 里「先查再写」。
 *    后者在两次往返之间有一个窗口：两个并发的答题提交都会读到「没有重测记录」，
 *    于是都写 1.0 —— 那天这道题就凭空多算了一题。
 *
 * ## 为什么 `now()` 与「同一天」都不能交给会话时区
 *
 * `date_trunc('day', asked_at)` 取的是**连接会话的** `TimeZone`，同一个库换一个
 * 连接池就可能换一个日界。这里把日界固定成 `SAME_DAY_TIME_ZONE`（默认
 * `Asia/Shanghai`，与实测库的 `SHOW TimeZone` 一致），并以参数传进去，
 * 这样「同一天」在任何一个连接上都是同一个答案。
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { classifyEvidence, type EvidenceItem, type TriVerdict } from '@/lib/quiz/xq-mastery';

/**
 * 判「同一天重测」用的时区。
 *
 * 不写死进 SQL 字符串里，而是当参数传：它必须可解释，也必须能被测试覆盖。
 * 取 `Asia/Shanghai` 的理由是实测库的 `SHOW TimeZone` 就是它，而错题四关
 * 的「今天」是本地日历日，不是 UTC 日。
 */
export const SAME_DAY_TIME_ZONE = 'Asia/Shanghai';

/** 证据来源：`existing` = 课程里本来就有的题，`generated` = 现场生成，`manual` = 人工录入。 */
export type ProbeSource = 'existing' | 'generated' | 'manual';

/** 答之前的自信度，只允许这四档（与表上的 `CHECK (confidence_pre IN (25,50,75,95))` 一致）。 */
export type ProbeConfidence = 25 | 50 | 75 | 95;

/**
 * 一条待写入的观测。
 *
 * `sameDayRetest` 是**降级提示**，不是权威：它只能把一条证据压成半题
 * （`OR` 进 SQL 的判定），不能把重测升回一整题。真正的判定由 SQL 里的
 * `EXISTS` 做，所以忽略它也不会算错，只是会少一个「我明确知道这是重测」的信号。
 */
export interface ProbeItemInput {
  taskId: string;
  stageId: string;
  sceneId: string;
  questionId: string;
  askedAt: Date;
  correct: boolean;
  confidencePre?: ProbeConfidence;
  elapsedMs?: number;
  sameDayRetest?: boolean;
  source: ProbeSource;
}

/** `ingestProbeItems` 的回执：真插进去几条、因为唯一键冲突跳过几条。 */
export interface ProbeIngestResult {
  inserted: number;
  skipped: number;
}

/** `dueReviews` 的一行。 */
export interface DueReview {
  stageId: string;
  sceneId: string;
  questionId: string;
  concept: string;
  round: number;
  dueAt: Date;
}

/** 复习关次：1/3/7/15 天。下标即「第 n 个剩余关次」，不是 round 本身。 */
const REVIEW_INTERVAL_DAYS: readonly number[] = [1, 3, 7, 15];

/**
 * 做错之后重排用的阶梯：**两行**，按「这道题以前失败过几次」选行。
 *
 * 第 0 次失败（也就是第一次做错）走第一行，仍然是 1/3/7/15 —— 和一期完全一样。
 * 从第二次失败起走第二行 3/7/15/30：一道题若在 15 天后才错，说明它曾经稳定过，
 * 再把它按 1 天的节奏重排等于永远出不了本（M §3.2 分歧四，Anki 用
 * `interval < 0.5 天` 区分短学期步进与回到 review）。
 *
 * ★ 为什么是「整行后移」而不是「按关次逐个加长」：阶梯的语义是**这一轮要走几步**，
 * 不是「每一步间隔多少」。行内仍严格递增，所以「四关依次变远」这条性质没变；
 * 变的只是起点。按关次逐个加长会得到非递增的序列，`due_at` 就不再能当排序依据。
 *
 * ★ 为什么只分两行而不是按失败次数继续加：失败次数多到一定程度，任何更长的间隔
 * 都只是「把它彻底忘掉」。两行已经覆盖了「新错题」与「反复错的题」两种情况，
 * 再细分需要真实数据支撑，而我们今天一条 `review_failed` 都还没有（见 §10.6 的教训：
 * 判据在空表上通过是空真）。
 */
const REVIEW_RESET_LADDER: readonly (readonly number[])[] = [
  [1, 3, 7, 15],
  [3, 7, 15, 30],
];

/** 每行的绑定参数个数（改这个必须同时改 `probeRowPlaceholders`）。 */
const PROBE_PARAMS_PER_ROW = 10;

/**
 * 一条 INSERT 最多带多少行。
 *
 * 500 行 × 10 个参数 = 5000 个参数，离 PostgreSQL 的 65535 上限有两个数量级余量，
 * 而语句大小还在一张 A4 纸的规模 —— 再大就只是让日志难读。分批的代价是
 * 「后一批失败时前一批已经写进去了」：这一点写在 `ingestProbeItems` 的 JSDoc 里，
 * 不假装它是原子的。
 */
const PROBE_INSERT_CHUNK_ROWS = 500;

/** 某一关不存在（没排过期，或者 round 越界）。 */
export class XqReviewRoundNotFoundError extends Error {
  constructor(
    readonly stageId: string,
    readonly sceneId: string,
    readonly questionId: string,
    readonly concept: string,
    readonly round: number,
  ) {
    super(
      `xq: no review round to record ` +
        `(stage=${stageId} scene=${sceneId} question=${questionId} ` +
        `concept=${JSON.stringify(concept)} round=${round})`,
    );
    this.name = 'XqReviewRoundNotFoundError';
  }
}

/**
 * 直接打在 `xq_probe_item` 上的那一句。见文件头「为什么同一天要在 SQL 里判」。
 *
 * `$TZ` 是占位符，在 `ingestChunk` 里替换成时区参数的下标 —— 时区是参数，
 * 不是拼进 SQL 的字符串。
 */
const INGEST_SQL_HEAD = `WITH incoming (
  task_id, stage_id, scene_id, question_id, asked_at, correct,
  confidence_pre, elapsed_ms, retest_hint, source
) AS (
  VALUES
`;

const INGEST_SQL_TAIL = `
),
flagged AS (
  SELECT
    i.task_id, i.stage_id, i.scene_id, i.question_id, i.asked_at, i.correct,
    i.confidence_pre, i.elapsed_ms, i.source,
    (
      i.retest_hint
      OR EXISTS (
        SELECT 1 FROM xq_probe_item e
         WHERE e.stage_id = i.stage_id
           AND e.scene_id = i.scene_id
           AND e.question_id = i.question_id
           AND e.asked_at < i.asked_at
           AND (e.asked_at AT TIME ZONE $TZ)::date = (i.asked_at AT TIME ZONE $TZ)::date
      )
      OR EXISTS (
        SELECT 1 FROM incoming o
         WHERE o.stage_id = i.stage_id
           AND o.scene_id = i.scene_id
           AND o.question_id = i.question_id
           AND o.asked_at < i.asked_at
           AND (o.asked_at AT TIME ZONE $TZ)::date = (i.asked_at AT TIME ZONE $TZ)::date
      )
    ) AS same_day_retest
  FROM incoming i
)
INSERT INTO xq_probe_item (
  task_id, stage_id, scene_id, question_id, asked_at, correct, confidence_pre,
  elapsed_ms, same_day_retest, counted_n, source
)
SELECT
  task_id, stage_id, scene_id, question_id, asked_at, correct, confidence_pre, elapsed_ms,
  same_day_retest,
  (CASE WHEN same_day_retest THEN 0.5 ELSE 1.0 END)::numeric(3, 1),
  source
FROM flagged
ON CONFLICT (task_id, stage_id, scene_id, question_id, asked_at) DO NOTHING
RETURNING id
`;

const SELECT_EVIDENCE_SQL = `SELECT p.counted_n, p.correct, p.asked_at
  FROM xq_probe_item p
 WHERE p.stage_id = $1 AND p.scene_id = $2
   AND NOT EXISTS (
         SELECT 1 FROM document_scenes s
          WHERE s.stage_id = p.stage_id
            AND s.id = p.scene_id
            AND coalesce(s.data->>'type', '') <> 'quiz'
       )
 ORDER BY p.asked_at, p.id`;

/**
 * 这一页在 `document_scenes` 里是什么类型；查不到返回 `null`。
 *
 * ★ 查不到**不是**「不是 quiz 页」：课程被删、或者这一页在文档层还没写进来时，
 *   证据仍然可能是真的（历史答题记录不会因为页面被删就变假）。所以只有
 *   **明确查到且不是 quiz** 才拒判。
 */
const SELECT_PAGE_TYPE_SQL = `SELECT data->>'type' AS type
  FROM document_scenes
 WHERE stage_id = $1 AND id = $2`;

/**
 * 删掉一格的缓存。
 *
 * 只在一件事上用：这一页**明确不是** quiz 页。那时这一格永远不会产出判定，
 * 留着它只会让状态块写出一句「这页还没有答题证据」—— 而它明明有 8 条答题证据，
 * 只是这一页不是自检页。`xq_cell_state` 是缓存（模块头「可以整表删掉重算，
 * 不丢任何事实」），删掉是正确动作；证据仍在 `xq_probe_item` 里。
 */
const DELETE_CELL_STATE_SQL = `DELETE FROM xq_cell_state WHERE stage_id = $1 AND scene_id = $2`;

/**
 * 写 `xq_cell_state`。整行覆盖，不是「更新一部分」：判定是一个整体，
 * 让 `tri` 与 `n/k` 来自两次不同重算只会得到自相矛盾的一行。
 */
const UPSERT_CELL_STATE_SQL = `INSERT INTO xq_cell_state (
  stage_id, scene_id, tri, n, k, lb5, ub95, n_delayed, k_delayed, reason, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
ON CONFLICT (stage_id, scene_id) DO UPDATE
   SET tri = EXCLUDED.tri,
       n = EXCLUDED.n,
       k = EXCLUDED.k,
       lb5 = EXCLUDED.lb5,
       ub95 = EXCLUDED.ub95,
       n_delayed = EXCLUDED.n_delayed,
       k_delayed = EXCLUDED.k_delayed,
       reason = EXCLUDED.reason,
       updated_at = now()`;

const SELECT_CELLS_SQL = `SELECT DISTINCT stage_id, scene_id FROM xq_probe_item`;

/**
 * 四关一次排完：`ON CONFLICT DO NOTHING` ⇒ 重跑不会把已经过掉的关重置回未到期。
 *
 * 间隔从 `$5` 传进来（`REVIEW_INTERVAL_DAYS`），不写死在 SQL 里 —— 那张表只有
 * 一份，写两份就会在改阶梯时对不上。`generate_series(1, 4)` 的第 n 个值取数组第 n 项。
 *
 * ★ 锚点是**参数**（`$6`），不是 SQL 里的 `now()`。两个理由：
 * ① 一次回填要按「他当时答错的时刻」排，而不是按「脚本跑起来的时刻」——
 *    否则补录三个月的错题，四关全从今天开始，第二天一起到期；
 * ② `now()` 让这条链不可重放：同样的输入在不同日子算出不同排期，
 *    测试也只能靠改系统时钟才过（实测真出现过一次「昨天还绿、今天红」）。
 */
const SCHEDULE_REVIEW_SQL = `INSERT INTO xq_review_schedule (
  stage_id, scene_id, question_id, concept, round, due_at
)
SELECT $1, $2, $3, $4, g.round,
       $6::timestamptz + make_interval(days => ($5::int[])[g.round])
  FROM generate_series(1, cardinality($5::int[])) AS g(round)
ON CONFLICT (stage_id, scene_id, question_id, concept, round) DO NOTHING
RETURNING id`;

/**
 * 记录一关的结果，**一条语句**里分两支：`pass`/`skip` 只标记这一关；
 * `fail` 把**同一道题同一个概念的四关全部重置回阶梯起点**。
 *
 * ## 为什么 fail 是重置四关，而不是「标记这一关 + 顺延后面」
 *
 * 「关」是**这一轮重练的关卡序号**，不是「第几次复习」。做错说明这一轮的关卡
 * 得整条重走 —— 站点的错题本（`/course/:courseId/wrong-book`）就是「做错回第 1 关」。
 * 顺延后面三关会得到一个别的语义：学习者的下一关变成 `round+1`，第一关再也回不去。
 *
 * 还有一个更隐蔽的错：若按 `阶梯[round - 当前关]` 重排，fail 在第 1 关时
 * `round - 1` 让四关被压成 1/3/7 —— **第 15 天那一关永远不会出现**，间隔表被
 * 悄悄改短。所以重置一律用 `阶梯[round]`（round 1..4 ⇒ 1/3/7/15 天）。
 *
 * ## 为什么合成一条语句
 *
 * `Queryable` 只有 `query`，没有事务入口；两条语句在连接池上会落到不同连接，
 * 第一条成功、第二条失败就留下「标记了 fail 但没重排」的半成品。
 *
 * 两个数据修改 CTE 的行**必须不相交**（`$6 <> 'fail'` 与 `$6 = 'fail'` 互斥），
 * 否则同一条语句里两次 UPDATE 撞同一行，Postgres 只保留其中一次的结果。
 *
 * `rescheduled` 用 `EXISTS` 门住「这一关存在」：fail 一个不存在的 `round`
 * 不该把四关重置一遍当成成功，那条路径要落到下面 `target` 的 0 行上。
 */
const RECORD_OUTCOME_SQL = `WITH target AS (
  SELECT 1
    FROM xq_review_schedule
   WHERE stage_id = $1 AND scene_id = $2 AND question_id = $3 AND concept = $4
     AND round = $5
), marked AS (
  UPDATE xq_review_schedule
     SET done_at = now(), outcome = $6
   WHERE stage_id = $1 AND scene_id = $2 AND question_id = $3 AND concept = $4
     AND round = $5
     AND $6 <> 'fail'
  RETURNING id
), prior AS (
  SELECT count(*)::int AS n
    FROM xq_event
   WHERE kind = 'review_failed'
     AND stage_id = $1 AND scene_id = $2 AND question_id = $3
     AND coalesce(payload->>'concept', '') = $4
     AND occurred_at < $8::timestamptz
), rescheduled AS (
  UPDATE xq_review_schedule s
     SET due_at = now() + make_interval(days =>
           ($7::int[][])[LEAST((SELECT n FROM prior), 1) + 1][s.round]),
         done_at = NULL,
         outcome = NULL
   WHERE s.stage_id = $1 AND s.scene_id = $2 AND s.question_id = $3 AND s.concept = $4
     AND $6 = 'fail'
     AND EXISTS (SELECT 1 FROM target)
  RETURNING id
)
SELECT (SELECT count(*)::int FROM target) AS target,
       (SELECT count(*)::int FROM marked) AS marked,
       (SELECT count(*)::int FROM rescheduled) AS rescheduled,
       (SELECT n FROM prior) AS prior_failures`;

const DUE_REVIEWS_SQL = `SELECT stage_id, scene_id, question_id, concept, round, due_at
  FROM xq_review_schedule
 WHERE due_at <= $1::timestamptz AND done_at IS NULL
 ORDER BY due_at, stage_id, scene_id, question_id, concept, round
 LIMIT $2`;

/**
 * 一道题该挂在哪个概念上：**最高档恰好只有一个概念时**才是它，否则回空串。
 *
 * 与状态块拿格子标签的规则是同一条（`learner-state.ts` 的 `ties = 1`），
 * 只是粒度换成「一道题」。理由也一样：一道题在最高档上同时命中三个概念时，
 * 挑任何一个当它的名字都错 —— 而 `xq_review_schedule` 的唯一键**含 concept**，
 * 挑错会另起一组四关，同一道错题在错题本里出现两次。
 *
 * 回空串不是失败：四关按题排，`concept` 是可选标注（`xq-learner.ts` 第四节）。
 *
 * ★ 只认 `concept_kind='keypoint'`：`chapter-band` 是「这题大概属于这一章」
 *   的兜底，置信度只有 0.50，拿它当知识点会把两个层级混成一个。
 */
const SELECT_QUESTION_CONCEPT_SQL = `SELECT concept
  FROM (
    SELECT concept,
           max(confidence) AS top,
           count(*) OVER (PARTITION BY max(confidence)) AS ties,
           row_number() OVER (ORDER BY max(confidence) DESC, concept) AS rank
      FROM xq_question_concept
     WHERE stage_id = $1 AND scene_id = $2 AND question_id = $3
       AND concept_kind = 'keypoint'
     GROUP BY concept
  ) ranked
 WHERE rank = 1 AND ties = 1`;

interface ProbeEvidenceRow extends Record<string, unknown> {
  counted_n: string | number | null;
  correct: boolean;
  asked_at: Date | string;
}

interface CellRow extends Record<string, unknown> {
  stage_id: string;
  scene_id: string;
}

interface DueReviewRow extends Record<string, unknown> {
  stage_id: string;
  scene_id: string;
  question_id: string;
  concept: string;
  round: number;
  due_at: Date | string;
}

/**
 * 学情证据的写入层。
 *
 * 所有方法只做 SQL 与纯函数运算：不调模型、不读文件，所以可以在请求里同步跑。
 * 所有 SQL 走 `$n` 绑定，唯一被拼进语句的是列名/表名与占位符序号。
 */
export class XqLearnerStore {
  private readonly queryable: Queryable;
  /**
   * 注入的「现在」。**只有测试与重放会传** —— 延迟桶按 `now − asked_at` 分档，
   * 不注入的话「同一天答对算不算延迟」会随真实钟表漂，测试就钉不住边界。
   */
  private readonly now?: () => Date;

  constructor({ queryable, now }: { queryable: Queryable; now?: () => Date }) {
    this.queryable = queryable;
    this.now = now;
  }

  /**
   * 落一批观测。
   *
   * `counted_n` 由 SQL 判定：同一 `(stage_id, scene_id, question_id)` 在**同一个
   * 本地日历日**里已经有**更早**（`asked_at <`）的记录，这一条就记 0.5，否则 1.0。
   * 判定同时看已落库的行与本批里的其它行，所以同一批里连答两次同题也能判出来。
   * 方向是「更早」而不是「不同」：一天里答两次，先答的那次是原始观测（1.0），
   * 后答的才是重测（0.5）；只比 `<>` 会让两次都变成 0.5，那天这道题只算半题。
   *
   * 唯一键 `(task_id, stage_id, scene_id, question_id, asked_at)` 冲突的行整条跳过
   * （`DO NOTHING`），不更新已有行 —— 观测只追加。
   *
   * 抛：`askedAt` 不是有效日期时抛 `RangeError`（在发 SQL 之前）；驱动错误
   * （连接失败、约束冲突、类型不匹配）原样抛出。超过 500 行会分批，**分批不是
   * 原子的** —— 后一批失败时前一批已经写进去，回执也不再返回，调用方要按
   * 「可能部分成功」处理。
   */
  async ingestProbeItems(items: ProbeItemInput[]): Promise<ProbeIngestResult> {
    for (const item of items) {
      if (!(item.askedAt instanceof Date) || Number.isNaN(item.askedAt.getTime())) {
        throw new RangeError(
          `xq: probe item ${item.stageId}/${item.sceneId}/${item.questionId} has an invalid askedAt`,
        );
      }
    }

    let inserted = 0;
    for (let start = 0; start < items.length; start += PROBE_INSERT_CHUNK_ROWS) {
      const chunk = items.slice(start, start + PROBE_INSERT_CHUNK_ROWS);
      inserted += await this.ingestChunk(chunk);
    }
    return { inserted, skipped: items.length - inserted };
  }

  /**
   * 重算一格并写回 `xq_cell_state`。
   *
   * 先把这一格的全部证据读出来（`counted_n` 是 `numeric` ⇒ 字符串，转成 `Number`；
   * 为 null 按 1.0），交给 `classifyEvidence()`，再整行覆盖缓存。
   *
   * 抛：驱动错误原样抛出；`classifyEvidence()` 自身的 `RangeError`
   * （只会在分类器参数非法时出现）也原样抛出。没有证据不是错误 ——
   * 会写成 `tri='unknown', reason='no-quiz'`。
   *
   * ★ **这一页如果明确不是 quiz 页，这一格会被删掉**（不是写成 unknown）：
   *   缓存里留一个「有证据但永远不会产出判定」的格子，只会让状态块说
   *   「这页还没有答题证据」—— 它明明有，只是那一页不是自检页。
   *   判断依据是 `document_scenes.data->>'type'`；查不到那一页时**不动**
   *   （课程被删不代表历史答题记录是假的）。
   */
  async recomputeCellState(stageId: string, sceneId: string): Promise<TriVerdict> {
    // ★ 第一步必须是「这一页是不是自检页」，不是「有没有证据」。
    //   实测有一条脏格：`stage-GYvpbYB_aN/scene-p13` 挂着 8 条全对的自检证据，
    //   但那一页现在是 `slide`（`比较运算符`，order 32）—— 那个 scene id 被非 quiz 页
    //   复用了。不拦这一步的话，状态块会写「这页已会」，而模型会去讲一页没有题的幻灯片。
    const pageType = await this.queryable.query<{ type: string | null }>(SELECT_PAGE_TYPE_SQL, [
      stageId,
      sceneId,
    ]);
    const type = pageType.rows[0]?.type ?? null;
    if (type !== null && type !== 'quiz') {
      // 缓存删掉，证据不动。返回 `no-quiz` 是因为这一页**确实没有题**可判。
      await this.queryable.query(DELETE_CELL_STATE_SQL, [stageId, sceneId]);
      return {
        tri: 'unknown',
        n: 0,
        k: 0,
        lb5: null,
        ub95: null,
        nDelayed: 0,
        kDelayed: 0,
        reason: 'no-quiz',
      };
    }

    const { rows } = await this.queryable.query<ProbeEvidenceRow>(SELECT_EVIDENCE_SQL, [
      stageId,
      sceneId,
    ]);

    const evidence: EvidenceItem[] = rows.map((row) => ({
      countedN: countedNOf(row.counted_n),
      correct: row.correct === true,
      // ★ 每条证据都带上观测时刻 —— 延迟桶全靠它。漏掉的话所有证据都会被当成
      //   「已经放够久」，延迟桶退化成全量桶，`known` 又变回「曾经答对过」。
      askedAt: row.asked_at,
    }));

    const verdict = classifyEvidence(evidence, { now: this.now?.() });
    await this.queryable.query(UPSERT_CELL_STATE_SQL, [
      stageId,
      sceneId,
      verdict.tri,
      verdict.n,
      verdict.k,
      verdict.lb5,
      verdict.ub95,
      verdict.nDelayed,
      verdict.kDelayed,
      verdict.reason ?? null,
    ]);
    return verdict;
  }

  /**
   * 把 `xq_probe_item` 里出现过的每一格都重算一遍。
   *
   * 一次 SQL 拿 distinct 的 `(stage_id, scene_id)`，再逐格调 `recomputeCellState`。
   * 刻意**不**把证据行读进 JS：那是一次全表扫描的内存副本，几万条就开始危险，
   * 而逐格只让单格的证据驻留。
   *
   * 抛：驱动错误原样抛出。中途失败时，已经重算过的格已经是新值，剩下的还是旧值
   * （每格自己的 upsert 是原子的，跨格不是）—— 所以这个方法是可重入的，
   * 失败后重跑一遍就能收敛。
   */
  async recomputeAllCellStates(options: { stageId?: string } = {}): Promise<{ cells: number }> {
    const stageId = options.stageId;
    const { rows } = stageId
      ? await this.queryable.query<CellRow>(
          `${SELECT_CELLS_SQL} WHERE stage_id = $1 ORDER BY 1, 2`,
          [stageId],
        )
      : await this.queryable.query<CellRow>(`${SELECT_CELLS_SQL} ORDER BY 1, 2`);

    for (const row of rows) {
      await this.recomputeCellState(row.stage_id, row.scene_id);
    }
    return { cells: rows.length };
  }

  /**
   * 给一道错题排上四关：1/3/7/15 天后到期。
   *
   * 四行一次插入，`ON CONFLICT DO NOTHING` ⇒ 重复调用不会把已经过掉的关
   * 重置回未到期（那会让学生永远出不了第 1 关）。
   *
   * 抛：驱动错误原样抛出（例如 `concept` 超长、连接断开）。已存在的行不算错误，
   * 只是不在 `rounds` 里计数。
   */
  async scheduleReviewForWrong(
    stageId: string,
    sceneId: string,
    questionId: string,
    concept: string,
    /**
     * 「今天」从哪一天算起 —— 传他**答错的那一刻**。
     * 不传就取注入的 `now`（再退到系统时钟），与构造函数的语义一致。
     */
    anchor?: Date,
  ): Promise<{ rounds: number }> {
    const { rows } = await this.queryable.query<{ id: string }>(SCHEDULE_REVIEW_SQL, [
      stageId,
      sceneId,
      questionId,
      concept,
      [...REVIEW_INTERVAL_DAYS],
      anchor ?? this.now?.() ?? new Date(),
    ]);
    return { rounds: rows.length };
  }

  /**
   * 记一关的结果。
   *
   * - `pass`：写 `done_at` 与 `outcome='pass'`。**后续关不动** —— 第 3 关仍然按
   *   排期那天到期，不会因为它提前过了就提前。
   * - `fail`：**四关全部重置**（不只是当前关之后的）：`due_at` 一律改成
   *   `now() + 阶梯[round]`，`done_at` 与 `outcome` 一律清空，连刚刚失败的那一关
   *   也清空。这就是「做错回第 1 关」：下一关还是第 1 关，这一轮的四个关卡从头
   *   再走一遍。
   * - `skip`：只写 `done_at` 与 `outcome='skip'`，不动排期。
   *
   * ## `fail` 用哪一行阶梯，取决于「以前错过几次」
   *
   * `REVIEW_RESET_LADDER` 是两行：第 0 次失败（第一次做错）走 `[1,3,7,15]`，
   * 第 1 次及以上走 `[3,7,15,30]`。计数来自 `xq_event`（排期表没有「重置次数」列），
   * 且**严格早于这一次** —— `recordXqReview` 先写事件再调这里，这一次自己的失败
   * 事件若被算进去，第一次做错就会用上第二行，一期判决被悄悄推翻。
   *
   * `occurredAt` 就是那个比较锚点。不传时退回本实例的 `now`（测试注入固定钟即可，
   * 生产路径由 `recordXqReview` 传事件的时刻）。**重放同一批事件必须传**，否则
   * 同一份历史重跑两次会按两个不同的「现在」算出两套排期。
   *
   * 抛：`XqReviewRoundNotFoundError` —— 这一关没有排过期（三种 outcome 都会先查它，
   * 否则 fail 一个不存在的 round 会顺手把四关重置一遍还报成功）；驱动错误原样抛出。
   * 标记与重置在**同一条语句**里，不会出现「标了 fail 没重置」。
   */
  async recordReviewOutcome(
    stageId: string,
    sceneId: string,
    questionId: string,
    concept: string,
    round: number,
    outcome: 'pass' | 'fail' | 'skip',
    occurredAt?: Date,
  ): Promise<void> {
    // 失败计数要**排除这一次**：`recordXqReview` 会先把 `review_failed` 事件写进去，
    // 再调这里。用严格小于，所以「第几次失败」指的是「这一次之前失败过几次」。
    // 不传时刻时退回本实例的 `now`，测试里注入固定钟即可复现。
    const anchor = occurredAt ?? this.now?.() ?? new Date();
    const { rows } = await this.queryable.query<{
      target: number;
      marked: number;
      rescheduled: number;
    }>(RECORD_OUTCOME_SQL, [
      stageId,
      sceneId,
      questionId,
      concept,
      round,
      outcome,
      REVIEW_RESET_LADDER.map((row) => [...row]),
      anchor.toISOString(),
    ]);
    const found = rows[0]?.target ?? 0;
    if (found === 0) {
      throw new XqReviewRoundNotFoundError(stageId, sceneId, questionId, concept, round);
    }
  }

  /**
   * 读现在该复习的关：`due_at <= now AND done_at IS NULL`，按到期时间升序。
   *
   * `now` 缺省取调用时刻（`new Date()`），显式传入时用它 —— 这让「翻到明天看看
   * 有什么到期」不需要改系统时钟。`limit` 缺省 50，非整数或负数按 0 处理。
   *
   * 抛：驱动错误原样抛出。
   */
  async dueReviews(now?: Date, limit = 50): Promise<DueReview[]> {
    const anchor = now ?? new Date();
    const bounded = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    if (bounded === 0) return [];

    const { rows } = await this.queryable.query<DueReviewRow>(DUE_REVIEWS_SQL, [
      anchor.toISOString(),
      bounded,
    ]);
    return rows.map((row) => ({
      stageId: row.stage_id,
      sceneId: row.scene_id,
      questionId: row.question_id,
      concept: row.concept,
      round: Number(row.round),
      dueAt: row.due_at instanceof Date ? row.due_at : new Date(row.due_at),
    }));
  }

  /**
   * 一道题该挂在哪个概念上 —— 给「答错了排四关」用。
   *
   * 最高档只有**一个**概念时回它；最高档并列、或这道题一条题级映射都没有时
   * 回 `''`。回空串不是失败：四关按题排，`concept` 只是可选标注
   * （`xq-learner.ts` 第四节），状态块那一行也仍然按页给。
   *
   * ★ 为什么不「挑一个也行」：`xq_review_schedule` 的唯一键是
   *   `(stage_id, scene_id, question_id, concept, round)`，**含 concept**。
   *   今天挑「字符串」、明天挑「空安全」，同一道错题会在错题本里变成两组四关，
   *   而两组都到期时学习者要重做两遍同一道题。
   *
   * 抛：驱动错误原样抛出（表不存在、连接断开）。
   */
  async conceptForQuestion(stageId: string, sceneId: string, questionId: string): Promise<string> {
    const { rows } = await this.queryable.query<{ concept: string }>(SELECT_QUESTION_CONCEPT_SQL, [
      stageId,
      sceneId,
      questionId,
    ]);
    return rows[0]?.concept ?? '';
  }

  /** 一批（≤500 行）一条语句写完，返回真插进去的条数。 */
  private async ingestChunk(items: ProbeItemInput[]): Promise<number> {
    if (items.length === 0) return 0;

    const params: unknown[] = [];
    for (const item of items) {
      params.push(
        item.taskId,
        item.stageId,
        item.sceneId,
        item.questionId,
        item.askedAt.toISOString(),
        item.correct,
        item.confidencePre ?? null,
        item.elapsedMs ?? null,
        item.sameDayRetest ?? false,
        item.source,
      );
    }
    const timeZoneParam = params.length + 1;
    params.push(SAME_DAY_TIME_ZONE);

    const placeholders = items.map((_, index) => probeRowPlaceholders(index)).join(',\n    ');
    const sql =
      INGEST_SQL_HEAD +
      '    ' +
      placeholders +
      INGEST_SQL_TAIL.replaceAll('$TZ', () => `$${timeZoneParam}`);

    const { rows } = await this.queryable.query<{ id: string }>(sql, params);
    return rows.length;
  }
}

/**
 * 第 `index` 行的占位符（从 1 起编号）。
 *
 * 参数顺序必须与 `ingestChunk` 里 `params.push` 的顺序一字不差；两处一起改。
 */
function probeRowPlaceholders(index: number): string {
  const base = index * PROBE_PARAMS_PER_ROW;
  return (
    `($${base + 1}::text, $${base + 2}::text, $${base + 3}::text, $${base + 4}::text, ` +
    `$${base + 5}::timestamptz, $${base + 6}::boolean, $${base + 7}::smallint, ` +
    `$${base + 8}::integer, $${base + 9}::boolean, $${base + 10}::text)`
  );
}

/** `numeric` 从 pg 读出来是字符串；null 按 1.0（一题算一题），坏值也按 1.0。 */
function countedNOf(value: string | number | null): number {
  if (value === null || value === undefined) return 1;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 1;
}
