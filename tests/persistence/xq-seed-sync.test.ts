import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import { aliasFormsOf, syncSeedGraph } from '@/lib/persistence/xq-seed-sync';
import { buildSeedGraph, type SeedGraph } from '@/lib/concepts';

/**
 * 这一组钉的是**同步的语义**，不是 SQL 的形状：
 *
 *   · 以 `canonical_name` 认领已有概念、**保留它原来的 id** —— 换 id 会把
 *     644 条出现记录与 71 条题级映射全部指空，而它们不在本模块管辖范围里
 *   · 四张表都幂等：同一张图同步两次，第二次全部计数是 0
 *   · 外部引用冲突**不覆盖**（那是归并没做完，不该被一次同步悄悄改掉方向）
 *   · 边的声明变了要**更新并计数**（改一次声明就该生效，但必须让人看见改了几条）
 *   · 默认不写库（`execute` 不传就是只报告）
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
)`;

async function freshDb(): Promise<PGlite> {
  // 每个用例自己建实例：`ensureXqLearnerSchema` 会跑完整迁移，共享会互相污染。
  const db = new PGlite();
  await db.waitReady;
  await db.exec(DOCUMENT_SCENES_MIN);
  await ensureXqLearnerSchema(db);
  return db;
}

/** 一张手搭的小种子图：三个概念、两条边、一个外部引用。 */
function tinyGraph(): SeedGraph {
  return {
    concepts: [
      {
        key: 'a',
        name: '顺序结构',
        kind: 'concept',
        aliases: ['顺序执行'],
        externalRefs: [{ sourceGraph: 'acm-graph', externalId: '顺序结构' }],
      },
      { key: 'b', name: '分支结构', kind: 'concept', aliases: ['条件结构'] },
      { key: 'c', name: '循环结构', kind: 'concept' },
    ],
    edges: [
      {
        from: 'a',
        to: 'b',
        relation: 'prereq',
        strength: 'strict',
        reason: '分支的条件是一个表达式，没先学会写表达式就无从下笔。',
        source: 'acm-graph',
      },
      {
        from: 'b',
        to: 'c',
        relation: 'prereq',
        strength: 'recommended',
        reason: '循环的终止条件通常就是一个判断，先熟悉判断再看循环。',
        source: 'course-outline',
      },
    ],
  };
}

async function countRows(
  db: PGlite,
): Promise<{ concepts: number; aliases: number; refs: number; edges: number }> {
  const { rows } = await db.query<{
    concepts: number;
    aliases: number;
    refs: number;
    edges: number;
  }>(
    `SELECT (SELECT count(*)::int FROM xq_concept) AS concepts,
            (SELECT count(*)::int FROM xq_concept_alias) AS aliases,
            (SELECT count(*)::int FROM xq_concept_external_ref) AS refs,
            (SELECT count(*)::int FROM xq_concept_edge) AS edges`,
  );
  return rows[0]!;
}

describe('aliasFormsOf', () => {
  it('规范名、英文名、别名都算，归一后去重', () => {
    const forms = aliasFormsOf({
      name: '顺序结构',
      nameEn: 'Sequence',
      aliases: ['SEQUENCE', '顺序执行'],
      kind: 'concept',
    });
    // 归一化会把 `SEQUENCE` 与 `Sequence` 压成同一个，所以两处只剩一条。
    expect(forms.map((f) => f.alias)).toEqual(['顺序结构', 'sequence', '顺序执行']);
    expect(new Set(forms.map((f) => f.alias)).size).toBe(forms.length);
  });

  it('空白与空串整条丢，不写进别名表', () => {
    const forms = aliasFormsOf({ name: '  ', nameEn: '', aliases: ['   '], kind: 'concept' });
    expect(forms).toEqual([]);
  });
});

describe('syncSeedGraph —— 默认不写库', () => {
  it('不传 execute 时只报告，库里一行都没有', async () => {
    const db = await freshDb();
    const report = await syncSeedGraph(db, { graph: tinyGraph() });
    expect(report.written).toBe(false);
    expect(report.insertedConcepts).toBe(3);
    expect(report.edges.inserted).toBe(2);
    expect(await countRows(db)).toEqual({ concepts: 0, aliases: 0, refs: 0, edges: 0 });
  });
});

