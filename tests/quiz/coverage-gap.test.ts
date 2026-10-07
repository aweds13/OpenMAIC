import { describe, expect, it } from 'vitest';

import {
  contentChunks,
  extractTaughtText,
  stripMarkup,
  findUncoveredTerms,
  formatCoverageGaps,
  taughtTextBefore,
} from '@/lib/quiz/coverage-gap';

describe('extractTaughtText', () => {
  it('collects text-bearing fields and ignores structural ones', () => {
    const text = extractTaughtText({
      canvas: {
        elements: [
          { type: 'text', text: '类是模板' },
          { type: 'text', content: '对象是实例' },
        ],
      },
      questions: [
        {
          id: 'q1',
          question: '什么是封装？',
          options: [{ label: '隐藏数据', value: 'A' }],
          answer: ['A'],
          analysis: '因为封装把数据藏起来',
        },
      ],
    });

    expect(text).toContain('类是模板');
    expect(text).toContain('对象是实例');
    expect(text).toContain('什么是封装？');
    expect(text).toContain('隐藏数据');
    expect(text).toContain('因为封装把数据藏起来');
    // 结构字段不算"讲过" —— 把 `A` / `q1` 算进去会让它们在题目侧变成"已讲过"。
    expect(text).not.toContain('q1');
    expect(text).not.toMatch(/\bA\b/);
  });

  it('is a whitelist walk, so an unknown field is deliberately not collected', () => {
    // 少收 ⇒ 已教侧变小 ⇒ 更容易报缺口 ⇒ 偏向误报。方向是刻意的。
    const text = extractTaughtText({ somethingNew: '未来才有的字段' });
    expect(text).toBe('');
  });
});

describe('stripMarkup', () => {
  it('strips tags so CSS keywords never become "taught terms"', () => {
    // 回归 pin：实测 slide 的 content 就是 HTML，不剥会让词表变成
    // font / style / size / 16px / monospace —— 那块注入比不注入更糟。
    const html =
      '<p style="font-size: 32px;"><strong>Java 条件语句</strong></p>' +
      '<p style="font-size: 16px;">• if (条件) { }</p>';
    const text = stripMarkup(html);
    expect(text).toContain('Java 条件语句');
    expect(text).toContain('if');
    expect(text).not.toContain('font-size');
    expect(text).not.toContain('strong');
    expect(contentChunks(html)).not.toContain('font');
    expect(contentChunks(html)).not.toContain('16px');
    expect(contentChunks(html)).not.toContain('monospace');
  });

  it('leaves plain text alone and drops script/style bodies entirely', () => {
    expect(stripMarkup('没有标记的一段话')).toBe('没有标记的一段话');
    const withScript = stripMarkup('<style>p{color:red}</style><p>正文</p>');
    expect(withScript).toContain('正文');
    expect(withScript).not.toContain('color');
  });
});

describe('taughtTextBefore', () => {
  it('takes only earlier pages, in order', () => {
    const text = taughtTextBefore(
      [
        { order: 3, content: { text: '第三页' } },
        { order: 1, content: { text: '第一页' } },
        { order: 9, content: { text: '第九页' } },
      ],
      5,
    );
    expect(text.indexOf('第一页')).toBeLessThan(text.indexOf('第三页'));
    expect(text).not.toContain('第九页');
  });
});

