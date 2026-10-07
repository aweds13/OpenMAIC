/**
 * 「滚轮翻页」开关的文案必须**每个语言都有**。
 *
 * 缺一个键不会报错：i18next 会回落到默认语言（zh-CN），于是英文界面里冒出中文，
 * 或者更糟 —— 按钮上直接显示 `stage.wheelPageTurn` 这个键名。这个按钮是用户
 * **唯一**能关掉滚轮翻页的地方（他的原话：「滚轮功能可以自己自由在看课时关掉
 * 才行」），它必须看得懂。
 */
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- locale JSON traversal
const get = (o: any, k: string): unknown => k.split('.').reduce((a, p) => a?.[p], o);

const locales: Record<string, unknown> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP,
  'ru-RU': ruRU,
  'ar-SA': arSA,
  'pt-BR': ptBR,
  'ko-KR': koKR,
  'es-MX': esMX,
  'fr-FR': frFR,
  'vi-VN': viVN,
  'de-DE': deDE,
};

const KEYS = ['stage.wheelPageTurn', 'stage.wheelPageTurnOff', 'stage.wheelPageTurnOn'];

describe('wheel page-turn switch locale coverage', () => {
  it('has all 12 locales', () => {
    // A new locale file that forgets these keys should fail here, not silently
    // render the key name in the toolbar.
    expect(Object.keys(locales)).toHaveLength(12);
  });

  it('every key exists, non-empty, and does not echo the key, in all 12 locales', () => {
    for (const [code, data] of Object.entries(locales)) {
      for (const k of KEYS) {
        const v = get(data, k);
        expect(typeof v, `${code} missing ${k}`).toBe('string');
        expect((v as string).trim(), `${code} empty ${k}`).not.toBe('');
        expect(v, `${code} echoes ${k}`).not.toBe(k);
      }
    }
  });

  it('says something different for on and off', () => {
    for (const [code, data] of Object.entries(locales)) {
      expect(get(data, 'stage.wheelPageTurnOff'), code).not.toBe(
        get(data, 'stage.wheelPageTurnOn'),
      );
    }
  });
});
