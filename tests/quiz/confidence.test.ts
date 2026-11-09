import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_BIAS_TOLERANCE,
  CONFIDENCE_LABEL_MIN_COUNT,
  CONFIDENCE_LEVELS,
  answeredQuestionIds,
  asConfidenceLevel,
  asConfidenceMap,
  calibrationFromResults,
  calibrationOf,
  confidenceOf,
  isConfidenceComplete,
  missingConfidence,
  withConfidence,
} from '@/lib/quiz/confidence';

describe('四档自评的取值', () => {
  it('★ 只认 25 / 50 / 75 / 95 —— 与 xq_probe_item 的 CHECK 逐值一致', () => {
    expect(CONFIDENCE_LEVELS).toEqual([25, 50, 75, 95]);
    for (const level of CONFIDENCE_LEVELS) {
      expect(asConfidenceLevel(level)).toBe(level);
    }
  });

  it('★ 近似值不收 —— 上层四舍五入，下层一样会被 CHECK 拒，只是那时错误发生在很远的地方', () => {
    expect(asConfidenceLevel(50.0001)).toBeUndefined();
    expect(asConfidenceLevel(74.9)).toBeUndefined();
    expect(asConfidenceLevel(0)).toBeUndefined();
    expect(asConfidenceLevel(100)).toBeUndefined();
  });

  it('★ 字符串不收 —— "50" 与 50 是两种东西，转过来就等于替调用方猜', () => {
    expect(asConfidenceLevel('50')).toBeUndefined();
    expect(asConfidenceLevel(null)).toBeUndefined();
    expect(asConfidenceLevel(undefined)).toBeUndefined();
    expect(asConfidenceLevel(Number.NaN)).toBeUndefined();
    expect(asConfidenceLevel(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('把来路不明的映射收成合法映射', () => {
  it('★ 收不进来的条目直接丢，不抛 —— 丢一条自评只是少一行事实，抛会毁掉整次提交', () => {
    expect(asConfidenceMap({ q1: 25, q2: '75', q3: 60, q4: 95, q5: null })).toEqual({
      q1: 25,
      q4: 95,
    });
  });

  it('★ 空题号不是一道题', () => {
    expect(asConfidenceMap({ '': 50, q1: 50 })).toEqual({ q1: 50 });
  });

  it('数组、null、标量都当没有', () => {
    expect(asConfidenceMap([25, 50])).toEqual({});
    expect(asConfidenceMap(null)).toEqual({});
    expect(asConfidenceMap(50)).toEqual({});
    expect(asConfidenceMap(undefined)).toEqual({});
  });

  it('读一道题：没问过与问过但没收进来都是 undefined', () => {
    const map = { q1: 75 as const };
    expect(confidenceOf(map, 'q1')).toBe(75);
    expect(confidenceOf(map, 'q2')).toBeUndefined();
    expect(confidenceOf(undefined, 'q1')).toBeUndefined();
  });

  it('写一道题返回新对象，不改传入的那个', () => {
    const before = { q1: 25 as const };
    const after = withConfidence(before, 'q2', 95);
    expect(after).toEqual({ q1: 25, q2: 95 });
    expect(before).toEqual({ q1: 25 });
  });
});

describe('问全了没有', () => {
  it('★ 只对答过的题要求自评 —— 跳过的题不存在「有多大把握」这种判断', () => {
    const questionIds = ['q1', 'q2', 'q3'];
    const answers = { q1: 'A', q2: '', q3: ['a', 'b'] };
    expect(answeredQuestionIds(questionIds, answers)).toEqual(['q1', 'q3']);
  });

  it('空白作答不算答过', () => {
    expect(answeredQuestionIds(['q1', 'q2'], { q1: '   ', q2: [] })).toEqual([]);
  });

  it('★ 没作答的题不选自评也不挡提交', () => {
    const questionIds = ['q1', 'q2'];
    const answers = { q1: 'A' };
    const confidence = { q1: 75 as const };
    expect(missingConfidence(answeredQuestionIds(questionIds, answers), confidence)).toEqual([]);
    expect(isConfidenceComplete(answeredQuestionIds(questionIds, answers), confidence)).toBe(true);
  });

  it('★ 答过但没选自评挡提交 —— 缺的是哪几道要点得出来', () => {
    const questionIds = ['q1', 'q2', 'q3'];
    const answers = { q1: 'A', q2: 'B', q3: '' };
    const confidence = { q1: 75 as const };
    expect(missingConfidence(answeredQuestionIds(questionIds, answers), confidence)).toEqual([
      'q2',
    ]);
    expect(isConfidenceComplete(answeredQuestionIds(questionIds, answers), confidence)).toBe(false);
  });
});

describe('校准', () => {
  it('★ 一道都没判出来时什么也不说 —— 不是「很准」，是「还不知道」', () => {
    const result = calibrationOf([]);
    expect(result.count).toBe(0);
    expect(result.label).toBeUndefined();
    expect(result.needed).toBe(CONFIDENCE_LABEL_MIN_COUNT);
  });

  it('★ 题数不到门槛时标签是 undefined 而不是 good', () => {
    const entries = [
      { confidence: 95 as const, correct: true },
      { confidence: 25 as const, correct: false },
    ];
    const result = calibrationOf(entries);
    expect(result.count).toBe(2);
    expect(result.label).toBeUndefined();
    expect(result.needed).toBe(CONFIDENCE_LABEL_MIN_COUNT - 2);
  });

  it('★ correct 为 null 的题不计入 —— 把没批出来的算成错，会让实际正确率凭空掉一截', () => {
    const entries = [
      { confidence: 75 as const, correct: true },
      { confidence: 75 as const, correct: null },
      { confidence: 75 as const, correct: false },
    ];
    const result = calibrationOf(entries);
    expect(result.count).toBe(2);
    expect(result.actual).toBe(50);
  });

  it('★ 过度自信：说 95 却做错', () => {
    const entries = Array.from({ length: 8 }, () => ({
      confidence: 95 as const,
      correct: false,
    }));
    const result = calibrationOf(entries);
    expect(result.expected).toBe(95);
    expect(result.actual).toBe(0);
    expect(result.bias).toBe(95);
    expect(result.label).toBe('over');
    expect(result.needed).toBe(0);
  });

  it('★ 低估自己：说 25 却做对', () => {
    const entries = Array.from({ length: 8 }, () => ({
      confidence: 25 as const,
      correct: true,
    }));
    const result = calibrationOf(entries);
    expect(result.bias).toBe(-75);
    expect(result.label).toBe('under');
  });

  it('★ 差在容差内算准 —— ±20 是经验值，不是结论', () => {
    expect(CONFIDENCE_BIAS_TOLERANCE).toBe(20);
    // 说 75，八题里六题对 = 75% 实际，bias 0
    const entries = [
      ...Array.from({ length: 6 }, () => ({ confidence: 75 as const, correct: true })),
      ...Array.from({ length: 2 }, () => ({ confidence: 75 as const, correct: false })),
    ];
    const result = calibrationOf(entries);
    expect(result.expected).toBe(75);
    expect(result.actual).toBe(75);
    expect(result.bias).toBe(0);
    expect(result.label).toBe('good');
  });

  it('★ 边界：bias 恰好等于容差算 over，差一点不算', () => {
    // 说 75，八题里四题对 = 50%，bias 25 > 20 ⇒ over
    const over = calibrationOf([
      ...Array.from({ length: 4 }, () => ({ confidence: 75 as const, correct: true })),
      ...Array.from({ length: 4 }, () => ({ confidence: 75 as const, correct: false })),
    ]);
    expect(over.bias).toBe(25);
    expect(over.label).toBe('over');
  });

  it('★ 与判分结果对齐时只吃两边都有的题', () => {
    const confidence = { q1: 95 as const, q2: 25 as const, q4: 95 as const };
    const results = [
      { questionId: 'q1', correct: true },
      { questionId: 'q2', correct: false },
      { questionId: 'q3', correct: true }, // 没自评
    ];
    const calibration = calibrationFromResults(confidence, results);
    expect(calibration.count).toBe(2);
    expect(calibration.expected).toBe(60);
    expect(calibration.actual).toBe(50);
  });

  it('★ q4 自评了但不在结果里 —— 那道题没有判分，不进校准', () => {
    const calibration = calibrationFromResults({ q4: 95 as const }, []);
    expect(calibration.count).toBe(0);
    expect(calibration.label).toBeUndefined();
  });
});
