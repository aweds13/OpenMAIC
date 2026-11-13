import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import { syncSeedGraph } from '@/lib/persistence/xq-seed-sync';
import type { ConceptGraph, ConceptNode } from '@/lib/persistence/xq-concept-graph';
import {
  BIGRAM_TAU,
  MATCH_REASONS,
  MIN_DICE_CHARS,
  SENSE_VETO_MIN_ANCHORS,
  SUSPECT_CANDIDATE_LIMIT,
  bigramSimilarity,
  buildLexicalIndex,
  buildNamesByConcept,
  decideMany,
  decideThreeWay,
  loadMatchFacts,
  makeConnectedPredicate,
  matchKey,
  senseHits,
} from '@/lib/persistence/xq-three-way-match';
import type { MatchFacts } from '@/lib/persistence/xq-three-way-match';
import type { SeedGraph } from '@/lib/concepts';

/**
 * 这一组钉的是**三段匹配判成哪一段**，不是 SQL 的形状。
 *
 * `J-外来课程接入设计.md` §3.2 的判定树有三条容易实现错的边：
 *
 *   · 「字面命中就判命中」—— 实测错误率 80%（程天学图 234 页命中 10 页，
 *     其中 8 页是「构造」误判）。所以只剩字面时必须降级成存疑。
 *   · 「候选没有锚就不能否决」—— 没锚是「我们对它一无所知」，不是「它不对」。
 *     否决只对**有锚却一个都没中**成立。
 *   · 「bigram τ 还没标定」—— 所以它必须是 `null`，而 `null` 时只有
 *     「一个 bigram 都不重合」才敢判未命中。
 */

const DOCUMENT_SCENES_MIN = `CREATE TABLE IF NOT EXISTS document_stages (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at double precision NOT NULL,
    updated_at double precision NOT NULL,
    data jsonb NOT NULL
  );

CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id text NOT NULL,
  id text NOT NULL,
  scene_order integer,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (stage_id, id)
);
CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
)`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(DOCUMENT_SCENES_MIN);
  await ensureXqLearnerSchema(db);
  return db;
}

function node(
  id: string,
  canonicalName: string,
  kind: ConceptNode['kind'] = 'concept',
): ConceptNode {
  return {
    id,
    canonicalName,
    kind,
    status: 'active',
    mergedInto: null,
    createdIn: 1,
    retiredIn: null,
  };
}

function factsOf(options: {
  nodes: ConceptNode[];
  aliases?: { alias: string; conceptId: string }[];
  anchors?: [string, string[]][];
  stages?: [string, string[]][];
  graph?: ConceptGraph;
}): MatchFacts {
  const nodes = new Map(options.nodes.map((item) => [item.id, item]));
  return {
    lexicalIndex: buildLexicalIndex(nodes, options.aliases ?? []),
    namesByConcept: buildNamesByConcept(nodes, options.aliases ?? []),
    nodes,
    anchors: new Map(options.anchors ?? []),
    stages: new Map((options.stages ?? []).map(([id, list]) => [id, new Set(list)])),
    connected: options.graph === undefined ? () => false : makeConnectedPredicate(options.graph),
  };
}

function graphOf(edges: [string, string, 'prereq' | 'contains'][]): ConceptGraph {
  return {
    nodes: new Map(),
    edges: edges.map(([fromId, toId, relation]) => ({
      fromId,
      toId,
      relation,
      strength: 'strict' as const,
      source: 'test',
      reason: '测试用',
    })),
  };
}

