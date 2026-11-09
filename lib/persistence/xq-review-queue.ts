/**
 * 学情（xq）的**复习读侧**：现在该复习哪几道题，带上题面与页标题。
 *
 * ## 为什么需要它
 *
 * 2026-11-10 之前，复习闭环两头都通了 —— `xq_review_schedule` 能排（S7 回填
 * 20 关）、能关（`POST /api/persistence/xq/reviews`）—— 但**中间没有人读**。
 * 服务端状态块（`learner-state-render.ts`）确实会把到期的关渲染成
 * 「今天到期的复习」，可那是给模型看的文本，浏览器里没有任何一处能问
 * 「我现在该复习什么」。于是那 20 关只能靠外部脚本关掉。
 *
 * 本文件补的就是这一层：一句话把「到期的关」变成「能直接显示的卡片」。
 *
 * ## 为什么一次 SQL 而不是三次
 *
 * 到期行在 `xq_review_schedule`，页标题在 `document_scenes.data->>'title'`，
 * 题面在 `document_scenes.data->'content'->'questions'`。三次往返（先取到期、
 * 再取页、再取题）会把同一批 `(stage_id, scene_id)` 查三遍，还要在 JS 里按
 * 复合键拼回去 —— 而 `document_scenes` 的主键是 `(stage_id, id)`，同名 scene
 * 可跨课存在，拼错就会张冠李戴。一次 `LEFT JOIN LATERAL` 让数据库自己按
 * 那个复合键对齐，JS 只负责形状转换。
 *
 * ## 为什么是 `LEFT JOIN` 而不是 `JOIN`
 *
 * 页被删、题被改、`scene_id` 漂了（这一仓的历史上真的发生过，见
 * `复盘/已结案结论.md` 里 `stage-GYvpbYB_aN/scene-p13` 从 quiz 变成 slide）——
 * 这些都不该让「到期」这条事实消失。排期还在，只是题面取不到；显示成
 * 「题面取不到」比让整条复习从列表里静默消失要好。
 *
 * ## 为什么不在这里判「该不该复习」
 *
 * 到期判据只有一条（`due_at <= now AND done_at IS NULL`），它属于
 * `xq_review_schedule` 的语义，`dueReviews()` 已经写了。这里只做
 * 「把那条判据的结果变成卡片」，不新增第二条判据 —— 两处判据会漂。
 *
 * 同理不在这里挑「今天最该做哪一道」：排序就是 `due_at` 升序，
 * 谁先到期谁在前。要更聪明的排序是产品决策，不是这一层的事。
 */
import type { Queryable } from '@openmaic/storage/document/pg';

/**
 * 题面最长保留多少个字符。超了截断并加省略号。
 *
 * 题面在库里是完整原文（自检页常见 80–200 字，个别长题超过 400 字）。
 * 卡片只需要「够认出是哪道题」，整段回给客户端会让一次复习列表轻松过百 KB，
 * 而客户端真正显示题面的地方是点开之后的那一页。
 */
export const QUESTION_STEM_MAX_CHARS = 160;

/** 一次最多回多少条。与 `dueReviews()` 的默认上限保持一致。 */
export const DUE_REVIEW_CARD_LIMIT = 50;

export interface DueReviewCard {
  readonly stageId: string;
  readonly sceneId: string;
  /** 页标题；页已不存在时是空串。 */
  readonly sceneTitle: string;
  readonly questionId: string;
  /** 截断后的题面；题已不存在时是空串。 */
  readonly questionStem: string;
  /** 题级概念；这道题没有唯一定论时是空串（见 `conceptForQuestion`）。 */
  readonly concept: string;
  readonly round: number;
  readonly dueAt: Date;
}

interface DueReviewCardRow extends Record<string, unknown> {
  stage_id: string;
  scene_id: string;
  question_id: string;
  concept: string;
  round: number | string;
  due_at: Date | string;
  scene_title: string | null;
  question_stem: string | null;
}

/**
 * 到期判据写在这一句里，与 `XqLearnerStore.dueReviews()` 的 `DUE_REVIEWS_SQL`
 * 同一条 —— 差别只在这里把页标题与题面一起取出来。
 *
 * `LIMIT` 作用在 CTE 上（先按到期时间取前 N 条），外层的 `ORDER BY` 只是保持
 * 输出顺序。若把 `LIMIT` 放在外层、`JOIN` 之后再截，一个跨多页的复习列表会
 * 因为某一页的题面查询把别的行挤掉 —— 截断必须发生在最窄的那一侧。
 */
const DUE_REVIEW_CARDS_SQL = `WITH due AS (
  SELECT stage_id, scene_id, question_id, concept, round, due_at
    FROM xq_review_schedule
   WHERE due_at <= $1::timestamptz AND done_at IS NULL
   ORDER BY due_at, stage_id, scene_id, question_id, concept, round
   LIMIT $2
)
SELECT d.stage_id, d.scene_id, d.question_id, d.concept, d.round, d.due_at,
       s.data->>'title' AS scene_title,
       q.value->>'question' AS question_stem
  FROM due d
  LEFT JOIN document_scenes s
         ON s.stage_id = d.stage_id AND s.id = d.scene_id
  LEFT JOIN LATERAL (
    SELECT value
      FROM jsonb_array_elements(
             coalesce(s.data->'content'->'questions', '[]'::jsonb)
           ) AS value
     WHERE value->>'id' = d.question_id
     LIMIT 1
  ) q ON TRUE
 ORDER BY d.due_at, d.stage_id, d.scene_id, d.question_id, d.concept, d.round`;

/** 按字符（不是 UTF-16 单元）截断，免得把一个 emoji 或代理对切两半。 */
function truncateStem(stem: string): string {
  const chars = Array.from(stem);
  if (chars.length <= QUESTION_STEM_MAX_CHARS) return stem;
  return `${chars.slice(0, QUESTION_STEM_MAX_CHARS).join('')}…`;
}

/**
 * 读现在到期的复习卡片，按到期时间升序。
 *
 * `now` 缺省取调用时刻；显式传入时用它 —— 这样「翻到明天看看有什么到期」
 * 不需要改系统时钟（与 `dueReviews()` 同一个约定）。
 *
 * 抛：驱动错误原样抛出（调用方决定是回 500 还是像状态块那样吞掉）。
 */
export async function listDueReviewCards(
  queryable: Queryable,
  options: { readonly now?: Date; readonly limit?: number } = {},
): Promise<DueReviewCard[]> {
  const anchor = options.now ?? new Date();
  const requested = options.limit ?? DUE_REVIEW_CARD_LIMIT;
  const bounded = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 0;
  if (bounded === 0) return [];

  const { rows } = await queryable.query<DueReviewCardRow>(DUE_REVIEW_CARDS_SQL, [
    anchor.toISOString(),
    bounded,
  ]);
  return rows.map((row) => ({
    stageId: row.stage_id,
    sceneId: row.scene_id,
    sceneTitle: row.scene_title ?? '',
    questionId: row.question_id,
    questionStem: truncateStem(row.question_stem ?? ''),
    concept: row.concept,
    round: Number(row.round),
    dueAt: row.due_at instanceof Date ? row.due_at : new Date(row.due_at),
  }));
}
