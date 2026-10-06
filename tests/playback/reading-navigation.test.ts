/**
 * 阅读页的滚轮翻页判据。
 *
 * 这是整条"滚轮翻页"里唯一会**悄悄错**的地方：少了去抖，一次轻甩翻好几页；
 * 阈值太低，触控板的惯性滚动会把整门课一次性翻过去。所以把它抽成纯函数钉住，
 * 而不是留在组件里靠手感验。
 */
import { describe, expect, it } from 'vitest';

import {
  resolveWheelTurn,
  WHEEL_TURN_COOLDOWN_MS,
  WHEEL_TURN_MIN_DELTA,
} from '@/lib/playback/reading-navigation';

describe('resolveWheelTurn', () => {
  it('scrolls down to the next page and up to the previous one', () => {
    expect(resolveWheelTurn(100, 0, 10_000)).toBe('next');
    expect(resolveWheelTurn(-100, 0, 10_000)).toBe('prev');
  });

  it('ignores the tiny deltas a trackpad emits continuously', () => {
    // Just under the threshold — noise, not intent.
    expect(resolveWheelTurn(WHEEL_TURN_MIN_DELTA - 1, 0, 10_000)).toBeNull();
    expect(resolveWheelTurn(-(WHEEL_TURN_MIN_DELTA - 1), 0, 10_000)).toBeNull();
    // At the threshold it counts.
    expect(resolveWheelTurn(WHEEL_TURN_MIN_DELTA, 0, 10_000)).toBe('next');
  });

  it('accepts only ONE turn per gesture, however many events arrive', () => {
    // A single flick is a burst of events. Every event after the first within
    // the cooldown must be swallowed — that is the difference between turning
    // one page and turning fifteen.
    const first = resolveWheelTurn(40, 0, 10_000);
    expect(first).toBe('next');

    expect(resolveWheelTurn(40, 10_000, 10_000 + 50)).toBeNull();
    expect(resolveWheelTurn(40, 10_000, 10_000 + WHEEL_TURN_COOLDOWN_MS - 1)).toBeNull();
    // …and it comes back once the gesture is over.
    expect(resolveWheelTurn(40, 10_000, 10_000 + WHEEL_TURN_COOLDOWN_MS)).toBe('next');
  });

  it('does not swallow the opposite direction for a whole cooldown', () => {
    // Scrolling back up mid-cooldown is still one gesture by the latch — this
    // documents the deliberate choice (a latch is simpler and never double-fires)
    // rather than leaving it to be discovered as a "bug" later.
    expect(resolveWheelTurn(-40, 10_000, 10_000 + 100)).toBeNull();
  });
});
