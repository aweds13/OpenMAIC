import { describe, expect, it } from 'vitest';
import {
  HINT_STEM_MAX_CHARS,
  HINT_STEM_PLACEHOLDER,
  buildHintPrompt,
  truncateStem,
} from '../../lib/learning/xq-hint-prompt';

describe('truncateStem', () => {
  it('短的题干原样带完，两端空白去掉', () => {
    expect(truncateStem('  下列哪个是 final 变量？  ')).toBe('下列哪个是 final 变量？');
  });

  it('★ 长的题干按码点截断并补省略号', () => {
    const stem = '一'.repeat(HINT_STEM_MAX_CHARS + 50);
    const out = truncateStem(stem);
    expect(Array.from(out).length).toBe(HINT_STEM_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('★ 代理对不会被切成两半', () => {
    // 数学题选项里真的会出现这些字符；按 UTF-16 码元切会切出孤立代理项，
    // 编码成 UTF-8 后就是替换字符。
    const stem = '𝔸'.repeat(HINT_STEM_MAX_CHARS + 5);
    const out = truncateStem(stem);
    expect(out.includes('\uFFFD')).toBe(false);
    expect(Array.from(out).length).toBe(HINT_STEM_MAX_CHARS + 1);
  });

  it('恰好等于上限时不加省略号', () => {
    const stem = 'a'.repeat(HINT_STEM_MAX_CHARS);
    expect(truncateStem(stem)).toBe(stem);
  });
});

describe('buildHintPrompt', () => {
  const template = `我卡住了：${HINT_STEM_PLACEHOLDER}`;

  it('把题干填进占位符', () => {
    expect(buildHintPrompt(template, '什么是空安全')).toBe('我卡住了：什么是空安全');
  });

  it('★ 模板里没有占位符时退回题干本身 —— 不发一句只剩框架的话', () => {
    expect(buildHintPrompt('我卡住了', '什么是空安全')).toBe('什么是空安全');
  });

  it('★ 模板里出现两次就填两次（不同语言可能前后各引一次）', () => {
    const twice = `${HINT_STEM_PLACEHOLDER} 是什么意思？我说的是 ${HINT_STEM_PLACEHOLDER}`;
    expect(buildHintPrompt(twice, 'Future')).toBe('Future 是什么意思？我说的是 Future');
  });

  it('长题干同样被截断', () => {
    const out = buildHintPrompt(template, 'x'.repeat(HINT_STEM_MAX_CHARS + 10));
    expect(Array.from(out).length).toBe('我卡住了：'.length + HINT_STEM_MAX_CHARS + 1);
  });
});
