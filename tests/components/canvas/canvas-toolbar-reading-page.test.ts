/**
 * A reading page must not present the player's transport.
 *
 * ── 为什么 ──────────────────────────────────────────────────────────
 *
 * 自学模式下每页 `actions: []`：没有讲稿可放，播放器在这页上会**停住等人**
 * （见 `lib/playback/engine.ts`）。那就别再摆出播放器的样子 —— 中间那个大播放键、
 * 工具栏的播放/暂停、自动播放开关，在这样一页上全是**假的控件**：
 *
 *   · 播放/暂停：按下去唯一可能的意思是"这页看完了，往下走"；
 *   · 自动播放：它靠「本页完成」触发，而这一页永远不会自己完成 —— 摆着却不生效。
 *
 * 用户的原话是「就像放视频，但我不需要这种东西」。翻页键**必须留着** —— 那才是
 * 阅读该有的控制。
 *
 * ── 为什么这必须是一条渲染测试 ──────────────────────────────────────
 *
 * `readingPage` 是"传了才生效"的布尔量：漏传不会报错，只会**静默地把播放键还回来**，
 * 正好退回被修掉的那个 bug。所以这里真的把工具栏渲染出来，按 DOM 断言。
 * （仓库没有 @testing-library，用 react-dom/client 的 createRoot，跟
 *  tests/components/roundtable-reference-send.test.ts 同一套。）
 */
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { CanvasToolbar } from '@/components/canvas/canvas-toolbar';

// The toolbar reads its labels through useI18n; a bare key-echo is enough here
// and keeps this test about the transport controls only (same seam the
// roundtable render test uses).
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

describe('CanvasToolbar on a reading page', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onToggleWheel: Mock<() => void>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onToggleWheel = vi.fn<() => void>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderToolbar(readingPage: boolean, withAutoPlay = true, wheelPageTurn?: boolean) {
    await act(async () =>
      root.render(
        createElement(CanvasToolbar, {
          currentSceneIndex: 0,
          scenesCount: 3,
          engineState: 'paused',
          isLiveSession: false,
          whiteboardOpen: false,
          onWhiteboardClose: vi.fn(),
          readingPage,
          ...(withAutoPlay ? { autoPlayLecture: false, onToggleAutoPlay: vi.fn() } : {}),
          // `undefined` = the roundtable layout, which renders this same toolbar
          // but has no wheel handler on the stage.
          ...(wheelPageTurn === undefined
            ? {}
            : { wheelPageTurn, onToggleWheelPageTurn: onToggleWheel }),
          onPrevSlide: vi.fn(),
          onNextSlide: vi.fn(),
          onPlayPause: vi.fn(),
        }),
      ),
    );
  }

  const playPause = () =>
    container.querySelector('button[aria-label="Play"], button[aria-label="Pause"]');
  const autoPlay = () => container.querySelector('button[aria-label="Auto-play"]');
  const wheelToggle = () => container.querySelector('button[aria-label="stage.wheelPageTurn"]');
  const navButtons = () =>
    Array.from(container.querySelectorAll('button')).filter((b) => {
      const label = b.getAttribute('aria-label') ?? '';
      return /next|prev|previous/i.test(label);
    });

  it('offers play/pause on a normal narrated page', async () => {
    await renderToolbar(false);

    expect(playPause()).not.toBeNull();
    expect(autoPlay()).not.toBeNull();
  });

  it('withholds play/pause and auto-play on a reading page', async () => {
    await renderToolbar(true);

    expect(playPause()).toBeNull();
    expect(autoPlay()).toBeNull();
  });

  it('keeps navigation on a reading page — that is the point', async () => {
    await renderToolbar(true);

    // Whatever the page shows, it must not become un-navigable: the learner
    // moves through a reading course with prev/next, not with play.
    expect(navButtons().length).toBeGreaterThan(0);
  });

  /**
   * 滚轮翻页的开关（用户：「滚轮功能可以自己自由在看课时关掉才行」）。
   *
   * 这一条必须是**渲染**测试：开关是"传了才出现"的 —— 漏传不会报错，只会
   * 让用户**找不到关掉它的地方**，而那正是他要的东西。所以这里按 DOM 断言
   * 按钮在不在、按下去了没。
   */
  it('offers the wheel switch on a reading page, and reports it as on/off', async () => {
    await renderToolbar(true, true, true);
    expect(wheelToggle()).not.toBeNull();
    expect(wheelToggle()?.getAttribute('aria-pressed')).toBe('true');

    await renderToolbar(true, true, false);
    expect(wheelToggle()).not.toBeNull();
    expect(wheelToggle()?.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking the wheel switch calls back — the learner can turn it off', async () => {
    await renderToolbar(true, true, true);

    await act(async () => {
      (wheelToggle() as HTMLButtonElement).click();
    });

    expect(onToggleWheel).toHaveBeenCalledTimes(1);
  });

  it('withholds the wheel switch where the wheel turns nothing', async () => {
    // 有讲稿的页：滚轮从来就不翻页，摆一个开关等于摆一个假控件。
    await renderToolbar(false, true, true);
    expect(wheelToggle()).toBeNull();

    // roundtable 布局：它渲染同一个工具栏，但舞台上没有滚轮处理（不传回调）——
    // 那里摆开关同样是假的。
    await renderToolbar(true);
    expect(wheelToggle()).toBeNull();
  });
});
