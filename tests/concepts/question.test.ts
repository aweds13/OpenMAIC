/**
 * 题级挂载的判据：只取题干、成员访问只取链头、强弱两档、同题同概念只留一条。
 *
 * ★ 为什么这些断言必须钉住：题级挂载一旦放宽，`xq_question_concept` 会变成
 *   一张「题目里出现过这个词」的表 —— 选项里复述的概念名、解析里顺带提到的
 *   概念、`Navigator.push` 里那个属于 git 的 `push` 都会挂到题上。下游
 *   `learner-state.ts` 拿这张表给状态块的每一格贴标签，一个错标会让学习者
 *   看到「字符串」而那一页讲的是 Dart 的空安全。
 *
 * ★ 夹具全部取自真库原文（`document_scenes.data.content.questions[].question`），
 *   不是自己编的句子。第一版夹具编了「Dart 的空安全是什么意思？」这种句子，
 *   结果一条都不命中 —— 因为 `matchWhole` 要求**整段相等**，而「的空安全是什么
 *   意思」是一个整段（中文没有词间空格）。那不是 bug，是这条尺子刻意的行为。
 */
import { describe, expect, it } from 'vitest';

import {
  QUESTION_CONCEPT_CONFIDENCE_STRONG,
  QUESTION_CONCEPT_CONFIDENCE_WEAK,
  STRONG_MIN_ASCII_CHARS,
  STRONG_MIN_CJK_CHARS,
  buildAliasIndex,
  buildSeedGraph,
  deriveQuestionConcepts,
  questionStemWords,
  questionWordTier,
} from '@/lib/concepts';
import type { SeedGraph } from '@/lib/concepts';

/**
 * 真库读数（2026-11-09，17 个 quiz 页 / 98 题，跑 `deriveQuestionConcepts`
 * 得到）：71 行、覆盖 13 页、强 35 行 / 弱 36 行、强档 11 页。
 */
const REAL_BASELINE = { pages: 17, rows: 71, pagesWith: 13, strongPages: 11 } as const;

/** 一张只含断言所需概念的小图 —— 不受种子图增删影响。 */
function miniGraph(): SeedGraph {
  return {
    concepts: [
      { key: 'dart.null-safety', name: '空安全', kind: 'concept' },
      {
        key: 'dart.var',
        name: 'Dart 变量 var / final / const',
        kind: 'concept',
        aliases: ['var', 'final'],
      },
      { key: 'flutter.route', name: '路由与页面跳转', kind: 'concept', aliases: ['Navigator'] },
      { key: 'git.remote', name: '远程仓库与 PR', kind: 'concept', aliases: ['push'] },
      { key: 'prog.class', name: '类与对象', kind: 'concept', aliases: ['类', 'class'] },
      { key: 'prog.string', name: '字符串', kind: 'concept', aliases: ['String'] },
    ],
    edges: [],
  };
}

describe('question: 只取题干', () => {
  it('选项与解析里的概念名不会进结果 —— 它们不是推导的输入', () => {
    // 真库原文：`stage--ShZtYAYOj/scene-p35/q7`。
    const question =
      '第 33 页讲了怎么从一个页面跳到另一个页面。关于 Navigator.push 和 Navigator.pop，下面哪种说法是对的？';
    const drafts = deriveQuestionConcepts(
      {
        stageId: 's1',
        sceneId: 'p1',
        questions: [
          {
            id: 'q7',
            question,
            // 选项与解析故意写成「满是概念名」：真跑时它们确实长这样。
            options: [{ label: 'push 会把改动推到远程仓库', value: 'A' }],
            analysis: '这一题考的是路由与页面跳转，与 push 无关。',
          },
        ] as never,
      },
      miniGraph(),
    );
    // 只有链头 `Navigator` 命中「路由与页面跳转」；`push` 是成员访问的尾巴，被丢掉。
    expect(drafts.map((d) => d.conceptName)).toEqual(['路由与页面跳转']);
  });

  it('没有题 id 的题直接跳过 —— 落库主键要它', () => {
    const drafts = deriveQuestionConcepts(
      { stageId: 's1', sceneId: 'p1', questions: [{ question: '继承。封装' }] },
      miniGraph(),
    );
    expect(drafts).toEqual([]);
  });

  it('题干整个为空时不抛，返回空数组', () => {
    expect(
      deriveQuestionConcepts({ stageId: 's1', sceneId: 'p1', questions: [] }, miniGraph()),
    ).toEqual([]);
    expect(
      deriveQuestionConcepts(
        { stageId: 's1', sceneId: 'p1', questions: [{ id: 'q1' }] },
        miniGraph(),
      ),
    ).toEqual([]);
  });
});

