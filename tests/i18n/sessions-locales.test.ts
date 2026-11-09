/**
 * 学习记录页的 locale 判据。
 *
 * 与 `ai-log-locales.test.ts` 同一条理由：一个页面在十二种语言下都得说
 * 人话，而不是只保证中文。这里只钉**结构**（键齐、占位符在、两句不许同句），
 * 不钉措辞 —— 措辞评审是人的事。
 */
import { describe, expect, it } from 'vitest';

import ar from '../../lib/i18n/locales/ar-SA.json';
import de from '../../lib/i18n/locales/de-DE.json';
import en from '../../lib/i18n/locales/en-US.json';
import es from '../../lib/i18n/locales/es-MX.json';
import fr from '../../lib/i18n/locales/fr-FR.json';
import ja from '../../lib/i18n/locales/ja-JP.json';
import ko from '../../lib/i18n/locales/ko-KR.json';
import pt from '../../lib/i18n/locales/pt-BR.json';
import ru from '../../lib/i18n/locales/ru-RU.json';
import vi from '../../lib/i18n/locales/vi-VN.json';
import zhCN from '../../lib/i18n/locales/zh-CN.json';
import zhTW from '../../lib/i18n/locales/zh-TW.json';

const LOCALES = [
  ['ar-SA', ar],
  ['de-DE', de],
  ['en-US', en],
  ['es-MX', es],
  ['fr-FR', fr],
  ['ja-JP', ja],
  ['ko-KR', ko],
  ['pt-BR', pt],
  ['ru-RU', ru],
  ['vi-VN', vi],
  ['zh-CN', zhCN],
  ['zh-TW', zhTW],
] as const;

const KEYS = [
  'title',
  'loading',
  'readFailed',
  'retry',
  'empty',
  'total',
  'minutes',
  'detail',
  'open',
] as const;

type Bundle = { sessions?: Record<string, string> };

describe('sessions 命名空间', () => {
  it.each(LOCALES)('%s 有完整的九个键', (_name, bundle) => {
    const block = (bundle as Bundle).sessions;
    expect(block).toBeDefined();
    expect(Object.keys(block ?? {}).sort()).toEqual([...KEYS].sort());
  });

  it.each(LOCALES)('%s 的 total 带 {{count}} 与 {{minutes}}', (_name, bundle) => {
    const total = (bundle as Bundle).sessions?.total ?? '';
    expect(total).toContain('{{count}}');
    expect(total).toContain('{{minutes}}');
  });

  it.each(LOCALES)('%s 的 detail 四个占位符齐', (_name, bundle) => {
    const detail = (bundle as Bundle).sessions?.detail ?? '';
    for (const slot of ['{{events}}', '{{pages}}', '{{answers}}', '{{hints}}']) {
      expect(detail).toContain(slot);
    }
  });

  it.each(LOCALES)('%s：读失败与「还没开始」不许同句', (_name, bundle) => {
    const block = (bundle as Bundle).sessions ?? {};
    expect(block.readFailed).not.toBe(block.empty);
    expect(block.readFailed.length).toBeGreaterThan(0);
  });

  it('★ 中文的读失败要点明「不等于今天没学」', () => {
    const failed = (zhCN as Bundle).sessions?.readFailed ?? '';
    expect(failed).toContain('不等于');
  });
});
