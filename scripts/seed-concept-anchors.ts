#!/usr/bin/env tsx
/**
 * 给概念图填义项锚（`xq_concept.anchors`）。
 *
 * ## 为什么需要这个脚本
 *
 * `xq_concept.anchors` 是 `J-外来课程接入设计.md` §3.4 闸 2 的**唯一**数据来源：
 * 外来课程里的「构造」如果在我们图里指 OOP，而那一侧的上下文没有
 * `构造方法` / `构造器` 这类锚词，就一票降级成存疑、**不许判命中**。实测覆盖率
 * 20/25 = 80%，剩下 5 页是「漏判成存疑」—— 方向是对的（漏判多问人一次，
 * 错判把 8 页错挂上去）。
 *
 * 但这一列在 104 个概念上**一个值都没有**（2026-11-10 实测）。闸 2 今天不是
 * 「实现漏了」，是「没有燃料」。
 *
 * ## 锚从哪来
 *
 * J §8 第 4 条给了两路：① 从 234 页正文按共现自动抽，人工只校 top-N；
 * ② 人工写（准，但 2686 节点写不完）。这里做 ①，判据在
 * `lib/persistence/xq-concept-anchors.ts` 的文件头（不是词频，是相对全库的富集）。
 *
 * ## 为什么默认只报告
 *
 * `anchors` 是唯一带**否决权**的列 —— 写错一个词，闸 2 会把本该命中的外来概念
 * 降级成存疑。所以默认只打印候选，写库要 `--execute`。已有锚的概念默认跳过
 * （人校过的值不许被一次自动重算抹掉），要重算得显式 `--force`。
 *
 * ## 用法
 *
 *   npx tsx --conditions=import --env-file-if-exists=.env.local scripts/seed-concept-anchors.ts
 *   npx tsx ... scripts/seed-concept-anchors.ts --execute
 *   npx tsx ... scripts/seed-concept-anchors.ts --execute --force --verbose
 *
 * 退出码：0 正常（含「什么都没写」）/ 1 异常。
 *
 * ## 为什么静态 import 只有 node 内建
 *
 * `pg-pool` 的 `esm/index.mjs` 需要被改回 `/index.js`（见 `source-provider` 那边
 * 同一个坑）；静态 import 会先于 `registerHooks` 求值，钩子来不及装。
 */

import * as nodeModule from 'node:module';

interface ModuleWithHooks {
  registerHooks?: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      nextResolve: (specifier: string, context: unknown) => { url: string },
    ) => { url: string };
  }) => void;
}

const registerHooks = (nodeModule as unknown as ModuleWithHooks).registerHooks;
if (typeof registerHooks === 'function') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const base = nextResolve(specifier, context);
      if (specifier === 'pg-pool') {
        return { ...base, url: base.url.replace(/[\\/]esm[\\/]index\.mjs$/, '/index.js') };
      }
      return base;
    },
  });
}

interface Options {
  execute: boolean;
  force: boolean;
  verbose: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { execute: false, force: false, verbose: false };
  for (const arg of argv) {
    if (arg === '--execute') options.execute = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--dry-run') options.execute = false;
    else {
      console.error(`未知参数：${arg}`);
      console.error('用法：seed-concept-anchors.ts [--execute] [--force] [--verbose]');
      process.exit(2);
    }
  }
  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error('DATABASE_URL 没有设置 —— 这个脚本要连真库。');
    return 1;
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });
  try {
    const { syncConceptAnchors } = await import('../lib/persistence/xq-concept-anchors');
    const report = await syncConceptAnchors(pool, {
      execute: options.execute,
      force: options.force,
    });

    console.log('义项锚读数：');
    console.log(`  库里概念 ${report.concepts} 个，其中有页可算的 ${report.eligible} 个`);
    console.log(`  算出锚的概念 ${report.withAnchors} 个，候选词共 ${report.candidates} 个`);
    console.log(`  已有锚跳过 ${report.kept} 个，本次要写 ${report.writtenDetail.length} 个`);

    if (options.verbose) {
      for (const item of report.writtenDetail) {
        console.log(`    + ${item.name}: ${item.anchors.join(' / ')}`);
      }
      for (const item of report.keptDetail) {
        console.log(`    = ${item.name}: 已有 ${item.existing.join(' / ')}`);
      }
    }

    if (!options.execute) {
      console.log('没加 --execute：一行都没写。');
      return 0;
    }
    console.log(`写入完成：${report.written} 个概念的 anchors 已更新。`);
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
