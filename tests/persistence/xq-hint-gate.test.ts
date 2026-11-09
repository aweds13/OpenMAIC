import { describe, expect, it } from 'vitest';

import {
  ANSWER_FIRST_CODE,
  hintGateApplies,
  XqAnswerNotStartedError,
} from '@/lib/persistence/xq-hint-gate';

/**
 * 提问闸的**管不管**这一层。
 *
 * 闸真正会拒人的那半（查库）在 `tests/persistence/xq-events-route.test.ts`
 * 里走真路由验；这里只钉「哪些提问根本不进闸」—— 三种豁免各自都有代价，
 * 写错了不会报错，只会悄悄改变谁能问：
 *
 * - 不是 `hint_requested`：别的 kind 挂上来就是写错行；
 * - `executive`：这是**故意留的自由口子**，挡死会把人推到搜索引擎那边
 *   （那边一个事件都收不到，学情直接断掉）；
 * - 没有题号：页面级提问没有「先答」的对象。
 */
describe('xq hint gate', () => {
  it('★ 只有 instrumental 的题目级提问进闸', () => {
    expect(hintGateApplies('hint_requested', 'q1', 'instrumental')).toBe(true);
  });

  it('★ executive 不进闸 —— 自由口子必须留，但如实记成「要答案」', () => {
    expect(hintGateApplies('hint_requested', 'q1', 'executive')).toBe(false);
  });

  it('没有题号不进闸 —— 页面级提问没有「先答」的对象', () => {
    expect(hintGateApplies('hint_requested', undefined, 'instrumental')).toBe(false);
    expect(hintGateApplies('hint_requested', '', 'instrumental')).toBe(false);
  });

  it('别的 kind 不进闸 —— 闸只管提问那一条', () => {
    expect(hintGateApplies('page_viewed', 'q1', undefined)).toBe(false);
    expect(hintGateApplies('answer_submitted', 'q1', undefined)).toBe(false);
  });

  it('拒绝码是 ANSWER_FIRST，不是状态码 —— 客户端按码切文案', () => {
    expect(ANSWER_FIRST_CODE).toBe('ANSWER_FIRST');
    const error = new XqAnswerNotStartedError('stage-A', 'scene-p1', 'q1');
    expect(error.name).toBe('XqAnswerNotStartedError');
    expect(error.message).toContain('stage-A/scene-p1/q1');
  });
});