describe('★ 归一与索引：查名字这一步不能自己发明一套规则', () => {
  it('用的是 normalizeConceptName —— 全角、空白、大小写三条都跟着走', () => {
    expect(matchKey('  ＧＩＴ  ')).toBe('git');
    expect(matchKey('WSL2   与  Debian')).toBe('wsl2 与 debian');
    // ★ 刻意不做的四件事之一：不改标点。「a-b」与「a b」不是同一个名字。
    expect(matchKey('a-b')).not.toBe(matchKey('a b'));
  });

  it('规范名与别名进同一张索引 —— 否则「查不到」取决于它是哪种写法', () => {
    const nodes = new Map([['c_1', node('c_1', 'Git 分支')]]);
    const index = buildLexicalIndex(nodes, [{ alias: '分支', conceptId: 'c_1' }]);
    expect(index.get(matchKey('Git 分支'))).toEqual(['c_1']);
    expect(index.get(matchKey('分支'))).toEqual(['c_1']);
  });

  it('★ 一个名字指两个概念时索引里就是两个 —— 歧义是事实，不是脏数据', () => {
    const nodes = new Map([
      ['c_1', node('c_1', '构造方法')],
      ['c_2', node('c_2', '构造')],
    ]);
    const index = buildLexicalIndex(nodes, [{ alias: '构造', conceptId: 'c_1' }]);
    expect(index.get('构造')?.length).toBe(2);
    // 排序稳定（码点序）—— 否则同一批导入两次的候选顺序会漂。
    expect(index.get('构造')).toEqual(['c_1', 'c_2']);
  });

  it('★ 反查表把规范名与别名摊在一个概念下（归一后去重）', () => {
    const nodes = new Map([['c_1', node('c_1', 'Git 分支')]]);
    const names = buildNamesByConcept(nodes, [
      { alias: '分支', conceptId: 'c_1' },
      // 归一后与规范名撞上 —— 同一个名字不该在表里出现两次。
      { alias: 'GIT   分支', conceptId: 'c_1' },
    ]);
    expect(names.get('c_1')).toEqual(['git 分支', '分支']);
  });
});

describe('★ 两个度量：bigram 与义项锚交集', () => {
  it('bigram 相似度对重复字也要算对（多重集计数，不是集合）', () => {
    expect(bigramSimilarity('构造', '构造')).toBe(1);
    expect(bigramSimilarity('构造', '构造方法')).toBeCloseTo((2 * 1) / (1 + 3), 6);
    // ★ bigram 是**两字**窗口，不是一字：「变量」的 bigram 只有 {变量}，
    //   「变脸」只有 {变脸}，一个字相同不算共享 —— 这是刻意的，按单字算
    //   会让「变量/变脸/变形」互相都是 1.0。
    expect(bigramSimilarity('变量', '变脸')).toBe(0);
    expect(bigramSimilarity('构造方法', '构造器')).toBeCloseTo((2 * 1) / (3 + 2), 6);
    expect(bigramSimilarity('变量', '类型')).toBe(0);
  });

  it('单字名没有 bigram —— 只能判完全相等', () => {
    expect(bigramSimilarity('栈', '栈')).toBe(1);
    expect(bigramSimilarity('栈', '堆栈')).toBe(0);
  });

  it('义项锚求交回的是**命中的词**不是布尔（要能数「几种锚中了」）', () => {
    expect(senseHits(['压缩', '归档'], ['压缩', '解压'])).toEqual(['压缩']);
    expect(senseHits(['压缩'], ['归档'])).toEqual([]);
    // 一侧为空时交集一定空 —— 但调用方要区分「候选没锚」与「候选有锚没中」。
    expect(senseHits([], ['压缩'])).toEqual([]);
    expect(senseHits(['压缩'], [])).toEqual([]);
  });
});

