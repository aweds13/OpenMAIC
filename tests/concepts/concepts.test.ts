/**
 * `lib/concepts` 的判据：id 形状、名字归一、种子图完整性、页级挂载的严苛性。
 *
 * ★ 为什么这里断言得这么细：这三个模块是**纯函数**，而它们下游是会拦人的东西
 *   ——「你还不到学这个的时候」这句话就是由先修边算出来的。一条错的边、一次
 *   宽松的匹配，代价是学习者被挡在正确的内容外面，或者被推去做还没学过的题。
 */
import { describe, expect, it } from 'vitest';

import {
  CONCEPT_ID_HEX_LENGTH,
  CONCEPT_ID_PREFIX,
  buildSeedGraph,
  deriveOccurrencesFromOutlines,
  newConceptId,
  normalizeConceptName,
} from '@/lib/concepts';
import type { SeedGraph } from '@/lib/concepts';

describe('ids: 主键形状', () => {
  it('是 `c_` + 12 位小写 hex，不含任何语义', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newConceptId();
      expect(id).toMatch(/^c_[0-9a-f]{12}$/u);
      expect(id.length).toBe(CONCEPT_ID_PREFIX.length + CONCEPT_ID_HEX_LENGTH);
    }
  });

  it('连续生成 2000 个不重复（48 bit 空间，这个量级不该撞）', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i += 1) ids.add(newConceptId());
    expect(ids.size).toBe(2000);
  });
});

describe('ids: 名字归一', () => {
  it('去空白 / 全角转半角 / 压连续空白 / 小写化', () => {
    expect(normalizeConceptName('  数组  ')).toBe('数组');
    expect(normalizeConceptName('ＡＢＣ')).toBe('abc');
    expect(normalizeConceptName('a\u3000b')).toBe('a b');
    expect(normalizeConceptName('a\u00a0\u00a0b')).toBe('a b');
    expect(normalizeConceptName('Constructor')).toBe('constructor');
    expect(normalizeConceptName('（全角括号）')).toBe('(全角括号)');
  });

  it('★ 不做同义归并 —— 这是刻意的，不是漏了', () => {
    // 归并是判断，判断要有出处。一个自动同义词表会把两个概念永久合并，
    // 而合并之后没有任何痕迹能拆开（见 ids.ts 文件头）。
    expect(normalizeConceptName('构造函数')).not.toBe(normalizeConceptName('构造方法'));
    expect(normalizeConceptName('数组')).not.toBe(normalizeConceptName('Arrays'));
    expect(normalizeConceptName('list')).not.toBe(normalizeConceptName('ArrayList'));
  });

  it('全是空白时返回空串（调用方据此丢弃）', () => {
    expect(normalizeConceptName('')).toBe('');
    expect(normalizeConceptName('   ')).toBe('');
    expect(normalizeConceptName('\u3000')).toBe('');
  });
});

describe('seed: 图本身成立', () => {
  const graph: SeedGraph = buildSeedGraph();

  it('规模在「宁少不乱」的预算内', () => {
    // 先修边预算 100–250 条（平均 2 条/概念），依据 os-taxonomy 2.15 条/节点，
    // 而 MOOCCubeX 的 22 条/节点被判「比稀疏更差」。超出上界要有人解释为什么。
    expect(graph.concepts.length).toBeGreaterThanOrEqual(50);
    expect(graph.concepts.length).toBeLessThanOrEqual(300);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeLessThanOrEqual(250);
  });

  it('没有悬空边、没有自环', () => {
    const keys = new Set(graph.concepts.map((c) => c.key));
    for (const edge of graph.edges) {
      expect(keys.has(edge.from), `悬空 from: ${edge.from}`).toBe(true);
      expect(keys.has(edge.to), `悬空 to: ${edge.to}`).toBe(true);
      expect(edge.from).not.toBe(edge.to);
    }
  });

  it('每条边都有能读的理由（表上有 length(btrim(reason)) > 0 的约束）', () => {
    for (const edge of graph.edges) {
      expect(edge.reason.trim().length, `${edge.from} -> ${edge.to}`).toBeGreaterThanOrEqual(10);
    }
  });

  it('★ preqeq 边构成 DAG —— 有环的图算不出「先学什么」', () => {
    const adj = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (edge.relation !== 'prereq') continue;
      const list = adj.get(edge.from) ?? [];
      list.push(edge.to);
      adj.set(edge.from, list);
    }
    const state = new Map<string, 1 | 2>();
    const cycles: string[] = [];
    const visit = (node: string, path: string[]): void => {
      const seen = state.get(node);
      if (seen === 1) {
        cycles.push([...path, node].join(' -> '));
        return;
      }
      if (seen === 2) return;
      state.set(node, 1);
      for (const next of adj.get(node) ?? []) visit(next, [...path, node]);
      state.set(node, 2);
    };
    for (const node of adj.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });

  it('★ 概念 key 与规范名都不重复', () => {
    const keys = new Set<string>();
    const names = new Set<string>();
    for (const concept of graph.concepts) {
      expect(keys.has(concept.key), `重复 key: ${concept.key}`).toBe(false);
      keys.add(concept.key);
      const norm = normalizeConceptName(concept.name);
      expect(names.has(norm), `重复规范名: ${concept.name}`).toBe(false);
      names.add(norm);
    }
  });

  it('★ 同一个别名不许有两个主人（同形异义必须显式处理，不许静默覆盖）', () => {
    // 这条就是「构造」踩过的坑：算竞里是构造题、Java 里是构造方法。
    // 种子图的构造函数在冲突时直接抛，所以这里只要不抛就说明没冲突。
    const owner = new Map<string, string>();
    for (const concept of graph.concepts) {
      const forms = [concept.name, concept.nameEn, ...(concept.aliases ?? [])];
      for (const form of forms) {
        if (!form) continue;
        const norm = normalizeConceptName(form);
        if (!norm) continue;
        const prev = owner.get(norm);
        // 同一个概念自己的 name / nameEn / aliases 之间重复是允许的（比如
        // 规范名本身又出现在 aliases 里）；只有**跨概念**撞名才算冲突。
        if (prev !== undefined) {
          expect(prev, `别名「${form}」同时属于 ${prev} 与 ${concept.key}`).toBe(concept.key);
        }
        owner.set(norm, concept.key);
      }
    }
  });

  it('边的 source 只能是那六个出处之一', () => {
    const allowed = new Set([
      'acm-graph',
      'exercism-cpp',
      'exercism-java',
      'cs-math-skill-tree',
      'course-outline',
      'cs2023',
    ]);
    for (const edge of graph.edges) {
      expect(allowed.has(edge.source), `未知出处: ${edge.source}`).toBe(true);
    }
  });

  it('两次调用得到逐字节相同的图（纯函数）', () => {
    expect(JSON.stringify(buildSeedGraph())).toBe(JSON.stringify(buildSeedGraph()));
  });
});