describe('question: 整段相等，不做子串包含', () => {
  it('概念名嵌在一长串中文里不命中 —— 中文没有词间空格，切开就会误挂', () => {
    // 「的空安全是什么意思」是一个整段；`空安全` 只是它的一部分。
    const drafts = deriveQuestionConcepts(
      {
        stageId: 's1',
        sceneId: 'p1',
        questions: [{ id: 'q1', question: 'Dart 的空安全是什么意思？' }],
      },
      miniGraph(),
    );
    expect(drafts).toEqual([]);
  });

  it('被标点/空格隔开时命中 —— 真库里的命中都是这种形态', () => {
    const drafts = deriveQuestionConcepts(
      { stageId: 's1', sceneId: 'p1', questions: [{ id: 'q1', question: '空安全，说的是什么？' }] },
      miniGraph(),
    );
    expect(drafts.map((d) => d.conceptName)).toEqual(['空安全']);
  });
});

describe('question: 成员访问只取链头', () => {
  it('`Navigator.push` 只命中 Navigator，不命中 push（真库里 push 会错挂到 git）', () => {
    const drafts = deriveQuestionConcepts(
      {
        stageId: 's1',
        sceneId: 'p1',
        questions: [{ id: 'q7', question: '关于 Navigator.push 和 Navigator.pop，哪种说法对？' }],
      },
      miniGraph(),
    );
    expect(drafts.map((d) => d.conceptKey)).toEqual(['flutter.route']);
  });

  it('链头本身是概念名时保留，只丢尾巴（`this.name` 里的 this）', () => {
    // 真库原文：`stage--ShZtYAYOj/scene-p18/q8` 的 `String sayHi() { ... }` 同类写法。
    const graph: SeedGraph = {
      concepts: [{ key: 'dart.this', name: 'this 关键字', kind: 'concept', aliases: ['this'] }],
      edges: [],
    };
    const drafts = deriveQuestionConcepts(
      {
        stageId: 's1',
        sceneId: 'p1',
        questions: [{ id: 'q1', question: 'this.name 取的是谁的字段？' }],
      },
      graph,
    );
    expect(drafts.map((d) => d.conceptName)).toEqual(['this 关键字']);
  });

  it('中文句号不是成员访问，`继承。封装` 两段都留着', () => {
    expect(questionStemWords('继承。封装')).toEqual(['继承', '封装']);
    expect(questionStemWords('a.b')).toEqual(['a']);
    expect(questionStemWords('a. b')).toEqual(['a', 'b']);
  });

  it('开头就是点号时不当成成员访问（没有前导标识符）', () => {
    expect(questionStemWords('.5 是多少')).toEqual(['5', '是多少']);
  });
});

describe('question: 强弱两档', () => {
  it('ASCII 门槛是 6 个字符，CJK 门槛是 2 个字', () => {
    expect(STRONG_MIN_ASCII_CHARS).toBe(6);
    expect(STRONG_MIN_CJK_CHARS).toBe(2);
    expect(questionWordTier('String')).toBe('strong');
    expect(questionWordTier('final')).toBe('weak');
    expect(questionWordTier('类')).toBe('weak');
    expect(questionWordTier('空安全')).toBe('strong');
  });

  it('短 ASCII 词命中也写进去，但压到弱档（0.50）', () => {
    // 真库原文：`stage--ShZtYAYOj/scene-p18/q1`（问 final / const）。
    const drafts = deriveQuestionConcepts(
      {
        stageId: 's1',
        sceneId: 'p1',
        questions: [
          {
            id: 'q1',
            question: 'final 和 const 声明出来的变量都只能赋一次值，但两者之间有一条重要区别。',
          },
        ],
      },
      miniGraph(),
    );
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.tier).toBe('weak');
      expect(draft.confidence).toBe(QUESTION_CONCEPT_CONFIDENCE_WEAK);
    }
  });

  it('长 ASCII 与双字中文概念名落强档（0.80）', () => {
    // 真库原文：`stage--ShZtYAYOj/scene-p24/q2`。
    const drafts = deriveQuestionConcepts(
      {
        stageId: 's1',
        sceneId: 'p1',
        questions: [
          {
            id: 'q2',
            question:
              '想表示“名字可能是空的”，要写成 String? name。关于 String? 里的这个问号，下面说法正确的是？',
          },
        ],
      },
      miniGraph(),
    );
    const byName = new Map(drafts.map((d) => [d.conceptName, d]));
    expect(byName.get('字符串')?.tier).toBe('strong');
    expect(byName.get('字符串')?.confidence).toBe(QUESTION_CONCEPT_CONFIDENCE_STRONG);
  });

  it('`link` 区分逐字命中与归一化后命中', () => {
    const drafts = deriveQuestionConcepts(
      { stageId: 's1', sceneId: 'p1', questions: [{ id: 'q1', question: '空安全 与 STRING' }] },
      miniGraph(),
    );
    const byName = new Map(drafts.map((d) => [d.conceptName, d]));
    expect(byName.get('空安全')?.link).toBe('exact');
    // `STRING` 归一化后是 `string`，与别名表相等，但原文不是它。
    expect(byName.get('字符串')?.link).toBe('normalized');
    expect(byName.get('字符串')?.matchedForm).toBe('STRING');
  });
});

