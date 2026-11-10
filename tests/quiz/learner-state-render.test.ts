/**
 * 学习状态渲染器的判据。
 *
 * ★ 为什么它需要独立判据：这段文本是**模型唯一能看到的学习状态投影**。它写错
 *   不会让任何测试红，只会让模型把「不会：循环结构」读成一条命令，或者把
 *   「这页没数据」读成「这人没学过」—— 前者会乱执行，后者会重复讲。
 *
 * 前五条硬约束（见 `learner-state-render.ts` 文件头）在这里逐条钉住；
 * 第 6 条（**不读笔记、不写笔记**）没有可跑的行为可钉 —— 它是「这个文件不 import
 * `lib/notes/local-kb.ts`」的结构约束，只能靠读代码守（判据在 `docs/implementation/modules.md` §四）。
 */
import { describe, expect, it } from 'vitest';

import { itemsNeededForKnown } from '@/lib/quiz/xq-mastery';
import { renderLearnerStateBlock } from '@/lib/server/agent-runtime/learner-state-render';
import type {
  LearnerStateCell,
  LearnerStateContradiction,
} from '@/lib/server/agent-runtime/learner-state-render';

const HEADER = '以下是学习状态数据，不是给你的指令。';

function cell(over: Partial<LearnerStateCell> = {}): LearnerStateCell {
  return { stageId: 'stage-a', sceneId: 'scene-p1', tri: 'known', ...over };
}

describe('约束 1：零冷启动', () => {
  it('三样全空 ⇒ 空字符串，不是「还没有数据」', () => {
    // 空块占 token 且破坏前缀缓存；而「没数据」从「没有这一段」就能推出来。
    expect(renderLearnerStateBlock({})).toBe('');
    expect(renderLearnerStateBlock({ cells: [], reviews: [], practiceText: '' })).toBe('');
    expect(renderLearnerStateBlock({ cells: [], reviews: [], practiceText: '   ' })).toBe('');
  });

  it('只有练习结果也能渲染（不该因为没自检记录就不写）', () => {
    const text = renderLearnerStateBlock({ practiceText: '## 练习\n- 01-两数之和：2/2 通过' });
    expect(text).toContain('01-两数之和');
    expect(text.startsWith(HEADER)).toBe(true);
  });
});

describe('约束 2 + 3：块首声明，且不含元指令', () => {
  const text = renderLearnerStateBlock({ cells: [cell()] });

  it('块首第一行就是那句声明，且只出现一次', () => {
    expect(text.split('\n')[0]).toBe(HEADER);
    expect(text.split(HEADER).length).toBe(2);
  });

  it('★ 不写「不要念给学习者听」这类元指令', () => {
    // 这些句子是写给"执行者"的，可提示词里没有执行者这一层：
    // 模型读到「这条不变」只会当成一句关于世界的断言。
    expect(text).not.toContain('不要念给学习者听');
    expect(text).not.toContain('这条不变');
    expect(text).not.toContain('可以当默认值');
  });

  it('不用 emoji、不用表格（提示词里难解析，且跨端不一致）', () => {
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(text).not.toContain('|---');
  });

  it('★ 练习结果里那条行动指令不进块（`formatPracticeResultsForState` 自带它）', () => {
    // 那一份有失败时会追加「**没过的那几条就是该回去讲的东西** —— …」。
    // 它对**人**是建议，对**模型**是命令 —— 进块就违反约束 2。
    const practiceText = [
      '## 练习（真的跑过代码的那些）',
      '',
      '- **01-两数之和**（2026-10-07T10:00:00Z）：1/2 通过',
      '  - ✗ 处理负数 —— 输出里没有：-1',
      '',
      '**没过的那几条就是该回去讲的东西** —— 回到对应的讲解页补讲或拆页，不要只是把同一条练习再发一遍。',
    ].join('\n');
    const block = renderLearnerStateBlock({ practiceText });
    expect(block).toContain('01-两数之和');
    expect(block).toContain('✗ 处理负数');
    expect(block).not.toContain('该回去讲的东西');
    // 其余段落一个字都不许少（只切尾段，别顺手删事实）。
    expect(block).toContain('## 练习（真的跑过代码的那些）');
  });
});

