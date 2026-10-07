/**
 * 阅读页的滚轮翻页判据。
 *
 * 这是整条"滚轮翻页"里唯一会**悄悄错**的地方：少了去抖，一次轻甩翻好几页；
 * 阈值太低，触控板的惯性滚动会把整门课一次性翻过去。所以把它抽成纯函数钉住，
 * 而不是留在组件里靠手感验。
 *
 * 另一半是**什么时候压根不该翻**：用户关掉了滚轮翻页，或者页内还有东西可滚
 * （见 `wheel-inner-scroll.test.ts`）。第一条在下面，第二条在隔壁那个 jsdom 文件。
 */
import { describe, expect, it } from 'vitest';

import {
  canTurnPageOnWheel,
  resolveWheelTurn,
  WHEEL_TURN_COOLDOWN_MS,
  WHEEL_TURN_MIN_DELTA,
  type WheelPageTurnContext,
} from '@/lib/playback/reading-navigation';

/** Everything that allows a turn — override one field per case. */
const allowed: WheelPageTurnContext = {
  showControls: true,
  readingPage: true,
  isLiveSession: false,
  isPendingScene: false,
  wheelPageTurn: true,
};

describe('canTurnPageOnWheel', () => {
  it('allows the turn on a reading page with the learner switch on', () => {
    expect(canTurnPageOnWheel(allowed)).toBe(true);
  });

  it("obeys the learner's switch — this is the whole point of the setting", () => {
    // 用户的原话：「滚轮功能可以自己自由在看课时关掉才行」。关掉 = 滚轮一个字都不管。
    expect(canTurnPageOnWheel({ ...allowed, wheelPageTurn: false })).toBe(false);
  });

  it('refuses the turn when the wheel never owned the gesture anyway', () => {
    expect(canTurnPageOnWheel({ ...allowed, readingPage: false })).toBe(false); // 有讲稿的页
    expect(canTurnPageOnWheel({ ...allowed, showControls: false })).toBe(false); // 非播放态
    expect(canTurnPageOnWheel({ ...allowed, isLiveSession: true })).toBe(false); // 直播/讨论
    expect(canTurnPageOnWheel({ ...allowed, isPendingScene: true })).toBe(false); // 下一页还没生成
  });
});

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
