import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import { syncSeedGraph } from '@/lib/persistence/xq-seed-sync';
import { syncConceptOccurrences } from '@/lib/persistence/xq-concept-occurrence-sync';
import {
  ANCHOR_MIN_LIFT,
  ANCHOR_MIN_PAGES,
  ANCHOR_STOP_WORDS,
  pageKeyOf,
  proposeAnchors,
  segmentAnchorWords,
  syncConceptAnchors,
} from '@/lib/persistence/xq-concept-anchors';
import type { SeedGraph } from '@/lib/concepts';

/**
 * 这一组钉的是**义项锚怎么算出来的**，不是 SQL 的形状。
 *
 * 锚是 `xq_concept.anchors`，也是 `J-外来课程接入设计.md` §3.4 闸 2 的唯一
 * 数据来源 —— 那一列是**唯一带否决权**的信号，写错一个词就会把本该命中的外来
 * 概念降级成存疑。所以这组判据的重点是「什么样的词算锚」：
 *
 *   · 不是词频，是**相对全库的富集**（`变量 94/234` 这种高频词一个都不该进）
 *   · 锚不许是概念名本身，也不许把概念名包进去（那是重复自己）
 *   · 页太少的概念不给锚（4 页里碰巧一起出现两次是巧合）
 *   · 已有锚的概念默认跳过（人校过的值不许被自动重算抹掉）
 *   · 默认不写库
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

function tinyGraph(): SeedGraph {
  return {
    concepts: [
      { key: 'a', name: '构造方法', kind: 'concept' },
      { key: 'b', name: '字符串', kind: 'concept' },
      { key: 'c', name: '数组', kind: 'concept' },
    ],
    edges: [],
  };
}

async function seed(db: PGlite): Promise<void> {
  const report = await syncSeedGraph(db, { graph: tinyGraph(), execute: true });
  expect(report.insertedConcepts).toBe(3);
}

interface PageSpec {
  sceneId: string;
  title: string;
  body: string;
}

async function seedPages(db: PGlite, stageId: string, pages: readonly PageSpec[]): Promise<void> {
  await db.query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, data)
    VALUES ($1, $1, 0, 0, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    [stageId],
  );
  for (const [index, page] of pages.entries()) {
    await db.query(
      `INSERT INTO document_scenes (stage_id, id, scene_order, data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        stageId,
        page.sceneId,
        index,
        JSON.stringify({
          id: page.sceneId,
          stageId,
          order: index,
          type: 'slide',
          title: page.title,
          content: {
            canvas: {
              elements: [{ id: 'e1', type: 'text', content: `<p>${page.body}</p>` }],
            },
          },
        }),
      ],
    );
  }
}

async function anchorsOf(db: PGlite, name: string): Promise<string[]> {
  const { rows } = await db.query<{ anchors: string[] }>(
    `SELECT anchors FROM xq_concept WHERE canonical_name = $1`,
    [name],
  );
  return rows[0]?.anchors ?? [];
}

describe('切词：只留像词的实义片段', () => {
  it('★ 中文按词切，不是按字切 n-gram', () => {
    // n-gram 会给 `造方` / `造方法` / `的构` 这类碎片 —— 那正是要避免的。
    // ★ 注意 `Intl.Segmenter` 对**没有分隔符**的连写并不总能切对：
    //   「构造方法里用 super 调用父类构造器」只切出 `构造` / `方法`，
    //   `父类` 被切成了 `父` + `类`（两个字一个词，被长度过滤掉）。
    //   这不是缺陷 —— 真实页面的正文有标点与空格，模型写的中文也有。
    const words = segmentAnchorWords('构造方法里用 super 调用父类构造器');
    expect(words).toContain('构造');
    // `方法` 切得出来，但它在停用词表里（整套课程都在讲「方法」）⇒ 被滤掉。
    expect(words).not.toContain('方法');
    expect(words).not.toContain('造方');
    expect(words).not.toContain('的构');
  });

  it('★ 首尾是虚字的碎片整条丢掉', () => {
    // 实测 `Intl.Segmenter` 会切出 `的是` / `那一` / `面上` / `要写`。
    const words = segmentAnchorWords('这个方法的是哪个，那一行代码，页面上显示的文字');
    expect(words).not.toContain('的是');
    expect(words).not.toContain('那一');
    expect(words).not.toContain('面上');
    expect(words).toContain('显示');
  });

  it('英文标识符不收 —— 它们在概念名里就带着', () => {
    const words = segmentAnchorWords('用 setState 触发 build 方法');
    expect(words).not.toContain('setState');
    expect(words).not.toContain('build');
  });

  it('一个字的词不收（`类` 会命中几乎每一页）', () => {
    expect(segmentAnchorWords('类和对象和方法')).not.toContain('类');
  });

  it('空串回空数组，不抛', () => {
    expect(segmentAnchorWords('')).toEqual([]);
  });

  it('停用词表里没有真义项词 —— 它是数据，不是判据', () => {
    for (const word of ['构造', '继承', '多态', '抽象', '封装', '分支', '递归']) {
      expect(ANCHOR_STOP_WORDS).not.toContain(word);
    }
  });
});

describe('算锚：富集而不是词频', () => {
  it('★ 一个到处都有的词不算锚 —— 哪怕它在这个概念的页面里出现得更多', () => {
    // `构造` 只在 c1 的 5 页上出现（全库 20 页）⇒ lift 高。
    // `无关` 在这 5 页 + 另外 10 页都出现（覆盖率相同，但全库更常见）⇒ lift 低。
    const pageText = new Map<string, string>();
    for (let i = 0; i < 5; i++) pageText.set(`p${i}`, '构造 无关');
    for (let i = 5; i < 15; i++) pageText.set(`q${i}`, '无关');
    for (let i = 0; i < 5; i++) pageText.set(`r${i}`, '别的内容');
    const proposed = proposeAnchors({
      concepts: [{ conceptId: 'c1', name: '子类', pageKeys: ['p0', 'p1', 'p2', 'p3', 'p4'] }],
      pageText,
      totalPages: 20,
    });
    const words = (proposed.get('c1') ?? []).map((c) => c.word);
    expect(words).toContain('构造');
    expect(words).not.toContain('无关');
  });

  it('★ 锚不许是概念名本身，也不许把概念名包进去', () => {
    const pageText = new Map<string, string>();
    for (let i = 0; i < 6; i++) pageText.set(`p${i}`, '构造方法 构造 继承');
    for (let i = 6; i < 30; i++) pageText.set(`q${i}`, '完全无关的别的内容');
    const proposed = proposeAnchors({
      concepts: [
        { conceptId: 'c1', name: '构造方法', pageKeys: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] },
      ],
      pageText,
      totalPages: 30,
    });
    const words = (proposed.get('c1') ?? []).map((c) => c.word);
    // 概念名本身不收（它是重复自己），它切出来的碎片也不收
    expect(words).not.toContain('构造方法');
    expect(words).not.toContain('方法');
    expect(words).toContain('继承');
  });

  it(`页数少于 ${ANCHOR_MIN_PAGES} 的概念不给锚 —— 两次共现是巧合`, () => {
    const pageText = new Map<string, string>([
      ['p0', '构造 父类'],
      ['p1', '构造 父类'],
      ['p2', '无关'],
      ['p3', '无关'],
    ]);
    const proposed = proposeAnchors({
      concepts: [{ conceptId: 'c1', name: '构造方法', pageKeys: ['p0', 'p1'] }],
      pageText,
      totalPages: 4,
    });
    expect(proposed.size).toBe(0);
  });

  it('门槛就是常量本身，不是写死的数字', () => {
    expect(ANCHOR_MIN_LIFT).toBe(2);
    expect(ANCHOR_MIN_PAGES).toBe(4);
  });

  it('排序稳定：同 lift 同 pages 时按码点，不按 locale', () => {
    const pageText = new Map<string, string>();
    for (let i = 0; i < 4; i++) pageText.set(`p${i}`, '编译 继承');
    for (let i = 0; i < 6; i++) pageText.set(`q${i}`, '别的内容');
    const proposed = proposeAnchors({
      concepts: [{ conceptId: 'c1', name: '重写与 @Override', pageKeys: ['p0', 'p1', 'p2', 'p3'] }],
      pageText,
      totalPages: 10,
    });
    const words = (proposed.get('c1') ?? []).map((c) => c.word);
    // 两个词 lift 与 pages 都相同 ⇒ 码点序：继(U+7EE7=32487) < 编(U+7F16=32534)
    expect(words).toContain('编译');
    expect(words).toContain('继承');
    expect(words.indexOf('继承')).toBeLessThan(words.indexOf('编译'));
  });

  it('页正文缺页当空串，不抛', () => {
    const proposed = proposeAnchors({
      concepts: [
        { conceptId: 'c1', name: '构造方法', pageKeys: ['gone', 'gone2', 'gone3', 'gone4'] },
      ],
      pageText: new Map(),
      totalPages: 10,
    });
    expect(proposed.size).toBe(0);
  });

  it('总页数 0 时直接回空，不算分母', () => {
    const proposed = proposeAnchors({
      concepts: [{ conceptId: 'c1', name: '构造方法', pageKeys: ['p0'] }],
      pageText: new Map([['p0', '构造']]),
      totalPages: 0,
    });
    expect(proposed.size).toBe(0);
  });
});

/** 六页讲「继承 编译」，另外三十页讲别的事 —— 义项锚要能从前者里认出这两个词。 */
const ANCHOR_PAGES: readonly PageSpec[] = [
  ...Array.from({ length: 6 }, (_unused, i) => ({
    sceneId: `scene-a${i}`,
    title: `讲继承的第 ${i} 页`,
    body: '继承 编译 终端',
  })),
  ...Array.from({ length: 30 }, (_unused, i) => ({
    sceneId: `scene-b${i}`,
    title: `别的第 ${i} 页`,
    body: '假期 旅行 天气',
  })),
];

