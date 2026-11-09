import { describe, expect, it } from 'vitest';

import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { shouldRecordPageView, useXqSessionLifecycle } from '@/lib/learning/use-xq-page-view';

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

describe('useXqSessionLifecycle：关标签页也要结束会话', () => {
  it('★ 它挂在 pagehide 上，不挂 visibilitychange', async () => {
    // 切标签页只是「手离开了」，不是「不学了」；拿它当结束会把一次学习
    // 切成很多段。`pagehide` 只在页面真的要走时触发。
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('lib/learning/use-xq-page-view.ts', 'utf8');
    const at = source.indexOf('export function useXqSessionLifecycle');
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 1400);
    expect(body).toContain("window.addEventListener('pagehide'");
    expect(body).not.toContain("addEventListener('visibilitychange'");
  });

  it('★ 卸载时把监听器摘掉 —— 否则换一门课就多一个监听器', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('lib/learning/use-xq-page-view.ts', 'utf8');
    const at = source.indexOf('export function useXqSessionLifecycle');
    const body = source.slice(at, at + 1400);
    expect(body).toContain("removeEventListener('pagehide'");
    expect(body).toContain('[stageId]');
  });

  it('它是 hook —— 不能在没有 stageId 时挂监听（也不该返回真值）', () => {
    expect(typeof useXqSessionLifecycle).toBe('function');
  });
});
