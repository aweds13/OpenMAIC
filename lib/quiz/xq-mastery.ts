/**
 * 学情的纯函数层：只做算术，不碰数据库、不调模型。
 *
 * 为什么强调「纯」：掌握度会被读到每一轮对话的提示词里。如果它里面有 LLM
 * 调用或数据库往返，那么（1）同一组答题记录两次读出的数可能不同，
 * （2）前缀缓存会每轮失效。实测过代价：`学习状态.md` 这种「每次运行重写」
 * 的做法让整段系统提示词每轮重算，缓存命中率 99.1% → 38.5%。
 *
 * 三个常量来自实测标定，不是拍的（推导过程见 `.tmp/kg_final2.py`）：
 *
 * - 全库 98 道题 = 单选 86（全 4 选项，盲猜正确率 g = 0.25）+ 多选 12
 *   （均值 g = 0.0638）。**答对率 p 不等于掌握度 m**：`m = (p - g) / (1 - g)`。
 *   漏掉这一步的话，要判「会不会」得 43 题，而且对真正会 90% 的人
 *   检出力只有 0.43 —— 等于白问。
 * - `CONF = 0.80`：用 Beta 后验的 20%/80% 分位反解 m，两端各留 20% 的错判余量。
 * - `KNOWN_MIN = 0.55` / `NOT_LEARNED_MAX = 0.30`：中间 0.25 宽的带子是
 *   `unknown`。留这条带子的理由不是保守，是因为 0.30–0.55 这一段在 8 题
 *   以内的样本上**本来就分不开**（Beta 区间会重叠），硬判一定是幻觉。
 *
 * 效果实测：17/17 个 cell 两端都可判；前沿 n=8 需 7/8 或 8/8；
 * 真会 90% 的人检出力 0.8836，纯猜的人 0.0004。
 */

/** 一道单选/多选题的盲猜正确率。 */
export const GUESS_RATE_CHOICE = 0.25;

/** 多选（12 道）的均值盲猜率；留常量是因为它有实测来源，不是 0。 */
export const GUESS_RATE_MULTIPLE_MEAN = 0.0638;

/** 判「会」的把握度（单边）：Beta 后验的 20% 分位要能反解出 m ≥ KNOWN_MIN。 */
export const CONFIDENCE = 0.8;

/** 判「会」的掌握度下限。 */
export const KNOWN_MIN = 0.55;

/** 判「没学过」的掌握度上限。 */
export const NOT_LEARNED_MAX = 0.3;

/** 少于这个题量，任何结论都只能是 `unknown`。 */
export const MIN_ITEMS_FOR_VERDICT = 3;

/**
 * 判「会」要求的第一条证据至少放了这么多天。
 *
 * ★ 3 天**不是文献值**，是「四关的第 2 关就是第 3 天」（`xq_review_schedule`
 *   里 round 2 的 `due_at = asked_at + 3d`）。用已有排期当分界，不需要新参数。
 *   这是「有依据的选择」不是「已优化的参数」—— 改它要重新标定。
 *
 * 为什么要有这一条：`n/k` 里的每一条证据都不含 `Δ = now − asked_at`，所以
 * Beta 区间虽然统计上正确（Beta-二项共轭、下界取 20% 分位），**构念上测的是
 * 「曾经答对的比例」，不是「隔几天还能不能取出来」**。实测的极端反例：
 * 反复测全部项 vs 答对就撤，一周后的保持率 80% vs 33–36%（d=4.03），
 * 而被测试者自己完全预测不出来 —— 当天答对不说明记住了。
 */
export const DELAYED_BUCKET_DAYS = 3;

/**
 * 延迟桶里至少要几条证据才允许判「会」。
 *
 * 与 `MIN_ITEMS_FOR_VERDICT` 同值但**不是同一个东西**：上面那条是「总量够不够」，
 * 这条是「隔了几天之后还答对的那部分够不够」。两条都要满足。
 */
export const MIN_DELAYED_ITEMS_FOR_KNOWN = 3;

export type Tri = 'known' | 'not-learned' | 'unknown';

/**
 * 为什么 `unknown`。**必须能解释**：一个说不清原因的 `unknown` 在界面上
 * 与「我没查过」无法区分，而这两件事对学习者是完全不同的信息。
 */
export type UnknownReason = 'no-quiz' | 'too-few-items' | 'mixed' | 'not-selected';

export interface EvidenceItem {
  /** 这一条证据算几分之几题：同题重测记 0.5。 */
  countedN: number;
  correct: boolean;
  /** 这道题的盲猜率；缺省按单选 0.25。 */
  guessRate?: number;
  /**
   * 这条证据是什么时候观测的（`xq_probe_item.asked_at`）。
   *
   * 给了才分延迟桶。**不给 = 不声称「这些证据是刚产生的」**，按「已经放够久」
   * 处理 —— 这条缺省只为向后兼容（历史调用点与纯算术测试不传时间），
   * 生产路径（`XqLearnerStore.recomputeCellState`）必须给。
   */
  askedAt?: Date | string | number;
}