describe('★ 判定树：没有字面候选的那一支', () => {
  it('一个 bigram 都不重合 ⇒ 未命中', () => {
    const facts = factsOf({ nodes: [node('c_1', '递归')] });
    const result = decideThreeWay({ externalName: '报价单', senseAnchors: [] }, facts);
    expect(result.tri).toBe('miss');
    expect(result.matchedConceptId).toBeNull();
    expect(result.reason).toBe('no-lexical-candidate');
  });

  it('★ τ 是标定过的数，不是 null —— 判据形状不再随「敢不敢判」改变', () => {
    expect(BIGRAM_TAU).toBe(0.45);
    expect(BIGRAM_TAU).toBeGreaterThan(0.42);
    expect(BIGRAM_TAU).toBeLessThan(0.52);
  });

  it('★ 像到 τ 以上但没进别名表 ⇒ 存疑，理由写「像」不写「没有」', () => {
    // `继承机制` 与 `继承` 的 Dice 是 0.500 —— 不在别名表里，靠 bigram 才认得出。
    const facts = factsOf({ nodes: [node('c_1', '继承')] });
    const result = decideThreeWay({ externalName: '继承机制', senseAnchors: [] }, facts);
    expect(result.tri).toBe('suspect');
    // ★ 理由要说「名字像但我们没把握」，不能写成结论式措辞 ——
    //   裁决的人看到 'no-lexical-candidate' 会以为「图上没有」。
    expect(result.reason).toBe('bigram-similar');
    expect(result.bestSimilarity).toBeGreaterThanOrEqual(BIGRAM_TAU);
  });

  it('★ 像但没到 τ ⇒ 未命中（理由与「毫不相干」分开）', () => {
    const facts = factsOf({ nodes: [node('c_1', '构造方法')] });
    // `方法重载` 与 `构造方法` 只共享「方法」一个窗口，Dice = 2/(3+3) ≈ 0.333。
    const result = decideThreeWay({ externalName: '方法重载', senseAnchors: [] }, facts);
    expect(result.tri).toBe('miss');
    expect(result.reason).toBe('bigram-below-tau');
    expect(result.bestSimilarity).toBeGreaterThan(0);
    expect(result.bestSimilarity).toBeLessThan(BIGRAM_TAU);
  });

  it('★★ 同义变体不许被 τ 判掉 —— 这个数是拿这批变体反推出来的', () => {
    const facts = factsOf({ nodes: [node('c_1', '继承')] });
    const result = decideThreeWay({ externalName: '继承机制', senseAnchors: [] }, facts);
    // `继承机制` 与 `继承` 的 Dice 是 0.500，正好在可用区间上沿 —— 判成 miss
    // 就是漏掉一个该问人的词。
    expect(result.bestSimilarity).toBeGreaterThanOrEqual(BIGRAM_TAU);
    expect(result.tri).not.toBe('miss');
  });
});

