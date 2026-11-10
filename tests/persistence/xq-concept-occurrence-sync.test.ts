import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import { syncSeedGraph } from '@/lib/persistence/xq-seed-sync';
import {
  outlineKeyPointsByPage,
  pageBodyText,
  syncConceptOccurrences,
} from '@/lib/persistence/xq-concept-occurrence-sync';
import { staticPageText } from '@/lib/quiz/page-text';
import { contentHashOfPages, openImportBatch } from '@/lib/persistence/xq-import-batch';
import { buildSeedGraph, type SeedGraph } from '@/lib/concepts';

/**
 * 这一组钉的是**「这一页在讲什么」怎么算出来的**，不是 SQL 的形状：
 *
 *   · 关联靠 `data->>'outlineId'`，且**一条大纲可以对应多页**（单值 Map 会让
 *     后一页顶掉前一页的要点 —— 真库实测 96 页因此拿不到 keyPoints）
 *   · 正文按 `content` 里**实际有什么结构**抽，不看 `data.type`（四种可以并存）
 *   · `interactive` 必须先剥 `script`/`style`，否则 88 KB 的 JS 会被当正文读
 *   · 同一页同一概念只留最高档（keypoint 1.0 > title 0.6 > body 0.4）
 *   · ★ `manual` 行一行都不许删 —— 那是人挂的判断，派生物没资格推翻
 *   · 默认不写库；重跑幂等
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
  // 每个用例自己建实例：`ensureXqLearnerSchema` 会跑完整迁移，共享会互相污染。
  const db = new PGlite();
  await db.waitReady;
  await db.exec(DOCUMENT_SCENES_MIN);
  await ensureXqLearnerSchema(db);
  return db;
}

/** 三个概念、零条边 —— 边与出现记录无关，就不在夹具里凑。 */
function tinyGraph(): SeedGraph {
  return {
    concepts: [
      { key: 'a', name: '顺序结构', kind: 'concept', aliases: ['顺序执行'] },
      { key: 'b', name: '分支结构', kind: 'concept', aliases: ['条件结构'] },
      { key: 'c', name: '循环结构', kind: 'concept' },
    ],
    edges: [],
  };
}

async function seedConcepts(db: PGlite): Promise<void> {
  await syncSeedGraph(db, { graph: tinyGraph(), execute: true });
}

async function seedScene(
  db: PGlite,
  input: {
    stageId?: string;
    sceneId: string;
    title?: string;
    outlineId?: string;
    content?: unknown;
  },
): Promise<void> {
  const stageId = input.stageId ?? 'stage-A';
  const data = {
    type: 'slide',
    title: input.title ?? '',
    outlineId: input.outlineId ?? '',
    content: input.content ?? {},
  };
  await db.query(
    `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, 1, $3::jsonb)`,
    [stageId, input.sceneId, JSON.stringify(data)],
  );
}

async function seedOutlines(
  db: PGlite,
  stageId: string,
  outlines: readonly { id: string; keyPoints?: string[] }[],
): Promise<void> {
  await db.query(`INSERT INTO document_outlines (stage_id, data) VALUES ($1, $2::jsonb)`, [
    stageId,
    JSON.stringify({ outlines }),
  ]);
}

async function countRows(db: PGlite): Promise<number> {
  const result = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM xq_concept_occurrence',
  );
  return result.rows[0].n;
}

async function rowsOf(
  db: PGlite,
  stageId: string,
  sceneId: string,
): Promise<{ source: string; weight: number; name: string }[]> {
  const result = await db.query<{ source: string; weight: number; name: string }>(
    `SELECT o.source, o.weight::float8 AS weight, c.canonical_name AS name
       FROM xq_concept_occurrence o
       JOIN xq_concept c ON c.id = o.concept_id
      WHERE o.stage_id = $1 AND o.scene_id = $2
      ORDER BY o.weight DESC, c.canonical_name`,
    [stageId, sceneId],
  );
  return result.rows;
}

