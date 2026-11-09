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
 * 「问 AI」的文案在十二个 locale 里都必须齐。
 *
 * 为什么单独一条：这段界面有**四句不同的话**对应四种结果（发出去 / 闸挡住 /
 * 记不上 / 记上了没发出去）。漏翻任何一条都会回退成英文，而英文回退在
 * 这里是最糟的形态 —— 学生看到一句他看不懂的语言，就不知道该去答题还是
 * 该改模型配置。
 *
 * ★ 还有一条判据：`template` 必须含 `{{stem}}`。漏了占位符时
 * `buildHintPrompt` 会退回「只发题干」—— 安全，但那样就等于没带
 * 「请给方向不要给答案」这个约束，模型会直接把答案说了。
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

type QuizBlock = { quiz?: { ask?: Record<string, unknown> } };

function askOf(locale: unknown): Record<string, unknown> {
  const ask = (locale as QuizBlock).quiz?.ask;
  return typeof ask === 'object' && ask !== null ? ask : {};
}

describe('quiz ask locale coverage', () => {
  it.each(LOCALES)('%s 定义了「问 AI」的全部文案', (_code, locale) => {
    const ask = askOf(locale);
    for (const key of [
      'label',
      'instrumental',
      'executive',
      'hint',
      'refused',
      'failed',
      'unsent',
      'template',
    ]) {
      expect(typeof ask[key], key).toBe('string');
      expect((ask[key] as string).length, key).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES)('%s 的 template 带题干占位符', (_code, locale) => {
    expect(askOf(locale).template).toContain('{{stem}}');
  });

  it.each(LOCALES)('%s 的两种问法不是同一句话', (_code, locale) => {
    // 两种分型与成绩的相关方向相反（`N3` §5.4）。文案一样的话，
    // 学生在界面上分不出自己点的是哪一个。
    const ask = askOf(locale);
    expect(ask.instrumental).not.toBe(ask.executive);
  });

  it.each(LOCALES)('%s 的「被挡住」与「真失败」不是同一句话', (_code, locale) => {
    const ask = askOf(locale);
    expect(ask.refused).not.toBe(ask.failed);
  });

  it('★ 中文的「被挡住」要指向下一步动作，而不是只说不行', () => {
    const zh = askOf(zhCN);
    expect(zh.refused).toContain('先');
    // 「直接要答案」那条路必须还在被指出来，否则学生只会反复点同一个按钮。
    expect(zh.refused).toContain('答案');
  });
});
