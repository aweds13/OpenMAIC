/**
 * 逐题即时置信（`confidence_pre`）的四档与校准判据。
 *
 * ## 为什么是 25 / 50 / 75 / 95 而不是 0 / 33 / 66 / 100
 *
 * 两端各留 5 个百分点的谦逊余量。趴到 0 的后果是具体的：一个真的「基本靠猜」
 * 的人只要蒙对一道，`bias = 0 − 100` 会被算成巨大的过度自信；而四档里
 * 「很有把握」写成 100 会让 tone 恒定 +0 或 +100，一题就把整段校准污染掉。
 * 出处是程天学的 API 原文（`{"level":1,"name":"基本靠猜","expected":25}` …
 * `{"level":4,"name":"很有把握","expected":95}`），照抄不改。
 *
 * ## ★ 这个文件不参与判定
 *
 * 自评**永不能把一格推成「会」**。Karpicke & Roediger 2008 的四组被试预测
 * 自己一周后约 50%（20.8/20.4/22.0/20.3），实际 80% 对 33%，组间 F<1 ——
 * 自评与真实保持零相关。`lib/quiz/xq-mastery.ts` 的 `EvidenceItem` 里
 * 因此**没有、也不许有** confidence 字段：它是**事实**，只用来算「他说有把握
 * 却答错了」这类描述，不用来算掌握度。
 *
 * 判据由 `tests/quiz/confidence.test.ts` 与一条源码断言共同钉住
 * （`xq-mastery.ts` 里出现 `confidence` 就红）。
 *
 * ## 为什么要问在「答完但还没交」这个时刻
 *
 * `confidence_pre` 的 `pre` 是相对**知道对错**而言的，不是相对**动笔**而言。
 * 程天学的实测给了依据：做题后回看打分（postdiction）与真实相关 r=0.53，
 * 做题前预测只有 r=0.33 —— 也就是说，**等他知道对错再问等于问了个更准的
 * 东西，但那个东西已经不是预测了**。我们的时刻选在他写完答案、判分还没
 * 开始的那一瞬：那时他对题目已经有过完整思考，但还不知道自己做得对不对。
 *
 * ## 校准标签为什么门槛是 8 题
 *
 * 少于 8 题时 `bias` 的方差大到任何标签都在撒谎：四档的档间是 25 个百分点，
 * 三道题的一次巧合就能把 50 推到 90 以上。门槛是经验值不是结论（C §11.3
 * 原文 `仅当 answers >= 8 才出 label`），所以它只影响**标签出不出**，
 * 不影响任何一条已经落库的事实。
 */

import type { QuizAnswers } from '@/lib/quiz/persistence';

/** 四档的期望正确率。与 `xq_probe_item.confidence_pre` 的 CHECK 逐值一致。 */
export const CONFIDENCE_LEVELS = [25, 50, 75, 95] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** 题号 → 他当时说的把握。缺的题就是「没问过」，不是「50」。 */
export type ConfidenceMap = Record<string, ConfidenceLevel>;

/**
 * 少于这个题数不出校准标签。经验值（C §11.3），不是研究结论。
 *
 * 写在这里而不是散在两处：标签与文案里的「还差几道题」必须用同一个数，
 * 否则会出现「已经 6 道了但文案说再答 8 道」这种自相矛盾的提示。
 */
export const CONFIDENCE_LABEL_MIN_COUNT = 8;

/** `bias` 的容差（百分点）。±20 内算「准」，这是 C §11.3 的经验值。 */
export const CONFIDENCE_BIAS_TOLERANCE = 20;

export type CalibrationLabel = 'over' | 'under' | 'good';

export interface Calibration {
  /** 参与计算的题数（只数**既自评了、又判出来了**的题）。 */
  readonly count: number;
  /** 自评均值（百分点）。 */
  readonly expected: number;
  /** 实际正确率（百分点）。 */
  readonly actual: number;
  /** `expected − actual`，正数是过度自信。 */
  readonly bias: number;
  /**
   * 标签。题数不到门槛时是 `undefined` —— **不是** `'good'`。
   * 「还没法判断」与「判断为准」是两件事，混在一起会让界面写出
   * 「你的自我评估很准」这种它并不知道的话。
   */
  readonly label: CalibrationLabel | undefined;
  /** 还差几道题才能出标签（够了两就是 0）。 */
  readonly needed: number;
}

/**
 * 把一个来路不明的值收成四档之一。收不进来就 `undefined`。
 *
 * 只认**恰好等于**四个值之一。写 `50.0` 或 `"50"` 都不收：这一列在库里是
 * `smallint CHECK IN (25,50,75,95)`，上层宽容地四舍五入，下层一样会被拒，
 * 只是那时错误发生在很远的地方（一次答题提交失败），而原因看不出来。
 */
