#!/usr/bin/env node
/**
 * 推进图谱版本：冻结旧版 → 开新版 → 把还没归属的概念钉到新版上。
 *
 * ## 为什么需要这个脚本（不是「以后再写个界面」）
 *
 * 迁移 `3 graph-version` / `4 concept-expand` 把**结构**建好了：版本表有一行
 * `1 baseline` 未冻结、概念表有 `created_in`、偏索引 `xq_graph_version_one_open`
 * 挡住第二个未冻结版本。规格 `SR-F11.4` 因此把「版本化」标成落地 —— 但同一节
 * 紧跟着写死一句：**「版本的推进流程一条都没写」**。
 *
 * 那不是留白，是一个具体缺口：没有任何代码能把第 1 版冻结、开第 2 版、再让新
 * 进来的概念落在第 2 版上。而一条**永远不推进的版本链**与一张没有版本的表，
 * 在「这个概念是哪版进的图」这个问法上给出同样的答案：都是 1。
 *
 * ## 为什么这是脚本而不是 HTTP 路由
 *
 * 推进版本是**一次导入的边界**，不是用户在他自己的学习里做的动作：
 *
 *   · 它没有「随时可点」的含义 —— 两次推进之间必须有真实的导入；
 *   · 它的失败模式是「有人在另一个窗口先推进了」，那需要人看一眼再决定，
 *     而不是一个自动重试的客户端；
 *   · 它要能打印出「这次哪 17 个概念进了第 2 版」，那是终端里读的，不是 JSON。
 *
 * 模块本身（`lib/persistence/xq-graph-version.ts`）是与调用方式无关的纯函数 +
 * SQL；将来要接界面，接的是同一个模块，不是同一段逻辑的第二份实现。
 *
 * ## 三步，顺序不能换
 *
 *   1. **读现状**：把版本链与每版概念数打出来。推进前不看现状，等于闭着眼
 *      按「冻结」——而 `from` 写错时的报错是 `not-found` / `already-frozen`，
 *      它只会告诉你「不行」，不会告诉你「现在是几」。
 *   2. **推进**（`--label` 给出时才做）：`advanceGraphVersion({ from, label })`。
 *      `from` 默认取当前开放版本，**显式给 `--from` 时以给的为准** —— 那正是
 *      比较并交换要拦的情况，脚本不该替人把错误盖掉。
 *   3. **归属**（`--assign` 给出时才做）：把匹配到的、`created_in IS NULL` 的
 *      概念钉到新版本。★ 只碰没归属的行 —— `created_in` 是「它哪一版进来的」，
 *      重写它等于篡改历史。
 *
 * ## 判据（怎么算做完）
 *
 * 真库读数（2026-11-10）：`xq_graph_version` 一行 `1 baseline` 未冻结、
 * 104 个概念全部 `created_in = 1`。所以：
 *
 *   · `--dry-run` 不带 `--label`：打印 1 版 / 104 概念 / 开放的是第 1 版，不写库。
 *   · `--label v2 --dry-run`：打印「将冻结第 1 版、开出第 2 版」，不写库。
 *   · `--label v2`（真跑）：版本链变 `[1 frozen, 2 open]`，概念数仍是
 *     `1 → 104`、`2 → 0`（没有概念被误标）；重跑同一条命令回
 *     `already-frozen`（不是静默成功）。
 *
 * ## 用法
 *
 *     npx tsx --conditions=import --env-file-if-exists=.env.local \
 *       scripts/advance-graph-version.ts [--dry-run] [--label v2] [--from 1] \
 *       [--note "2026-11 导入 CS2023"] [--assign <regex>]
 *
 * 默认**不** dry-run：推进本身是幂等语义下的显式动作，`--dry-run` 是给你先
 * 看一眼现状用的，不是默认值（默认 dry-run 会让「我明明跑了」变成谜）。
 *
 * ## 为什么静态 import 只有 node 内建
 *
 * 与 `scripts/backfill-review-schedule.ts` 同一个理由：`@openmaic/storage` 只在
 * `import` 条件下发布子路径，而在那条件下 `pg` 会把自身的 `pg-pool` 依赖解析成
 * ESM 入口，随后 `class BaseStore extends Pool` 抛
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
  label: string | null;
  from: number | null;
  note: string | null;
  assign: string | null;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { dryRun: false, label: null, from: null, note: null, assign: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--label') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--label 需要一个值');
      options.label = value;
      i += 1;
      continue;
    }
    if (arg === '--from') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--from 需要一个数字');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--from 必须是正整数：${value}`);
      }
      options.from = parsed;
      i += 1;
      continue;
    }
    if (arg === '--note') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--note 需要一个值');
      options.note = value;
      i += 1;
      continue;
    }
    if (arg === '--assign') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--assign 需要一个正则');
      options.assign = value;
      i += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}（只认 --dry-run / --label / --from / --note / --assign）`);
  }
  if (options.label === null && options.assign !== null) {
    throw new Error('--assign 必须与 --label 一起用：归属的目标版本正是新开出来的那一版');
  }
  return options;
}

function describe(version: {
  version: number;
  label: string;
  note: string | null;
  frozenAt: Date | null;
  concepts: number;
}): string {
  const state = version.frozenAt === null ? 'open  ' : 'frozen';
  const frozen = version.frozenAt === null ? '' : `  frozen_at=${version.frozenAt.toISOString()}`;
  const note = version.note === null ? '' : `  note=${version.note}`;
  return `  v${version.version}  ${state}  ${version.label}  concepts=${version.concepts}${frozen}${note}`;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const { Pool } = await import('pg');
  const { advanceGraphVersion, assignConceptsToVersion, openGraphVersion, readGraphVersions } =
    await import('../lib/persistence/xq-graph-version');

  const pool = new Pool({ connectionString });
  try {
    const queryable = pool as unknown as Parameters<typeof readGraphVersions>[0];

    // ── 第一步：现状 ────────────────────────────────────────────────
    const before = await readGraphVersions(queryable);
    const openBefore = openGraphVersion(before);
    console.log(`版本链（${before.length} 版）：`);
    for (const version of before) console.log(describe(version));
    console.log(
      openBefore === null
        ? '当前开放版本：无（所有版本都已冻结）'
        : `当前开放版本：v${openBefore.version}（${openBefore.label}）`,
    );

    if (options.label === null) {
      if (options.dryRun) console.log('--dry-run：只读了现状，没有写库。');
      else console.log('没给 --label：只读了现状，没有写库（推进必须显式点名新版本标签）。');
      return 0;
    }

    // ── 第二步：推进 ────────────────────────────────────────────────
    const from = options.from ?? openBefore?.version ?? null;
    if (from === null) {
      console.error('没有开放版本可推进 —— 所有版本都已冻结，先决定要不要手工补一版。');
      return 2;
    }

    if (options.dryRun) {
      console.log(
        `--dry-run：将冻结 v${from}、开出 v${from + 1}（label=${options.label}${
          options.note === null ? '' : `, note=${options.note}`
        }）。没有写库。`,
      );
      if (options.assign !== null) {
        const preview = await pool.query<{ id: string; canonical_name: string }>(
          `SELECT id, canonical_name FROM xq_concept
            WHERE created_in IS NULL AND canonical_name ~ $1
            ORDER BY canonical_name`,
          [options.assign],
        );
        console.log(
          `--assign ${options.assign}：将归属 ${preview.rows.length} 个概念${
            preview.rows.length === 0
              ? ''
              : `（${preview.rows.map((row) => row.canonical_name).join('、')}）`
          }。`,
        );
      }
      return 0;
    }

    const advanced = await advanceGraphVersion(queryable, {
      from,
      label: options.label,
      note: options.note,
    });
    if (!advanced.ok) {
      const current = advanced.current === null ? '无' : `v${advanced.current.version}`;
      console.error(
        `推进失败：${advanced.reason}（当前开放版本：${current}）。` +
          {
            'not-found': ' —— 那个版本号不存在，检查 --from。',
            'already-frozen': ' —— 那一版已经冻结了，多半是有人先推进了；重跑一次看新链。',
            'not-current': ' —— 开放着的不是你以为的那一版；重跑一次，脚本会把现状打出来。',
          }[advanced.reason],
      );
      return 2;
    }
    console.log(`已开出 v${advanced.version.version}（${advanced.version.label}）。`);

    // ── 第三步：归属 ────────────────────────────────────────────────
    if (options.assign !== null) {
      const matched = await pool.query<{ id: string }>(
        `SELECT id FROM xq_concept
          WHERE created_in IS NULL AND canonical_name ~ $1
          ORDER BY canonical_name`,
        [options.assign],
      );
      const result = await assignConceptsToVersion(queryable, {
        version: advanced.version.version,
        conceptIds: matched.rows.map((row) => row.id),
      });
      console.log(
        `归属：写进 ${result.assigned} 个概念（已有归属、没动的 ${result.alreadyAssigned} 个，` +
          `库里不存在的 ${result.missing.length} 个）。`,
      );
      if (result.missing.length > 0) console.log(`  不存在的 id：${result.missing.join(', ')}`);
    } else {
      console.log(
        '没给 --assign：只开了版本，没有概念被归属（新概念得由导入方自己写 created_in）。',
      );
    }

    const after = await readGraphVersions(queryable);
    console.log(`推进后（${after.length} 版）：`);
    for (const version of after) console.log(describe(version));
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
