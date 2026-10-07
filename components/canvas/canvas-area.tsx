'use client';

import { useCallback, useRef, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SceneRenderer } from '@/components/stage/scene-renderer';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { Whiteboard } from '@/components/whiteboard';
import { CanvasToolbar } from '@/components/canvas/canvas-toolbar';
import type { CanvasToolbarProps } from '@/components/canvas/canvas-toolbar';
import type { Scene, StageMode } from '@/lib/types/stage';
import {
  canTurnPageOnWheel,
  innerScrollConsumesWheel,
  resolveWheelTurn,
} from '@/lib/playback/reading-navigation';
import { useSettingsStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ClassroomCompletePageConnected } from '@/components/scene-renderers/classroom-complete';
import { ContainBox } from '@/components/edit/ContainBox';
import { useInWorkbenchPanel } from '@/lib/workbench/panel-context';
import type { PPTElement } from '@openmaic/dsl';
import type { WhiteboardElementReference } from '@/lib/types/chat';
import { SlideElementPickOverlay } from '@/components/canvas/slide-element-pick-overlay';

/**
 * CanvasArea takes everything the toolbar takes EXCEPT `readingPage` — it is the
 * component that DERIVES that flag (from `currentScene.actions`), so requiring it
 * as an input would be a lie and would force every caller to duplicate the rule.
 *
 * `wheelPageTurn` / `onToggleWheelPageTurn` are omitted for the same reason: the
 * wheel handler lives in THIS component, so the switch it consults has to be
 * owned here too. Letting a caller pass them in would mean two places to wire and
 * one of them certain to drift.
 */
interface CanvasAreaProps extends Omit<
  CanvasToolbarProps,
  'readingPage' | 'wheelPageTurn' | 'onToggleWheelPageTurn'
> {
  readonly currentScene: Scene | null;
  readonly mode: StageMode;
  readonly hideToolbar?: boolean;
  readonly isPendingScene?: boolean;
  readonly isCourseComplete?: boolean;
  readonly isGenerationFailed?: boolean;
  readonly onRetryGeneration?: () => void;
  readonly elementPickActive?: boolean;
  readonly whiteboardElementReference?: WhiteboardElementReference;
  readonly onPickWhiteboardElement?: (element: PPTElement) => void;
  readonly onPickElement?: (element: PPTElement) => void;
  readonly onCancelElementPick?: () => void;
}