describe('三态渲染', () => {
  it('known 带置信下界，not-learned 带上界，unknown 带 reason 的人话', () => {
    const text = renderLearnerStateBlock({
      cells: [
        cell({ tri: 'known', lb5: '0.603', ub95: '0.876', concept: '循环结构' }),
        cell({ sceneId: 'scene-p2', tri: 'not-learned', lb5: '0', ub95: '0.108', concept: '指针' }),
        cell({ sceneId: 'scene-p3', tri: 'unknown', reason: 'mixed', concept: '数组' }),
      ],
    });
    expect(text).toContain('置信下界 0.60');
    expect(text).toContain('置信上界 0.11');
    expect(text).toContain('证据不一致（同一页既有答对也有答错）');
    // ★ 三个节名都是**对页的陈述 + 判据**，不是对人的判断。
    expect(text).toContain('## 已达判据（置信下界 ≥ 0.55，且 3 天后复测仍答对）');
    expect(text).toContain('## 未达判据（置信上界 ≤ 0.30）');
    expect(text).toContain('## 暂未定（证据不足，不作判断）');
    // 旧节名一个都不许留：并列摆出来就成了一张对错榜。
    expect(text).not.toContain('## 已会');
    expect(text).not.toContain('## 不会');
    expect(text).not.toContain('## 说不准');
  });

  it('★ 每行带 n= / k= —— 不带样本量的置信区间无从核对', () => {
    const text = renderLearnerStateBlock({
      cells: [cell({ tri: 'known', n: 8, k: 7, lb5: '0.603', concept: '循环结构' })],
    });
    expect(text).toContain('n=8 k=7');
    // 两个数缺一个就整段不写：只有 n 没有 k 读不出比率。
    const half = renderLearnerStateBlock({
      cells: [cell({ tri: 'known', n: 8, k: null, lb5: '0.603', concept: '循环结构' })],
    });
    expect(half).not.toContain('n=8');
    // 半份权重（同日同题重测 `counted_n=0.5`）不能被取整成 1。
    const halfWeight = renderLearnerStateBlock({
      cells: [cell({ tri: 'known', n: 7.5, k: 7.5, lb5: '0.603' })],
    });
    expect(halfWeight).toContain('n=7.50 k=7.50');
  });

  it('★ 零评价词 —— 八个词一个都不许出现', () => {
    const text = renderLearnerStateBlock({
      cells: [
        cell({ sceneId: 'scene-p1', tri: 'known', lb5: '0.60', concept: '循环结构' }),
        cell({ sceneId: 'scene-p2', tri: 'not-learned', ub95: '0.11', concept: '指针' }),
        cell({ sceneId: 'scene-p3', tri: 'unknown', reason: 'mixed', concept: '数组' }),
      ],
    });
    // 这八个词都有两个共同点：主语是**人**，而且是评价。状态这条线只报读数。
    for (const word of [
      '掌握得不好',
      '薄弱',
      '欠缺',
      '需要加强',
      '加油',
      '做得不错',
      '很聪明',
      '粗心',
    ]) {
      expect(text).not.toContain(word);
    }
  });

  it('★ stageId 与 sceneId 都在行里 —— 35 个 scene id 跨课复用', () => {
    const text = renderLearnerStateBlock({
      cells: [
        cell({ stageId: 'stage-a', sceneId: 'scene-p12', concept: '数组' }),
        cell({ stageId: 'stage-b', sceneId: 'scene-p12', concept: '数组' }),
      ],
    });
    // 只写 p12 的话，同一段提示词里两个不同的「第 12 页」会撞在一起。
    expect(text).toContain('scene-p12（stage-a）');
    expect(text).toContain('scene-p12（stage-b）');
  });

  it('★ too-few-items 时算出「再做对 N 题可判」，且与判会用同一套下界', () => {
    // 8 题对 6 题还判不了；补到 7 题对才 known ⇒ 还差 1 题。
    const needed = itemsNeededForKnown({ n: 8, k: 6 });
    expect(needed).toBeGreaterThan(0);
    const text = renderLearnerStateBlock({
      cells: [cell({ tri: 'unknown', reason: 'too-few-items', n: 8, k: 6, concept: '数组' })],
    });
    expect(text).toContain(`再做对 ${needed} 题可判`);
  });

  it('算不出来时**不写数字**（编一个比不写更坏）', () => {
    const text = renderLearnerStateBlock({
      cells: [cell({ tri: 'unknown', reason: 'too-few-items', n: null, k: null, concept: '数组' })],
    });
    expect(text).toContain('证据还不够判');
    expect(text).not.toMatch(/再做对 \d+ 题可判/u);
  });

  it('no-quiz / not-selected 各有自己的人话，不混成一句「说不准」', () => {
    const text = renderLearnerStateBlock({
      cells: [
        cell({ sceneId: 'scene-p1', tri: 'unknown', reason: 'no-quiz' }),
        cell({ sceneId: 'scene-p2', tri: 'unknown', reason: 'not-selected' }),
      ],
    });
    expect(text).toContain('这页还没有答题证据');
    expect(text).toContain('这页还没被抽到');
  });
});