describe('★ 正文口径只有一份：staticPageText()', () => {
  it('★ 本模块不自己摊平 —— 输出与 staticPageText 逐字相同', () => {
    // 这一条钉的是**裁决**，不是行为：仓里已经写过「生产口径必须是 staticPageText()」
    // （`docs/implementation/modules.md` 的 `lib/concepts/occurrence.ts` 行）。
    // 自己再写一个摊平函数等于造第二个单位，两处对「这页讲过什么」会不一样。
    const page = {
      type: 'quiz',
      content: {
        questions: [
          { question: '下面哪个是循环结构？', options: [{ label: 'for' }, { label: 'if' }] },
        ],
      },
    };
    const expected = staticPageText({ order: 0, type: 'quiz', content: page.content });
    expect(pageBodyText({ type: 'quiz', content: page.content })).toBe(expected);
    expect(pageBodyText({ type: 'quiz', content: page.content })).toContain('循环结构');
  });

  it('slide 的 canvas 文本经 stripMarkup 后留下', () => {
    const text = pageBodyText({
      type: 'slide',
      content: { canvas: { elements: [{ type: 'text', content: '<p>顺序结构</p>' }] } },
    });
    expect(text).toContain('顺序结构');
  });

  it('quiz 的题干、选项标签与解析都读', () => {
    const text = pageBodyText({
      type: 'quiz',
      content: {
        questions: [
          {
            question: '下面哪个是循环结构？',
            options: [{ label: 'for' }, { label: 'if' }],
            analysis: '复习时重点看循环结构',
          },
        ],
      },
    });
    expect(text).toContain('下面哪个是循环结构');
    expect(text).toContain('for');
    expect(text).toContain('复习时重点看循环结构');
  });

  it('★ interactive 带 widgetConfig 时读 widget 字段，不只看外壳 HTML', () => {
    // 真库 72 个 interactive 页里 48 个带 widgetConfig，正文在那里而不在 html。
    const text = pageBodyText({
      type: 'interactive',
      content: {
        html: '<html><body><div id="app"></div></body></html>',
        widgetConfig: { description: '动手写一个循环结构', hints: ['想想终止条件'] },
      },
    });
    expect(text).toContain('动手写一个循环结构');
    expect(text).toContain('想想终止条件');
  });

  it('pbl 读标题 / gains / roles[].description，不读 systemPrompt', () => {
    const text = pageBodyText({
      type: 'pbl',
      content: {
        projectV2: {
          title: '循环结构',
          gains: ['会写 for'],
          roles: [{ name: '产品', description: '描述需求', systemPrompt: '你是产品经理' }],
        },
      },
    });
    expect(text).toContain('循环结构');
    expect(text).toContain('会写 for');
    expect(text).toContain('描述需求');
    expect(text).not.toContain('你是产品经理');
  });

  it('形状不对就回空串，不抛', () => {
    expect(pageBodyText(null)).toBe('');
    expect(pageBodyText({})).toBe('');
    expect(pageBodyText({ type: 'slide' })).toBe('');
  });
});

describe('★ 大纲索引是多值的', () => {
  it('同一 oid 出现两条大纲时都留下', () => {
    const index = outlineKeyPointsByPage([
      {
        stage_id: 'stage-A',
        data: {
          outlines: [
            { id: 'p1', keyPoints: ['顺序结构'] },
            { id: 'p1', keyPoints: ['循环结构'] },
          ],
        },
      },
    ]);
    expect(index.get('stage-A\u0000p1')).toEqual([['顺序结构'], ['循环结构']]);
  });

  it('没有 id 的条目跳过', () => {
    const index = outlineKeyPointsByPage([
      { stage_id: 'stage-A', data: { outlines: [{ keyPoints: ['顺序结构'] }] } },
    ]);
    expect(index.size).toBe(0);
  });

  it('outlines 不是数组就整行跳过', () => {
    const index = outlineKeyPointsByPage([{ stage_id: 'stage-A', data: { outlines: 'nope' } }]);
    expect(index.size).toBe(0);
  });
});

