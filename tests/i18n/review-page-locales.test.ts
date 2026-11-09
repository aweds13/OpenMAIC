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
 * `/review` 页的文案在十二个 locale 里都必须齐。
 *
 * 为什么单独一条：这一页是**唯一**一处把「读失败」与「没有到期」画成两句话的
 * 界面（`review.readFailed` vs `review.empty`）。漏翻那一条，英文回退串会把
 * 「没读到队列」说成「没有要复习的」—— 那正是这页最不该犯的错。
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

type ReviewBlock = {
  review?: Record<string, unknown>;
};

function blockOf(locale: unknown): Record<string, unknown> {
  const review = (locale as ReviewBlock).review;
  return typeof review === 'object' && review !== null ? review : {};
}

describe('review page locale coverage', () => {
  it.each(LOCALES)('%s 定义了复习页的九个文案', (_code, locale) => {
    const review = blockOf(locale);
    for (const key of [
      'title',
      'loading',
      'readFailed',
      'retry',
      'empty',
      'meta',
      'noConcept',
      'saving',
      'saveFailed',
    ]) {
      expect(typeof review[key], key).toBe('string');
      expect((review[key] as string).length, key).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES)('%s 定义了三种复习动作', (_code, locale) => {
    const actions = blockOf(locale).action as Record<string, unknown> | undefined;
    expect(actions).toBeTruthy();
    for (const outcome of ['pass', 'fail', 'skip']) {
      expect(typeof actions?.[outcome], outcome).toBe('string');
      expect((actions?.[outcome] as string).length, outcome).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES)('%s 定义了概念读数的文案与三档名', (_code, locale) => {
    const review = blockOf(locale);
    expect(typeof review.mastery, 'mastery').toBe('string');
    expect(review.mastery as string).toContain('{{tri}}');
    expect(review.mastery as string).toContain('{{questions}}');
    expect(review.mastery as string).toContain('{{n}}');
    const tri = review.tri as Record<string, unknown> | undefined;
    expect(tri, 'tri').toBeTruthy();
    for (const key of ['known', 'not-learned', 'unknown']) {
      expect(typeof tri?.[key], key).toBe('string');
      expect((tri?.[key] as string).length, key).toBeGreaterThan(0);
    }
  });

  it('★ 三档名互不相同 —— 三态画成同一句话就等于没有三态', () => {
    for (const [code, locale] of LOCALES) {
      const tri = blockOf(locale).tri as Record<string, string>;
      expect(new Set([tri.known, tri['not-learned'], tri.unknown]).size, code).toBe(3);
    }
  });

  it('★ 「读失败」与「没有到期」不许是同一句话', () => {
    for (const [code, locale] of LOCALES) {
      const review = blockOf(locale);
      expect(review.readFailed, code).not.toBe(review.empty);
    }
  });

  it('interpolation 占位在每种语言里都保留', () => {
    for (const [code, locale] of LOCALES) {
      const meta = blockOf(locale).meta as string;
      expect(meta, code).toContain('{{round}}');
      expect(meta, code).toContain('{{concept}}');
    }
  });
});
