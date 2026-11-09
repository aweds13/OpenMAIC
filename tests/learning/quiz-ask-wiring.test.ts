import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「问 AI」这条线穿过的四层，靠读源码验它没断。
 *
 * 为什么不渲染：仓里没有 `@testing-library/react`（`tests/**\/*.test.ts` 是
 * 唯一的测试入口，环境是 node）。而这条线上真正会坏的形态是**接线断了**：
 * Provider 没包住画布、题卡不再读 context、按钮在 `null` 上也渲染。
 * 这三件都能从源码读出来，渲染反而验不到「没人在上面提供把手时按钮
 * 该消失」——那需要一个真的播放态。
 */
const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('问 AI 的接线', () => {
  it('★ 播放态把把手包在画布外面 —— 白板与侧栏不在里层', () => {
    const source = read('components/edit/PlaybackChromeRoot.tsx');
    const open = source.indexOf('<QuizAskProvider value={quizAsk}>');
    const canvas = source.indexOf('<CanvasArea', open);
    const close = source.indexOf('</QuizAskProvider>', open);

    expect(open).toBeGreaterThan(-1);
    expect(canvas).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(canvas);
  });

  it('★ 中间三层零改动 —— 画布与场景渲染器都不认识「提问」', () => {
    for (const file of [
      'components/canvas/canvas-area.tsx',
      'components/stage/scene-renderer.tsx',
    ]) {
      expect(read(file)).not.toContain('QuizAsk');
    }
  });

  it('★ 题卡从 context 取把手，取不到就不渲染按钮', () => {
    const source = read('components/scene-renderers/quiz-view.tsx');
    expect(source).toContain('useQuizAsk');
    // 三个按钮全部挂在 `ask !== null` 的判断里。
    expect(source).toContain('{ask !== null && (');
    // 两种问法各有一个按钮，各自带 data-testid。
    expect(source).toContain('data-testid="quiz-ask-instrumental"');
    expect(source).toContain('data-testid="quiz-ask-executive"');
  });

  it('★ 两个按钮记两个不同的分型 —— 不许都记成一个', () => {
    const source = read('components/scene-renderers/quiz-view.tsx');
    expect(source).toContain("void handleAsk('instrumental')");
    expect(source).toContain("void handleAsk('executive')");
  });

  it('★ 发出去之前先把侧栏展开 —— 回答落在一个折叠面板里等于没问成', () => {
    const source = read('components/edit/PlaybackChromeRoot.tsx');
    const at = source.indexOf('send: (content) => {');
    expect(at).toBeGreaterThan(-1);
    // 取一个足够宽的窗口，不靠换行符定位 —— 缩进改一次就会失效。
    const send = source.slice(at, at + 600);
    expect(send).toContain('setChatAreaCollapsed(false)');
    // 展开必须在发送之前，不能发完再补。
    expect(send.indexOf('setChatAreaCollapsed(false)')).toBeLessThan(
      send.indexOf('sendMessageWithElementReference('),
    );
  });

  it('★ 提问带着题号出去 —— 只记到页就再也对不上「他在哪道题上卡住」', () => {
    const source = read('components/edit/PlaybackChromeRoot.tsx');
    const at = source.indexOf('send: (content) => {');
    const send = source.slice(at, at + 600);

    // 第三个参数就是子锚点。少了它，对话会话只有页面锚点，
    // AI 日志事后只能按页归并 —— 八道题的问话混成一堆。
    expect(send).toMatch(/sendMessageWithElementReference\(content, undefined, target\.questionId/);
  });

  it('★ 闸挡住的话与真失败的话不是同一条 locale 键', () => {
    const source = read('components/scene-renderers/quiz-view.tsx');
    expect(source).toContain("t('quiz.ask.refused')");
    expect(source).toContain("t('quiz.ask.failed')");

    const zh = JSON.parse(read('lib/i18n/locales/zh-CN.json')) as {
      quiz: { ask: Record<string, string> };
    };
    expect(zh.quiz.ask.refused).not.toBe(zh.quiz.ask.failed);
    expect(zh.quiz.ask.refused).toContain('先');
  });
});