export function asConfidenceLevel(value: unknown): ConfidenceLevel | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return CONFIDENCE_LEVELS.find((level) => level === value);
}

/** 读一道题的把握。没问过 / 存坏了都是 `undefined`。 */
export function confidenceOf(
  map: ConfidenceMap | undefined,
  questionId: string,
): ConfidenceLevel | undefined {
  if (!map) return undefined;
  return asConfidenceLevel(map[questionId]);
}

/**
 * 把一整张来路不明的映射收成合法的 `ConfidenceMap`。
 *
 * 用它而不是直接信 payload：`confidence` 是 app 自有字段，runtime 的
 * payload 校验表不认识它（`quizAttempt` 只查 `phase` + `answers`），
 * 所以库里可能存在任何形状。收不进来的条目直接丢，不抛 —— 丢一条自评
 * 只是少一行事实，抛出去会让整次答题提交失败。
 */
export function asConfidenceMap(raw: unknown): ConfidenceMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: ConfidenceMap = {};
  for (const [questionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (questionId === '') continue;
    const level = asConfidenceLevel(value);
    if (level !== undefined) out[questionId] = level;
  }
  return out;
}

/** 还没问过把握的题号（按传入顺序）。 */
export function missingConfidence(questionIds: readonly string[], map: ConfidenceMap): string[] {
  return questionIds.filter((questionId) => confidenceOf(map, questionId) === undefined);
}

/** 这一轮自评算不算问全了。 */
export function isConfidenceComplete(questionIds: readonly string[], map: ConfidenceMap): boolean {
  return missingConfidence(questionIds, map).length === 0;
}

/** 写一道题的把握，返回新对象（不改传入的那个）。 */
export function withConfidence(
  map: ConfidenceMap,
  questionId: string,
  level: ConfidenceLevel,
): ConfidenceMap {
  return { ...map, [questionId]: level };
}

/** 一道题在不在「他答了」的范围里 —— 自评只对答过的题有意义。 */
export function answeredQuestionIds(
  questionIds: readonly string[],
  answers: QuizAnswers,
): string[] {
  return questionIds.filter((questionId) => {
    const value = answers[questionId];
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * 只数**既自评了、又判出了对错**的题。
 *
 * `correct === null`（简答题 AI 批改没回来）不计入：把它当成错会让
 * 「实际正确率」凭空掉一截，而这个函数的结果会被当成「他对自己判断得准不准」
 * 直接给人看。宁可少几道题、标签晚一点出，也不要给出一个偏低的数。
 */
export function calibrationOf(
  entries: readonly { confidence: ConfidenceLevel; correct: boolean | null }[],
): Calibration {
  const scored = entries.filter((entry) => entry.correct !== null);
  const count = scored.length;
  if (count === 0) {
    return {
      count: 0,
      expected: 0,
      actual: 0,
      bias: 0,
      label: undefined,
      needed: CONFIDENCE_LABEL_MIN_COUNT,
    };
  }
  const expectedSum = scored.reduce((sum, entry) => sum + entry.confidence, 0);
  const correctCount = scored.filter((entry) => entry.correct === true).length;
  const expected = expectedSum / count;
  const actual = (correctCount / count) * 100;
  const bias = expected - actual;
  const enough = count >= CONFIDENCE_LABEL_MIN_COUNT;
  return {
    count,
    expected,
    actual,
    bias,
    label: !enough
      ? undefined
      : bias >= CONFIDENCE_BIAS_TOLERANCE
        ? 'over'
        : bias <= -CONFIDENCE_BIAS_TOLERANCE
          ? 'under'
          : 'good',
    needed: enough ? 0 : CONFIDENCE_LABEL_MIN_COUNT - count,
  };
}

/**
 * 从「题号 → 把握」与判分结果拼出校准。
 *
 * 只吃**两边都有**的题：自评了但没判出来（`correct === null`）与判出来了
 * 但没自评（老数据、或者他跳过了那一题）都不进来。
 */
export function calibrationFromResults(
  confidence: ConfidenceMap,
  results: readonly { questionId: string; correct: boolean | null }[],
): Calibration {
  const entries: { confidence: ConfidenceLevel; correct: boolean | null }[] = [];
  for (const result of results) {
    const level = confidenceOf(confidence, result.questionId);
    if (level === undefined) continue;
    entries.push({ confidence: level, correct: result.correct });
  }
  return calibrationOf(entries);
}