describe('occurrence: 页级挂载的严苛性', () => {
  const graph = buildSeedGraph();

  it('keyPoint 整串逐字命中 → 权重 1.0', () => {
    const hit = deriveOccurrencesFromOutlines(
      {
        stageId: 'stage-x',
        sceneId: 'scene-p1',
        keyPoints: ['类与对象'],
        title: '今天收工',
      },
      graph,
    );
    const entry = hit.find((d) => d.weight === 1.0);
    expect(entry, JSON.stringify(hit)).toBeTruthy();
    expect(entry?.source).toBe('keypoint');
  });

  it('★ 「构造方法」不会被一个叫「构造」的概念吃掉（子串不算命中）', () => {
    // 实测过的错：按名字做子串匹配，「构造」一次把 8 页错挂到一个概念上。
    const hit = deriveOccurrencesFromOutlines(
      { stageId: 'stage-x', sceneId: 'scene-p9', keyPoints: ['构造方法'], title: '构造方法' },
      graph,
    );
    // 它应该命中「构造方法」这个概念（如果种子里有），而不是「构造」。
    for (const draft of hit) {
      const concept = graph.concepts.find((c) => c.key === draft.conceptKey);
      expect(concept?.name, `命中 ${concept?.name} 说明做了子串匹配`).not.toBe('构造');
    }
  });

  it('目标是整段而不是子串：`switch 与 else if 的取舍` 只切出三段整词', () => {
    const hit = deriveOccurrencesFromOutlines(
      { stageId: 'stage-x', sceneId: 'scene-p10', title: 'switch 与 else if 的取舍' },
      graph,
    );
    for (const draft of hit) {
      expect(draft.weight).toBeLessThanOrEqual(0.6);
      expect(draft.source).toBe('title');
    }
  });

  it('同一页全空 → 没有任何挂载（不是「挂满」）', () => {
    expect(
      deriveOccurrencesFromOutlines({ stageId: 'stage-x', sceneId: 'scene-p11' }, graph),
    ).toEqual([]);
  });

  it('同一概念在同一页只留权重最高的一条，且结果稳定排序', () => {
    const hit = deriveOccurrencesFromOutlines(
      {
        stageId: 'stage-x',
        sceneId: 'scene-p12',
        keyPoints: ['类与对象'],
        title: '类与对象',
        body: '类与对象',
      },
      graph,
    );
    const keys = hit.map((d) => d.conceptKey);
    expect(new Set(keys).size).toBe(keys.length);
    const weights = hit.map((d) => d.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
    // 两次调用逐字节相同（前缀缓存要求）
    expect(JSON.stringify(hit)).toBe(
      JSON.stringify(
        deriveOccurrencesFromOutlines(
          {
            stageId: 'stage-x',
            sceneId: 'scene-p12',
            keyPoints: ['类与对象'],
            title: '类与对象',
            body: '类与对象',
          },
          graph,
        ),
      ),
    );
  });
});
