import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import {
  conceptReadiness,
  cyclesIn,
  directPrerequisites,
  isConceptId,
  prerequisiteClosure,
  prerequisiteDepth,
  readConceptGraph,
  resolveConcept,
  type ConceptEdge,
  type ConceptGraph,
  type ConceptNode,
  type PrereqStrength,
} from '@/lib/persistence/xq-concept-graph';

const DOCUMENT_SCENES_MIN = `
CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id text NOT NULL,
  id text NOT NULL,
  scene_order integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (stage_id, id)
);`;

const A = 'c_aaaaaaaaaaaa';
const B = 'c_bbbbbbbbbbbb';
const C = 'c_cccccccccccc';
const D = 'c_dddddddddddd';
const E = 'c_eeeeeeeeeeee';
const F = 'c_ffffffffffff';

function node(id: string, overrides: Partial<ConceptNode> = {}): ConceptNode {
  return {
    id,
    canonicalName: id,
    kind: 'concept',
    status: 'active',
    mergedInto: null,
    createdIn: 1,
    retiredIn: null,
    ...overrides,
  };
}

function prereq(fromId: string, toId: string, strength: PrereqStrength = 'strict'): ConceptEdge {
  return { fromId, toId, relation: 'prereq', strength };
}

function contains(fromId: string, toId: string): ConceptEdge {
  return { fromId, toId, relation: 'contains', strength: null };
}

function graph(nodes: ConceptNode[], edges: ConceptEdge[]): ConceptGraph {
  return { nodes: new Map(nodes.map((n) => [n.id, n])), edges };
}

const STRICT_AND_RECOMMENDED: ReadonlySet<PrereqStrength> = new Set(['strict', 'recommended']);

describe('isConceptId', () => {
  it('只认 c_ 加十二位小写十六进制', () => {
    expect(isConceptId(A)).toBe(true);
    expect(isConceptId('c_0123456789ab')).toBe(true);
  });

  it('大写、长度不对、别的前缀都不是', () => {
    for (const bad of [
      'c_AAAAAAAAAAAA',
      'c_aaaaaaaaaaa',
      'c_aaaaaaaaaaaaa',
      'x_aaaaaaaaaaaa',
      'aaaaaaaaaaaa',
      '',
    ]) {
      expect(isConceptId(bad)).toBe(false);
    }
  });
});

describe('resolveConcept', () => {
  it('顺着合并链走到底', () => {
    const g = graph(
      [
        node(A, { status: 'merged', mergedInto: B }),
        node(B, { status: 'merged', mergedInto: C }),
        node(C),
      ],
      [],
    );
    expect(resolveConcept(g, A)).toBe(C);
    expect(resolveConcept(g, C)).toBe(C);
  });

  it('★ 合并链成环时返回 null —— 没有终点，不能猜', () => {
    const g = graph(
      [node(A, { status: 'merged', mergedInto: B }), node(B, { status: 'merged', mergedInto: A })],
      [],
    );
    expect(resolveConcept(g, A)).toBeNull();
  });

  it('链断在半路（指向不存在的行）返回 null', () => {
    const g = graph([node(A, { status: 'merged', mergedInto: 'c_000000000000' })], []);
    expect(resolveConcept(g, A)).toBeNull();
  });

  it('不存在的 id 也返回 null', () => {
    expect(resolveConcept(graph([], []), A)).toBeNull();
  });
});

describe('directPrerequisites', () => {
  it('一条链：只给直接先修，不给闭包', () => {
    const g = graph([node(A), node(B), node(C)], [prereq(A, B), prereq(B, C)]);
    expect(directPrerequisites(g, C).prerequisites).toEqual([B]);
    expect(directPrerequisites(g, B).prerequisites).toEqual([A]);
    expect(directPrerequisites(g, A).prerequisites).toEqual([]);
  });

  it('★ contains 不算先修 —— 学完整个域才能学其中一个主题是荒谬序列', () => {
    const g = graph([node(A), node(B)], [contains(A, B)]);
    expect(directPrerequisites(g, B).prerequisites).toEqual([]);
  });

  it('菱形去重：两条路径指到同一个先修只算一次', () => {
    const g = graph(
      [node(A), node(B), node(C), node(D)],
      [prereq(A, B), prereq(A, C), prereq(B, D), prereq(C, D)],
    );
    expect(directPrerequisites(g, D).prerequisites).toEqual([B, C]);
  });

  it('★ 先修被合并时解析到合并后的那个', () => {
    const g = graph(
      [node(A, { status: 'merged', mergedInto: B }), node(B), node(C)],
      [prereq(A, C)],
    );
    expect(directPrerequisites(g, C).prerequisites).toEqual([B]);
  });

  it('★ 先修的合并链断了 —— 进 unresolved，不当成「没有先修」', () => {
    const g = graph([node(A, { status: 'merged', mergedInto: null }), node(C)], [prereq(A, C)]);
    expect(directPrerequisites(g, C)).toEqual({ prerequisites: [], unresolved: [A] });
  });

  it('自环（from === to）被 DDL 挡住，但函数也不把它当先修', () => {
    const g = graph([node(A)], [prereq(A, A)]);
    expect(directPrerequisites(g, A).prerequisites).toEqual([]);
  });

  it('默认只认 strict —— recommended 不进默认口径', () => {
    const g = graph([node(A), node(B)], [prereq(A, B, 'recommended')]);
    expect(directPrerequisites(g, B).prerequisites).toEqual([]);
    expect(directPrerequisites(g, B, STRICT_AND_RECOMMENDED).prerequisites).toEqual([A]);
  });
});

