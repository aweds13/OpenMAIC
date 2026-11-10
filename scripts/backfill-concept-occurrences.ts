#!/usr/bin/env node
/**
 * 重算「哪一页在讲哪个概念」，写进 `xq_concept_occurrence`。
 *
 * ## 为什么需要这个脚本
 *
 * 2026-11-10 实测：`deriveOccurrencesFromOutlines` 在全仓只被测试调用。库里那
 * 644 行出现记录是 2026-11-09 用一个**已不在盘上**的 `.tmp` 脚本灌的 —— 也就
 * 是说，新课生成之后没有任何代码会把它的页挂到概念上。`xq_concept_occurrence`
 * 不是「数据少了」，是**只有老课有**。
 *
 * ## 为什么默认不写库
 *
 * 与 `scripts/seed-concept-graph.ts` 同一条理由，但这里更硬：本脚本会
 * **删行**。重算之后库里多出来的那些（`source` 是 `keypoint`/`title`/`body`
 * 的）说明那一页不再讲了，派生表该跟着变；但 `source = 'manual'` 的行一行都
 * 不许删 —— 那是人手动挂的判断。这条判据写在 `syncConceptOccurrences` 里，
 * 不靠调用方记得传开关。
 *
 * ## 判据（真库 2026-11-10）
 *
 * 历史那次导入留下 644 行（`body 500 / title 127 / keypoint 17`，209 页）。
 * 本脚本按 `staticPageText()` 重算得 **645 行**（`body 500 / title 126 /
 * keypoint 19`，**209 页**）—— `body` 与页数两栏同时落回原位，这是「同一个
 * 单位」最强的证据。
 *
 * ★ 记一笔走过的弯路：第一版自己写了一个按 `content` 结构分派的抽取函数，
 * 算出 674 行 / 211 页 / `body 529`，与当时库里的 644 行对上 613 行（看着像
 * 95.2% 的高吻合）。那个数是**假象** —— 它把 interactive 外壳 HTML 里的词当
 * 成正文（多 29 行 body），又漏掉 48 个带 `widgetConfig` 的页的真实正文。
 * 换成仓里唯一的那个单位后 body 与页数才同时对上。
 *
 * ## 批次：每一行都要指得出「哪次导进来的」
 *
 * `--execute --batch` 时脚本按课各开一批（`openImportBatch()` 五键幂等，同一份
 * 内容重跑命中同一批）→ 把 `stage → batchId` 交给同步器 → 全部写成功才
 * `applyImportBatch()` 落定。不带 `--batch` 时行为与以前一样：只写权重与来源，
 * 不碰 `batch_id` / `page_hash` —— 那两列一经写入就是「这一行是哪一批拍的」的
 * 唯一凭据，不该由不知道自己是哪一批的调用方去写。
 *
 * ★ 两列都不是装饰：`page_hash` 让「页被重生成过、但抽取没重跑」在读时可判
 * （`stale_since`），`batch_id` 让「这批是谁导的」在库里可答。
 *
 * ## 为什么静态 import 只有 node 内建
 *
 * 与 `scripts/backfill-review-schedule.ts` 完全同一个原因：`@openmaic/storage`
 * 只在 `import` 条件下发布子路径，而在那条件下 `pg` 会把自身的 `pg-pool`
 * 依赖解析成 ESM 入口，随后 `class BoundPool extends Pool` 抛
 *
 *     TypeError: Class extends value #<Object> is not a constructor or null
 *
 * 钩子必须在 `pg` 第一次加载前注册，所以应用模块一律动态 import。
 *
 * ## 用法
 *
 *     npx tsx --conditions=import --env-file-if-exists=.env.local \
 *     scripts/backfill-concept-occurrences.ts [--execute] [--dry-run] [--verbose] [--batch]
 */

import * as nodeModule from 'node:module';

interface ResolveResult {
  url: string;
}
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => ResolveResult,
) => ResolveResult;
const registerModuleHooks = (
  nodeModule as unknown as {
    registerHooks: (hooks: { resolve: ResolveHook }) => void;
  }
).registerHooks;

registerModuleHooks({
  resolve(specifier, context, nextResolve) {
    const base = nextResolve(specifier, context);
    if (specifier === 'pg-pool') {
      return { ...base, url: base.url.replace(/[\\/]esm[\\/]index\.mjs$/, '/index.js') };
    }
    return base;
  },
});

interface Options {
  execute: boolean;
  verbose: boolean;
  /** 开批次并把归属写进 occurrence（只有 `--execute` 时才真开）。 */
  batch: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { execute: false, verbose: false, batch: false };
  for (const arg of argv) {
    if (arg === '--execute') options.execute = true;
    else if (arg === '--dry-run') options.execute = false;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--batch') options.batch = true;
    else throw new Error(`未知参数：${arg}（只认 --execute / --dry-run / --verbose / --batch）`);
  }
  return options;
}

interface Counts extends Record<string, unknown> {
  total: string;
  manual: string;
  generated: string;
  foreign: string;
  pages: string;
}

