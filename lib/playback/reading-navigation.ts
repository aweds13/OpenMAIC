/**
 * Page-turning gestures for a **reading page** — a scene with no actions.
 *
 * ── 为什么单独一个纯函数 ────────────────────────────────────────────
 *
 * 滚轮的判据（方向、阈值、去抖）是这里唯一会**悄悄错**的部分：少了去抖，
 * 一次轻甩就翻好几页；阈值太低，触控板的惯性滚动会把整门课翻过去。
 * 放在 React 组件里就只能靠"感觉"验，抽出来就能钉住。
 *
 * 阅读页是固定的 1000×562.5 画布，页内没有可滚的东西，也没有讲稿在抢这个
 * 手势 —— 所以"滚轮=翻页"在这里是安全的，在别处不是。调用方负责这个前提。
 *
 * ★ 但"页内没有可滚的东西"这句话**不总成立**：长测验页（`quiz-renderer.tsx`
 * 的 `overflow-y-auto`）、PBL 面板、代码块内部都要上下滚。用户的原话是
 * 「有时课件内部也要上下滑动，有冲突」。所以这里多两条判据：
 *   · `canTurnPageOnWheel` —— 用户能把滚轮翻页**当场关掉**（并记住）；
 *   · `innerScrollConsumesWheel` —— 开着的时候，**内部还能滚就让它滚**，
 *     不去翻页（滚到头再继续滚，才轮到翻页）。
 */

/** Below this |deltaY| the event is trackpad noise, not an intentional turn. */
export const WHEEL_TURN_MIN_DELTA = 12;

/**
 * One turn per gesture. Trackpads emit a continuous stream of wheel events for a
 * single flick; without a latch a flick of ~600px at ~40px/event would turn the
 * page fifteen times.
 */
export const WHEEL_TURN_COOLDOWN_MS = 450;

/**
 * A scroll container within this many pixels of its end already counts as
 * "at the end" — sub-pixel leftovers otherwise trap the gesture forever.
 */
export const SCROLL_EDGE_SLACK_PX = 1;

export type ReadingTurn = 'next' | 'prev';

export interface WheelPageTurnContext {
  /** The player chrome is on screen at all (`mode === 'playback'`). */
  readonly showControls: boolean;
  /** The current scene has no actions — a page to read, not to play. */
  readonly readingPage: boolean;
  /** A live (streaming / discussion) session owns the stage. */
  readonly isLiveSession: boolean;
  /** The next scene is still generating; there is nothing to turn to. */
  readonly isPendingScene: boolean;
  /** The learner's persisted switch (`settings.wheelPageTurn`). */
  readonly wheelPageTurn: boolean;
}

/**
 * Is the wheel allowed to turn the page right now?
 *
 * Pure and exported so the rule has **one** home: the switch is the kind of
 * boolean that silently stops being consulted once it is inlined in a
 * component, and then "关掉滚轮翻页" quietly keeps turning pages.
 */
export function canTurnPageOnWheel(ctx: WheelPageTurnContext): boolean {
  return (
    ctx.showControls &&
    ctx.readingPage &&
    !ctx.isLiveSession &&
    !ctx.isPendingScene &&
    ctx.wheelPageTurn
  );
}

/**
 * Does an element inside the stage consume this wheel gesture itself?
 *
 * Walks up from the event target to `boundary` (the stage root, exclusive) and
 * answers "yes, something here can still scroll in this direction". The caller
 * then leaves the event alone: the inner scroll happens natively and **no page
 * turn is issued**.
 *
 * Why a walk and not just the target: the wheel usually lands on a `div` deep
 * inside a scroll container (a paragraph in a long quiz), not on the container.
 * Why "can still scroll" and not "is a scroll container": at the bottom of a
 * long quiz the page SHOULD turn — that is the scroll chaining a reader expects,
 * and it keeps a long quiz from becoming a dead end.
 */
export function innerScrollConsumesWheel(
  target: EventTarget | null,
  deltaY: number,
  boundary: Element | null,
): boolean {
  let node: Element | null = target instanceof Element ? target : null;
  while (node && node !== boundary) {
    if (canScrollInDirection(node, deltaY)) return true;
    node = node.parentElement;
  }
  return false;
}

function canScrollInDirection(el: Element, deltaY: number): boolean {
  const overflowY = el.ownerDocument?.defaultView?.getComputedStyle(el).overflowY ?? '';
  // `overlay` is the legacy mobile value; `visible`/`hidden`/`clip` never scroll.
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false;
  const { scrollTop, clientHeight, scrollHeight } = el as HTMLElement;
  // A scroll container with nothing to move must not swallow the gesture.
  if (scrollHeight - clientHeight <= SCROLL_EDGE_SLACK_PX) return false;
  return deltaY > 0
    ? scrollTop + clientHeight < scrollHeight - SCROLL_EDGE_SLACK_PX
    : scrollTop > SCROLL_EDGE_SLACK_PX;
}

/**
 * Decide what a wheel event means on a reading page.
 *
 * Pure: the caller owns `lastTurnAt` (a ref) and passes `now`, so this is
 * testable without timers or a DOM.
 *
 * @param deltaY        the event's vertical delta (positive = scroll down)
 * @param lastTurnAt    timestamp of the previous accepted turn (0 = never)
 * @param now           current timestamp
 * @returns the turn to perform, or null to ignore the event
 */
export function resolveWheelTurn(
  deltaY: number,
  lastTurnAt: number,
  now: number,
): ReadingTurn | null {
  if (Math.abs(deltaY) < WHEEL_TURN_MIN_DELTA) return null;
  if (now - lastTurnAt < WHEEL_TURN_COOLDOWN_MS) return null;
  return deltaY > 0 ? 'next' : 'prev';
}
