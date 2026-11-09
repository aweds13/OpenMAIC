import { describe, expect, it } from 'vitest';

import {
  accuracyForMastery,
  betaQuantile,
  classifyEvidence,
  CONFIDENCE,
  GUESS_RATE_CHOICE,
  GUESS_RATE_MULTIPLE_MEAN,
  itemsNeededForKnown,
  KNOWN_MIN,
  DELAYED_BUCKET_DAYS,
  MIN_DELAYED_ITEMS_FOR_KNOWN,
  logGamma,
  masteryFromAccuracy,
  MIN_ITEMS_FOR_VERDICT,
  NOT_LEARNED_MAX,
  regularizedIncompleteBeta,
} from '@/lib/quiz/xq-mastery';

/**
 * 判据的分母是「标定读数」，不是「我觉得对」。
 *
 * 这些数字来自 `D:/文档/jelly_ware/program/OpenMAIC/.tmp/kg_final2.py` ——
 * 一个独立的 python 实现，用 98 道真题（单选 86 / 多选 12）的盲猜率标定出来。
 * 这里的每一条断言都在钉住某一个具体读数，小数点后两位以内。
 *
 * 为什么需要逐位钉：这个模块的头三个版本都把 Beta 分位数取反过
 * （先 40/60、再 10/90、最后才对成单边 20/80）。取反之后**代码能跑、
 * 类型也对、界面上还显示得像模像样**，只有拿标定读数一比才看得出错。
 * 所以判据必须钉到数字，不能只断言「known 了」。
 */

function evidence(n: number, correct: number, guessRate = GUESS_RATE_CHOICE) {
  return Array.from({ length: n }, (_, i) => ({
    countedN: 1,
    correct: i < correct,
    guessRate,
  }));
}

describe('掌握度的数学基础', () => {
  it('logGamma 与已知值一致', () => {
    expect(logGamma(1)).toBeCloseTo(0, 10);
    expect(logGamma(2)).toBeCloseTo(0, 10);
    // Γ(0.5) = sqrt(pi)
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 8);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 8);
  });

  it('正则化不完全 Beta 在端点与中点的取值', () => {
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
    // 对称先验 Beta(1,1) 就是均匀分布 ⇒ I_x(1,1) = x
    expect(regularizedIncompleteBeta(0.37, 1, 1)).toBeCloseTo(0.37, 8);
    // Beta(2,2) 的 CDF 在 0.5 处是 0.5（对称）
    expect(regularizedIncompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 8);
  });

  it('betaQuantile 是 regularizedIncompleteBeta 的反函数', () => {
    for (const [p, a, b] of [
      [0.2, 2, 4],
      [0.5, 3, 3],
      [0.8, 5, 2],
      [0.1, 1, 1],
    ] as const) {
      const x = betaQuantile(p, a, b);
      expect(regularizedIncompleteBeta(x, a, b)).toBeCloseTo(p, 8);
    }
  });
});

describe('盲猜校正', () => {
  it('答对率等于盲猜率时掌握度为 0', () => {
    expect(masteryFromAccuracy(GUESS_RATE_CHOICE, GUESS_RATE_CHOICE)).toBe(0);
    expect(masteryFromAccuracy(0.1, GUESS_RATE_CHOICE)).toBe(0);
  });

  it('全对时掌握度为 1', () => {
    expect(masteryFromAccuracy(1, GUESS_RATE_CHOICE)).toBeCloseTo(1, 10);
  });

  it('半对（单选）是 1/3 不是 1/2', () => {
    // 这一条是「漏了盲猜校正」的探针：把 p 当 m 会得到 0.5。
    expect(masteryFromAccuracy(0.5, GUESS_RATE_CHOICE)).toBeCloseTo(1 / 3, 10);
  });

  it('accuracyForMastery 是 masteryFromAccuracy 的反函数', () => {
    for (const m of [0, 0.3, 0.55, 0.8, 1]) {
      expect(masteryFromAccuracy(accuracyForMastery(m), GUESS_RATE_CHOICE)).toBeCloseTo(m, 10);
    }
  });
});

