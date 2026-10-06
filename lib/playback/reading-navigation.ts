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
 */

/** Below this |deltaY| the event is trackpad noise, not an intentional turn. */
export const WHEEL_TURN_MIN_DELTA = 12;

/**
 * One turn per gesture. Trackpads emit a continuous stream of wheel events for a
 * single flick; without a latch a flick of ~600px at ~40px/event would turn the
 * page fifteen times.
 */
export const WHEEL_TURN_COOLDOWN_MS = 450;

export type ReadingTurn = 'next' | 'prev';

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