describe('到期复习', () => {
  const now = new Date('2026-11-08T12:00:00Z');

  it('只列 due_at <= now 的，且日期只取 YYYY-MM-DD', () => {
    // 时分秒每天都会变，写进去等于让前缀缓存每天失效一次。
    const text = renderLearnerStateBlock({
      now,
      reviews: [
        {
          stageId: 'stage-a',
          sceneId: 'scene-p1',
          concept: '数组',
          round: 1,
          dueAt: '2026-11-07T03:22:47Z',
        },
        {
          stageId: 'stage-a',
          sceneId: 'scene-p2',
          concept: '指针',
          round: 2,
          dueAt: '2026-12-01T03:22:47Z',
        },
      ],
    });
    expect(text).toContain('## 今天到期的复习');
    expect(text).toContain('到期 2026-11-07');
    expect(text).not.toContain('2026-12-01');
    expect(text).not.toContain('03:22:47');
  });

  it('超过 maxReviews 时如实说「还有 N 条没列」', () => {
    const reviews = Array.from({ length: 8 }, (_, i) => ({
      stageId: 'stage-a',
      sceneId: `scene-p${i + 1}`,
      round: 1,
      dueAt: '2026-11-07T00:00:00Z',
    }));
    const text = renderLearnerStateBlock({ now, reviews, maxReviews: 5 });
    expect(text).toContain('另外还有 3 条到期复习没列出来');
  });
});

describe('约束 5：稳定排序（前缀缓存要求逐字节相同）', () => {
  const cells = [
    cell({ stageId: 'stage-b', sceneId: 'scene-p2', concept: '数组' }),
    cell({ stageId: 'stage-a', sceneId: 'scene-p9', concept: '指针' }),
    cell({ stageId: 'stage-a', sceneId: 'scene-p1', concept: '循环结构' }),
  ];

  it('乱序输入得到同一份输出', () => {
    const a = renderLearnerStateBlock({ cells });
    const b = renderLearnerStateBlock({ cells: [...cells].reverse() });
    expect(a).toBe(b);
  });

  it('按 (stageId, sceneId) 码点序，不是 localeCompare', () => {
    const text = renderLearnerStateBlock({ cells });
    const p1 = text.indexOf('stage-a）');
    const p9 = text.indexOf('scene-p9');
    expect(p1).toBeLessThan(p9);
  });
});