describe('★ 模糊分支认全部名字，短名字不进 Dice（F1 + F2）', () => {
  it('★ 别名参与相似度 —— 只比规范名的话 `再循环` 永远够不到 `循环`', () => {
    const facts = factsOf({
      nodes: [node('c_1', '循环结构')],
      aliases: [{ alias: '循环', conceptId: 'c_1' }],
    });
    // 规范名 0.400（只共享「循环」一个窗口）< τ；别名 0.667 ≥ τ。
    const result = decideThreeWay({ externalName: '再循环', senseAnchors: [] }, facts);
    expect(result.tri).toBe('suspect');
    expect(result.reason).toBe('bigram-similar');
    expect(result.bestSimilarity).toBeCloseTo(2 / 3, 6);
  });

  it('★ 取的是「规范名 + 全部别名」里的最大者 —— 不能只翻别名', () => {
    const facts = factsOf({
      nodes: [node('c_1', '方法重载')],
      aliases: [{ alias: '重载', conceptId: 'c_1' }],
    });
    // `方法重写` 对规范名 0.667，对别名 `重载` 0.500 —— 规范名赢，取最大。
    const result = decideThreeWay({ externalName: '方法重写', senseAnchors: [] }, facts);
    expect(result.reason).toBe('bigram-similar');
    expect(result.bestSimilarity).toBeCloseTo(2 / 3, 6);
  });

  it('★ 一个概念有几个说法时，任一个够格就算够格', () => {
    const facts = factsOf({
      nodes: [node('c_1', '基本语言')],
      aliases: [
        { alias: 'BASIC', conceptId: 'c_1' },
        { alias: 'basics', conceptId: 'c_1' },
      ],
    });
    // 审计原样例：`BASIC语言` 经别名 `basics` 是 0.727，而规范名只有 0.222。
    const result = decideThreeWay({ externalName: 'BASIC语言', senseAnchors: [] }, facts);
    expect(result.tri).toBe('suspect');
    expect(result.bestSimilarity).toBeGreaterThanOrEqual(BIGRAM_TAU);
  });

  it('★ 二字别名是 F1 的主力（39 条里 32 条靠它）—— 候选名短不设闸', () => {
    const facts = factsOf({
      nodes: [node('c_1', '方法与字段')],
      aliases: [{ alias: '方法', conceptId: 'c_1' }],
    });
    // 规范名 0.333；别名只有两个字，但 2/Lb = 0.667 恰好是「外来名原样
    // 包含这个短名」的信号。候选侧一起闸，会连 F1 的主战场一起丢掉。
    const result = decideThreeWay({ externalName: '配方法', senseAnchors: [] }, facts);
    expect(result.reason).toBe('bigram-similar');
    expect(result.bestSimilarity).toBeCloseTo(2 / 3, 6);
  });

  it('★ 闸门看的是「这一对」，不是外来名单独短不短', () => {
    // 2 字外来名对 4 字候选名：分数 0.500 带着「包含」的意思，必须照比。
    // 若把闸切在「外来名 < 3 字」上，这条路会被判成 `short-name-no-fuzzy`。
    const facts = factsOf({ nodes: [node('c_1', '循环结构')] });
    const result = decideThreeWay({ externalName: '循环', senseAnchors: [] }, facts);
    expect(result.reason).toBe('bigram-similar');
    expect(result.bestSimilarity).toBeCloseTo(0.5, 6);
    expect(result.tri).toBe('suspect');
    // ★ 形状写死：短名闸不许把这一对推到「没得比」那一档。
    expect(result.reason).not.toBe('short-name-no-fuzzy');
  });

  it('★ 两侧都只有两字 ⇒ Dice 只可能是 0/1，不比，理由单独一档', () => {
    const facts = factsOf({ nodes: [node('c_1', '接口')] });
    const result = decideThreeWay({ externalName: '路由', senseAnchors: [] }, facts);
    expect(result.tri).toBe('miss');
    expect(result.reason).toBe('short-name-no-fuzzy');
    // ★ null 而不是 0：「没得比」与「比过、毫不相干」在报告里是两句话。
    expect(result.bestSimilarity).toBeNull();
    expect(MATCH_REASONS).toContain('short-name-no-fuzzy');
  });

  it('★ 单字名一个窗口都没有 ⇒ 同样落到 short-name-no-fuzzy', () => {
    const facts = factsOf({ nodes: [node('c_1', '堆栈')] });
    const result = decideThreeWay({ externalName: '栈', senseAnchors: [] }, facts);
    expect(result.reason).toBe('short-name-no-fuzzy');
    expect(result.bestSimilarity).toBeNull();
  });

  it('★ 短名闸不许架在「完全相等」前面 —— 那是字面分支的事', () => {
    const facts = factsOf({ nodes: [node('c_1', '接口')] });
    const result = decideThreeWay({ externalName: '接口', senseAnchors: [] }, facts);
    // 两字名归一后相等 ⇒ 走字面，哪怕它短于 MIN_DICE_CHARS。
    expect(result.reason).toBe('lexical-only');
    expect(result.candidates.map((item) => item.conceptId)).toEqual(['c_1']);
    expect(result.bestSimilarity).toBeNull();
  });

  it('闸门钉在 MIN_DICE_CHARS 上：三字名仍然要比', () => {
    expect(MIN_DICE_CHARS).toBe(3);
    const facts = factsOf({ nodes: [node('c_1', '循环')] });
    const result = decideThreeWay({ externalName: '再循环', senseAnchors: [] }, facts);
    expect(result.reason).toBe('bigram-similar');
    expect(result.bestSimilarity).toBeCloseTo(2 / 3, 6);
  });
});

