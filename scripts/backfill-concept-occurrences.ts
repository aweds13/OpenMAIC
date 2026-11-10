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
 *     scripts/backfill-concept-occurrences.ts [--execute] [--dry-run] [--verbose]
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
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { execute: false, verbose: false };
  for (const arg of argv) {
    if (arg === '--execute') options.execute = true;
    else if (arg === '--dry-run') options.execute = false;
    else if (arg === '--verbose') options.verbose = true;
    else throw new Error(`未知参数：${arg}（只认 --execute / --dry-run / --verbose）`);
  }
  return options;
}

interface Counts extends Record<string, unknown> {
  total: string;
  manual: string;
  generated: string;
  pages: string;
}

async function readCounts(pool: {
  query: <T extends Record<string, unknown>>(text: string) => Promise<{ rows: T[] }>;
}): Promise<Counts> {
  const result = await pool.query<Counts>(
    `SELECT (SELECT count(*) FROM xq_concept_occurrence)::text AS total,
            (SELECT count(*) FROM xq_concept_occurrence WHERE source = 'manual')::text AS manual,
            (SELECT count(*) FROM xq_concept_occurrence WHERE source <> 'manual')::text AS generated,
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

  const pool = new Pool({ connectionString });
  try {
    const before = await readCounts(pool);
    const report = await syncConceptOccurrences(pool, { execute: options.execute });

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
        `库里多出来要删 ${report.stale}（manual ${report.manual} 行不动）`,
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
        `其中 manual ${before.manual} → ${after.manual}`,
    );

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