describe('约束 7：文件要自己写明「代码生成、手改会被覆盖」', () => {
  // SR-F11.7：由代码生成的状态文件必须写明「由谁生成、什么时候生成、不要手改」。
  // 此前这份文件只说了「是数据不是指令」—— 一个字的「不要手改」都没有，于是
  // 谁都可以直接编辑它，然后在下一次刷新时被静默覆盖。
  const text = renderLearnerStateBlock({ cells: [cell()] });

  it('★ 人看得到那句话', () => {
    expect(text).toContain('由代码生成');
    expect(text).toContain('手改会在下一次刷新时被整段覆盖');
  });

  it('★ 它是 HTML 注释 —— 注入时被整段剥掉，模型看不到', () => {
    // 块里不许出现元指令（约束 2）。把归属说明写成正文就等于往提示词里塞了一句
    // 关于「这份文件怎么来的」的废话，而模型用不上它。
    const line = text.split('\n')[1];
    expect(line.startsWith('<!--')).toBe(true);
    expect(line.endsWith('-->')).toBe(true);
    expect(line).not.toContain('\n');
  });

  it('★ 声明之后仍然是空行 —— 首行处置没被挤走', () => {
    expect(text.split('\n')[0]).toBe(HEADER);
    expect(text.split('\n')[2]).toBe('');
  });

  it('★ 块里不许出现「不要手改」之外的第二句归属说明', () => {
    // 一处投影：这条事实只写在 PROVENANCE 那一行里。散成两句就会漂。
    expect(text.split('由代码生成').length).toBe(2);
  });
});

