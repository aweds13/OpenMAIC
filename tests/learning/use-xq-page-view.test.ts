import { describe, expect, it } from 'vitest';

import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { shouldRecordPageView } from '@/lib/learning/use-xq-page-view';

/**
 * 「这一页该不该记成一次浏览」的判据。
 *
 * 这一段防的是**记错**，不是记漏：多记一条可以在读的时候扔掉，把
 * 「页面还不存在」记成浏览则会让「他看过这页」变成假话，而这条假话
 * 会顺着事件 → 状态 → 状态块一路传到给模型看的那段文字里。
 */
describe('page view: 什么算一次真的浏览', () => {
  it('★ 正常翻页要记 —— 有课程、有页面', () => {
    expect(shouldRecordPageView('stage-abc', 'scene-p1')).toBe(true);
  });

  it('★ 占位页不记 —— 那一页根本还不存在', () => {
    expect(PENDING_SCENE_ID).toBe('__pending__');
    expect(shouldRecordPageView('stage-abc', PENDING_SCENE_ID)).toBe(false);
  });

  it('没有课程 id 不记 —— 事件必须带 stage_id（35 个 scene id 跨课程复用）', () => {
    expect(shouldRecordPageView(undefined, 'scene-p1')).toBe(false);
    expect(shouldRecordPageView('', 'scene-p1')).toBe(false);
  });

  it('没有页面 id 不记 —— 空串/null 都不是一页', () => {
    expect(shouldRecordPageView('stage-abc', undefined)).toBe(false);
    expect(shouldRecordPageView('stage-abc', null)).toBe(false);
    expect(shouldRecordPageView('stage-abc', '')).toBe(false);
  });
});
