/**
 * A page with nothing to play is a page to READ — not a 2-second slide.
 *
 * ── 实测出来的问题 ──────────────────────────────────────────────────
 *
 * 自学模式下每页 `actions: []`。`resolvePlaybackCursor` 会给这种页合成一个
 * `EMPTY_SCENE_DWELL`（空文本 speech），而空 speech 走朗读计时器：
 *
 *   estimateSpeechDurationMs('') = max(MIN_READING_MS = 2000, 0 × 240) = 2000ms
 *
 * 两秒后引擎把这一页走完 → `onComplete`。而 `PlaybackChromeRoot` 的 onComplete
 * 在「自动播放」打开时会 `setCurrentSceneId(下一页)` —— 于是整门课以
 * **每页 2 秒**播过去。自学页正文 350–400 字 ≈ 1–2 分钟阅读量，**差了 30–60 倍**。
 *
 * 那个 dwell 的本意是「别把空页跳过」（跳过它就从播放里消失了），
 * **它从来没有说"该看多久"**。
 *
 * ── 为什么测试用「单个场景」的引擎 ──────────────────────────────────
 *
 * 生产里 `PlaybackChromeRoot` 建引擎时传的是 `[currentScene]` —— **一个场景**。
 * 跨页前进靠 onComplete → setCurrentSceneId → 重建引擎，不是靠引擎自己跨场景。
 * 所以这里也只用单个场景测，否则测的是生产里不存在的形状。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene 1',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
}

function speech(id: string, text: string): Action {
  return { id, type: 'speech', text } as unknown as Action;
}

function createActionEngine(): ActionEngine {
  return {
    execute: vi.fn(async () => {}),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
  } as unknown as ActionEngine;
}

/** Never starts audio, so every speech takes the reading-timer path. */
function createAudioPlayer(): AudioPlayer {
  return {
    play: vi.fn(async () => false),
    onEnded: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: vi.fn(() => false),
    hasActiveAudio: vi.fn(() => false),
  } as unknown as AudioPlayer;
}

describe('a scene with no actions is a reading page, not a 2-second beat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parks on it instead of completing after the 2s reading floor', async () => {
    const onComplete = vi.fn();
    const onSpeechStart = vi.fn();
    const engine = new PlaybackEngine([scene([])], createActionEngine(), createAudioPlayer(), {
      onComplete,
      onSpeechStart,
    });

    engine.start();
    await vi.advanceTimersByTimeAsync(0);

    // Parked, not playing — and nothing is "spoken", because there is no narration.
    expect(engine.getMode()).toBe('paused');
    expect(onSpeechStart).not.toHaveBeenCalled();

    // The old behaviour: 2s later the dwell expired and the page was reported
    // complete — which, with 自动播放 on, advanced the whole course at 2s/page.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onComplete).not.toHaveBeenCalled();
    expect(engine.getMode()).toBe('paused');
  });

  it('treats "play" on a parked page as "this page is done, go on"', async () => {
    const onComplete = vi.fn();
    const engine = new PlaybackEngine([scene([])], createActionEngine(), createAudioPlayer(), {
      onComplete,
    });

    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.getMode()).toBe('paused');
    expect(onComplete).not.toHaveBeenCalled();

    // Nothing to resume, so resume() finishes the page — which is what the
    // chrome turns into "advance to the next page".
    engine.resume();
    await vi.advanceTimersByTimeAsync(0);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(engine.getMode()).toBe('idle');
  });

  it('leaves a scene that HAS narration on the normal timed path', async () => {
    const onComplete = vi.fn();
    const onSpeechStart = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speech('s1', '这是一段真的讲稿。')])],
      createActionEngine(),
      createAudioPlayer(),
      { onComplete, onSpeechStart },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(0);

    // A narrated scene still plays: it stays in 'playing' and speaks.
    expect(onSpeechStart).toHaveBeenCalledWith('这是一段真的讲稿。');
    expect(engine.getMode()).toBe('playing');
    expect(onComplete).not.toHaveBeenCalled();

    // 10 CJK chars × 150ms = 1500ms, floored at 2000ms → completes after ~2s.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps a blank speech clip the user actually has on the timed path', async () => {
    // A blank clip that the user cleared by hand has a normal (non-sentinel) id,
    // so it is still a real beat with a real duration — only the synthetic
    // action-less dwell parks.
    const onComplete = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speech('user-cleared-clip', '')])],
      createActionEngine(),
      createAudioPlayer(),
      { onComplete },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.getMode()).toBe('playing');

    await vi.advanceTimersByTimeAsync(2_500);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