describe('syncSeedGraph —— 四张表一起写', () => {
  it('三个概念、五个别名、一个外部引用、两条边', async () => {
    const db = await freshDb();
    const report = await syncSeedGraph(db, { graph: tinyGraph(), execute: true });

    expect(report.insertedConcepts).toBe(3);
    expect(report.matched).toBe(0);
    // 顺序结构 / 顺序执行 / 分支结构 / 条件结构 / 循环结构 —— 每个概念至少要有一条
    // 能按名字找到它的别名，否则「按名字查概念」永远查不到第三个。
    expect(report.aliases.inserted).toBe(5);
    expect(report.externalRefs.inserted).toBe(1);
    expect(report.edges.inserted).toBe(2);

    expect(await countRows(db)).toEqual({ concepts: 3, aliases: 5, refs: 1, edges: 2 });
  });

  it('★ 幂等：同一张图同步两次，第二次一行都不动', async () => {
    const db = await freshDb();
    await syncSeedGraph(db, { graph: tinyGraph(), execute: true });
    const second = await syncSeedGraph(db, { graph: tinyGraph(), execute: true });

    expect(second.insertedConcepts).toBe(0);
    expect(second.aliases.inserted).toBe(0);
    expect(second.externalRefs.inserted).toBe(0);
    expect(second.edges.inserted).toBe(0);
    expect(second.edges.updated).toBe(0);
    expect(second.matched).toBe(3);
    expect(second.edges.unchanged).toBe(2);
  });
});

describe('syncSeedGraph —— 认领已有概念', () => {
  it('★ 库里已有的概念保留它原来的 id —— 换 id 会把出现记录与题级映射指空', async () => {
    const db = await freshDb();
    await db.query(`INSERT INTO xq_concept (id, canonical_name, kind) VALUES ($1, $2, 'concept')`, [
      'c_aaaaaaaaaaaa',
      '分支结构',
    ]);

    const report = await syncSeedGraph(db, { graph: tinyGraph(), execute: true });
    expect(report.matched).toBe(1);
    expect(report.insertedConcepts).toBe(2);

    const { rows } = await db.query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM xq_concept WHERE canonical_name = '分支结构'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('c_aaaaaaaaaaaa');
  });

  it('退役或合并过的概念照样认领 id，但不写别名', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, status) VALUES ($1, $2, 'concept', 'retired')`,
      ['c_bbbbbbbbbbbb', '分支结构'],
    );

    const report = await syncSeedGraph(db, { graph: tinyGraph(), execute: true });
    expect(report.matched).toBe(1);
    expect(report.problems.some((line) => line.includes('retired'))).toBe(true);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM xq_concept_alias WHERE concept_id = 'c_bbbbbbbbbbbb'`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('新概念归到当前开放的图谱版本', async () => {
    const db = await freshDb();
    await syncSeedGraph(db, { graph: tinyGraph(), execute: true });
    const { rows } = await db.query<{ created_in: number | null }>(
      `SELECT created_in FROM xq_concept ORDER BY canonical_name`,
    );
    // 迁移 3 建了一个开放的 baseline（version 1）。
    expect(rows.map((r) => r.created_in)).toEqual([1, 1, 1]);
  });
});