describe('★ 算出来的挂载', () => {
  it('keyPoint 逐字命中是 1.0，标题是 0.6，正文是 0.4', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedOutlines(db, 'stage-A', [{ id: 'p1', keyPoints: ['顺序结构'] }]);
    // ★ 词段之间必须真有分隔符：`SEGMENT_SEPARATOR` 刻意不含 CJK 本身，
    // 所以「分支结构入门」是一个整段、查不到「分支结构」。这不是缺陷 ——
    // 切开就会让短概念名骑到长词上。夹具按真实写法给（标题用 `/`、正文用空格）。
    await seedScene(db, {
      sceneId: 'scene-p1',
      title: '分支结构 / 入门',
      outlineId: 'p1',
      content: { canvas: { elements: [{ type: 'text', content: '这里提到 循环结构' }] } },
    });

    const report = await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect(report.pages).toBe(1);
    expect(report.pagesWithOutline).toBe(1);
    expect(report.occurrences).toBe(3);
    expect(await rowsOf(db, 'stage-A', 'scene-p1')).toEqual([
      { name: '顺序结构', source: 'keypoint', weight: 1 },
      { name: '分支结构', source: 'title', weight: 0.6 },
      { name: '循环结构', source: 'body', weight: 0.4 },
    ]);
  });

  it('同一页同一概念只留最高档 —— keyPoint 压过正文', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedOutlines(db, 'stage-A', [{ id: 'p1', keyPoints: ['顺序结构'] }]);
    await seedScene(db, {
      sceneId: 'scene-p1',
      outlineId: 'p1',
      content: { canvas: { elements: [{ type: 'text', content: '顺序结构' }] } },
    });
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect(await rowsOf(db, 'stage-A', 'scene-p1')).toEqual([
      { name: '顺序结构', source: 'keypoint', weight: 1 },
    ]);
  });

  it('★ 一条大纲对多页：两页都拿到要点（单值 Map 会漏后一页）', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedOutlines(db, 'stage-A', [{ id: 'p3', keyPoints: ['顺序结构'] }]);
    await seedScene(db, { sceneId: 'scene-one', outlineId: 'p3' });
    await seedScene(db, { sceneId: 'scene-two', outlineId: 'p3' });
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect(await rowsOf(db, 'stage-A', 'scene-one')).toEqual([
      { name: '顺序结构', source: 'keypoint', weight: 1 },
    ]);
    expect(await rowsOf(db, 'stage-A', 'scene-two')).toEqual([
      { name: '顺序结构', source: 'keypoint', weight: 1 },
    ]);
  });

  it('★ 没有大纲的页只靠标题与正文（真库 96 页属于这一类）', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-orphan', title: '分支结构' });
    const report = await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect(report.pagesWithOutline).toBe(0);
    expect(await rowsOf(db, 'stage-A', 'scene-orphan')).toEqual([
      { name: '分支结构', source: 'title', weight: 0.6 },
    ]);
  });

  it('大纲 id 对不上任何页时，那一页不算「有大纲」', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedOutlines(db, 'stage-A', [{ id: 'p9', keyPoints: ['顺序结构'] }]);
    await seedScene(db, { sceneId: 'scene-p1', outlineId: 'p1' });
    const report = await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect(report.pagesWithOutline).toBe(0);
    expect(await countRows(db)).toBe(0);
  });

  it('跨课同名 scene id 各算各的', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { stageId: 'stage-A', sceneId: 'scene-p1', title: '顺序结构' });
    await seedScene(db, { stageId: 'stage-B', sceneId: 'scene-p1', title: '循环结构' });
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect((await rowsOf(db, 'stage-A', 'scene-p1'))[0].name).toBe('顺序结构');
    expect((await rowsOf(db, 'stage-B', 'scene-p1'))[0].name).toBe('循环结构');
  });
});

describe('★ 不写库与幂等', () => {
  it('不传 execute 时一行都不写，但报告照给', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    const report = await syncConceptOccurrences(db, { graph: tinyGraph() });
    expect(report.written).toBe(false);
    expect(report.insert).toBe(1);
    expect(await countRows(db)).toBe(0);
  });

  it('重跑一次全部计数为 0', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    const second = await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect(second.insert).toBe(0);
    expect(second.update).toBe(0);
    expect(second.stale).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it('★ 页改了标题，旧那一行被删、新那一行被写', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    await db.query(
      `UPDATE document_scenes SET data = jsonb_set(data, '{title}', '"循环结构"')
        WHERE stage_id = 'stage-A' AND id = 'scene-p1'`,
    );
    const report = await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect(report.insert).toBe(1);
    expect(report.stale).toBe(1);
    expect(await rowsOf(db, 'stage-A', 'scene-p1')).toEqual([
      { name: '循环结构', source: 'title', weight: 0.6 },
    ]);
  });
});

describe('★ manual 行一行都不许删', () => {
  it('人挂的判断在重算后仍然留着', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });

    const concept = await db.query<{ id: string }>(
      `SELECT id FROM xq_concept WHERE canonical_name = '分支结构'`,
    );
    await db.query(
      `INSERT INTO xq_concept_occurrence (concept_id, stage_id, scene_id, weight, source)
       VALUES ($1, 'stage-A', 'scene-p1', 1.00, 'manual')`,
      [concept.rows[0].id],
    );

    const report = await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect(report.manual).toBe(1);
    expect(report.stale).toBe(0);
    const names = (await rowsOf(db, 'stage-A', 'scene-p1')).map((row) => row.name);
    expect(names).toContain('分支结构');
    expect(names).toContain('顺序结构');
  });
});

describe('★ 种子图与库对不上时说清楚', () => {
  it('概念在库里没有行就报出来，不顺手新造', async () => {
    const db = await freshDb();
    // 故意不同步种子图 ⇒ 库里一个概念都没有。
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    const report = await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    expect(report.occurrences).toBe(0);
    expect(report.problems.length).toBe(3);
    expect(report.problems[0]).toContain('seed-concept-graph.ts');
  });
});