describe('prerequisiteClosure', () => {
  it('传递闭包不含自己', () => {
    const g = graph([node(A), node(B), node(C)], [prereq(A, B), prereq(B, C)]);
    expect(prerequisiteClosure(g, C)).toEqual({
      conceptId: C,
      closure: [A, B],
      retired: [],
      cycle: false,
    });
  });

  it('★ 环：cycle 为真，且不爆栈', () => {
    const g = graph([node(A), node(B), node(C)], [prereq(A, B), prereq(B, C), prereq(C, A)]);
    const result = prerequisiteClosure(g, C);
    expect(result.cycle).toBe(true);
    expect([...result.closure].sort()).toEqual([A, B]);
  });

  it('★ 闭包里的退役先修单独交出来 —— 挡住它的那个概念可能已经不存在了', () => {
    const g = graph(
      [node(A, { status: 'retired' }), node(B), node(C)],
      [prereq(A, B), prereq(B, C)],
    );
    expect(prerequisiteClosure(g, C).retired).toEqual([A]);
  });

  it('没有先修时闭包为空', () => {
    expect(prerequisiteClosure(graph([node(A)], []), A)).toEqual({
      conceptId: A,
      closure: [],
      retired: [],
      cycle: false,
    });
  });

  it('不存在的概念回空闭包而不是抛', () => {
    expect(prerequisiteClosure(graph([], []), A)).toEqual({
      conceptId: A,
      closure: [],
      retired: [],
      cycle: false,
    });
  });
});

describe('prerequisiteDepth', () => {
  it('★ 取最长路径，不取最短 —— 垫了五层不该看起来一步就到', () => {
    // A 到 E 有两条路：A→E 直接（一层），A→B→C→D→E（四层）。
    const g = graph(
      [node(A), node(B), node(C), node(D), node(E)],
      [prereq(A, E), prereq(A, B), prereq(B, C), prereq(C, D), prereq(D, E)],
    );
    expect(prerequisiteDepth(g, E)).toBe(4);
  });

  it('根节点深度 0', () => {
    expect(prerequisiteDepth(graph([node(A)], []), A)).toBe(0);
  });

  it('★ 有环时返回 null —— 环上的最长路径没有定义，给个数就是编的', () => {
    const g = graph([node(A), node(B)], [prereq(A, B), prereq(B, A)]);
    expect(prerequisiteDepth(g, A)).toBeNull();
  });

  it('长链不爆栈（300 层）', () => {
    const nodes: ConceptNode[] = [];
    const edges: ConceptEdge[] = [];
    for (let i = 0; i < 300; i += 1) {
      nodes.push(node(`c_${i.toString(16).padStart(12, '0')}`));
      if (i > 0)
        edges.push(
          prereq(
            `c_${(i - 1).toString(16).padStart(12, '0')}`,
            `c_${i.toString(16).padStart(12, '0')}`,
          ),
        );
    }
    const g = graph(nodes, edges);
    expect(prerequisiteDepth(g, `c_${(299).toString(16).padStart(12, '0')}`)).toBe(299);
  });

  it('不存在的概念返回 null', () => {
    expect(prerequisiteDepth(graph([], []), A)).toBeNull();
  });
});

describe('cyclesIn', () => {
  it('无环图返回空', () => {
    const g = graph([node(A), node(B), node(C)], [prereq(A, B), prereq(B, C)]);
    expect(cyclesIn(g)).toEqual([]);
  });

  it('三元环被找出来，且起点按最小 id 归一', () => {
    const g = graph([node(A), node(B), node(C)], [prereq(A, B), prereq(B, C), prereq(C, A)]);
    expect(cyclesIn(g)).toEqual([[A, B, C]]);
  });

  it('两个独立的环都找出来', () => {
    const g = graph(
      [node(A), node(B), node(C), node(D), node(E), node(F)],
      [prereq(A, B), prereq(B, A), prereq(D, E), prereq(E, F), prereq(F, D)],
    );
    const rings = cyclesIn(g);
    expect(rings).toHaveLength(2);
    expect(rings.map((r) => r.length).sort()).toEqual([2, 3]);
  });
});

