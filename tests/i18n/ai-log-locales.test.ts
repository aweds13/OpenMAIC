import { describe, expect, it } from 'vitest';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import deDE from '@/lib/i18n/locales/de-DE.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import viVN from '@/lib/i18n/locales/vi-VN.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';

/**
 * 对话日志页的文案在十二个 locale 里都必须齐。
 *
 * 最重的一条不是「有没有翻译」，是**「没读到」与「没有记录」必须是
 * 两句话**。把这两件事说成一句，是这一页能犯的最大的错：一份空的
 * 对话日志看起来像「他从来没用过 AI」，而它完全可能是网络没通。
 */
const LOCALES = [
  ['ar-SA', arSA],
  ['de-DE', deDE],
  ['en-US', enUS],
  ['es-MX', esMX],
  ['fr-FR', frFR],
  ['ja-JP', jaJP],
  ['ko-KR', koKR],
  ['pt-BR', ptBR],
  ['ru-RU', ruRU],
  ['vi-VN', viVN],
  ['zh-CN', zhCN],
  ['zh-TW', zhTW],
] as const;

type AiLogBlock = {
  aiLog?: Record<string, unknown>;
};

const KEYS = [
  'title',
  'loading',
  'readFailed',
  'retry',
  'empty',
  'meta',
  'instrumental',
  'executive',
  'generations',
  'noTurns',
  'you',
  'ai',
  'truncated',
] as const;

function blockOf(locale: AiLogBlock): Record<string, string> {
  const block = locale.aiLog;
  expect(block).toBeDefined();
  return block as Record<string, string>;
}

describe('对话日志页的文案', () => {
  it.each(LOCALES)('%s 有完整的 aiLog 文案', (_name, locale) => {
    const block = blockOf(locale);
    for (const key of KEYS) {
      expect(typeof block[key], `aiLog.${key}`).toBe('string');
      expect(block[key].length, `aiLog.${key}`).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES)('%s 的「没读到」与「没有记录」不是同一句', (_name, locale) => {
    const block = blockOf(locale);
    expect(block.readFailed).not.toBe(block.empty);
  });

  it.each(LOCALES)('%s 的 meta 带两个占位符', (_name, locale) => {
    const block = blockOf(locale);
    expect(block.meta).toContain('{{scene}}');
    expect(block.meta).toContain('{{question}}');
  });

  it.each(LOCALES)('%s 的「配不到对话」解释得足够长', (_name, locale) => {
    // 它必须说清**为什么**会配不到，否则用户只会以为页面坏了。
    // 十二个 locale 都写英文/中文长句，30 字符是下限而不是目标。
    expect(blockOf(locale).noTurns.length).toBeGreaterThan(30);
  });

  it.each(LOCALES)('%s 把两种分型说成不同的动作', (_name, locale) => {
    const block = blockOf(locale);
    expect(block.instrumental).not.toBe(block.executive);
  });

  it('中文的「没读到」明确说了「不等于没有记录」', () => {
    expect(blockOf(zhCN).readFailed).toContain('不等于');
  });

  it('中文的「没找到对话」给了两种可能的原因', () => {
    const zh = blockOf(zhCN).noTurns;
    // 早于子锚点 / 被滚动到别的代 —— 两句都要在。
    expect(zh).toContain('子锚点');
    expect(zh).toContain('代');
  });

  it('十二个 locale 的键集合一致', () => {
    const expected = [...KEYS].sort();
    for (const [name, locale] of LOCALES) {
      expect(Object.keys(blockOf(locale)).sort(), name).toEqual(expected);
    }
  });
});