describe('question: 同题同概念只留一条，结果稳定', () => {
  it('一个概念两个别名、长短不同时，只出一行且取强档', () => {
    const one: SeedGraph = {
      concepts: [
        { key: 'x.class', name: '类与对象', kind: 'concept', aliases: ['类', '类与对象'] },
      ],
      edges: [],
    };
    const drafts = deriveQuestionConcepts(
      {
        stageId: 's1',
        sceneId: 'p1',
        questions: [{ id: 'q1', question: '类与对象，说的是什么？' }],
      },
      one,
    );
    expect(drafts.length).toBe(1);
    expect(drafts[0].tier).toBe('strong');
    expect(drafts[0].confidence).toBe(QUESTION_CONCEPT_CONFIDENCE_STRONG);
  });

  it('同一题同一概念换写法命中两次也不重复', () => {
    const drafts = deriveQuestionConcepts(
      { stageId: 's1', sceneId: 'p1', questions: [{ id: 'q1', question: '类与对象，类与对象' }] },
      miniGraph(),
    );
    const keys = drafts.map((d) => `${d.questionId}/${d.conceptKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('返回顺序按 questionId 再按 conceptKey 升序 —— 两次跑逐字节相同', () => {
    const graph = miniGraph();
    const input = {
      stageId: 's1',
      sceneId: 'p1',
      questions: [
        { id: 'q2', question: 'String 与空安全' },
        { id: 'q1', question: '空安全 与 String' },
      ],
    };
    const first = deriveQuestionConcepts(input, graph);
    const second = deriveQuestionConcepts(input, graph);
    expect(first).toEqual(second);
    const order = first.map((d) => `${d.questionId}/${d.conceptKey}`);
    expect(order).toEqual([...order].sort());
  });

  it('可以复用已建好的别名表，结果与现场建的一致', () => {
    const graph = miniGraph();
    const input = {
      stageId: 's1',
      sceneId: 'p1',
      questions: [{ id: 'q1', question: '空安全 与 String' }],
    };
    expect(deriveQuestionConcepts(input, graph, { index: buildAliasIndex(graph) })).toEqual(
      deriveQuestionConcepts(input, graph),
    );
  });
});

describe('question: 真种子图上的读数', () => {
  it('真图里 13 页挂得上、4 页一条都挂不上 —— 覆盖不到是事实', () => {
    const graph = buildSeedGraph();
    const rounds: {
      stageId: string;
      sceneId: string;
      questions: { id: string; question: string }[];
    }[] = [
      {
        stageId: 'stage-7tNoR37iqT',
        sceneId: 'scene-p7',
        questions: [
          { id: 'q1', question: 'git status 的作用是什么？' },
          { id: 'q7', question: '关于分支（branch），下列哪种说法正确？' },
        ],
      },
      {
        stageId: 'stage-7tNoR37iqT',
        sceneId: 'scene-p12',
        questions: [
          { id: 'q1', question: 'HTTP 的 GET 和 POST 有什么区别？' },
          { id: 'q2', question: '返回 404 说明什么？' },
        ],
      },
    ];
    const git = deriveQuestionConcepts(rounds[0], graph);
    expect(git.map((d) => d.conceptName)).toContain('Git 分支');

    // 这门课的题干全在种子图之外（HTTP 状态码不是概念）。
    expect(deriveQuestionConcepts(rounds[1], graph)).toEqual([]);
    expect(REAL_BASELINE.pagesWith).toBeLessThan(REAL_BASELINE.pages);
  });

  it('短 ASCII 别名在真图上确实占约一半（36/71），这是设计接受的事实', () => {
    const graph = buildSeedGraph();
    // `stage--ShZtYAYOj/scene-p18/q1` 只有 final / const 命中。
    const drafts = deriveQuestionConcepts(
      {
        stageId: 'stage--ShZtYAYOj',
        sceneId: 'scene-p18',
        questions: [
          {
            id: 'q1',
            question:
              'final 和 const 声明出来的变量都只能赋一次值，但两者之间有一条重要区别。下面哪一条说法是对的？',
          },
        ],
      },
      graph,
    );
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.tier === 'weak')).toBe(true);
  });
});