/** 分延迟桶用的「现在」与阈值。`now` 不注入就取真实时钟 —— 测试与重放必须注入。 */
export interface ClassifyOptions {
  now?: Date | number | string;
  /** 默认 {@link DELAYED_BUCKET_DAYS}。传它是为了让测试能钉住边界，不是给生产调的。 */
  delayedDays?: number;
}

function toEpoch(value: Date | string | number | undefined): number | null {
  if (value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export interface TriVerdict {
  tri: Tri;
  /** 有效题量（`counted_n` 之和）。 */
  n: number;
  /** 有效答对数（同样按 `counted_n` 加权）。 */
  k: number;
  /** 掌握度的后验下界（20% 分位反解）；样本不足时为 null。 */
  lb5: number | null;
  /** 掌握度的后验上界（80% 分位反解）。 */
  ub95: number | null;
  /**
   * 延迟桶（`Δ ≥ DELAYED_BUCKET_DAYS`）里的有效题量与答对数。
   *
   * 落进 `xq_cell_state.n_delayed` / `k_delayed`。`tri='known'` 只允许由这一对
   * 推出（见 {@link classifyEvidence}），所以这两个数必须能被单独看见 ——
   * 否则「为什么这一格明明是 8/8 却不是 known」在库里查不出来。
   */
  nDelayed: number;
  kDelayed: number;
  reason?: UnknownReason;
}

/**
 * 盲猜校正后的掌握度点估计。
 *
 * 输入是「答对率 p」（已按 counted_n 加权），输出是 m ∈ [0,1]。
 * p ≤ g 时返回 0 —— 答得比瞎猜还差不能推出「负掌握」，只能推出「不会」。
 */
export function masteryFromAccuracy(p: number, guessRate = GUESS_RATE_CHOICE): number {
  if (!Number.isFinite(p)) return 0;
  const g = clamp(guessRate, 0, 0.99);
  if (p <= g) return 0;
  return clamp((p - g) / (1 - g), 0, 1);
}

/** 反向：要把掌握度推到 m，需要多高的答对率。用于「还差几题」的提示。 */
export function accuracyForMastery(m: number, guessRate = GUESS_RATE_CHOICE): number {
  const g = clamp(guessRate, 0, 0.99);
  return clamp(g + clamp(m, 0, 1) * (1 - g), 0, 1);
}

/**
 * Beta 后验分位数（正则化不完全 Beta 函数的反函数）。
 *
 * 不引第三方库：这里只需要 `alpha`/`beta` 都是正数时的分位数，
 * 用二分找根足够（每次 60 步，误差 < 1e-12），而且它没有依赖 ——
 * 这个模块要能在插件进程里裸跑。
 */
export function betaQuantile(
  p: number,
  alpha: number,
  beta: number,
  iterations = 60,
): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`betaQuantile: p must be in (0,1), got ${p}`);
  if (!(alpha > 0) || !(beta > 0)) throw new RangeError('betaQuantile: alpha, beta must be > 0');
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (lo + hi) / 2;
    const cdf = regularizedIncompleteBeta(mid, alpha, beta);
    if (cdf < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 正则化不完全 Beta 函数 I_x(a,b)，用连分式（Lentz 法）。
 *
 * 这是标准做法（Numerical Recipes 的 `betacf`/`betai`），放在这里是因为
 * 掌握度的判定**完全依赖它** —— 没有它就只能比点估计，而点估计在 n=3 时
 * 毫无意义（3/3 的点估计是 1.0，但 20% 分位只有 0.55 左右）。
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - logBeta) / a;
  if (x < (a + 1) / (a + b + 2)) return front * betaContinuedFraction(x, a, b);
  return 1 - (front * betaContinuedFraction(1 - x, b, a) * a) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}

/** Lanczos 近似的 log Γ，够用且无依赖。 */
export function logGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i += 1) x += g[i]! / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * 一组证据 → 三态判定。
 *
 * 判定用的是**区间不重叠**，不是点估计：
 *   known        ⟺ Beta 20% 分位反解出的 m ≥ KNOWN_MIN
 *   not-learned  ⟺ Beta 80% 分位反解出的 m ≤ NOT_LEARNED_MAX
 *   其余         ⟺ unknown（并说明为什么）
 *
 * 为什么不是「点估计 > 阈值就算会」：3 题全对是 3/3，点估计 1.0，
 * 但 Beta(1,1) 先验下 20% 分位只有 0.55 —— 恰好卡在门槛上。这与
 * 「n=8 需 7/8」是同一件事的两面，用区间表达才能同时解释两者。
 */