describe('classifyEvidence 与标定读数逐条对齐', () => {
  /**
   * 标定脚本的原样读数（g=0.25）：
   *   n=8 k=0..8: NNN....KK
   * 即 k=0,1,2 → not-learned；k=3..6 → unknown；k=7,8 → known。
   */
  it('n=8 的九个格子与标定矩阵一致（NNN....KK）', () => {
    const got = Array.from({ length: 9 }, (_, k) => {
      const verdict = classifyEvidence(evidence(8, k));
      if (verdict.tri === 'known') return 'K';
      if (verdict.tri === 'not-learned') return 'N';
      return '.';
    }).join('');
    expect(got).toBe('NNN....KK');
  });

  /** n=3 k=0..3: N..K */
  it('n=3 的四个格子与标定矩阵一致（N..K）', () => {
    const got = Array.from({ length: 4 }, (_, k) => {
      const verdict = classifyEvidence(evidence(3, k));
      if (verdict.tri === 'known') return 'K';
      if (verdict.tri === 'not-learned') return 'N';
      return '.';
    }).join('');
    expect(got).toBe('N..K');
  });

  it('n=10 的十一个格子与标定矩阵一致（NNNN.....KK）', () => {
    const got = Array.from({ length: 11 }, (_, k) => {
      const verdict = classifyEvidence(evidence(10, k));
      if (verdict.tri === 'known') return 'K';
      if (verdict.tri === 'not-learned') return 'N';
      return '.';
    }).join('');
    expect(got).toBe('NNNN.....KK');
  });

  it('7/8 判会时的置信区间与标定一致（lb≈0.603 ub≈0.876）', () => {
    const verdict = classifyEvidence(evidence(8, 7));
    expect(verdict.tri).toBe('known');
    expect(verdict.n).toBe(8);
    expect(verdict.k).toBe(7);
    expect(verdict.lb5).toBeCloseTo(0.603, 2);
    expect(verdict.ub95).toBeCloseTo(0.876, 2);
  });

  it('6/8 仍是 unknown，理由必须是 mixed（不是 too-few-items）', () => {
    const verdict = classifyEvidence(evidence(8, 6));
    expect(verdict.tri).toBe('unknown');
    expect(verdict.reason).toBe('mixed');
  });
});

describe('门槛与理由是能解释的', () => {
  it('零证据是 no-quiz，不是 mixed', () => {
    const verdict = classifyEvidence([]);
    expect(verdict.tri).toBe('unknown');
    expect(verdict.reason).toBe('no-quiz');
    expect(verdict.n).toBe(0);
  });

  it(`题量低于 ${MIN_ITEMS_FOR_VERDICT} 一律 too-few-items`, () => {
    for (const n of [1, 2]) {
      for (let k = 0; k <= n; k += 1) {
        const verdict = classifyEvidence(evidence(n, k));
        expect(verdict.tri).toBe('unknown');
        expect(verdict.reason).toBe('too-few-items');
        expect(verdict.lb5).toBeNull();
        expect(verdict.ub95).toBeNull();
      }
    }
  });

  it('同题重测按 0.5 计：2 题各答对两次只等于 1 题', () => {
    // 四条证据都是 correct，但每条 countedN 是 0.5 ⇒ n=2 < 3 ⇒ too-few-items。
    // 如果没按 countedN 加权（当 4 题算），就会判 known —— 这就是这条判据的意义。
    const halved = Array.from({ length: 4 }, () => ({
      countedN: 0.5,
      correct: true,
      guessRate: GUESS_RATE_CHOICE,
    }));
    const verdict = classifyEvidence(halved);
    expect(verdict.n).toBe(2);
    expect(verdict.tri).toBe('unknown');
    expect(verdict.reason).toBe('too-few-items');
  });

  it('多选盲猜率更低 ⇒ 同样 3/3 的下界更高', () => {
    const single = classifyEvidence(evidence(3, 3, GUESS_RATE_CHOICE));
    const multi = classifyEvidence(evidence(3, 3, GUESS_RATE_MULTIPLE_MEAN));
    expect(single.lb5).not.toBeNull();
    expect(multi.lb5).not.toBeNull();
    expect(multi.lb5!).toBeGreaterThan(single.lb5!);
  });
});

describe('还差几题', () => {
  it('与标定读数一致（0/1→6, 2/2→1, 2/3→4, 4/5→2, 6/8→3）', () => {
    expect(itemsNeededForKnown({ n: 1, k: 0 })).toBe(6);
    expect(itemsNeededForKnown({ n: 2, k: 2 })).toBe(1);
    expect(itemsNeededForKnown({ n: 3, k: 2 })).toBe(4);
    expect(itemsNeededForKnown({ n: 5, k: 4 })).toBe(2);
    expect(itemsNeededForKnown({ n: 8, k: 6 })).toBe(3);
  });

  it('已经判会时为 0', () => {
    expect(itemsNeededForKnown({ n: 8, k: 7 })).toBe(0);
    expect(itemsNeededForKnown({ n: 8, k: 8 })).toBe(0);
  });
});