describe('syncSeedGraph —— 冲突不覆盖', () => {
  it('★ 外部 id 已指向别的概念时不改方向，只报冲突', async () => {
    const db = await freshDb();
    await db.query(`INSERT INTO xq_concept (id, canonical_name, kind) VALUES ($1, $2, 'concept')`, [
      'c_cccccccccccc',
      '别的东西',
    ]);
    await db.query(
      `INSERT INTO xq_concept_external_ref (source_graph, external_id, concept_id) VALUES ($1, $2, $3)`,
      ['acm-graph', '顺序结构', 'c_cccccccccccc'],
    );

    const report = await syncSeedGraph(db, { graph: tinyGraph(), execute: true });
    expect(report.externalRefs.conflicting).toHaveLength(1);
    expect(report.externalRefs.conflicting[0]).toContain('c_cccccccccccc');

    const { rows } = await db.query<{ concept_id: string }>(
      `SELECT concept_id FROM xq_concept_external_ref WHERE source_graph = 'acm-graph' AND external_id = '顺序结构'`,
    );
    expect(rows[0]!.concept_id).toBe('c_cccccccccccc');
  });

  it('★ 别名已被别的概念占用时跳过并记一条问题', async () => {
    const db = await freshDb();
    await db.query(`INSERT INTO xq_concept (id, canonical_name, kind) VALUES ($1, $2, 'concept')`, [
      'c_dddddddddddd',
      '别的东西',
    ]);
    await db.query(
      `INSERT INTO xq_concept_alias (alias, kind, concept_id, source) VALUES ($1, 'concept', $2, 'manual')`,
      ['条件结构', 'c_dddddddddddd'],
    );

    const report = await syncSeedGraph(db, { graph: tinyGraph(), execute: true });
    expect(report.problems.some((line) => line.includes('条件结构'))).toBe(true);
    // 其余别名照写：一条冲突不该把整批停下。
    expect(report.aliases.inserted).toBe(4);
  });
});

describe('syncSeedGraph —— 边变了要更新', () => {
  it('★ strength 或 reason 变了就更新，并计入 updated', async () => {
    const db = await freshDb();
    await syncSeedGraph(db, { graph: tinyGraph(), execute: true });

    const changed = tinyGraph();
    changed.edges[0] = {
      ...changed.edges[0]!,
      strength: 'recommended',
      reason: '改过的理由：不再那么硬。',
    };
    const report = await syncSeedGraph(db, { graph: changed, execute: true });

    expect(report.edges.updated).toBe(1);
    expect(report.edges.unchanged).toBe(1);

    // 按 from 的概念名定位那一条 —— 两条边现在都是 recommended，
    // 只按 strength 筛会取到没改过的那条。
    const { rows } = await db.query<{ strength: string; reason: string }>(
      `SELECT e.strength, e.reason
         FROM xq_concept_edge e
         JOIN xq_concept c ON c.id = e.from_id
        WHERE c.canonical_name = '顺序结构' AND e.relation = 'prereq'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strength).toBe('recommended');
    expect(rows[0]!.reason).toBe('改过的理由：不再那么硬。');
  });

  it('端点不在种子图里的边整条跳过并报出来', async () => {
    const db = await freshDb();
    const broken = tinyGraph();
    broken.edges.push({
      from: 'a',
      to: 'nope',
      relation: 'prereq',
      strength: 'strict',
      reason: '这条边的终点不存在，应该被跳过。',
      source: 'cs2023',
    });
    const report = await syncSeedGraph(db, { graph: broken, execute: true });
    expect(report.edges.inserted).toBe(2);
    expect(report.problems.some((line) => line.includes('nope'))).toBe(true);
  });
});

describe('syncSeedGraph —— 真种子图', () => {
  it('★ 空库上跑真种子图：104 概念 / 357 别名 / 63 外部引用 / 105 边', async () => {
    const db = await freshDb();
    const report = await syncSeedGraph(db, { graph: buildSeedGraph(), execute: true });

    expect(report.seed.concepts).toBe(104);
    expect(report.seed.edges).toBe(105);
    expect(report.seed.externalRefs).toBe(63);
    expect(report.seed.aliases).toBe(357);
    expect(report.insertedConcepts).toBe(104);
    expect(report.aliases.inserted).toBe(357);
    expect(report.externalRefs.inserted).toBe(63);
    expect(report.edges.inserted).toBe(105);

    expect(await countRows(db)).toEqual({ concepts: 104, aliases: 357, refs: 63, edges: 105 });
  }, 120_000);

  it('★ 真种子图也是幂等的：第二次全部 0', async () => {
    const db = await freshDb();
    await syncSeedGraph(db, { graph: buildSeedGraph(), execute: true });
    const second = await syncSeedGraph(db, { graph: buildSeedGraph(), execute: true });

    expect(second.insertedConcepts).toBe(0);
    expect(second.aliases.inserted).toBe(0);
    expect(second.externalRefs.inserted).toBe(0);
    expect(second.edges.inserted).toBe(0);
    expect(second.edges.updated).toBe(0);
    expect(second.edges.unchanged).toBe(105);
  }, 120_000);
});
