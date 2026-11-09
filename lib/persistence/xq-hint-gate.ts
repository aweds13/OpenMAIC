/**
 * 提问闸：同一道题上没先动过手，就不许问。
 *
 * ## 为什么这是一个闸，不是一句提示词
 *
 * 「先自己想，再来问」写成系统提示词是没有执行者的：`2607.25166`（n=3,982）
 * 六项干预没有一项降低了 AI 的说服力，`2503.10556` 里学生在短期 AI 素养
 * 干预之后采纳错误建议的比例仍是 52.1%。提示词能让模型**说**「你先想想」，
 * 但它挡不住回车。要挡，只能在事件落库之前挡。
 *
 * 所以判据放在**服务端写入侧**：UI 侧挡不住直接调接口，而闸的意义正是
 * 「这件事在系统里不允许发生」，不是「界面上不好点」。
 *
 * ## 判据只看事件存在性，不看内容
 *
 * 一层很容易想到的替代方案是让模型判断「他是不是已经想清楚了」——
 * Explore 的「知识整合」就是这么做的（`P-对话辅助教材的形态对照.md` §1.3）。
 * **这里刻意不这么做**：`2605.16207`（7 个模型 / 10,836 组）与 `2605.12748`
 * （7 个模型 / Selective Flip Score 近零）都表明模型会系统性地过度肯定
 * 错误的解法。若闸的判据是「AI 认为你想清楚了」，那么模型越是迎合，
 * 闸越容易放行 —— **闸会在最需要它的时候打开**。
 *
 * 因此这里只有一条 `exists`：同一道题上有没有更早的 `answer_attempted`
 * 或 `answer_submitted`。不调模型，不做文本分类，不看答案对不对。
 *
 * ## 「答过」不等于「答对」
 *
 * 答错、写了一半、超时放弃，全都算答过。要求答对才放行会诱导乱猜，
 * 而 desirable difficulty 的最优区是即时正确率 60–85%（`2506.08872` 一脉
 * 的讨论见 M §10.2）—— 一个「必须答对才能问」的闸会把学生推到作弊式猜答案。
 *
 * ## 自由提问的口子必须留，且必须记成 `executive`
 *
 * 学生有时确实连题干都读不懂，那时 instrumental 求助（「这题在问什么」）
 * 是正当的。完全堵死会把他推到搜索引擎 —— 那边一个事件都收不到，
 * 学情直接断掉。所以留一个 `bypass`：显式声明这次不走闸，代价是这条
 * 提问**必须**记成 `executive`。`N3` §5.4 里 executive（求答案）与成绩
 * 强负相关、instrumental（求「怎么想」）正相关 —— 不区分这两者，
 * 等于把两种相反信号混成一个「用过提示」，之后再也折不出来。
 *
 * ## 为什么用 `occurred_at` 而不是 `recorded_at`
 *
 * 闸判的是「他先做了哪件事」，那是当事人的时间线。`recorded_at` 是服务端
 * 记账时刻，一次网络重试就能让它晚于后发生的事。
 */
import type { Queryable } from '@openmaic/storage/runtime/pg';

/** 拒绝码。客户端按码切文案，不按状态码猜。 */
export const ANSWER_FIRST_CODE = 'ANSWER_FIRST';

/**
 * 同一道题上还没有任何作答痕迹，却被要求给提示。
 *
 * 单独一个错误类型是为了让路由层能把「请求形状不对」（400）与
 * 「顺序不对」（409）分开 —— 混成 400 会让客户端以为该改请求。
 */
export class XqAnswerNotStartedError extends Error {
  constructor(
    readonly stageId: string,
    readonly sceneId: string,
    readonly questionId: string,
  ) {
    super(`xq: question ${stageId}/${sceneId}/${questionId} has no answer attempt yet`);
    this.name = 'XqAnswerNotStartedError';
  }
}

/**
 * 闸管不管这一条。三种情况不管：
 *
 * 1. 不是 `hint_requested`；
 * 2. 没有题号 —— 页面级提问没有「先答」的对象；
 * 3. `hintSubtype === 'executive'` —— **这就是那个自由口子本身**。
 *    executive 的含义是「别绕了，直接告诉我结果」，它本来就承认自己在
 *    要答案，而 `N3` §5.4 里 executive 与成绩强负相关 —— 让它自由发生、
 *    但如实记账，比把它挡在门外再让学生去搜索引擎（那边收不到任何事件）好。
 *    换句话说：**闸只挡 instrumental**（求「怎么想」却连手都没动过）。
 */
export function hintGateApplies(
  kind: string,
  questionId: string | undefined,
  hintSubtype: string | undefined,
): boolean {
  if (kind !== 'hint_requested') return false;
  if (hintSubtype === 'executive') return false;
  return questionId !== undefined && questionId !== '';
}

const PRIOR_ANSWER_SQL = `SELECT 1
   FROM xq_event
  WHERE kind IN ('answer_attempted', 'answer_submitted')
    AND stage_id = $1
    AND scene_id = $2
    AND question_id = $3
    AND occurred_at <= $4::timestamptz
  LIMIT 1`;

/**
 * 这道题上有没有更早（或同一时刻）的作答痕迹。
 *
 * 同一时刻算「有」：浏览器把「写完最后一个字」与「点提示」放在同一个
 * 毫秒里是完全可能的，而拒绝一条已经先答过的提问是把闸判错了方向。
 */
export async function hasPriorAnswerEvent(
  queryable: Queryable,
  input: {
    readonly stageId: string;
    readonly sceneId: string;
    readonly questionId: string;
    readonly occurredAt: Date;
  },
): Promise<boolean> {
  const { rows } = await queryable.query(PRIOR_ANSWER_SQL, [
    input.stageId,
    input.sceneId,
    input.questionId,
    input.occurredAt.toISOString(),
  ]);
  return rows.length > 0;
}