/** 把 `构造方法` 也挂到前六页上，这样它才「有页可算」。 */
async function setupAnchors(db: PGlite): Promise<void> {
  await seed(db);
  await seedPages(db, 'stage-A', ANCHOR_PAGES);
  await syncConceptOccurrences(db, { graph: tinyGraph(), execute: true });
  await db.query(
    `INSERT INTO xq_concept_occurrence (concept_id, stage_id, scene_id, weight, source)
     SELECT id, 'stage-A', scene_id, 1.0, 'manual'
       FROM xq_concept, (VALUES ('scene-a0'),('scene-a1'),('scene-a2'),('scene-a3'),('scene-a4'),('scene-a5')) AS t(scene_id)
      WHERE canonical_name = '构造方法'
     ON CONFLICT DO NOTHING`,
  );
}

describe('落库：默认不写，已有锚不覆盖', () => {
  it('★ 不传 execute 一行都不写（但报告要说清「本来要写什么」）', async () => {
    const db = await freshDb();
    await setupAnchors(db);

    const report = await syncConceptAnchors(db);
    expect(report.execute).toBe(false);
    // ★ `written` 是「这一次要写的概念数」，不是「真写了几行」——
    // 不然 `--dry-run` 的报告会永远说 0，那份报告就没有意义了。
    expect(report.written).toBeGreaterThan(0);
    const planned = report.writtenDetail.find((item) => item.name === '构造方法');
    expect(planned).toBeDefined();
    expect(planned?.anchors).toContain('继承');
    // 库里一行都没动
    expect(await anchorsOf(db, '构造方法')).toEqual([]);
  });

  it('★ execute 之后锚真的在库里，且不含概念名', async () => {
    const db = await freshDb();
    await setupAnchors(db);

    const report = await syncConceptAnchors(db, { execute: true });
    expect(report.written).toBeGreaterThan(0);
    const anchors = await anchorsOf(db, '构造方法');
    expect(anchors).toContain('继承');
    expect(anchors).toContain('编译');
    expect(anchors).not.toContain('构造方法');
    expect(anchors).not.toContain('构造');
    expect(anchors).not.toContain('方法');
  });

  it('★ 已有锚的概念默认跳过 —— 人校过的值不许被自动重算抹掉', async () => {
    const db = await freshDb();
    await setupAnchors(db);
    await db.query(
      `UPDATE xq_concept SET anchors = ARRAY['人工校过的'] WHERE canonical_name = '构造方法'`,
    );

    const report = await syncConceptAnchors(db, { execute: true });
    expect(report.kept).toBeGreaterThanOrEqual(1);
    expect(report.keptDetail.some((item) => item.name === '构造方法')).toBe(true);
    expect(await anchorsOf(db, '构造方法')).toEqual(['人工校过的']);
  });

  it('★ force 才覆盖已有锚', async () => {
    const db = await freshDb();
    await setupAnchors(db);
    await db.query(
      `UPDATE xq_concept SET anchors = ARRAY['人工校过的'] WHERE canonical_name = '构造方法'`,
    );

    const report = await syncConceptAnchors(db, { execute: true, force: true });
    expect(report.kept).toBe(0);
    const anchors = await anchorsOf(db, '构造方法');
    expect(anchors).not.toEqual(['人工校过的']);
    expect(anchors).toContain('继承');
  });

  it('幂等：同一份数据算两次，结果一样', async () => {
    const db = await freshDb();
    await setupAnchors(db);
    await syncConceptAnchors(db, { execute: true });
    const first = await anchorsOf(db, '构造方法');
    await syncConceptAnchors(db, { execute: true, force: true });
    expect(await anchorsOf(db, '构造方法')).toEqual(first);
  });

  it('没有出现记录的概念不参与 —— 锚必须来自「它真的在哪几页」', async () => {
    const db = await freshDb();
    await seed(db);
    await seedPages(db, 'stage-A', ANCHOR_PAGES.slice(0, 6));
    // 不跑 occurrence 同步、也不手工挂概念 ⇒ 没有任何页挂着概念。
    const report = await syncConceptAnchors(db, { execute: true });
    expect(report.eligible).toBe(0);
    expect(report.writtenDetail).toEqual([]);
  });

  it('pageKeyOf 与 occurrence 主键同口径：跨课同名 scene 算两页', () => {
    expect(pageKeyOf('stage-A', 'scene-p1')).not.toBe(pageKeyOf('stage-B', 'scene-p1'));
  });
});