async function readCounts(pool: {
  query: <T extends Record<string, unknown>>(text: string) => Promise<{ rows: T[] }>;
}): Promise<Counts> {
  const result = await pool.query<Counts>(
    `SELECT (SELECT count(*) FROM xq_concept_occurrence)::text AS total,
            (SELECT count(*) FROM xq_concept_occurrence WHERE source = 'manual')::text AS manual,
            (SELECT count(*) FROM xq_concept_occurrence
              WHERE source IN ('keypoint', 'title', 'body'))::text AS generated,
            (SELECT count(*) FROM xq_concept_occurrence
              WHERE source LIKE 'foreign-%')::text AS foreign,
            (SELECT count(DISTINCT (stage_id, scene_id)) FROM xq_concept_occurrence)::text AS pages`,
  );
  return result.rows[0];
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const { Pool } = await import('pg');
  const { syncConceptOccurrences } = await import('../lib/persistence/xq-concept-occurrence-sync');
  const { applyImportBatch, contentHashOfPages, openImportBatch } =
    await import('../lib/persistence/xq-import-batch');
  const { openGraphVersion, readGraphVersions } =
    await import('../lib/persistence/xq-graph-version');

  const pool = new Pool({ connectionString });
  try {
    const before = await readCounts(pool);

    // ── 批次（只在 --batch 时开）──────────────────────────────────
    //
    // 一次重算覆盖「库里所有页」，而批次是按课的（`xq_import_batch.stage_id`
    // 非空且有外键）。所以按 stage 分组各开一批，把 `stage → batchId` 交给
    // 同步器；没有 --batch 就让 batchIds 保持 undefined —— 同步器不会去动
    // 那两列。
    // ★ 只有真的写库时才开批 —— `--dry-run` 一个字都不该落，而开批本身就是
    // 一次 INSERT。想看「会开几批」的话，读下面那行阶段性的页数就够了。
    let batchIds: Map<string, string> | undefined;
    if (options.batch && !options.execute) {
      console.log('没加 --execute：不真开批次（开批自己就是一次写）。');
    }
    if (options.batch && options.execute) {
      const versions = await readGraphVersions(pool);
      const current = openGraphVersion(versions);
      if (current === null) {
        throw new Error('没有开放的图谱版本，先跑 scripts/advance-graph-version.ts');
      }

      const { rows } = await pool.query<{
        stage_id: string;
        scene_id: string;
        scene_order: number | null;
        data: unknown;
      }>('SELECT stage_id, id AS scene_id, scene_order, data FROM document_scenes');
      const byStage = new Map<string, { sceneId: string; sceneOrder: number; data: unknown }[]>();
      for (const row of rows) {
        const list = byStage.get(row.stage_id) ?? [];
        list.push({
          sceneId: row.scene_id,
          sceneOrder: row.scene_order ?? 0,
          data: row.data,
        });
        byStage.set(row.stage_id, list);
      }

      batchIds = new Map<string, string>();
      console.log(`批次（图谱 v${current.version}，${byStage.size} 门课）：`);
      for (const [stageId, pages] of byStage) {
        const result = await openImportBatch(pool, {
          stageId,
          origin: 'own-course',
          contentHash: contentHashOfPages(pages),
          extractor: 'openmaic/occurrence@1',
          graphVersion: current.version,
        });
        batchIds.set(stageId, result.batch.batchId);
        console.log(`  ${stageId} ${result.created ? '新开' : '命中'} ${result.batch.batchId}`);
      }
    }

    const report = await syncConceptOccurrences(pool, {
      execute: options.execute,
      ...(batchIds === undefined ? {} : { batchIds }),
    });

    console.log('页与大纲：');
    console.log(
      `  页 ${report.pages}，其中 ${report.pagesWithOutline} 页的 outlineId 能在大纲里找到`,
    );
    console.log(`  算出来 ${report.occurrences} 行：`);
    for (const source of ['keypoint', 'title', 'body']) {
      console.log(`    ${source} ${report.bySource[source] ?? 0}`);
    }
    console.log('与库比对：');
    console.log(
      `  新增 ${report.insert}，更新 ${report.update}，未变 ${report.unchanged}，` +
        `库里多出来要删 ${report.stale}（manual ${report.manual} 行、` +
        `foreign ${report.foreign} 行都不动）`,
    );

    if (report.problems.length > 0) {
      console.log(`  另有问题 ${report.problems.length} 条：`);
      for (const line of report.problems) console.log(`    - ${line}`);
    }

    if (!options.execute) {
      console.log('没加 --execute：一行都没写。');
      return 0;
    }

    const after = await readCounts(pool);
    console.log(
      `写库前后：行 ${before.total} → ${after.total}，` +
        `覆盖页 ${before.pages} → ${after.pages}，` +
        `其中 manual ${before.manual} → ${after.manual}、` +
        `foreign ${before.foreign} → ${after.foreign}`,
    );

    // ── 落定批次 ─────────────────────────────────────────────────
    //
    // 同步器把全部行写完才走到这里。半途抛错时批次留在 open，下次重跑会命中
    // 同一批再试一遍 —— 这就是「三态而不是成功/失败」的用处。
    if (batchIds !== undefined) {
      let applied = 0;
      for (const batchId of batchIds.values()) {
        const result = await applyImportBatch(pool, batchId);
        if (result.ok) applied += 1;
      }
      console.log(`落定 ${applied} / ${batchIds.size} 批（其余可能已在别处落定）。`);
    }

    if (options.verbose) {
      console.log('（--verbose 没有额外输出：逐行明细在报告里已经全了）');
    }
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