export function CanvasArea({
  currentScene,
  currentSceneIndex,
  scenesCount,
  mode,
  engineState,
  isLiveSession,
  isSoftClosing,
  softCloseDeadline,
  whiteboardOpen,
  sidebarCollapsed,
  chatCollapsed,
  onToggleSidebar,
  onToggleChat,
  onPrevSlide,
  onNextSlide,
  onPlayPause,
  onWhiteboardClose,
  isPresenting,
  onTogglePresentation,
  showStopDiscussion,
  onStopDiscussion,
  onContinueDiscussion,
  hideToolbar,
  isPendingScene,
  isCourseComplete,
  isGenerationFailed,
  onRetryGeneration,
  elementPickActive,
  whiteboardElementReference,
  onPickElement,
  onPickWhiteboardElement,
  onCancelElementPick,
}: CanvasAreaProps) {
  const { t } = useI18n();
  const inWorkbenchPanel = useInWorkbenchPanel();
  /**
   * 滚轮翻页是**用户自己的开关**（持久化在 settings 里）。
   *
   * 阅读页上滚轮翻页是最顺的手势，但课件**自己也会滚** —— 长测验页
   * （`quiz-renderer.tsx` 的 `overflow-y-auto`）、PBL 面板、代码块都要上下滑。
   * 用户的原话是「滚轮功能可以自己自由在看课时关掉才行，因为有时课件内部也要
   * 上下滑动，有冲突」。所以：开关关掉 ⇒ 滚轮一个字都不管，翻页回到按钮/方向键。
   */
  const wheelPageTurn = useSettingsStore((s) => s.wheelPageTurn);
  const setWheelPageTurn = useSettingsStore((s) => s.setWheelPageTurn);
  const showControls = mode === 'playback' && !whiteboardOpen;
  /**
   * A scene with no actions is a page to READ, not a lecture to play.
   *
   * 自学模式（现在的默认）下每页 `actions: []`。此时既没有讲稿可放，也没有
   * 别的可播 —— 播放器在这页上会**停住等人**（见 lib/playback/engine.ts）。
   * 那就别再摆播放器的样子：不显示中间那个大播放键，点页面也不触发播放。
   * 「播放」在这里唯一的意思只能是"这一页看完了，往下走"，把它当按钮摆着
   * 只会让人以为自己在看视频 —— 用户的原话就是「就像放视频，我不需要这种东西」。
   */
  const readingPage = (currentScene?.actions?.length ?? 0) === 0;
  /**
   * Turning the page on a reading page: click the page, or scroll the wheel.
   *
   * A reading page is a fixed 1000×562.5 canvas — there is nothing to scroll
   * inside it, and no narration competing for the gesture — so the two most
   * natural "next" gestures are free here and nowhere else. One gesture must
   * equal one page: the wheel is debounced, otherwise a single flick skips
   * several pages at once.
   *
   * 但那条前提有例外（见 `wheelPageTurn`），所以滚轮这条手势有两个闸：
   * 用户的开关，以及"这一滚是不是被页内某个可滚容器吃掉了"。
   */
  const wheelLatchRef = useRef(0);
  const canTurnPage = canTurnPageOnWheel({
    showControls,
    readingPage,
    isLiveSession: !!isLiveSession,
    isPendingScene: !!isPendingScene,
    wheelPageTurn,
  });
  const handleReadingWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!canTurnPage) return;
      // 页内还有东西可滚（长测验页、PBL 面板、代码块）⇒ 这一滚归它，
      // 既不翻页也不阻止默认行为，让它原生滚。滚到头再滚才轮到翻页。
      if (innerScrollConsumesWheel(e.target, e.deltaY, e.currentTarget)) return;
      const turn = resolveWheelTurn(e.deltaY, wheelLatchRef.current, Date.now());
      if (!turn) return;
      wheelLatchRef.current = Date.now();
      e.preventDefault();
      e.stopPropagation();
      if (turn === 'next') onNextSlide();
      else onPrevSlide();
    },
    [canTurnPage, onNextSlide, onPrevSlide],
  );

  const showPlayHint =
    showControls &&
    !readingPage &&
    engineState !== 'playing' &&
    currentScene?.type === 'slide' &&
    !isLiveSession &&
    !isPendingScene;

  const handleSlideClick = useCallback(
    (e: React.MouseEvent) => {
      if (!showControls || isLiveSession || currentScene?.type !== 'slide') return;
      // A reading page has nothing to play — clicking it means "next page",
      // which is the only forward action that page has.
      if (readingPage) {
        onNextSlide();
        return;
      }
      // Don't trigger page play/pause when clicking inside a video element's visual area.
      // Video elements may be visually covered by other slide elements (e.g. text),
      // so we check click coordinates against all video element bounding rects.
      const container = e.currentTarget as HTMLElement;
      const videoEls = container.querySelectorAll('[data-video-element]');
      for (const el of videoEls) {
        const rect = el.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          return;
        }
      }
      onPlayPause();
    },
    [showControls, isLiveSession, onPlayPause, onNextSlide, currentScene?.type, readingPage],
  );

  return (
    <div
      className="w-full h-full flex flex-col bg-gray-50 dark:bg-gray-900 group/canvas"
      onWheel={handleReadingWheel}
    >
      {/* Slide area — takes remaining space */}
      <div
        className={cn(
          'flex-1 min-h-0 relative overflow-hidden flex items-center justify-center p-2 transition-colors duration-500',
          currentScene?.type === 'interactive'
            ? 'bg-blue-50/30 dark:bg-blue-900/10'
            : 'bg-gray-50/30 dark:bg-gray-900/30',
        )}
      >
        <StageViewport
          workbench={inWorkbenchPanel}
          interactive={currentScene?.type === 'interactive'}
          className={cn(
            'bg-white dark:bg-gray-800 shadow-2xl rounded-lg overflow-hidden relative transition-all duration-700',
            showControls && !isLiveSession && currentScene?.type === 'slide' && 'cursor-pointer',
            currentScene?.type === 'interactive'
              ? 'shadow-blue-200/50 dark:shadow-blue-900/50 ring-1 ring-blue-900/5 dark:ring-blue-500/10'
              : 'shadow-gray-200/50 dark:shadow-gray-800/50 ring-1 ring-gray-950/5 dark:ring-white/5',
          )}
          onClick={handleSlideClick}
        >
          {/* Whiteboard Layer */}
          <div className="absolute inset-0 z-[110] pointer-events-none">
            <SceneProvider>
              <Whiteboard
                isOpen={whiteboardOpen}
                onClose={onWhiteboardClose}
                elementPickActive={elementPickActive && whiteboardOpen}
                whiteboardElementReference={whiteboardElementReference}
                onPickElement={onPickWhiteboardElement}
                onCancelElementPick={onCancelElementPick}
              />
            </SceneProvider>
          </div>

          {/* Scene Content */}
          {currentScene && !whiteboardOpen && (
            <div className="absolute inset-0">
              <SceneProvider>
                <SceneRenderer scene={currentScene} mode={mode} />
              </SceneProvider>
            </div>
          )}

          {elementPickActive &&
            !whiteboardOpen &&
            onPickElement &&
            onCancelElementPick &&
            currentScene?.type === 'slide' &&
            currentScene.content.type === 'slide' && (
              <SlideElementPickOverlay
                scene={currentScene}
                onPick={onPickElement}
                onCancel={onCancelElementPick}
              />
            )}

          {/* Pending Scene Loading / Completion Overlay */}
          <AnimatePresence>
            {isPendingScene && !currentScene && isCourseComplete && (
              <motion.div
                key="course-complete"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="absolute inset-0"
              >
                <ClassroomCompletePageConnected />
              </motion.div>
            )}
            {isPendingScene && !currentScene && !isCourseComplete && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
                className="absolute inset-0 z-[105] flex flex-col items-center justify-center bg-white dark:bg-gray-800"
              >
                {isGenerationFailed ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
                      <svg
                        className="w-6 h-6 text-red-400 dark:text-red-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                        />
                      </svg>
                    </div>
                    <span className="text-sm text-red-500 dark:text-red-400 font-medium">
                      {t('stage.generationFailed')}
                    </span>
                    {onRetryGeneration && (
                      <button
                        onClick={onRetryGeneration}
                        className="mt-1 px-4 py-1.5 text-xs font-medium rounded-full bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95"
                      >
                        {t('generation.retryScene')}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-4">
                    {/* Spinner */}
                    <div className="relative w-12 h-12">
                      <div className="absolute inset-0 rounded-full border-2 border-gray-100 dark:border-gray-700" />
                      <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 dark:border-t-purple-400 animate-spin" />
                    </div>
                    {/* Text */}
                    <motion.span
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2, duration: 0.3 }}
                      className="text-sm text-gray-400 dark:text-gray-500 font-medium"
                    >
                      {t('stage.generatingNextPage')}
                    </motion.span>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Scene Number Badge */}
          {currentScene && (
            <div className="absolute top-4 right-4 text-gray-200 dark:text-gray-700 font-black text-4xl opacity-50 pointer-events-none select-none mix-blend-multiply dark:mix-blend-screen">
              {(currentSceneIndex + 1).toString().padStart(2, '0')}
            </div>
          )}

          {/* Play hint — breathing button when idle or paused (slides only) */}
          <AnimatePresence>
            {showPlayHint && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="absolute inset-0 z-[102] flex items-center justify-center pointer-events-none"
              >
                <motion.div
                  className="opacity-50 group-hover/canvas:opacity-100 transition-opacity duration-300 pointer-events-auto cursor-pointer"
                  exit={{ pointerEvents: 'none' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlayPause();
                  }}
                >
                  <motion.div
                    initial={{ scale: 0.85 }}
                    animate={{ scale: [1, 1.06] }}
                    exit={{ scale: 1.15, opacity: 0 }}
                    transition={{
                      default: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
                      scale: {
                        repeat: Infinity,
                        repeatType: 'mirror',
                        duration: 1,
                        ease: 'easeInOut',
                      },
                    }}
                    className="w-20 h-20 rounded-full bg-white/95 dark:bg-gray-800/95 flex items-center justify-center shadow-[0_4px_30px_rgba(147,51,234,0.15),inset_0_0_0_1px_rgba(233,213,255,0.5)] dark:shadow-[0_4px_30px_rgba(147,51,234,0.3),inset_0_0_0_1px_rgba(126,34,206,0.3)]"
                    style={{ willChange: 'transform' }}
                  >
                    <Play className="w-7 h-7 text-purple-600 dark:text-purple-400 fill-purple-600/90 dark:fill-purple-400/90 ml-0.5" />
                  </motion.div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </StageViewport>
      </div>

      {/* ── Canvas Toolbar — in document flow, only when not merged into roundtable ── */}
      {!hideToolbar && (
        <CanvasToolbar
          className={cn(
            'shrink-0 h-9 px-2',
            'bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl',
            'border-t border-gray-200/40 dark:border-gray-700/40',
          )}
          currentSceneIndex={currentSceneIndex}
          scenesCount={scenesCount}
          engineState={engineState}
          isLiveSession={isLiveSession}
          isSoftClosing={isSoftClosing}
          softCloseDeadline={softCloseDeadline}
          whiteboardOpen={whiteboardOpen}
          sidebarCollapsed={sidebarCollapsed}
          chatCollapsed={chatCollapsed}
          onToggleSidebar={onToggleSidebar}
          onToggleChat={onToggleChat}
          onPrevSlide={onPrevSlide}
          onNextSlide={onNextSlide}
          onPlayPause={onPlayPause}
          readingPage={readingPage}
          wheelPageTurn={wheelPageTurn}
          onToggleWheelPageTurn={() => setWheelPageTurn(!wheelPageTurn)}
          onWhiteboardClose={onWhiteboardClose}
          isPresenting={isPresenting}
          onTogglePresentation={onTogglePresentation}
          showStopDiscussion={showStopDiscussion}
          onStopDiscussion={onStopDiscussion}
          onContinueDiscussion={onContinueDiscussion}
        />
      )}
    </div>
  );
}

function StageViewport({
  workbench,
  interactive,
  className,
  onClick,
  children,
}: {
  readonly workbench: boolean;
  readonly interactive: boolean;
  readonly className?: string;
  readonly onClick?: (event: React.MouseEvent) => void;
  readonly children: ReactNode;
}) {
  if (interactive) {
    return (
      <div className={cn('h-full w-full', className)} onClick={onClick}>
        {children}
      </div>
    );
  }
  if (!workbench) {
    return (
      <div
        className={cn('aspect-[16/9] h-full max-h-full max-w-full', className)}
        onClick={onClick}
      >
        {children}
      </div>
    );
  }
  return (
    <ContainBox fit="contain" className={className}>
      <div className="relative h-full w-full" onClick={onClick}>
        {children}
      </div>
    </ContainBox>
  );
}