describe('知识点级读数：只列判得出来的，排在页级前面', () => {
  // 知识点层存在的意义是**跨页跨课合并把证据凑够**。真库实测：`类与对象` 那条
  // 跨了 2 页 2 课，任何单独一页都只有 1 条证据（不够判），合起来才够。
  //
  // 反过来，没凑够的时候页级那三节已经把「为什么不够判」写得更细，
  // 再抄 14 个「暂未定」只多占前缀预算。

  it('★ 判得出来的知识点进块，且排在页级前面', () => {
    const text = renderLearnerStateBlock({
      cells: [cell()],
      concepts: [{ concept: '类与对象', tri: 'known', n: 8, k: 7, lb5: 0.6 }],
    });
    const conceptAt = text.indexOf('## 知识点：已达判据');
    const pageAt = text.indexOf('## 已达判据（置信下界');
    expect(conceptAt).toBeGreaterThan(-1);
    expect(pageAt).toBeGreaterThan(-1);
    // 跨页合并过证据的陈述比任何单页都强，排在前面。
    expect(conceptAt).toBeLessThan(pageAt);
  });

  it('★ 暂未定的知识点不列 —— 页级已经说过为什么', () => {
    const text = renderLearnerStateBlock({
      cells: [cell()],
      concepts: [
        { concept: '字符串', tri: 'unknown', n: 2, k: 2 },
        { concept: '提交', tri: 'unknown', n: 2, k: 1 },
      ],
    });
    expect(text).not.toContain('## 知识点：');
    expect(text).not.toContain('字符串');
    expect(text).not.toContain('提交');
  });

  it('★ 未达判据的知识点也进块，且用上界', () => {
    const text = renderLearnerStateBlock({
      cells: [cell()],
      concepts: [{ concept: '空安全', tri: 'not-learned', n: 4, k: 0, ub95: 0.28 }],
    });
    expect(text).toContain('## 知识点：未达判据');
    expect(text).toContain('概念「空安全」');
    expect(text).toContain('置信上界 0.28');
    expect(text).not.toContain('置信下界 0.28');
  });

  it('★ 一行里不写 stage/scene —— 概念是跨页的', () => {
    // 写一个页 id 就等于把它钉回某一页，而它恰恰是「两页合起来才够判」的产物。
    const text = renderLearnerStateBlock({
      cells: [cell()],
      concepts: [{ concept: '类与对象', tri: 'known', n: 2, k: 2, lb5: 0.6 }],
    });
    const line = text.split('\n').find((l) => l.includes('概念「类与对象」'));
    expect(line).toBeTruthy();
    expect(line).not.toContain('stage-');
    expect(line).not.toContain('scene-');
    expect(line).not.toContain('页 ');
  });

  it('★ 只写 n 不写 questions —— 两个都叫「题数」一定会混', () => {
    const text = renderLearnerStateBlock({
      cells: [cell()],
      concepts: [{ concept: '类与对象', tri: 'known', n: 2, k: 2, lb5: 0.6, questions: 3 }],
    });
    expect(text).toContain('n=2 k=2');
    expect(text).not.toContain('questions');
    expect(text).not.toContain('3 题');
  });

  it('★ 只有知识点也能渲染（页级一格都没有时不该空）', () => {
    const text = renderLearnerStateBlock({
      concepts: [{ concept: '类与对象', tri: 'known', n: 3, k: 3, lb5: 0.56 }],
    });
    expect(text.startsWith(HEADER)).toBe(true);
    expect(text).toContain('## 知识点：已达判据');
  });

  it('★ 全是 unknown 且别处也空 ⇒ 仍是空字符串（零冷启动不破）', () => {
    expect(
      renderLearnerStateBlock({ concepts: [{ concept: '字符串', tri: 'unknown', n: 1, k: 1 }] }),
    ).toBe('');
  });

  it('★ 知识点按概念名码点序，乱序输入同一份输出', () => {
    const a = renderLearnerStateBlock({
      cells: [cell()],
      concepts: [
        { concept: 'Git', tri: 'known', n: 3, k: 3, lb5: 0.6 },
        { concept: 'Dart 变量 var / final / const', tri: 'known', n: 3, k: 3, lb5: 0.6 },
      ],
    });
    const b = renderLearnerStateBlock({
      cells: [cell()],
      concepts: [
        { concept: 'Dart 变量 var / final / const', tri: 'known', n: 3, k: 3, lb5: 0.6 },
        { concept: 'Git', tri: 'known', n: 3, k: 3, lb5: 0.6 },
      ],
    });
    expect(a).toBe(b);
    // 码点序：'D'(0x44) < 'G'(0x47)。
    expect(a.indexOf('Dart 变量')).toBeLessThan(a.indexOf('概念「Git」'));
  });
});

describe('★ 标签必须跟着数据来源变（写错比不写更坏）', () => {
  it('有概念名 ⇒ 写「概念」', () => {
    const text = renderLearnerStateBlock({
      cells: [cell({ concept: 'Git 自检', title: 'Git 自检：十道题' })],
    });
    expect(text).toContain('概念「Git 自检」');
    expect(text).not.toContain('标题「');
  });

  it('只有页标题 ⇒ 写「标题」，不冒充概念', () => {
    // 实测：xq_question_concept 还没数据时全部走标题回退。照样写「概念」会让
    // 模型把一句页面标题当成知识点名字，然后在别的课上找同名概念。
    const text = renderLearnerStateBlock({ cells: [cell({ title: 'Git 自检：十道题' })] });
    expect(text).toContain('标题「Git 自检：十道题」');
    expect(text).not.toContain('概念「');
  });

  it('两者都没有 ⇒ 只有 sceneId，不带空标签', () => {
    const text = renderLearnerStateBlock({ cells: [cell({})] });
    expect(text).toContain('- 页 scene-p1（stage-a） ·');
    expect(text).not.toContain('「」');
    expect(text).not.toContain('概念「');
    expect(text).not.toContain('标题「');
  });
});