export function classifyEvidence(
  items: readonly EvidenceItem[],
  options: ClassifyOptions = {},
): TriVerdict {
  const effective = items.filter((item) => item.countedN > 0);
  if (effective.length === 0) {
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

  let n = 0;
  let k = 0;
  let nDelayed = 0;
  let kDelayed = 0;
  // 「现在」只求一次：逐条取会把跨午夜的那一秒算成两种答案。
  const nowMs = toEpoch(options.now) ?? Date.now();
  const bucketMs = (options.delayedDays ?? DELAYED_BUCKET_DAYS) * 86_400_000;
  for (const item of effective) {
    n += item.countedN;
    if (item.correct) k += item.countedN;
    // ★ 没给 `askedAt` 的条目按「已放够久」算。这是向后兼容的缺省，不是判据：
    //   生产路径每条都带 `asked_at`（见 XqLearnerStore.recomputeCellState）。
    const askedMs = toEpoch(item.askedAt);
    if (askedMs === null || nowMs - askedMs >= bucketMs) {
      nDelayed += item.countedN;
      if (item.correct) kDelayed += item.countedN;
    }
  }

  if (n < MIN_ITEMS_FOR_VERDICT) {
    return {
      tri: 'unknown',
      n: round1(n),
      k: round1(k),
      lb5: null,
      ub95: null,
      nDelayed: round1(nDelayed),
      kDelayed: round1(kDelayed),
      reason: 'too-few-items',
    };
  }

  // 每道题的盲猜率可能不同（单选 0.25、多选 0.0638）。混在一格里时取
  // 加权平均——这是在算「这一格的整体盲猜水平」，不是算单题的。
  const guessWeighted =
    effective.reduce((sum, item) => sum + (item.guessRate ?? GUESS_RATE_CHOICE) * item.countedN, 0) /
    n;

  // Beta 先验取 (1,1)，即无信息先验：不假设任何人格外会或格外不会。
  const alpha = 1 + k;
  const beta = 1 + (n - k);
  // ★ 单边 80%，不是双边：下界取 20% 分位、上界取 80% 分位。
  // 站到双边会得到 (1-0.8)/2 = 10% 与 90%，那样 n=8 要全对 8/8 才能判会、
  // 真会 90% 的人检出率掉到 0.53 —— 与标定读数（7/8 即可、0.8836）不符。
  const pLow = betaQuantile(1 - CONFIDENCE, alpha, beta);
  const pHigh = betaQuantile(CONFIDENCE, alpha, beta);
  const lb5 = round3(masteryFromAccuracy(pLow, guessWeighted));
  const ub95 = round3(masteryFromAccuracy(pHigh, guessWeighted));
  const rounded = {
    n: round1(n),
    k: round1(k),
    lb5,
    ub95,
    nDelayed: round1(nDelayed),
    kDelayed: round1(kDelayed),
  };

  // ★ 「会」**只**由延迟桶推出。全量桶的 `lb5 >= KNOWN_MIN` 不再直接判 known ——
  //   它只说明「这些题当时答对了」，不说明「隔了几天还取得出来」。
  //   延迟桶不够时的 reason 是 `mixed`（不是 `too-few-items`）：总量是够的，
  //   缺的是「隔了几天之后的那一次」—— 这两件事对学习者的含义完全不同。
  if (nDelayed >= MIN_DELAYED_ITEMS_FOR_KNOWN) {
    const dAlpha = 1 + kDelayed;
    const dBeta = 1 + (nDelayed - kDelayed);
    const dLow = masteryFromAccuracy(betaQuantile(1 - CONFIDENCE, dAlpha, dBeta), guessWeighted);
    if (dLow >= KNOWN_MIN) return { tri: 'known', ...rounded };
  }
  if (ub95 <= NOT_LEARNED_MAX) return { tri: 'not-learned', ...rounded };
  return { tri: 'unknown', ...rounded, reason: 'mixed' };
}

/**
 * 「再答对几题就能判会」——用于给学生一句可执行的下一步，而不是一个分数。
 *
 * 返回 null 表示按当前证据怎么答都判不出来（只在盲猜率极端时不出现）。
 */
export function itemsNeededForKnown(
  observed: { n: number; k: number },
  guessRate = GUESS_RATE_CHOICE,
  maxExtra = 20,
): number | null {
  for (let extra = 0; extra <= maxExtra; extra += 1) {
    const n = observed.n + extra;
    const k = observed.k + extra;
    const alpha = 1 + k;
    const beta = 1 + (n - k);
    const pLow = betaQuantile(1 - CONFIDENCE, alpha, beta);
    if (masteryFromAccuracy(pLow, guessRate) >= KNOWN_MIN) return extra;
  }
  return null;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