describe('★ 判定树：字面命中之后还有三道关', () => {
  // ★ 三个锚 —— 刚好到 `SENSE_VETO_MIN_ANCHORS`。换个数字就没法测否决了：
  //   两个锚时这条路径会走 `sense-too-thin`（见下面「锚太薄」那组），
  //   那是刻意的：词表薄的时候我们不许说「它不像」。
  const constructorFacts = (): MatchFacts =>
    factsOf({
      nodes: [node('c_oop', '构造方法')],
      anchors: [['c_oop', ['构造器', '构造函数', '实例化']]],
    });

  it('候选 ≥ 2 ⇒ 直接存疑（字面本身就有歧义）', () => {
    const facts = factsOf({
      nodes: [node('c_1', '构造方法'), node('c_2', '构造')],
      aliases: [{ alias: '构造', conceptId: 'c_1' }],
    });
    const result = decideThreeWay({ externalName: '构造', senseAnchors: [] }, facts);
    expect(result.tri).toBe('suspect');
    expect(result.reason).toBe('lexical-ambiguous');
    expect(result.candidates.length).toBeGreaterThanOrEqual(SUSPECT_CANDIDATE_LIMIT);
    // 歧义时也要把每个候选评估出来 —— 人裁决时要看到为什么。
    expect(result.candidates.every((item) => item.signals.includes('lexical'))).toBe(true);
  });

  it('★★ 「构造」这个真例子：字面中了、锚一个都没中 ⇒ 存疑，不许判命中', () => {
    const result = decideThreeWay(
      { externalName: '构造方法', senseAnchors: ['构造题', '构造解'] },
      constructorFacts(),
    );
    expect(result.tri).toBe('suspect');
    expect(result.matchedConceptId).toBeNull();
    expect(result.reason).toBe('all-vetoed');
    expect(result.candidates[0].vetoed).toBe(true);
    // ★ 否决优先于加分：上下文支持也不许把它救回来。
    expect(result.candidates[0].signals).not.toContain('context');
  });

  it('★ 锚交集非空 ⇒ 命中，且理由写的是 sense 不是 context', () => {
    const result = decideThreeWay(
      { externalName: '构造方法', senseAnchors: ['构造函数'] },
      constructorFacts(),
    );
    expect(result.tri).toBe('hit');
    expect(result.matchedConceptId).toBe('c_oop');
    expect(result.reason).toBe('sense-supported');
  });

  it('★★ 外来侧没给锚时，带着锚的候选也不许被否决 —— 空缺不是反对证据', () => {
    // 这条是拿 104 个种子名喂进去之后才发现的：`senseAnchors` 留空时，
    // 36 个有锚的概念全被判成 `all-vetoed`（「被义项锚否决」），
    // 而真相是外来侧根本没说话。
    const result = decideThreeWay(
      { externalName: '构造方法', senseAnchors: [] },
      constructorFacts(),
    );
    expect(result.tri).toBe('suspect');
    expect(result.reason).toBe('lexical-only');
    expect(result.candidates[0].vetoed).toBe(false);
    // 给了锚但一个都没中，才是否决。
    const vetoed = decideThreeWay(
      { externalName: '构造方法', senseAnchors: ['构造题'] },
      constructorFacts(),
    );
    expect(vetoed.reason).toBe('all-vetoed');
    expect(vetoed.candidates[0].vetoed).toBe(true);
  });

  it('★ 没有锚的候选不许被否决 —— 沉默不是证据', () => {
    const facts = factsOf({ nodes: [node('c_1', 'Git')] });
    const result = decideThreeWay(
      { externalName: 'Git', senseAnchors: ['版本控制'], stageId: 'stage-A' },
      facts,
    );
    // 没锚 ⇒ 没否决；但也没有 context support ⇒ 只剩字面 ⇒ 存疑。
    expect(result.tri).toBe('suspect');
    expect(result.reason).toBe('lexical-only');
    expect(result.candidates[0].vetoed).toBe(false);
  });

  it('★★ 锚太薄时不许否决 —— 拿自己的词表薄去怀疑对方，是自伤', () => {
    // 真库实测的反例：`构造方法` 的锚只有 ["编译"]。于是语义正确的
    // `构造器` / `父类` / `super` 全被判 `all-vetoed`，而错误的 `编译` 反而命中。
    // 单锚概念等于「它只认一个词」，任何同义说法都成了反对证据。
    const thin = factsOf({
      nodes: [node('c_oop', '构造方法')],
      anchors: [['c_oop', ['编译']]],
    });
    const result = decideThreeWay(
      { externalName: '构造方法', senseAnchors: ['构造器', '父类', 'super'] },
      thin,
    );
    expect(result.tri).toBe('suspect');
    // ★ 理由必须指向「我们词表薄」，不是「它像不像」。
    expect(result.reason).toBe('sense-too-thin');
    expect(result.candidates[0].vetoed).toBe(false);
    expect(result.candidates[0].senseTooThin).toBe(true);
  });

  it('★ 锚够厚时才轮到否决 —— 门槛是常量本身，不是随手写的数', () => {
    // 同一个概念名、同一组外来锚，只改我们自己词表的厚度，结论就应当不同。
    const enough = (count: number): MatchFacts =>
      factsOf({
        nodes: [node('c_oop', '构造方法')],
        anchors: [['c_oop', Array.from({ length: count }, (_unused, index) => `词${index}`)]],
      });
    const thin = decideThreeWay(
      { externalName: '构造方法', senseAnchors: ['构造器'] },
      enough(SENSE_VETO_MIN_ANCHORS - 1),
    );
    expect(thin.reason).toBe('sense-too-thin');
    expect(thin.candidates[0].vetoed).toBe(false);

    const thick = decideThreeWay(
      { externalName: '构造方法', senseAnchors: ['构造器'] },
      enough(SENSE_VETO_MIN_ANCHORS),
    );
    expect(thick.reason).toBe('all-vetoed');
    expect(thick.candidates[0].vetoed).toBe(true);
  });

  it('★ 薄锚仍然可以「支持」—— 取消的是否决权，不是信息', () => {
    const thin = factsOf({
      nodes: [node('c_oop', '构造方法')],
      anchors: [['c_oop', ['编译']]],
    });
    const result = decideThreeWay({ externalName: '构造方法', senseAnchors: ['编译'] }, thin);
    // 交集非空 ⇒ sense 信号照给 ⇒ 两个信号 ⇒ 命中。
    expect(result.tri).toBe('hit');
    expect(result.reason).toBe('sense-supported');
    expect(result.candidates[0].senseTooThin).toBe(false);
  });

  it('★★ 外来侧用的正是我们登记的别名 ⇒ 语义对上了，不许否决', () => {
    // `anchors` 按定义不许是概念名或别名，所以「它说的是我们的别名」这条
    // 永远不可能与 anchors 相交。不单独处理就会「越熟悉的概念越容易被拒」。
    const facts = factsOf({
      nodes: [node('c_git', 'Git')],
      aliases: [{ alias: '版本控制', conceptId: 'c_git' }],
      anchors: [['c_git', ['分支', '合并', '命令']]],
    });
    const result = decideThreeWay({ externalName: '版本控制', senseAnchors: ['版本控制'] }, facts);
    expect(result.tri).toBe('hit');
    expect(result.matchedConceptId).toBe('c_git');
    expect(result.reason).toBe('sense-supported');
    expect(result.candidates[0].vetoed).toBe(false);
  });

  it('★ 别名对上只在**那个**概念上生效，不会顺手救别的候选', () => {
    const facts = factsOf({
      nodes: [node('c_git', 'Git'), node('c_git2', 'Git 分支')],
      aliases: [{ alias: '版本控制', conceptId: 'c_git' }],
      anchors: [
        ['c_git', ['分支', '合并', '命令']],
        ['c_git2', ['切换', '检出', '合并']],
      ],
    });
    const result = decideThreeWay({ externalName: '版本控制', senseAnchors: ['版本控制'] }, facts);
    // 一个字面候选、sense 命中 ⇒ 命中；`Git 分支` 根本不是字面候选，不该跟进来。
    expect(result.tri).toBe('hit');
    expect(result.candidates.map((c) => c.conceptId)).toEqual(['c_git']);
  });

  it('★ 外来词与我们**无关**时照旧否决 —— 这一条不是给所有词开的后门', () => {
    const facts = factsOf({
      nodes: [node('c_git', 'Git')],
      aliases: [{ alias: '版本控制', conceptId: 'c_git' }],
      anchors: [['c_git', ['分支', '合并', '命令']]],
    });
    const result = decideThreeWay(
      { externalName: '版本控制', senseAnchors: ['代数方程', '矩阵'] },
      facts,
    );
    expect(result.tri).toBe('suspect');
    expect(result.candidates[0].vetoed).toBe(true);
  });

  it('★ 无锚 + 本课已有 occurrence ⇒ 命中（信号 B ②）', () => {
    const facts = factsOf({
      nodes: [node('c_1', 'Git')],
      stages: [['c_1', ['stage-A']]],
    });
    const result = decideThreeWay(
      { externalName: 'Git', senseAnchors: [], stageId: 'stage-A' },
      facts,
    );
    expect(result.tri).toBe('hit');
    expect(result.reason).toBe('context-supported');
  });

  it('本课没出现过就不算 —— 别的课出现过不是上下文', () => {
    const facts = factsOf({
      nodes: [node('c_1', 'Git')],
      stages: [['c_1', ['stage-B']]],
    });
    const result = decideThreeWay(
      { externalName: 'Git', senseAnchors: [], stageId: 'stage-A' },
      facts,
    );
    expect(result.tri).toBe('suspect');
  });

  it('★ kind 一致算支持；外来侧没说 kind 时不算（「没说」不是「说了对」）', () => {
    const facts = factsOf({ nodes: [node('c_1', 'Git', 'tool')] });
    expect(
      decideThreeWay({ externalName: 'Git', externalKind: 'tool', senseAnchors: [] }, facts).tri,
    ).toBe('hit');
    expect(decideThreeWay({ externalName: 'Git', senseAnchors: [] }, facts).tri).toBe('suspect');
  });

  it('已映射的祖先与候选有路径 ⇒ 命中', () => {
    const facts = factsOf({
      nodes: [node('c_1', 'Git 分支'), node('c_2', 'Git')],
      graph: graphOf([['c_2', 'c_1', 'prereq']]),
    });
    const result = decideThreeWay(
      { externalName: 'Git 分支', mappedAncestors: ['c_2'], senseAnchors: [] },
      facts,
    );
    expect(result.tri).toBe('hit');
    expect(result.reason).toBe('context-supported');
  });

  it('候选自己就是祖先时不算「有路径」（同一节点不是上下文）', () => {
    const facts = factsOf({
      nodes: [node('c_1', 'Git')],
      graph: graphOf([]),
    });
    const result = decideThreeWay(
      { externalName: 'Git', mappedAncestors: ['c_1'], senseAnchors: [] },
      facts,
    );
    expect(result.tri).toBe('suspect');
  });
});

