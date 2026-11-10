import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import {
  abandonImportBatch,
  applyImportBatch,
  canonicalJson,
  contentHashOfPages,
  IMPORT_ORIGINS,
  openImportBatch,
  pageHashOf,
  readImportBatches,
  type OpenImportBatchInput,
} from '@/lib/persistence/xq-import-batch';

/**
 * 这一组钉的是**批次的语义**，不是 SQL 的形状：
 *
 *   · 同一份内容 + 同一个抽取器 + 同一个版图 ⇒ 同一批（`created: false`）
 *   · 中间任何一个维度变了 ⇒ 新一批（改内容、换抽取器、跨版图重导）
 *   · `source_graph` 的 NULL 也要参与唯一性 —— 否则自有课程每导一次都新开一批
 *   · 内容哈希与**键序**无关（jsonb 往返会重排键），但与**页序**有关
 *   · `status='applied'` 当且仅当 `applied_at IS NOT NULL`（双向，防半截状态）
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
  // `xq_import_batch.stage_id` 有外键指向 `document_stages` —— 批次是「一门课
  // 的一次导入」，课不存在就无处可挂。三个 stage 都先建上。
  for (const stageId of ['stage-A', 'stage-B', 'stage-X']) {
    await db.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, data)
       VALUES ($1, $1, 0, 0, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [stageId],
    );
  }
  return db;
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function batchInput(overrides: Partial<OpenImportBatchInput> = {}): OpenImportBatchInput {
  return {
    stageId: 'stage-A',
    origin: 'own-course',
    contentHash: HASH_A,
    extractor: 'openmaic/pages@1',
    graphVersion: 1,
    ...overrides,
  };
}

async function countBatches(db: PGlite): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM xq_import_batch');
  return rows[0]?.n ?? 0;
}

describe('canonicalJson', () => {
  it('键序不同规范化后相同', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('数组顺序保留 —— 顺序是语义', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('嵌套对象也按键排序', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('null 与原始值原样', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('文本')).toBe('"文本"');
    expect(canonicalJson(3)).toBe('3');
  });
});

describe('contentHashOfPages / pageHashOf', () => {
  const pages = [
    { sceneId: 'scene-p1', sceneOrder: 1, data: { title: '第一页' } },
    { sceneId: 'scene-p2', sceneOrder: 2, data: { title: '第二页' } },
  ];

  it('同一份页两次算出同一个哈希', () => {
    expect(contentHashOfPages(pages)).toBe(contentHashOfPages(pages));
  });

  it('★ 输入顺序不影响哈希 —— 按 scene_order 排', () => {
    expect(contentHashOfPages(pages)).toBe(contentHashOfPages([...pages].reverse()));
  });

  it('★ 页序变了哈希就变 —— 顺序是课程的一部分', () => {
    const swapped = [
      { sceneId: 'scene-p1', sceneOrder: 2, data: { title: '第一页' } },
      { sceneId: 'scene-p2', sceneOrder: 1, data: { title: '第二页' } },
    ];
    expect(contentHashOfPages(swapped)).not.toBe(contentHashOfPages(pages));
  });

  it('内容改了哈希就变', () => {
    const edited = [{ ...pages[0], data: { title: '改过的第一页' } }, pages[1]];
    expect(contentHashOfPages(edited)).not.toBe(contentHashOfPages(pages));
  });

  it('★ 键序不影响哈希 —— jsonb 往返会重排键', () => {
    const reordered = [
      { sceneId: 'scene-p1', sceneOrder: 1, data: { title: '第一页' } },
      { sceneId: 'scene-p2', sceneOrder: 2, data: { title: '第二页' } },
    ];
    const rewritten = reordered.map((page) => ({
      ...page,
      data: Object.fromEntries(Object.entries(page.data).reverse()),
    }));
    expect(contentHashOfPages(rewritten)).toBe(contentHashOfPages(reordered));
  });

  it('空课也有哈希（不是空串）', () => {
    expect(contentHashOfPages([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pageHashOf 与 contentHashOfPages 是两件事', () => {
    expect(pageHashOf({ title: '第一页' })).not.toBe(contentHashOfPages([pages[0]]));
  });
});

describe('openImportBatch', () => {
  it('★ 第一次开批 created: true，再开一次 created: false 且批次 id 相同', async () => {
    const db = await freshDb();
    const first = await openImportBatch(db, batchInput());
    expect(first.created).toBe(true);
    const second = await openImportBatch(db, batchInput());
    expect(second.created).toBe(false);
    expect(second.batch.batchId).toBe(first.batch.batchId);
    expect(await countBatches(db)).toBe(1);
  });

  it('★ 内容变了就新开一批', async () => {
    const db = await freshDb();
    const first = await openImportBatch(db, batchInput());
    const second = await openImportBatch(db, batchInput({ contentHash: HASH_B }));
    expect(second.created).toBe(true);
    expect(second.batch.batchId).not.toBe(first.batch.batchId);
    expect(await countBatches(db)).toBe(2);
  });

  it('★ 换抽取器就新开一批 —— 换了抽取器必须重建投影', async () => {
    const db = await freshDb();
    const first = await openImportBatch(db, batchInput());
    const second = await openImportBatch(db, batchInput({ extractor: 'openmaic/pages@2' }));
    expect(second.created).toBe(true);
    expect(second.batch.batchId).not.toBe(first.batch.batchId);
  });

  it('★ 跨版图重导是新一批 —— 边与概念归属都变了', async () => {
    const db = await freshDb();
    // `graph_version` 有外键指向 `xq_graph_version` —— 版图得先存在。
    // 版本 2 直接建成已冻结（`one_open` 那条偏索引只允许一个开放版）。
    await db.query(
      `INSERT INTO xq_graph_version (version, label, note, frozen_at)
       VALUES (2, 'v2-test', '测试用', now())`,
    );
    const first = await openImportBatch(db, batchInput());
    const second = await openImportBatch(db, batchInput({ graphVersion: 2 }));
    expect(second.created).toBe(true);
    expect(second.batch.batchId).not.toBe(first.batch.batchId);
  });

  it('★ source_graph 为 NULL 时也参与唯一性（NULLS NOT DISTINCT）', async () => {
    const db = await freshDb();
    const first = await openImportBatch(db, batchInput({ origin: 'own-course' }));
    const second = await openImportBatch(db, batchInput({ origin: 'own-course' }));
    expect(first.batch.sourceGraph).toBeNull();
    expect(second.created).toBe(false);
    expect(await countBatches(db)).toBe(1);
  });

  it('同样是 NULL，换一门课是另一批', async () => {
    const db = await freshDb();
    await openImportBatch(db, batchInput({ stageId: 'stage-A' }));
    const other = await openImportBatch(db, batchInput({ stageId: 'stage-B' }));
    expect(other.created).toBe(true);
  });

  it('外部图批次必须带 sourceGraph，不带就抛 RangeError 且不写行', async () => {
    const db = await freshDb();
    await expect(openImportBatch(db, batchInput({ origin: 'external-graph' }))).rejects.toThrow(
      RangeError,
    );
    expect(await countBatches(db)).toBe(0);
  });

  it('外部图批次带上 sourceGraph 就写得进', async () => {
    const db = await freshDb();
    const result = await openImportBatch(
      db,
      batchInput({ origin: 'external-graph', sourceGraph: 'acm-graph' }),
    );
    expect(result.created).toBe(true);
    expect(result.batch.sourceGraph).toBe('acm-graph');
  });

  it('★ 哈希不是 64 个小写十六进制就抛', async () => {
    const db = await freshDb();
    for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(63)}z`]) {
      await expect(openImportBatch(db, batchInput({ contentHash: bad }))).rejects.toThrow(
        RangeError,
      );
    }
    expect(await countBatches(db)).toBe(0);
  });

  it('空的 stageId / extractor / 非正整数 graphVersion 都抛', async () => {
    const db = await freshDb();
    await expect(openImportBatch(db, batchInput({ stageId: '  ' }))).rejects.toThrow(RangeError);
    await expect(openImportBatch(db, batchInput({ extractor: '' }))).rejects.toThrow(RangeError);
    await expect(openImportBatch(db, batchInput({ graphVersion: 0 }))).rejects.toThrow(RangeError);
    await expect(openImportBatch(db, batchInput({ graphVersion: 1.5 }))).rejects.toThrow(
      RangeError,
    );
    expect(await countBatches(db)).toBe(0);
  });

  it('未知 origin 被库里的 CHECK 拒（不是悄悄写进去）', async () => {
    const db = await freshDb();
    await expect(
      openImportBatch(db, batchInput({ origin: 'bogus' as (typeof IMPORT_ORIGINS)[number] })),
    ).rejects.toThrow(/xq_import_batch_origin_check/i);
  });

  it('新开的批次是 open，applied_at 为空', async () => {
    const db = await freshDb();
    const { batch } = await openImportBatch(db, batchInput());
    expect(batch.status).toBe('open');
    expect(batch.appliedAt).toBeNull();
    expect(batch.createdAt).toBeInstanceOf(Date);
  });
});

describe('applyImportBatch / abandonImportBatch', () => {
  it('★ 落定写上 applied_at，且 status 变 applied', async () => {
    const db = await freshDb();
    const { batch } = await openImportBatch(db, batchInput());
    const applied = await applyImportBatch(db, batch.batchId);
    expect(applied.ok).toBe(true);
    expect(applied.batch?.status).toBe('applied');
    expect(applied.batch?.appliedAt).toBeInstanceOf(Date);
  });

  it('★ 重复落定不重写时刻（第二次 ok: false 且 时刻不变）', async () => {
    const db = await freshDb();
    const { batch } = await openImportBatch(db, batchInput());
    const first = await applyImportBatch(db, batch.batchId);
    const second = await applyImportBatch(db, batch.batchId);
    expect(second.ok).toBe(false);
    expect(second.batch?.appliedAt?.getTime()).toBe(first.batch?.appliedAt?.getTime());
  });

  it('★ 放弃只对 open 生效；已落定的批次不许被改成放弃', async () => {
    const db = await freshDb();
    const { batch } = await openImportBatch(db, batchInput());
    await applyImportBatch(db, batch.batchId);
    const abandoned = await abandonImportBatch(db, batch.batchId);
    expect(abandoned.ok).toBe(false);
    expect(abandoned.batch?.status).toBe('applied');
  });

  it('放弃一个刚开的批次会把它标成 abandoned，且 applied_at 仍为空', async () => {
    const db = await freshDb();
    const { batch } = await openImportBatch(db, batchInput());
    const abandoned = await abandonImportBatch(db, batch.batchId);
    expect(abandoned.ok).toBe(true);
    expect(abandoned.batch?.status).toBe('abandoned');
    expect(abandoned.batch?.appliedAt).toBeNull();
  });

  it('批次不存在时 ok: false 且 batch 为 null（不抛）', async () => {
    const db = await freshDb();
    const missing = await applyImportBatch(db, '00000000-0000-4000-8000-000000000000');
    expect(missing.ok).toBe(false);
    expect(missing.batch).toBeNull();
  });
});

describe('readImportBatches', () => {
  it('按创建时间倒序，可按 stage 过滤', async () => {
    const db = await freshDb();
    await openImportBatch(db, batchInput({ stageId: 'stage-A', contentHash: HASH_A }));
    await openImportBatch(db, batchInput({ stageId: 'stage-B', contentHash: HASH_B }));
    const all = await readImportBatches(db);
    expect(all).toHaveLength(2);
    const onlyA = await readImportBatches(db, { stageId: 'stage-A' });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.stageId).toBe('stage-A');
  });

  it('limit 非正数回空数组（不去库里问）', async () => {
    const db = await freshDb();
    await openImportBatch(db, batchInput());
    expect(await readImportBatches(db, { limit: 0 })).toEqual([]);
    expect(await readImportBatches(db, { limit: -3 })).toEqual([]);
  });

  it('limit 生效', async () => {
    const db = await freshDb();
    await openImportBatch(db, batchInput({ contentHash: HASH_A }));
    await openImportBatch(db, batchInput({ contentHash: HASH_B }));
    expect(await readImportBatches(db, { limit: 1 })).toHaveLength(1);
  });
});

describe('库里的约束（契约漂移）', () => {
  it('★ 唯一键是五个字段且带 NULLS NOT DISTINCT', async () => {
    const db = await freshDb();
    const { rows } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'xq_import_batch'::regclass AND contype = 'u'`,
    );
    const def = rows[0]?.def ?? '';
    expect(def).toContain('stage_id');
    expect(def).toContain('source_graph');
    expect(def).toContain('content_hash');
    expect(def).toContain('extractor');
    expect(def).toContain('graph_version');
    expect(def).toContain('NULLS NOT DISTINCT');
  });

  it('★ applied 与 applied_at 是双向约束 —— 手写一行半截状态要被拒', async () => {
    const db = await freshDb();
    await expect(
      db.query(
        `INSERT INTO xq_import_batch
           (stage_id, origin, source_graph, content_hash, extractor, graph_version, status, applied_at)
         VALUES ('stage-X', 'own-course', NULL, $1, 'e', 1, 'applied', NULL)`,
        [HASH_A],
      ),
    ).rejects.toThrow(/xq_import_batch_applied_pair/i);
  });

  it('★ origin 与 source_graph 也是双向的', async () => {
    const db = await freshDb();
    await expect(
      db.query(
        `INSERT INTO xq_import_batch
           (stage_id, origin, source_graph, content_hash, extractor, graph_version)
         VALUES ('stage-X', 'own-course', 'acm-graph', $1, 'e', 1)`,
        [HASH_A],
      ),
    ).rejects.toThrow(/xq_import_batch_origin_graph/i);
  });
});
