import { describe, expect, it } from 'vitest';

import {
  appendToSystemPrompt,
  buildQuizGrounding,
  taughtVocabulary,
} from '@/lib/quiz/quiz-grounding';

function scene(order: number, title: string, content: unknown) {
  return { order, title, content };
}

describe('taughtVocabulary', () => {
  it('ranks by occurrence, then by length', () => {
    const vocab = taughtVocabulary('封装 封装 封装 类 类 动态绑定');
    expect(vocab[0]).toBe('封装');
    // 「类」只出现两次但长度 1 < 2，被 MIN_TERM 丢掉；「动态绑定」与「类」同频时更长的在前。
    expect(vocab).not.toContain('类');
    expect(vocab).toContain('动态绑定');
  });

  it('drops boilerplate and single characters', () => {
    const vocab = taughtVocabulary('选项 下列 的 是 一个 封装');
    expect(vocab).toEqual(['封装']);
  });
});

describe('buildQuizGrounding', () => {
  it('says nothing when there is no earlier page', () => {
    expect(
      buildQuizGrounding({ scenes: [scene(1, '第一页', { text: '封装' })], beforeOrder: 1 }),
    ).toBe('');
  });

  it('says nothing when earlier pages carry no readable text', () => {
    expect(buildQuizGrounding({ scenes: [scene(1, '空', {})], beforeOrder: 2 })).toBe('');
  });

  it('lists earlier pages in order and the vocabulary they established', () => {
    const block = buildQuizGrounding({
      scenes: [
        scene(3, '多态', { text: '动态绑定 动态绑定' }),
        scene(1, '类与对象', { text: '类是模板' }),
        scene(9, '还没讲的页', { text: '不该出现的词' }),
      ],
      beforeOrder: 5,
    });

    expect(block).toContain('QUIZ GROUNDING');
    expect(block.indexOf('第 1 页《类与对象》')).toBeLessThan(block.indexOf('第 3 页《多态》'));
    // 本页之后的内容不能进词表。
    expect(block).not.toContain('第 9 页');
    expect(block).not.toContain('不该出现的词');
    expect(block).toContain('动态绑定');
  });

  it('carries the five rules, including "reword rather than introduce" and the distractor ban', () => {
    const block = buildQuizGrounding({
      scenes: [scene(1, '类', { text: '类是模板' })],
      beforeOrder: 2,
    });
    expect(block).toContain('RE-TEST');
    expect(block).toContain('NEVER use a term this course has not introduced as a distractor');
    expect(block).toContain('PREFER REWORDING over introducing it');
    expect(block).toContain('`analysis` must not lean on any term outside the list');
  });

  it('ranks by importance and never lets a tight budget empty the vocabulary', () => {
    const block = buildQuizGrounding({
      scenes: [scene(1, '类', { text: '核心概念 核心概念 核心概念 边角词甲 边角词乙 边角词丙' })],
      beforeOrder: 2,
      // 比指令块本身还小 —— 预算下限必须兜住，否则会产出"有指令、空词表"的块，
      // 而指令第 1 条恰恰说"末尾那份清单就是允许用的词"。
      maxChars: 200,
    });
    // 指令完整。
    expect(block).toContain('QUIZ GROUNDING');
    expect(block).toContain('END QUIZ GROUNDING');
    // 词表非空，且**出现次数最多的排最前**。
    const terms = block.split('allowed terms) ---')[1] ?? '';
    expect(terms).toContain('核心概念');
    expect(terms.indexOf('核心概念')).toBeLessThan(terms.indexOf('边角词甲'));
  });

  it('honours maxTerms', () => {
    const block = buildQuizGrounding({
      scenes: [scene(1, '词多', { text: '甲甲甲 乙乙乙 丙丙丙 丁丁丁' })],
      beforeOrder: 2,
      maxTerms: 1,
    });
    // 同频同长时由**确定性**排序决定谁胜出（locale 序），所以这里不假设是哪一个 ——
    // 只断言"正好一个"。取两个标记**之间**的那一段，别把尾标记也算成一行。
    const after = block.split('allowed terms) ---')[1] ?? '';
    const section = after.split('=== END QUIZ')[0] ?? '';
    const terms = section.trim().split('\n').filter(Boolean);
    expect(terms).toHaveLength(1);
  });
});

describe('appendToSystemPrompt', () => {
  it('appends to the system prompt and forwards the other arguments untouched', async () => {
    const seen: { system?: string; user?: string; images?: unknown } = {};
    const wrapped = appendToSystemPrompt(async (system, user, images) => {
      seen.system = system;
      seen.user = user;
      seen.images = images;
      return 'ok';
    }, 'BLOCK');

    const images = [{ id: 'img_1', src: '/x.png' }];
    const text = await wrapped('BASE', 'USER', images);

    expect(text).toBe('ok');
    expect(seen.system).toBe('BASE\nBLOCK');
    expect(seen.user).toBe('USER');
    expect(seen.images).toBe(images);
  });
});
