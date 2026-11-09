'use client';

import { useEffect } from 'react';

import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { getXqEventClient } from '@/lib/learning/xq-event-client';

/**
 * 这一页现在该不该记成一次浏览。
 *
 * 判据全在这里，挂载点只负责「状态变了就调它」——
 * 不是为了好玩：`PENDING_SCENE_ID` 这种例外一旦散在组件里，
 * 任何一处漏写都会把「正在生成、页面还不存在」记成一次真的浏览。
 */
export function shouldRecordPageView(
  stageId: string | undefined,
  sceneId: string | null | undefined,
): sceneId is string {
  if (stageId === undefined || stageId === '') return false;
  if (sceneId === null || sceneId === undefined || sceneId === '') return false;
  // `__pending__` 是「正在生成下一课，先停在这里」的占位符，不是一页内容。
  if (sceneId === PENDING_SCENE_ID) return false;
  return true;
}

/**
 * 把「他翻到了哪一页」记成一条学习事实。
 *
 * ## 为什么挂在 `currentSceneId` 的副作用上，而不是各个点击处理器里
 *
 * 播放态翻页有五条入口（上一页 / 下一页 / 目录点页 / 键盘 / 自动切换），
 * 它们最后都只做一件事：`setCurrentSceneId`。在每条入口里各埋一次，等于把
 * 同一个判据抄五遍，还会漏掉今天没写、明天新加的那条。
 *
 * 副作用跟的是**结果**（当前页变了），不是**原因**（谁点的）。
 *
 * ## 为什么不去重
 *
 * 相邻重复由 `getXqEventClient().viewPage` 自己挡（StrictMode 双挂载、热更新
 * 重跑副作用都会让同一页被记两遍）。这里保持成一个纯粹的「看见就报」，
 * 判据只有一份。
 *
 * ## 为什么不在这里判「看多久算看过」
 *
 * 停留时长（`dwell_ms`）是诊断标签，不进任何判定式（DDL 注释原文）。这里只记
 * 「发生了浏览」这个事实；要不要算学时，是读的人的事。
 *
 * ## 为什么编辑态不会误记
 *
 * 这个 hook 只在 `PlaybackChromeRoot` 里调用 —— 组件树按 `mode` 分叉，
 * 编辑态根本不挂它。`setCurrentSceneId` 本身混着编辑态与播放态，所以埋点
 * 不能埋在那个 action 里。
 */
export function useXqPageView(
  stageId: string | undefined,
  sceneId: string | null | undefined,
): void {
  useEffect(() => {
    if (!shouldRecordPageView(stageId, sceneId)) return;
    void getXqEventClient().viewPage(stageId as string, sceneId);
  }, [stageId, sceneId]);
}

/**
 * 离开播放态时把这次会话关掉。
 *
 * 与 `useXqPageView` 分开：结束是**一次性的动作**（由 `teardown()` 显式调），
 * 不是一个随渲染变化的状态。挂在 effect cleanup 上会在 StrictMode 的双挂载
 * 与热更新里反复开关会话，把「今天学了 5 次」写成 15 次。
 */
export function endXqLearningSession(stageId: string | undefined): void {
  if (stageId === undefined || stageId === '') return;
  void getXqEventClient().endSession(stageId, 'terminated');
}