describe('延迟桶：会 = 隔了几天还答得对', () => {
  /**
   * ★ 这一组钉的是 N2 §8.4 的那个洞：「n/k 里没有任何一条证据带 Δ=now−asked_at，
   * 所以 Beta 区间统计上正确，但构念上测的是『曾经答对的比例』」。
   * 实测反例：反复测全部项 vs 答对就撤，一周保持率 80% vs 33–36%（d=4.03），
   * 而被测试者自己预测不出来。
   */

  const NOW = new Date('2026-11-20T00:00:00Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

  /** 8 条全对，但全是今天答的 ⇒ 一条也不该进延迟桶。 */
  it('今天答对的题不算延迟证据 —— 即使 8/8 也不判会', () => {
    const items = Array.from({ length: 8 }, () => ({
      countedN: 1,
      correct: true,
      askedAt: daysAgo(0),
    }));
    const verdict = classifyEvidence(items, { now: NOW });
    expect(verdict.n).toBe(8);
    expect(verdict.nDelayed).toBe(0);
    expect(verdict.tri).toBe('unknown');
    // 不是 too-few-items：总量够，缺的是「隔了几天之后的那一次」。
    expect(verdict.reason).toBe('mixed');
  });

  it('8 条全对且都放了 3 天以上 ⇒ 判会，延迟桶等于全量桶', () => {
    const items = Array.from({ length: 8 }, () => ({
      countedN: 1,
      correct: true,
      askedAt: daysAgo(4),
    }));
    const verdict = classifyEvidence(items, { now: NOW });
    expect(verdict.tri).toBe('known');
    expect(verdict.nDelayed).toBe(8);
    expect(verdict.kDelayed).toBe(8);
  });

  it('★ 延迟桶不足 3 条时，全量桶再漂亮也只判 unknown', () => {
    // 10 条全对，但只有 2 条放过 3 天 —— 缺的正是「隔几天还取得出来」的证据。
    const items = [
      ...Array.from({ length: 2 }, () => ({ countedN: 1, correct: true, askedAt: daysAgo(5) })),
      ...Array.from({ length: 8 }, () => ({ countedN: 1, correct: true, askedAt: daysAgo(0) })),
    ];
    const verdict = classifyEvidence(items, { now: NOW });
    expect(verdict.n).toBe(10);
    expect(verdict.nDelayed).toBe(2);
    expect(verdict.tri).toBe('unknown');
    expect(verdict.reason).toBe('mixed');
    expect(MIN_DELAYED_ITEMS_FOR_KNOWN).toBe(3);
  });

  it('缺省 askedAt 的条目按「已放够久」算（向后兼容，不是判据）', () => {
    // 老调用点与纯算术测试不传时间；把它们当成「刚答的」会让所有历史调用突然掉成 unknown。
    const verdict = classifyEvidence(evidence(8, 8), { now: NOW });
    expect(verdict.tri).toBe('known');
    expect(verdict.nDelayed).toBe(8);
  });

  it('3 天是边界：2.99 天不进延迟桶，3.00 天进', () => {
    const justUnder = [
      ...Array.from({ length: 3 }, () => ({
        countedN: 1,
        correct: true,
        askedAt: new Date(NOW.getTime() - (DELAYED_BUCKET_DAYS * 86_400_000 - 1)),
      })),
      ...Array.from({ length: 5 }, () => ({ countedN: 1, correct: true, askedAt: daysAgo(10) })),
    ];
    expect(classifyEvidence(justUnder, { now: NOW }).nDelayed).toBe(5);
    const justOver = justUnder.map((item, i) =>
      i < 3 ? { ...item, askedAt: daysAgo(DELAYED_BUCKET_DAYS) } : item,
    );
    expect(classifyEvidence(justOver, { now: NOW }).nDelayed).toBe(8);
  });

  it('阈值可注入 —— 只给测试钉边界用，不是给生产调的旋钮', () => {
    const items = Array.from({ length: 8 }, () => ({
      countedN: 1,
      correct: true,
      askedAt: daysAgo(1),
    }));
    expect(classifyEvidence(items, { now: NOW }).nDelayed).toBe(0);
    expect(classifyEvidence(items, { now: NOW, delayedDays: 1 }).nDelayed).toBe(8);
  });
});

describe('判界矩阵（钉住真实读数，不是钉住任何一份文档的说法）', () => {
  /**
   * ★ 这一组存在的原因是：设计文档 M §5.2 说「n=8 时两个实现巧合一致（都要 7/8），
   * n=9 分叉（D 允许 8/9，代码要 9/9）」，而真跑出来的判界是：
   *
   *   n=6 → 6/6   n=7 → 6/7   n=8 → 7/8   n=9 → 8/9
   *   n=10 → 9/10 n=11 → 9/11 n=12 → 10/12
   *
   * **n=9 并不分叉**（代码也允许 8/9），M 那句话与它自己那张表都不一致。
   * 所以这里钉住代码的实测判界 —— 谁要按文档去「修正」代码，这几条会红。
   */
  it('判界矩阵与实测一致：n=6..12 的最小判会题数', () => {
    const minKnown = (n: number) => {
      for (let k = 0; k <= n; k += 1) {
        if (classifyEvidence(evidence(n, k)).tri === 'known') return k;
      }
      return -1;
    };
    expect([6, 7, 8, 9, 10, 11, 12].map(minKnown)).toEqual([6, 6, 7, 8, 9, 9, 10]);
    // 差的这一题就是「n=9 要 8/9」—— 与文档说的「要 9/9」不同。
    expect(minKnown(9)).toBe(8);
  });

  /**
   * ★ 分叉二：`not-learned` 的 `ub95 = 0` 是**截断**不是估计。
   *
   * `masteryFromAccuracy(p, g)` 在 `p ≤ g` 时返回 0，所以 5/0 的真实
   * raw 概率上界 0.2353 被压成 0。语义上可辩护（答对率低于盲猜率 ⇒ 掌握度 0），
   * 但状态块会写「不会（置信上界 0.00）」，那个 0.00 会被读成「确定不会」。
   * 这条断言钉住「它确实是 0」，同时钉住它不是算出来的。
   */
  it('5/0 的 ub95 是 0 —— 这是截断，真实 raw 上界是 0.2353', () => {
    const verdict = classifyEvidence(evidence(5, 0));
    expect(verdict.ub95).toBe(0);
    expect(verdict.tri).toBe('not-learned');
    // 原始 raw 分位（不经盲猜反解）确实不是 0 —— 说明 0 来自截断。
    const rawUpper = betaQuantile(CONFIDENCE, 1, 6);
    expect(rawUpper).toBeCloseTo(0.2353, 4);
  });
});

describe('常量是标定出来的，不是拍的', () => {
  it('常量组合能复现标定的边界', () => {
    expect(CONFIDENCE).toBe(0.8);
    expect(KNOWN_MIN).toBe(0.55);
    expect(NOT_LEARNED_MAX).toBe(0.3);
    // 中间留 0.25 宽的带子：0.30–0.55 在 8 题内的样本上本来分不开。
    expect(KNOWN_MIN - NOT_LEARNED_MAX).toBeCloseTo(0.25, 10);
  });

  it('检出率与标定同量级（真会 90% 的人，n=8）', () => {
    // 用固定种子的确定性模拟，避免测试本身随机。
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const p = GUESS_RATE_CHOICE + 0.9 * (1 - GUESS_RATE_CHOICE);
    let hit = 0;
    const trials = 20000;
    for (let t = 0; t < trials; t += 1) {
      const items = Array.from({ length: 8 }, () => ({ countedN: 1, correct: rand() < p }));
      if (classifyEvidence(items).tri === 'known') hit += 1;
    }
    // 标定值是 0.8836；这里允许 ±0.02（固定种子的模拟误差）
    expect(hit / trials).toBeGreaterThan(0.86);
    expect(hit / trials).toBeLessThan(0.90);
  });

  it('纯猜的人几乎永远判不出会', () => {
    let seed = 999;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let hit = 0;
    const trials = 20000;
    for (let t = 0; t < trials; t += 1) {
      const items = Array.from({ length: 8 }, () => ({
        countedN: 1,
        correct: rand() < GUESS_RATE_CHOICE,
      }));
      if (classifyEvidence(items).tri === 'known') hit += 1;
    }
    // 标定值是 0.0004
    expect(hit / trials).toBeLessThan(0.005);
  });
});
