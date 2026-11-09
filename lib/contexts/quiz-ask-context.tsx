'use client';

import { createContext, useContext } from 'react';
import type { XqHintSubtype, XqHintResult } from '@/lib/learning/xq-hint';

/**
 * 「这道题我不会，问一句」的把手。
 *
 * ## 为什么要一个 context，而不是往下传 prop
 *
 * 从播放态的 `PlaybackChromeRoot`（它持有 `chatAreaRef`）到
 * `CanvasArea → SceneRenderer → QuizView → QuestionCard`（它要放那个按钮）
 * 中间隔着四层，其中 `CanvasArea` 已经收了三十多个 prop。再加一个
 * 「发送消息的函数」进去，等于让每一个中间层都知道「页面上有个聊天框」——
 * 而它们确实不需要知道：滑动页、白板、PBL 都不该有这个概念。
 *
 * context 是**这条能力自己**穿过那四层的通道，中间层零改动。
 *
 * ## 为什么默认是 `null` 而不是一个空实现
 *
 * `null` 的语义是「这个场景里没有聊天框」——编辑态、预览态、
 * `lib/playback` 的单测里都是这样。此时按钮**不渲染**，而不是渲染一个
 * 点了没反应的按钮。用一个 `async () => {}` 的空实现会把「没有这个功能」
 * 伪装成「有，但不管用」。
 */

/** 一次提问要的坐标。题干由调用方（`QuestionCard`）自己带。 */
export interface QuizAskTarget {
  readonly questionId: string;
  readonly stem: string;
}

export interface QuizAskHandle {
  /**
   * 问一次。`subtype` 是 `instrumental`（问「怎么想」）或 `executive`
   * （问「直接给答案」），由界面上的两个按钮决定，不在这里猜。
   */
  readonly ask: (target: QuizAskTarget, subtype: XqHintSubtype) => Promise<XqHintResult>;
  /** 这句话的模板（含 `{{stem}}`），由持有 i18n 的那一层给。 */
  readonly template: string;
  /** 当前这门课 / 这一页。`QuizView` 自己有同样的 props，但对不上时以这里为准。 */
  readonly stageId: string;
  readonly sceneId: string;
}

const QuizAskContext = createContext<QuizAskHandle | null>(null);

export const QuizAskProvider = QuizAskContext.Provider;

/** 没人在上面提供把手时返回 `null` —— 调用方据此决定**不渲染**按钮。 */
export function useQuizAsk(): QuizAskHandle | null {
  return useContext(QuizAskContext);
}
