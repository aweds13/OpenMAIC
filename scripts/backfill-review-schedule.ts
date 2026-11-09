#!/usr/bin/env node
/**
 * 把「已经答错的题」补上四关排期 —— 让复习闭环对历史证据也开张。
 *
 * ## 为什么需要这个脚本（不是「顺手补一下」）
 *
 * `xq_review_schedule` 建表以来一直是 **0 行**。原因是历史上那批学情证据
 * 来自一次性探针 `.tmp/probe_xq_store.mts`，它只调 `ingestProbeItems()` 与
 * `recomputeCellState()`，**不调** `scheduleReviewForWrong()`。生产入口
 * （`recordProbeFromRuntimeAppend`）现在会排期，但那只管**新**记录；
 * 库里那 5 条错题是旧路径留下的，不会自己长出排期。
 *
 * 于是「答错了要复习」这件事在库里只对将来的答题成立，对已经发生的错题
 * 不成立 —— 状态块会显示「未达判据」，却没有一条到期复习。这个脚本补的就是这个缺口。
 *
 * ## 三步，顺序不能换
 *
 *   1. 读 `xq_probe_item WHERE correct = false`，按 `(stage_id, scene_id,
 *      question_id)` **去重**。同一道题错了三次只排一组四关：排期是「这道题
 *      要复习」，不是「错了三次所以复习三次」。
 *   2. 每道题查一次 `conceptForQuestion()` —— 与生产路径**同一个方法**，
 *      规则也同一份（最高档恰好一个概念才用，否则空串）。不在这里另写一条
 *      SQL：两处判据分叉时，「新错题」与「历史错题」会挂到不同的概念上，
 *      `xq_review_schedule` 的唯一键含 `concept`，同一道题会变成两组四关。
 *   3. `scheduleReviewForWrong()` 一次插四行（1/3/7/15 天）。它用
 *      `ON CONFLICT DO NOTHING` ⇒ 重跑幂等，已经排过的关不会被推后。
 *
 * ## 判据（怎么算做完）
 *
 * 真库读数（2026-11-09）：`xq_probe_item` 里 5 条错题、分属 5 道不同的题，
 * 其中 2 道题的最高档有唯一概念（`scene-p18/q7 → 类与对象`、
 * `scene-p35/q4 → setState 与状态管理`），另 3 道题级映射为零 ⇒ 概念留空。
 * 期望写入 **5 × 4 = 20 行**。重跑一次仍是 20 行。
 *
 * ## 用法
 *
 *     npx tsx --conditions=import --env-file-if-exists=.env.local \
 *     scripts/backfill-review-schedule.ts [--dry-run] [--verbose]
 *
 * 默认**不** dry-run（写的是可从 `xq_probe_item` 整表重算的派生表，且幂等）。
 *
 * ## 为什么静态 import 只有 node 内建
 *
 * 与 `scripts/backfill-question-concepts.ts` 同一个理由：`@openmaic/storage`
 * 只在 `import` 条件下发布子路径，而在那条件下 `pg` 会把自身的 `pg-pool`
 * 依赖解析成 ESM 入口，随后 `class BoundPool extends Pool` 抛
 *
 *     TypeError: Class extends value #<Object> is not a constructor or null
 *
 * 钩子必须在 `pg` 第一次加载前注册，所以应用模块一律动态 import。
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
  dryRun: boolean;
  verbose: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { dryRun: false, verbose: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verbose') options.verbose = true;
    else throw new Error(`未知参数：${arg}（只认 --dry-run / --verbose）`);
  }
  return options;
}

/** 一道答错过的题：去重后的 `(stage, scene, question)`。 */
interface WrongQuestionRow {
  stage_id: string;
  scene_id: string;
  question_id: string;
  wrong_n: string;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const { Pool } = await import('pg');
  const { XqLearnerStore } = await import('../lib/persistence/xq-learner-store');

  const pool = new Pool({ connectionString });
  try {
    const wrong = await pool.query<WrongQuestionRow>(
      `SELECT stage_id, scene_id, question_id, count(*)::text AS wrong_n
         FROM xq_probe_item
        WHERE correct = false
        GROUP BY stage_id, scene_id, question_id
        ORDER BY stage_id, scene_id, question_id`,
    );

    if (wrong.rows.length === 0) {
      console.log('没有答错的题，什么都没做。');
      return 0;
    }

    const store = new XqLearnerStore({ queryable: pool });

    console.log(`答错的题 ${wrong.rows.length} 道（去重后；错了几次不影响排几组四关）：`);

    let planned = 0;
    const failed: string[] = [];
    for (const row of wrong.rows) {
      const concept = await store.conceptForQuestion(row.stage_id, row.scene_id, row.question_id);
      const label = concept === '' ? '（无唯一概念，留空）' : concept;
      if (options.dryRun) {
        console.log(
          `  ${row.stage_id}/${row.scene_id}/${row.question_id}  错 ${row.wrong_n} 次  → ${label}`,
        );
        planned += 4;
        continue;
      }
      try {
        const result = await store.scheduleReviewForWrong(
          row.stage_id,
          row.scene_id,
          row.question_id,
          concept,
        );
        planned += result.rounds;
        if (options.verbose) {
          console.log(
            `  ${row.stage_id}/${row.scene_id}/${row.question_id}  → ${label}  +${result.rounds} 关`,
          );
        }
      } catch (error) {
        failed.push(`${row.stage_id}/${row.scene_id}/${row.question_id}: ${String(error)}`);
      }
    }

    if (options.dryRun) {
      console.log(`--dry-run：会排 ${planned} 行（每道题 4 关），一行都没写。`);
      return 0;
    }

    const after = await pool.query<{ n: string; q: string }>(
      `SELECT count(*)::text AS n, count(DISTINCT (stage_id, scene_id, question_id))::text AS q
         FROM xq_review_schedule`,
    );
    console.log(
      `写入完成：xq_review_schedule ${after.rows[0].n} 行 / ${after.rows[0].q} 道题` +
        `（本次新增 ${planned} 行）。`,
    );

    if (failed.length > 0) {
      console.error(`排期失败 ${failed.length} 道（其余已写）：`);
      for (const line of failed) console.error(`  - ${line}`);
      return 1;
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
