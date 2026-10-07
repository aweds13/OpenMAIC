/**
 * 滚轮到底会不会翻页 —— 在**真的 CanvasArea** 上验一遍。
 *
 * ── 为什么不能只测纯函数 ────────────────────────────────────────────
 *
 * `canTurnPageOnWheel` / `innerScrollConsumesWheel` 各自都对，接线接错了照样白干：
 * 组件忘了读 `settings.wheelPageTurn`，用户把开关关掉之后滚轮**继续翻页**，
 * 而且没有任何报错 —— 这正是 `AGENTS.md` §12 记下的那类"漏传一个布尔量"的坑。
 * 所以这里把 CanvasArea 挂起来，按 DOM 派发真的 `wheel` 事件，断言翻没翻。
 *
 * 重的东西（场景渲染器 / 白板 / 场景上下文）都换成空壳：这条链路上只有
 * "滚轮 → 翻页"这一段是要验的，别的都是噪声。
 */
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { CanvasArea } from '@/components/canvas/canvas-area';
import type { Scene } from '@/lib/types/stage';

// Zustand 的 mock 要在 import 之前就位 —— `vi.hoisted` 保证工厂里拿得到它。
const { settingsState } = vi.hoisted(() => ({
  settingsState: {
    wheelPageTurn: true,
    setWheelPageTurn: vi.fn(),
  },
}));

vi.mock('@/lib/store', () => ({
  // Both are read by CanvasArea / CanvasToolbar; only the selector form is used.
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
  useStageStore: (selector: (s: { stage: null }) => unknown) => selector({ stage: null }),
}));
vi.mock('@/components/stage/scene-renderer', async () => {
  // An async factory so this does not have to reach for a hoisted import.
  const { createElement } = await import('react');
  // One plain div: the cases below turn it into a scroll container by hand.
  return {
    SceneRenderer: () => createElement('div', { 'data-testid': 'mock-scene' }),
  };
});
vi.mock('@/components/whiteboard', () => ({ Whiteboard: () => null }));
vi.mock('@/lib/contexts/scene-context', () => ({
  SceneProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/scene-renderers/classroom-complete', () => ({
  ClassroomCompletePageConnected: () => null,
}));
vi.mock('@/components/edit/ContainBox', () => ({
  ContainBox: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/workbench/panel-context', () => ({ useInWorkbenchPanel: () => false }));
vi.mock('@/components/canvas/slide-element-pick-overlay', () => ({
  SlideElementPickOverlay: () => null,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

/** A reading page: no actions at all — see lib/playback/engine.ts. */
const readingScene = {
  id: 'scene-1',
  type: 'slide',
  title: '要读的一页',
  actions: [],
  content: { type: 'slide', elements: [] },
} as unknown as Scene;

describe('CanvasArea wheel page-turn', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onNextSlide: Mock<() => void>;
  let onPrevSlide: Mock<() => void>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    settingsState.wheelPageTurn = true;
    settingsState.setWheelPageTurn = vi.fn();
    onNextSlide = vi.fn<() => void>();
    onPrevSlide = vi.fn<() => void>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderCanvasArea() {
    await act(async () =>
      root.render(
        createElement(CanvasArea, {
          currentScene: readingScene,
          currentSceneIndex: 0,
          scenesCount: 3,
          mode: 'playback',
          engineState: 'paused',
          whiteboardOpen: false,
          onPrevSlide,
          onNextSlide,
          onPlayPause: vi.fn(),
          onWhiteboardClose: vi.fn(),
        }),
      ),
    );
  }

  /** The stage root — CanvasArea's own div is where `onWheel` lives. */
  const stageRoot = () => container.firstElementChild as HTMLElement;

  async function wheel(deltaY: number) {
    await act(async () => {
      stageRoot().dispatchEvent(
        new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }),
      );
    });
  }

  /** Wheel on a specific element inside the stage. */
  async function wheelOn(el: Element, deltaY: number) {
    await act(async () => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    });
  }

  /**
   * Turn the (otherwise empty) mocked scene into a scroll container.
   *
   * jsdom 不做布局 ⇒ scrollHeight/clientHeight 恒为 0，所以几何要显式摆出来。
   * 这正是用户说的那个场景：**课件自己**是 `overflow-y-auto`（长测验页 / PBL
   * 面板就是），滚轮归它。
   */
  function makeSceneScroller(geometry: {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  }) {
    const el = stageRoot().querySelector('[data-testid="mock-scene"]') as HTMLElement;
    el.style.overflowY = 'auto';
    Object.defineProperty(el, 'scrollTop', {
      value: geometry.scrollTop,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(el, 'clientHeight', { value: geometry.clientHeight, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
    return el;
  }

  it('turns the page on a reading page by default', async () => {
    await renderCanvasArea();
    await wheel(100);
    expect(onNextSlide).toHaveBeenCalledTimes(1);

    // …and upward goes back one page.
    await wheel(-100); // inside the 450ms latch — swallowed on purpose
    expect(onPrevSlide).not.toHaveBeenCalled();
  });

  it('does nothing at all once the learner switched it off', async () => {
    settingsState.wheelPageTurn = false;
    await renderCanvasArea();

    await wheel(100);
    await wheel(-100);
    await wheel(100);

    // 用户的原话：「可以自己自由在看课时关掉」。关掉就是**一次都不翻** ——
    // 这一页从此只认按钮和方向键。
    expect(onNextSlide).not.toHaveBeenCalled();
    expect(onPrevSlide).not.toHaveBeenCalled();
  });

  it('hands the gesture to courseware that can still scroll itself', async () => {
    await renderCanvasArea();
    const quiz = makeSceneScroller({ scrollTop: 0, clientHeight: 600, scrollHeight: 1000 });

    // 400px of content left below ⇒ this scroll belongs to the quiz page, not
    // to the page-turn. 用户的原话：「有时课件内部也要上下滑动，有冲突」。
    await wheelOn(quiz, 100);
    expect(onNextSlide).not.toHaveBeenCalled();

    // Scrolled to the end: now the same gesture turns the page (scroll chaining).
    Object.defineProperty(quiz, 'scrollTop', { value: 400, writable: true, configurable: true });
    await wheelOn(quiz, 100);
    expect(onNextSlide).toHaveBeenCalledTimes(1);
  });

  it('shows the switch on a reading page, and writes the setting when clicked', async () => {
    await renderCanvasArea();

    const toggle = stageRoot().querySelector('button[aria-label="stage.wheelPageTurn"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });

    // The store owns the value; CanvasArea only flips it.
    expect(settingsState.setWheelPageTurn).toHaveBeenCalledWith(false);
  });
});