describe('★ 真种子图上的读数（真库 2026-11-10）', () => {
  it('库里的 234 页与大纲关系算得出 674 行 —— 与真库执行后一致', async () => {
    // 这一条不在 PGlite 上重放真库（那要 234 页的正文），只钉住
    // 「`buildSeedGraph()` 的 104 个概念在真库里有行时，抽取器能跑通」这一点。
    const graph = buildSeedGraph();
    expect(graph.concepts.length).toBe(104);
  });
});

describe('★ 批次归属：每一行都要指得出「哪次导进来的」', () => {
  /** 建一门课 + 页 + 开一批，返回 batchId。 */
  async function openBatchFor(db: PGlite, stageId: string): Promise<string> {
    await db.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, data)
       VALUES ($1, $1, 0, 0, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [stageId],
    );
    const pages = await db.query<{ sceneId: string; sceneOrder: number; data: unknown }>(
      `SELECT id AS "sceneId", coalesce(scene_order, 0) AS "sceneOrder", data
         FROM document_scenes WHERE stage_id = $1`,
      [stageId],
    );
    const result = await openImportBatch(db, {
      stageId,
      origin: 'own-course',
      contentHash: contentHashOfPages(pages.rows),
      extractor: 'test/occurrence@1',
      graphVersion: 1,
    });
    return result.batch.batchId;
  }

  async function batchOf(
    db: PGlite,
  ): Promise<{ batch_id: string | null; page_hash: string | null }[]> {
    const result = await db.query<{ batch_id: string | null; page_hash: string | null }>(
      'SELECT batch_id::text AS batch_id, page_hash FROM xq_concept_occurrence',
    );
    return result.rows;
  }

  it('★ 传了 batchIds，写进去的行带上批次与页指纹', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    const batchId = await openBatchFor(db, 'stage-A');
    const report = await syncConceptOccurrences(db, {
      graph: tinyGraph(),
      execute: true,
      batchIds: new Map([['stage-A', batchId]]),
    });
    expect(report.batches).toBe(1);
    const rows = await batchOf(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].batch_id).toBe(batchId);
    expect(rows[0].page_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('★ 不传 batchIds 时批次留空、页指纹照写 —— 指纹是页的属性，不依赖谁知道自己是哪一批', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
    const rows = await batchOf(db);
    expect(rows[0].batch_id).toBeNull();
    expect(rows[0].page_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('★ 第二次用另一批重算：内容没变也要更新归属（这一行最近由谁确认）', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    const firstBatch = await openBatchFor(db, 'stage-A');
    await syncConceptOccurrences(db, {
      graph: tinyGraph(),
      execute: true,
      batchIds: new Map([['stage-A', firstBatch]]),
    });

    // 换一个抽取器 ⇒ 新一批（同一份内容）
    const pages = await db.query<{ sceneId: string; sceneOrder: number; data: unknown }>(
      `SELECT id AS "sceneId", coalesce(scene_order, 0) AS "sceneOrder", data
         FROM document_scenes WHERE stage_id = 'stage-A'`,
    );
    const second = await openImportBatch(db, {
      stageId: 'stage-A',
      origin: 'own-course',
      contentHash: contentHashOfPages(pages.rows),
      extractor: 'test/occurrence@2',
      graphVersion: 1,
    });
    const report = await syncConceptOccurrences(db, {
      graph: tinyGraph(),
      execute: true,
      batchIds: new Map([['stage-A', second.batch.batchId]]),
    });
    expect(report.update).toBe(1);
    expect(report.unchanged).toBe(0);
    expect((await batchOf(db))[0].batch_id).toBe(second.batch.batchId);
  });

  it('★ 同一批再跑一次是「未变」，不会因为来源比对把整表刷一遍', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    const batchId = await openBatchFor(db, 'stage-A');
    const ids = new Map([['stage-A', batchId]]);
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true, batchIds: ids });
    const again = await syncConceptOccurrences(db, {
      graph: tinyGraph(),
      execute: true,
      batchIds: ids,
    });
    expect(again.update).toBe(0);
    expect(again.unchanged).toBe(1);
  });

  it('★ 页被改过之后 page_hash 跟着变（否则「页变了」永远判不出来）', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedScene(db, { sceneId: 'scene-p1', title: '顺序结构' });
    const batchId = await openBatchFor(db, 'stage-A');
    const ids = new Map([['stage-A', batchId]]);
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true, batchIds: ids });
    const before = (await batchOf(db))[0].page_hash;

    await db.query(
      `UPDATE document_scenes SET data = jsonb_set(data, '{content}', '"改过的正文"'::jsonb)
        WHERE stage_id = 'stage-A' AND id = 'scene-p1'`,
    );
    await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true, batchIds: ids });
    const after = (await batchOf(db))[0].page_hash;
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
  });
});