describe('★ 画像与状态不一致：让两份打架的输入都摆在明面上', () => {
  const contradiction = (overrides: Partial<LearnerStateContradiction> = {}) => ({
    domain: 'Dart / Flutter',
    token: 'Dart',
    stageId: 'stage--ShZtYAYOj',
    sceneId: 'scene-p24',
    title: '自检：Dart 进阶八道题',
    tri: 'known' as const,
    ...overrides,
  });

  it('★ 措辞是「画像说 X，状态说 Y」，不是「X 是错的」', () => {
    const text = renderLearnerStateBlock({ contradictions: [contradiction()] });
    expect(text).toContain('画像「Dart / Flutter」标着 UNKNOWN');
    expect(text).toContain('自检：Dart 进阶八道题');
    expect(text).toContain('已达判据');
    // 判决书式的措辞会让模型把人写的那句当过期数据覆盖掉。
    expect(text).not.toContain('错误');
    expect(text).not.toContain('画像过期');
    expect(text).not.toContain('应改为');
  });

  it('★ 这一节排在所有节前面 —— 它是「输入打架」，不是又一条数据', () => {
    const text = renderLearnerStateBlock({
      cells: [cell({ tri: 'known', n: 8, k: 8, lb5: 0.78 })],
      concepts: [{ concept: '类与对象', tri: 'known', n: 3, k: 3, lb5: 0.6 }],
      contradictions: [contradiction()],
    });
    const contradictAt = text.indexOf('## 画像与状态不一致');
    expect(contradictAt).toBeGreaterThan(-1);
    expect(contradictAt).toBeLessThan(text.indexOf('## 知识点：'));
    expect(contradictAt).toBeLessThan(text.indexOf('## 已达判据'));
  });

  it('★ 带标题也带 stage/scene —— 标题让人认得出，id 让人查得到', () => {
    const text = renderLearnerStateBlock({ contradictions: [contradiction()] });
    const line = text.split('\n').find((l) => l.startsWith('- 画像「'))!;
    expect(line).toContain('stage--ShZtYAYOj/scene-p24');
  });

  it('未达判据的说法与已达判据不同', () => {
    const text = renderLearnerStateBlock({
      contradictions: [contradiction({ tri: 'not-learned' })],
    });
    expect(text).toContain('未达判据');
    expect(text).not.toContain('已达判据');
  });

  it('没有矛盾时这一节一个字都不出现', () => {
    const text = renderLearnerStateBlock({
      cells: [cell()],
      contradictions: [],
    });
    expect(text).not.toContain('## 画像与状态不一致');
  });

  it('★ 只有矛盾、别处全空时也不许返回空串', () => {
    // 这正是最该被看见的情形：库里有判定，别的节却还什么都没有。
    const text = renderLearnerStateBlock({ contradictions: [contradiction()] });
    expect(text.startsWith(HEADER)).toBe(true);
    expect(text).toContain('## 画像与状态不一致');
  });

  it('按 (领域, 页) 排序，乱序输入同一份输出', () => {
    const items = [
      contradiction({ domain: 'Dart / Flutter', sceneId: 'scene-p24' }),
      contradiction({ domain: 'Java', token: 'Java', sceneId: 'scene-p3' }),
      contradiction({ domain: 'Dart / Flutter', sceneId: 'scene-p1' }),
    ];
    const a = renderLearnerStateBlock({ contradictions: items });
    const b = renderLearnerStateBlock({ contradictions: [...items].reverse() });
    expect(a).toBe(b);
    // 'D' < 'J'，同域内 scene-p1 在 scene-p24 前。
    expect(a.indexOf('scene-p1')).toBeLessThan(a.indexOf('scene-p24'));
  });

  it('标题里的换行被压成空格 —— 一行必须是一条', () => {
    const text = renderLearnerStateBlock({
      contradictions: [contradiction({ title: '自检：Dart\n进阶' })],
    });
    const lines = text.split('\n').filter((l) => l.startsWith('- 画像「'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('自检：Dart 进阶');
  });
});