describe('conceptReadiness', () => {
  const g = graph([node(A), node(B), node(C)], [prereq(A, B), prereq(B, C)]);

  it('★ 判的是整个闭包，不只是直接先修', () => {
    // 直接先修 B 会了，但 B 的先修 A 不会 ⇒ 还不能学 C。
    expect(conceptReadiness(g, C, new Set([B]))).toMatchObject({ ready: false, blockedBy: [A] });
  });

  it('闭包全会才 ready', () => {
    expect(conceptReadiness(g, C, new Set([A, B]))).toMatchObject({ ready: true, blockedBy: [] });
  });

  it('没有先修的概念直接 ready —— 没有要先垫的东西', () => {
    expect(conceptReadiness(g, A, new Set())).toMatchObject({ ready: true, blockedBy: [] });
  });

  it('★ 有环时永远不 ready', () => {
    const cyclic = graph([node(A), node(B)], [prereq(A, B), prereq(B, A)]);
    expect(conceptReadiness(cyclic, B, new Set([A]))).toMatchObject({ ready: false, cycle: true });
  });

  it('退役先修同时出现在 retired 里', () => {
    const r = graph([node(A, { status: 'retired' }), node(B)], [prereq(A, B)]);
    expect(conceptReadiness(r, B, new Set())).toMatchObject({
      ready: false,
      blockedBy: [A],
      retired: [A],
    });
  });

  it('★ 本函数不判谁掌握了 —— 空 mastered 时「有先修」就是没 ready', () => {
    expect(conceptReadiness(g, B, new Set()).ready).toBe(false);
    expect(conceptReadiness(g, B, new Set([A])).ready).toBe(true);
  });

  it('不存在的概念不 ready 且不炸', () => {
    expect(conceptReadiness(graph([], []), A, new Set())).toEqual({
      conceptId: A,
      ready: false,
      blockedBy: [],
      retired: [],
      cycle: false,
    });
  });
});

describe('readConceptGraph', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await ensureXqLearnerSchema(db);
  });

  async function seed(): Promise<void> {
    // 版本 1 由迁移建好；概念与边直接写。
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, status, merged_into, created_in)
       VALUES ($1, 'Dart 变量', 'concept', 'active', NULL, 1),
              ($2, 'Dart 空安全', 'concept', 'active', NULL, 1),
              ($3, '旧名', 'concept', 'merged', $2, 1),
              ($4, '已退役', 'concept', 'retired', NULL, 1),
              ($5, '工具链', 'tool', 'active', NULL, 1)`,
      [A, B, C, D, E],
    );
    await db.query(
      `INSERT INTO xq_concept_edge (from_id, to_id, relation, strength, reason, source)
       VALUES ($1, $2, 'prereq', 'strict', '空安全必须建立在变量与类型之上', 'cs2023'),
              ($3, $4, 'prereq', 'recommended', '旧名那条边指到合并后的概念', 'course-outline'),
              ($5, $2, 'contains', NULL, '这个域包含这个主题', 'acm-graph')`,
      [A, B, C, B, E],
    );
  }

  it('★ 读回节点与边，退役与合并的节点也在图里', async () => {
    await seed();
    const g = await readConceptGraph(db);
    expect([...g.nodes.keys()].sort()).toEqual([A, B, C, D, E]);
    expect(g.nodes.get(C)?.status).toBe('merged');
    expect(g.nodes.get(C)?.mergedInto).toBe(B);
    expect(g.nodes.get(D)?.status).toBe('retired');
    expect(g.nodes.get(E)?.kind).toBe('tool');
    expect(g.edges).toHaveLength(3);
    expect(g.nodes.get(A)?.createdIn).toBe(1);
  });

  it('★ 一条 recommended 边默认不进口径，但能显式读到', async () => {
    await seed();
    const g = await readConceptGraph(db);
    expect(directPrerequisites(g, B).prerequisites).toEqual([A]);
    expect(directPrerequisites(g, B, STRICT_AND_RECOMMENDED).prerequisites).toEqual([A]);
    // C 合并进 B 之后，「C 是先修」这条边仍能被解析成 B 自己 ⇒ 不算先修。
    expect(directPrerequisites(g, B, STRICT_AND_RECOMMENDED).unresolved).toEqual([]);
  });

  it('★ contains 边读进来但不参与先修判断', async () => {
    await seed();
    const g = await readConceptGraph(db);
    const toB = g.edges.filter((edge) => edge.toId === B);
    // 三条边都指到 B：A→B strict、C→B recommended（C 已合并进 B）、E→B contains。
    expect(toB.map((edge) => edge.relation).sort()).toEqual(['contains', 'prereq', 'prereq']);
    expect(conceptReadiness(g, B, new Set()).ready).toBe(false);
  });

  it('空图回空图而不是抛', async () => {
    const g = await readConceptGraph(db);
    expect(g.nodes.size).toBe(0);
    expect(g.edges).toHaveLength(0);
  });
});
