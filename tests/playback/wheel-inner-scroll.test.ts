/**
 * 页内还有东西可滚的时候，滚轮**不能**翻页。
 *
 * ── 为什么 ──────────────────────────────────────────────────────────
 *
 * 用户的原话：「滚轮功能可以自己自由在看课时关掉才行，因为有时课件内部也要
 * 上下滑动的，有冲突」。冲突是**真的**：`quiz-renderer.tsx` 的根就是
 * `overflow-y-auto`，`pbl/v2/*` 与 `CodeElement` 也各自有可滚容器。滚轮在翻页
 * 的同时把它们一起滚了 —— 长测验页读到一半就跳走了。
 *
 * 开关（`settings.wheelPageTurn`）解决"我不想要这个手势"；这个判据解决
 * "这一滚本来就该归页内"。两条都要，因为关掉开关后页内的滚动**必须还能用**，
 * 而开着开关时页内滚动也不该被抢走。
 *
 * ── 为什么必须是 jsdom ──────────────────────────────────────────────
 *
 * 判据是"往上走 DOM 树找一个还能滚的祖先"，只有在真的 DOM 上才验得出来。
 * jsdom 不做布局 ⇒ `scrollHeight/clientHeight/scrollTop` 恒为 0，所以这里用
 * `Object.defineProperty` 明确摆出几何 —— 这正好也让每个用例在说
 * "此时这个容器是什么状态"，而不是靠一个真浏览器里的像素。
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { innerScrollConsumesWheel, SCROLL_EDGE_SLACK_PX } from '@/lib/playback/reading-navigation';

/** A container with explicit scroll geometry (jsdom has no layout). */
function scroller(
  overflowY: string,
  geometry: { scrollTop: number; clientHeight: number; scrollHeight: number },
): HTMLDivElement {
  const el = document.createElement('div');
  el.style.overflowY = overflowY;
  Object.defineProperty(el, 'scrollTop', {
    value: geometry.scrollTop,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(el, 'clientHeight', { value: geometry.clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
  return el;
}

/** stage root (boundary) > outer > [inner scroller] > leaf(wheel target) */
function stageWith(inner: HTMLElement | null) {
  const boundary = document.createElement('div');
  const outer = document.createElement('div');
  const leaf = document.createElement('span');
  boundary.appendChild(outer);
  if (inner) {
    outer.appendChild(inner);
    inner.appendChild(leaf);
  } else {
    outer.appendChild(leaf);
  }
  return { boundary, leaf };
}

describe('innerScrollConsumesWheel', () => {
  it('lets a long quiz keep the wheel while it can still scroll', () => {
    // 1000px of content in a 600px box, at the top: 400px left to scroll.
    const quiz = scroller('auto', { scrollTop: 0, clientHeight: 600, scrollHeight: 1000 });
    const { boundary, leaf } = stageWith(quiz);

    // The wheel lands on a <span> deep inside the quiz, not on the container —
    // hence the walk up the tree.
    expect(innerScrollConsumesWheel(leaf, 100, boundary)).toBe(true);
    // …and upward, once it has scrolled away from the top.
    Object.defineProperty(quiz, 'scrollTop', { value: 120, writable: true, configurable: true });
    expect(innerScrollConsumesWheel(leaf, -100, boundary)).toBe(true);
  });

  it('gives the gesture back at the end of the content, so the page still turns', () => {
    const atBottom = scroller('auto', { scrollTop: 400, clientHeight: 600, scrollHeight: 1000 });
    const { boundary, leaf } = stageWith(atBottom);
    // Scrolling further down: nothing left inside ⇒ the turn is allowed.
    expect(innerScrollConsumesWheel(leaf, 100, boundary)).toBe(false);

    const atTop = scroller('auto', { scrollTop: 0, clientHeight: 600, scrollHeight: 1000 });
    const second = stageWith(atTop);
    // Scrolling further up at the top: likewise.
    expect(innerScrollConsumesWheel(second.leaf, -100, second.boundary)).toBe(false);
  });

  it('ignores short content and non-scrolling containers', () => {
    // A scroll container whose content fits: nothing to move, so it must not
    // swallow the gesture — otherwise the page would be a dead end.
    const fits = scroller('auto', { scrollTop: 0, clientHeight: 600, scrollHeight: 600 });
    const a = stageWith(fits);
    expect(innerScrollConsumesWheel(a.leaf, 100, a.boundary)).toBe(false);

    // `hidden`/`visible` clip or overflow without scrolling — never the wheel's owner.
    for (const overflowY of ['hidden', 'visible', 'clip']) {
      const box = scroller(overflowY, { scrollTop: 0, clientHeight: 600, scrollHeight: 5000 });
      const b = stageWith(box);
      expect(innerScrollConsumesWheel(b.leaf, 100, b.boundary), overflowY).toBe(false);
    }
  });

  it('does not look at anything outside the stage (the boundary is exclusive)', () => {
    // An outer page/panel scroller above the stage must not be mistaken for
    // "the courseware scrolls itself" — that would disable wheel paging for good.
    const panel = scroller('auto', { scrollTop: 0, clientHeight: 400, scrollHeight: 4000 });
    const boundary = document.createElement('div');
    const leaf = document.createElement('span');
    panel.appendChild(boundary);
    boundary.appendChild(leaf);

    expect(innerScrollConsumesWheel(leaf, 100, boundary)).toBe(false);
  });

  it('treats a sub-pixel remainder as the end (slack, not a stuck gesture)', () => {
    const nearlyDone = scroller('auto', {
      scrollTop: 400 - SCROLL_EDGE_SLACK_PX,
      clientHeight: 600,
      scrollHeight: 1000,
    });
    const { boundary, leaf } = stageWith(nearlyDone);
    expect(innerScrollConsumesWheel(leaf, 100, boundary)).toBe(false);
  });

  it('is safe when the target is not an element', () => {
    const { boundary } = stageWith(null);
    expect(innerScrollConsumesWheel(null, 100, boundary)).toBe(false);
    expect(innerScrollConsumesWheel(document, 100, boundary)).toBe(false);
  });
});
