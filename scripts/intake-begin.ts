/**
 * 开一次「我要学点什么」：把现有三态格子折成对齐单元，落成任务 + 单元。
 *
 * ## 为什么是脚本而不是 HTTP 路由 / agent 工具
 *
 * 与 `advance-graph-version.ts` 同一条理由：**开一次任务是学习开始的边界**。
 * 它读的是「此刻库里已有的证据」——同一份证据开两次任务会得到两份时间点
 * 不同的对齐，谁也不知道该信哪份。所以它是个人在某个时刻的一次动作，
 * 不是可以被前端随手点两下的端点。
 *
 * 挂成 agent 工具是下一步（D 文档 §B4 的 `intake_begin`），但要先有这个东西
 * 跑通一次、看一眼真实输出长什么样 —— 否则工具的形状是凭想象定的。
 *
 * ## 三步
 *
 * 1. 读 `xq_cell_state`（`--stage` 限定某门课，不给就全部）并回 `document_scenes` 取标题
 * 2. `unitsFromCellStates()` 折成单元 → `deriveIntakeConfidence()` 算三档
 * 3. 给了 `--execute` 才真写（任务 + 单元一个事务），否则只打印将要写什么
 *
 * ## 为什么默认不写
 *
 * 与 `seed-concept-graph.ts` 同一个理由：`xq_intake_task` 一旦多出一行，
 * 「这一趟为什么来」这个问题就有了一个不该有的答案，而它不会被自动清掉。
 *
 * 用法：
 *
 *   npx tsx --conditions=import --env-file-if-exists=.env.local \
 *     scripts/intake-begin.ts --goal '把 Flutter 的 setState 弄明白' --stage stage--ShZtYAYOj
 *
 *   加 --execute 才写库。
 */
import * as nodeModule from 'node:module';

interface RegisterHooks {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      nextResolve: (specifier: string, context: unknown) => { url: string },
    ) => { url: string };
  }) => void;
}

// `pg-pool` 的 ESM 入口是 `esm/index.mjs`，它按 ESM 加载 `pg` 会拿到不可构造的
// 默认导出（`TypeError: Class extends value #<Object> is not a constructor`）。
// 把那一层换回 CJS 的 `index.js` 是本仓所有脚本共用的做法。
const { registerHooks } = nodeModule as unknown as RegisterHooks;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const base = nextResolve(specifier, context);
    if (specifier === 'pg-pool') {
      return { ...base, url: base.url.replace(/[\\/]esm[\\/]index\.mjs$/, '/index.js') };
    }
    return base;
  },
});

interface Options {
  goal?: string;
  kind?: string;
  stage?: string;
  execute: boolean;
  verbose: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { execute: false, verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--goal') options.goal = argv[++index];
    else if (arg === '--kind') options.kind = argv[++index];
    else if (arg === '--stage') options.stage = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法：scripts/intake-begin.ts --goal <原话> [--kind course|outline|utterance] [--stage <stageId>] [--execute]',
          '',
          '  不给 --execute 只打印将要写什么。',
          '  单元来自 xq_cell_state（三态格子），有作答记录的格子才算实测。',
        ].join('\n'),
      );
      process.exit(0);
    } else if (arg.startsWith('--')) {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.goal || !options.goal.trim()) {
    console.error('缺少 --goal：一次任务必须有一句用户原话。');
    return 2;
  }
  const kind = options.kind ?? 'course';
  if (!['course', 'outline', 'utterance'].includes(kind)) {
    console.error(`--kind 只能是 course / outline / utterance，收到：${kind}`);
    return 2;
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error('DATABASE_URL 没设 —— 先 --env-file-if-exists=.env.local。');
    return 2;
  }

  const { Pool } = await import('pg');
  const { beginIntake, deriveIntakeConfidence, newIntakeTaskId, unitsFromCellStates } =
    await import('../lib/persistence/xq-intake-task');
  const { ensureXqLearnerSchema } = await import('../lib/persistence/xq-learner');
  const { nodePostgresTransaction } =
    await import('../packages/@openmaic/storage/src/server/reference');

  const pool = new Pool({ connectionString });
  try {
    await ensureXqLearnerSchema(pool);

    const stageClause = options.stage ? 'WHERE c.stage_id = $1' : '';
    const params = options.stage ? [options.stage] : [];
    const cells = await pool.query<{
      stage_id: string;
      scene_id: string;
      tri: string;
      n: string;
      k: string;
      lb5: string | null;
      ub95: string | null;
      title: string | null;
    }>(
      `SELECT c.stage_id, c.scene_id, c.tri, c.n::text AS n, c.k::text AS k,
              c.lb5::text AS lb5, c.ub95::text AS ub95,
              s.data->>'title' AS title
         FROM xq_cell_state c
         LEFT JOIN document_scenes s ON s.stage_id = c.stage_id AND s.id = c.scene_id
         ${stageClause}
        ORDER BY c.stage_id, c.scene_id`,
      params,
    );

    if (cells.rows.length === 0) {
      console.log('没有任何三态格子 —— 先答题或跑一次重算（`recomputeAllCellStates`）。');
      console.log('没加 --execute：一行都没写。');
      return 0;
    }

    // ★ 单元 id 里含 taskId，所以必须先定 taskId 再折单元 —— 否则 --execute
    //   写进去的 unit_id 会带着排练用的假前缀。实测踩过：库里留下
    //   t_pending0000 开头的 unit_id，而任务行是另一个 id，两者对不上。
    const taskId = options.execute ? newIntakeTaskId() : 't_dryrun00000';
    const inputs = unitsFromCellStates(
      taskId,
      cells.rows.map((row) => ({
        stageId: row.stage_id,
        sceneId: row.scene_id,
        tri: row.tri as 'known' | 'not-learned' | 'unknown',
        n: Number(row.n),
        k: Number(row.k),
        lb5: row.lb5 === null ? null : Number(row.lb5),
        ub95: row.ub95 === null ? null : Number(row.ub95),
        title: row.title,
      })),
    );
    const confidence = deriveIntakeConfidence(inputs);
    const measured = inputs.filter((unit) => !unit.proxy).length;

    console.log(
      `格子 ${cells.rows.length} 个（其中 ${measured} 个有作答记录，${cells.rows.length - measured} 个是推的）`,
    );
    console.log(`按规则算出的 confidence：${confidence}`);
    console.log(
      `将写 1 行任务 + ${inputs.length} 行对齐单元（goal=「${options.goal.trim()}」，kind=${kind}）`,
    );
    if (options.verbose) {
      for (const unit of inputs) {
        console.log(
          `  ${unit.tri.padEnd(11)} ${unit.proxy ? '推的' : '实测'}  ${unit.label}  (${unit.unitId})`,
        );
      }
    }

    if (!options.execute) {
      console.log('没加 --execute：一行都没写。');
      return 0;
    }

    const result = await beginIntake(nodePostgresTransaction(pool), {
      taskId,
      goal: options.goal.trim(),
      kind: kind as 'course' | 'outline' | 'utterance',
      sourceRefs: options.stage ? { stageId: options.stage } : { scope: 'all' },
      units: inputs,
    });

    console.log(
      `已开任务 ${result.task.taskId}（${result.created ? '新建' : '已存在，未重复写'}）· ` +
        `${result.units.length} 个单元 · confidence=${result.task.confidence}`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
