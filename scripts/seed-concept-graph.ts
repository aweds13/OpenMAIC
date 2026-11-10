#!/usr/bin/env node
/**
 * 把种子图写进库 —— 让「那 104 个概念」变成可再生的一步。
 *
 * ## 为什么需要这个脚本（不是「补一次数据」）
 *
 * 2026-11-10 实测：全仓 `grep buildSeedGraph` 只命中 `lib/concepts/index.ts`
 * 的 re-export、`scripts/backfill-question-concepts.ts`（只拿它建别名索引做
 * 匹配，**不写概念表**）与两个测试。库里那 104 概念 / 357 别名 / 63 外部
 * 引用 / 105 条先修边，是 2026-11-09 用一个**已不在盘上**的 `.tmp` 脚本灌的。
 *
 * 也就是说：今天没有人能照着仓里的代码把这份图重做一遍。换台机器、重建个库、
 * 或者只是想加一个概念，第一步都卡在这里。这个脚本补的就是这一步。
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
 * ## 判据（真库 2026-11-10）
 *
 * 种子图读数：概念 **104** / 边 **105**（`prereq` 94 + `contains` 11）/
 * 外部引用 **63** / 归一化别名 **357**。库里的行数与它们**逐一吻合**
 * （104 / 357 / 63 / 105）—— 这正好充当一次反向验证：如果同步器算出来的
 * 数字对不上，说明它的归一化规则或认领规则与当初那次导入不一致。
 *
 * 因此真库上跑 `--dry-run` 的期望读数是「新增 0 / 更新 0 / 跳过全部」。
 *
 * ## 用法
 *
 *     npx tsx --conditions=import --env-file-if-exists=.env.local \
 *     scripts/seed-concept-graph.ts [--execute] [--verbose]
 *
 * ★ **默认只报告，不写库**。这一条与 `scripts/backfill-*.ts` 那几个不同，
 * 是刻意的：这个脚本动的是 `xq_concept`，它是所有学情表的外键父表。批量新造
 * 概念 id 之后，旧的出现记录与题级映射会失去父行（它们按 id 指 —— 见本文件
 * 「为什么不重造 id」那段：同步器**以名字认领**已有行，所以正常路径不会撞上
 * 这个风险，但「一个新概念算不算新」本身需要人看一眼）。
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

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const { Pool } = await import('pg');
  const { syncSeedGraph } = await import('../lib/persistence/xq-seed-sync');

  const pool = new Pool({ connectionString });
  try {
    const before = await pool.query<{
      concepts: string;
      aliases: string;
      refs: string;
      edges: string;
    }>(
      `SELECT (SELECT count(*) FROM xq_concept)::text AS concepts,
              (SELECT count(*) FROM xq_concept_alias)::text AS aliases,
              (SELECT count(*) FROM xq_concept_external_ref)::text AS refs,
              (SELECT count(*) FROM xq_concept_edge)::text AS edges`,
    );
    const b = before.rows[0];

    const report = await syncSeedGraph(pool, { execute: options.execute });

    console.log('种子图读数：');
    console.log(
      `  概念 ${report.seed.concepts} / 边 ${report.seed.edges} / 外部引用 ${report.seed.externalRefs}` +
        ` / 归一化别名 ${report.seed.aliases}`,
    );
    console.log('这一次：');
    console.log(`  概念：认领 ${report.matched} 行，新增 ${report.insertedConcepts} 行`);
    console.log(`  别名：新增 ${report.aliases.inserted}，跳过 ${report.aliases.skipped}`);
    console.log(
      `  外部引用：新增 ${report.externalRefs.inserted}，跳过 ${report.externalRefs.skipped}`,
    );
    console.log(
      `  边：新增 ${report.edges.inserted}，更新 ${report.edges.updated}，未变 ${report.edges.unchanged}`,
    );

    if (report.externalRefs.conflicting.length > 0) {
      console.log(`  外部引用冲突 ${report.externalRefs.conflicting.length} 条（不覆盖，只报）：`);
      for (const line of report.externalRefs.conflicting) console.log(`    - ${line}`);
    }

    if (report.problems.length > 0) {
      console.log(`  另有问题 ${report.problems.length} 条：`);
      for (const line of report.problems) console.log(`    - ${line}`);
    }

    if (!options.execute) {
      console.log('没加 --execute：一行都没写。');
      return 0;
    }

    const after = await pool.query<{
      concepts: string;
      aliases: string;
      refs: string;
      edges: string;
    }>(
      `SELECT (SELECT count(*) FROM xq_concept)::text AS concepts,
              (SELECT count(*) FROM xq_concept_alias)::text AS aliases,
              (SELECT count(*) FROM xq_concept_external_ref)::text AS refs,
              (SELECT count(*) FROM xq_concept_edge)::text AS edges`,
    );
    const a = after.rows[0];
    console.log(
      `写库前后：概念 ${b.concepts} → ${a.concepts}，别名 ${b.aliases} → ${a.aliases}，` +
        `外部引用 ${b.refs} → ${a.refs}，边 ${b.edges} → ${a.edges}`,
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
