import { describe, expect, it } from 'vitest';

import {
  answerAttemptDedupeKey,
  answerSubmittedDedupeKey,
  resolveAnswerTarget,
} from '@/lib/learning/xq-answer-events';

/**
 * 答题事件的两个**纯判据**：坐标够不够、幂等键长什么样。
 *
 * 为什么这两条值得单独测：`recordAnswerAttempt` / `recordAnswerSubmitted`
 * 一进去就 `void getXqEventClient().recordEvent(...)`，是发给网络的副作用，
 * 测试里没法直接断言「发了几条」。但「该不该发」「发的键是不是同一个」
 * 恰恰是这两条事件唯一会出错的地方 —— 判据抽出来，副作用交给发送端。
 */
describe('xq answer events', () => {
  const context = { stageId: 'stage-A', sceneId: 'scene-p1', attemptId: 'att-1' };

  describe('★ 坐标不全就不发 —— 发出去的事件挂不上任何页', () => {
    it('三样齐 + 有题号 ⇒ 就是那个坐标', () => {
      expect(resolveAnswerTarget(context, 'q1')).toEqual({
        stageId: 'stage-A',
        sceneId: 'scene-p1',
        attemptId: 'att-1',
        questionId: 'q1',
      });
    });

    it('没有上下文就没有坐标', () => {
      expect(resolveAnswerTarget(undefined, 'q1')).toBeUndefined();
    });

    it('题号缺或空串都没有坐标', () => {
      expect(resolveAnswerTarget(context, undefined)).toBeUndefined();
      expect(resolveAnswerTarget(context, '')).toBeUndefined();
    });

    it('三样里任何一个空串都没有坐标（attemptId 未就绪时最常见）', () => {
      expect(resolveAnswerTarget({ ...context, attemptId: '' }, 'q1')).toBeUndefined();
      expect(resolveAnswerTarget({ ...context, sceneId: '' }, 'q1')).toBeUndefined();
      expect(resolveAnswerTarget({ ...context, stageId: '' }, 'q1')).toBeUndefined();
      expect(
        resolveAnswerTarget({ stageId: 'stage-A', sceneId: 'scene-p1' }, 'q1'),
      ).toBeUndefined();
    });
  });

  describe('★ 幂等键与时间无关 —— 改三遍答案仍是一行', () => {
    it('同一轮同一题，键是稳定的', () => {
      expect(answerAttemptDedupeKey('att-1', 'q1')).toBe('answer_attempted:att-1:q1');
      expect(answerAttemptDedupeKey('att-1', 'q1')).toBe(answerAttemptDedupeKey('att-1', 'q1'));
    });

    it('换题、换轮、换阶段都换键（重做是另一次尝试，不能被上一轮吃掉）', () => {
      expect(answerAttemptDedupeKey('att-1', 'q1')).not.toBe(answerAttemptDedupeKey('att-1', 'q2'));
      expect(answerAttemptDedupeKey('att-1', 'q1')).not.toBe(
        answerAttemptDedupeKey('att-1:retry:1', 'q1'),
      );
    });

    it('attempted 与 submitted 是两条不同的事实（键不同）', () => {
      expect(answerAttemptDedupeKey('att-1', 'q1')).not.toBe(
        answerSubmittedDedupeKey('att-1', 'q1'),
      );
    });
  });
});