describe('★ 路径判定：只认一步与两步，再远就不是上下文', () => {
  it('一步中、两步中、三步不中', () => {
    const connected = makeConnectedPredicate(
      graphOf([
        ['a', 'b', 'prereq'],
        ['b', 'c', 'contains'],
        ['c', 'd', 'prereq'],
      ]),
    );
    expect(connected('a', 'b')).toBe(true);
    expect(connected('a', 'c')).toBe(true);
    expect(connected('a', 'd')).toBe(false);
    // 双向：contains 是归属，从子往父查也要中。
    expect(connected('c', 'a')).toBe(true);
  });

  it('不相干的节点不中；同一节点算中', () => {
    const connected = makeConnectedPredicate(graphOf([['a', 'b', 'prereq']]));
    expect(connected('a', 'x')).toBe(false);
    expect(connected('a', 'a')).toBe(true);
  });
});

describe('★ 从库里读事实：读错一处，判定全歪', () => {
  async function seedGraph(db: PGlite): Promise<void> {
    const graph: SeedGraph = {
      concepts: [
        { key: 'ctor', name: '构造方法', kind: 'concept', aliases: ['构造器'] },
        { key: 'git', name: 'Git', kind: 'tool', aliases: [] },
      ],
      edges: [
        {
          from: 'git',
          to: 'ctor',
          relation: 'prereq',
          strength: 'strict',
          reason: '测试用的先修边，长度为十以上。',
          source: 'test',
        },
      ],
    };
    await syncSeedGraph(db, { graph, execute: true });
  }

  it('★ 别名不按 ambiguous 过滤 —— 含混的别名本来就是「一名多指」的事实', async () => {
    const db = await freshDb();
    await seedGraph(db);
    // 手工造一条含混别名：同一个「构造」指两个概念。
    await db.query(
      `INSERT INTO xq_concept_alias (alias, kind, concept_id, source, ambiguous)
       SELECT '构造', 'concept', id, 'test', true FROM xq_concept WHERE canonical_name IN ('构造方法', 'Git')`,
    );
    const facts = await loadMatchFacts(db);
    const ids = facts.lexicalIndex.get('构造');
    expect(ids?.length).toBe(2);
  });

  it('锚、页分布、路径都读进来了', async () => {
    const db = await freshDb();
    await seedGraph(db);
    await db.query(
      `UPDATE xq_concept SET anchors = ARRAY['构造器'] WHERE canonical_name = '构造方法'`,
    );
    await db.query(
      `INSERT INTO document_scenes (stage_id, id, scene_order, data)
       VALUES ('stage-A', 'scene-p1', 1, '{"title":"t","type":"slide","content":{}}'::jsonb)`,
    );
    await db.query(
      `INSERT INTO xq_concept_occurrence (concept_id, stage_id, scene_id, weight, source)
       SELECT id, 'stage-A', 'scene-p1', 0.4, 'body' FROM xq_concept WHERE canonical_name = 'Git'`,
    );

    const facts = await loadMatchFacts(db);
    const ctor = [...facts.nodes.values()].find((item) => item.canonicalName === '构造方法');
    const git = [...facts.nodes.values()].find((item) => item.canonicalName === 'Git');
    expect(ctor).toBeDefined();
    expect(git).toBeDefined();
    expect(facts.anchors.get(ctor!.id)).toEqual(['构造器']);
    expect(facts.stages.get(git!.id)?.has('stage-A')).toBe(true);
    // 种子里 Git → 构造方法 有一条 prereq 边。
    expect(facts.connected(ctor!.id, git!.id)).toBe(true);
  });

  it('★ 别名进了 namesByConcept —— 否则模糊分支还是只看规范名', async () => {
    const db = await freshDb();
    await seedGraph(db);
    const facts = await loadMatchFacts(db);
    const ctor = [...facts.nodes.values()].find((item) => item.canonicalName === '构造方法');
    expect(ctor).toBeDefined();
    // 规范名与种子里的别名都在，且是**归一后**的形态 —— 查名字与比名字
    // 必须共用 `matchKey` 一套规则，否则大小写/全角一漂就漏。
    expect(facts.namesByConcept.get(ctor!.id)).toEqual(['构造器', '构造方法']);
  });

  it('没有锚的概念在 facts 里是「没有这个键」，不是空数组', async () => {
    const db = await freshDb();
    await seedGraph(db);
    const facts = await loadMatchFacts(db);
    const git = [...facts.nodes.values()].find((item) => item.canonicalName === 'Git');
    expect(facts.anchors.has(git!.id)).toBe(false);
  });

  it('decideMany 共用一份事实，结果与逐个判一样', async () => {
    const db = await freshDb();
    await seedGraph(db);
    const facts = await loadMatchFacts(db);
    const inputs = [
      { externalName: '构造器', senseAnchors: [] },
      { externalName: '报价单', senseAnchors: [] },
    ];
    const results = decideMany(inputs, facts);
    expect(results.length).toBe(2);
    expect(results[0].tri).toBe(decideThreeWay(inputs[0], facts).tri);
    expect(results[1].reason).toBe('no-lexical-candidate');
  });
});