describe('findUncoveredTerms', () => {
  it('reports everything when nothing was taught', () => {
    const gaps = findUncoveredTerms({
      questions: [{ id: 'q1', question: '什么是多态？' }],
      taughtText: '',
    });
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.map((gap) => gap.term).join('')).toContain('多态');
  });

  it('says nothing when the assessed text was all taught', () => {
    const gaps = findUncoveredTerms({
      questions: [{ id: 'q1', question: '什么是封装', analysis: '封装是隐藏数据' }],
      taughtText: '什么是封装 封装是隐藏数据',
    });
    expect(gaps).toEqual([]);
  });

  it('separates a term that only appears in the analysis, and names where', () => {
    const gaps = findUncoveredTerms({
      questions: [
        {
          id: 'q1',
          question: '下面哪一个是多态？',
          analysis: '父类引用指向子类对象，这是动态绑定。',
        },
      ],
      taughtText: '下面哪一个是多态',
    });

    const joined = gaps.map((gap) => gap.term).join('|');
    expect(joined).toContain('动态绑定');
    const dynamic = gaps.find((gap) => gap.term.includes('动态绑定'));
    expect(dynamic?.sources).toEqual(['解析']);
  });

  it('flags a distractor that was never taught (the「抽象」case)', () => {
    const gaps = findUncoveredTerms({
      questions: [
        {
          id: 'q1',
          question: '下面哪个是封装的好处？',
          options: ['隐藏实现细节', '抽象'],
        },
      ],
      taughtText: '下面哪个是封装的好处 隐藏实现细节',
    });

    const abstract = gaps.find((gap) => gap.term.includes('抽象'));
    expect(abstract).toBeDefined();
    expect(abstract?.sources).toEqual(['选项']);
  });

  it('honours an explicit "not covered in this course" list', () => {
    const questions = [{ id: 'q1', question: '动态绑定，对吗' }];
    const taught = '对吗';
    expect(findUncoveredTerms({ questions, taughtText: taught }).map((gap) => gap.term)).toEqual([
      '动态绑定',
    ]);
    expect(
      findUncoveredTerms({ questions, taughtText: taught, deferred: ['动态绑定'] }),
    ).toEqual([]);
  });

  it('compares content blocks, not characters — boundaries come from function words', () => {
    // ★ 粒度钉在这里，因为**按字符比是错的**：中文没有词边界，任何改写都会产生一长段
    // "新"文字。实测真实课程 4 个自检页按字符比报出 **345 段**缺口，绝大多数是
    // 「的是大小关系而非布尔值）；选项 D」这种措辞碎片，真信号被埋在底下 ——
    // 98% 噪声的报告没人会读，等于漏报。这几条就是那个教训的 pin。
    expect(contentChunks('动态绑定发生在什么时候？')).toEqual(['动态绑定发生']);
    // 上面那句里只有一个 `在`（发生在），所以前六个字是一个块 —— 这是**对的**，
    // 不是 bug：没有分隔符的地方本来就该连着。下面这句多一个 `在`，就切开了。
    expect(contentChunks('动态绑定在发生')).toEqual(['动态绑定', '发生']);
    expect(contentChunks('和抽象是面向')).toEqual(['抽象', '面向']);
    expect(contentChunks('选项 A 与 private 字段')).toEqual(['private', '字段']);
  });

  it('drops punctuation-only and digit-only runs, keeps the long ones first', () => {
    const gaps = findUncoveredTerms({
      questions: [{ id: 'q1', question: '1234 ？？？ 动态绑定与父类引用' }],
      taughtText: '无关的另一页内容',
    });
    expect(gaps.every((gap) => !/^[\d\s？]+$/.test(gap.term))).toBe(true);
    const lengths = gaps.map((gap) => gap.term.length);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });

  it('merges the same text found in two places and keeps both sources', () => {
    const gaps = findUncoveredTerms({
      questions: [
        {
          id: 'q1',
          question: '动态绑定是什么？',
          analysis: '动态绑定是按实际类型选方法',
        },
      ],
      taughtText: '是什么 是按实际类型选方法',
    });
    const dynamic = gaps.find((gap) => gap.term.includes('动态绑定'));
    expect(dynamic?.sources).toEqual(['题干', '解析']);
  });

  it('matches case-insensitively for the deferred list but reports the original casing', () => {
    const gaps = findUncoveredTerms({
      questions: [{ id: 'q1', question: '这是什么 PRIVATE 字段？' }],
      taughtText: '这是什么 字段',
    });
    expect(gaps.some((gap) => gap.term === 'PRIVATE')).toBe(true);
    expect(
      findUncoveredTerms({
        questions: [{ id: 'q1', question: '这是什么 PRIVATE 字段？' }],
        taughtText: '这是什么 字段',
        deferred: ['private'],
      }).some((gap) => gap.term === 'PRIVATE'),
    ).toBe(false);
  });
});

describe('formatCoverageGaps', () => {
  it('says nothing for no gaps', () => {
    expect(formatCoverageGaps([])).toBe('');
  });

  it('is explicit that a gap is evidence, not a verdict, and gives three ways out', () => {
    const text = formatCoverageGaps([{ term: '动态绑定', sources: ['解析'] }]);
    expect(text).toContain('「动态绑定」');
    expect(text).toContain('不一定是错');
    expect(text).toContain('本课不展开');
    expect(text).toContain('干扰项');
  });

  it('★ 把两类分开报：含代码/英文的逐条列，纯中文片段只举例', () => {
    // 这一段行为的来历（2026-10-07 实测）：旁注原来只报一个总数
    //（「94 段…还有 82 段」），agent 于是把它读成**待办清单**，来回问
    //「你要我做哪些」。而实测那 94 条里含代码/英文的才是"可能真没讲"的，
    // 其余是从句子中间切下来的中文碎片（讲解页与自检页各自独立生成，措辞必然不同）。
    const gaps = [
      { term: 'plugin', sources: ['解析'] },
      { term: 'GROUP', sources: ['解析', '选项'] },
      { term: '子类自动拥有父类成员', sources: ['解析'] },
      { term: '时才重写部分方法', sources: ['解析'] },
    ];
    const text = formatCoverageGaps(gaps);
    // 两类各自计数，而且数字要对得上。
    expect(text).toContain('含代码/英文的 2 段');
    expect(text).toContain('纯中文片段 2 段');
    // 含代码/英文的逐条列出来（这是值得看的那一类）。
    expect(text).toContain('「plugin」');
    expect(text).toContain('「GROUP」');
    // 中文片段只举例 —— 但**不能假装它们不存在**：计数在标题里。
    expect(text).toContain('子类自动拥有父类成员');
    // ★ 明说它不是验收指标（它随页序与措辞涨落）。
    expect(text).toContain('不是验收指标');
  });

  it('★ 两类各自的截断都要说清剩多少（别留一个查不到的数）', () => {
    const code = Array.from({ length: 5 }, (_, index) => ({
      term: `term${index}`,
      sources: ['题干'],
    }));
    const prose = Array.from({ length: 5 }, (_, index) => ({
      term: `中文片段${index}`,
      sources: ['解析'],
    }));
    const text = formatCoverageGaps([...code, ...prose], { maxTerms: 2, maxProse: 1 });
    expect(text).toContain('「term0」');
    expect(text).toContain('「term1」');
    expect(text).not.toContain('「term2」');
    expect(text).toContain('还有 3 段');
    expect(text).toContain('中文片段0');
    expect(text).not.toContain('中文片段1');
    expect(text).toContain('另有 4 段同类片段');
  });
});
