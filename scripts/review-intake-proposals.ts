/**
 * 外来概念提案的**裁决台**：列出待裁队列，按编号接受或拒绝。
 *
 * ## 为什么是一个脚本，不是 HTTP 路由
 *
 * 裁决是「人看一遍、决定收不收」的动作，一次导入只做一遍，而且需要一个
 * **会署名的人**（`decided_by`）。挂成路由就要回答鉴权（谁是谁）、并发
 * （两个人同时批同一条）、审计（谁在什么时候点了什么）—— 这三件事今天
 * 都还没有答案，而脚本天然只有一个人、一次一条、署名是命令行给的。
 *
 * ## 三个动作
 *
 * - 不带 `--accept` / `--reject`：只列队列（默认 `status='proposed'`）。
 * - `--accept <id>`：走 J §4.3 的晋升五步事务（`promoteProposal`），
 *   概念、提案状态、出现记录、外来先修边一起落或一起不落。
 * - `--reject <id> --why '...'`：走 J §4.4。**行不删** —— 下次同一份材料
 *   再来时 `seen_count` 会涨，但状态保持 `rejected`，这就是「不再问」。
 *
 * ## 为什么 `--operator` 是必填而不是从环境里猜
 *
 * `decided_by` 记的是「谁批的」。从 `$USER` 猜出来的名字在共享机器上会把
 * 两个不同的人混成一个；解析不到时就会变成空串，而库里那条
 * `decision_pair` 约束会把它当成「没裁过」。
 *
 * ## 它不做什么
 *
 * 不跑三段匹配（那是 `scripts/match-external-names.ts`）、不写提案
 * （那是导入器的事）、不建 `xq_intake_task`。
 */

import * as nodeModule from 'node:module';

interface RegisterHooks {
  registerHooks?: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      nextResolve: (specifier: string, context: unknown) => { url: string },
    ) => { url: string };
  }) => void;
}

// ★ 与 scripts/ 里其它 xq 脚本同一条坑：`pg` 的 ESM 入口找不到 `pg-pool` 的
//   默认导出，必须把 `esm/index.mjs` 指回 `index.js`。钩子要在任何动态
//   import 之前装好 —— 所以不用 top-level await（`tsx` 走 cjs 会报
//   `Top-level await is currently not supported with the "cjs" output format`）。
const registerHooks = (nodeModule as unknown as RegisterHooks).registerHooks;
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
  accept: number | null;
  reject: number | null;
  operator: string | null;
  why: string | null;
  status: string | null;
  tri: string | null;
  limit: number;
  json: boolean;
  dryRun: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    accept: null,
    reject: null,
    operator: null,
    why: null,
    status: null,
    tri: null,
    limit: 20,
    json: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--accept') options.accept = Number(argv[index + 1] ?? '');
    else if (arg === '--reject') options.reject = Number(argv[index + 1] ?? '');
    else if (arg === '--operator') options.operator = argv[index + 1] ?? null;
    else if (arg === '--why') options.why = argv[index + 1] ?? null;
    else if (arg === '--status') options.status = argv[index + 1] ?? null;
    else if (arg === '--tri') options.tri = argv[index + 1] ?? null;
    else if (arg === '--limit') options.limit = Number(argv[index + 1] ?? '20');
    else if (arg === '--json') options.json = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法：',
          '  tsx scripts/review-intake-proposals.ts [--status proposed] [--tri miss] [--limit 20] [--json]',
          '  tsx scripts/review-intake-proposals.ts --accept 12 --operator owner [--dry-run]',
          "  tsx scripts/review-intake-proposals.ts --reject 12 --operator owner --why '这是构造题，不是构造方法'",
        ].join('\n'),
      );
      process.exit(0);
    } else if (arg.startsWith('--')) {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 20;
  return options;
}

function formatDate(value: Date | null): string {
  if (value === null) return '-';
  return value.toISOString().slice(0, 16).replace('T', ' ');
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (options.accept !== null && options.reject !== null) {
    console.error('一次只能做一件事：`--accept` 与 `--reject` 不能同时给。');
    return 2;
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error('DATABASE_URL 没有设置。');
    return 2;
  }

  const { Pool } = (await import('pg')) as unknown as {
    Pool: new (config: { connectionString: string }) => {
      query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      connect: () => Promise<{
        query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
        release: () => void;
      }>;
      end: () => Promise<void>;
    };
  };
  const pool = new Pool({ connectionString });

  try {
    const { promoteProposal, readProposals, rejectProposal } =
      await import('../lib/persistence/xq-intake-proposal');

    if (options.accept !== null || options.reject !== null) {
      const operator = (options.operator ?? '').trim();
      if (operator === '') {
        console.error('裁决必须署名：缺 --operator <who>。');
        return 2;
      }
      if (options.accept !== null) {
        const proposalId = Math.trunc(options.accept);
        if (!Number.isFinite(proposalId) || proposalId <= 0) {
          console.error(`--accept 后面要一个正整数编号，收到 ${String(options.accept)}。`);
          return 2;
        }
        if (options.dryRun) {
          console.log(`--dry-run：会把提案 ${proposalId} 晋升成一个新概念，没有写库。`);
          return 0;
        }
        // ★ 事务适配器照 `nodePostgresTransaction` 的写法内联：一次调用借一个
        //   连接，BEGIN / body / COMMIT 全在它上面，永远 release。
        const withTransaction = async <T>(body: (q: unknown) => Promise<T>): Promise<T> => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const result = await body(client);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
        const result = await promoteProposal(withTransaction as never, {
          proposalId,
          operator,
        });
        if (!result.ok) {
          console.error(`没有晋升：${result.reason}${result.detail ? `（${result.detail}）` : ''}`);
          if (result.reason === 'name-taken') {
            console.error('同名 concept 已经是 active —— 该把它当 hit 归并，而不是新建。');
          } else if (result.reason === 'no-open-version') {
            console.error('没有开放的图谱版本 —— 先跑 scripts/advance-graph-version.ts。');
          }
          return 2;
        }
        console.log(`已晋升：提案 ${proposalId} → 概念 ${result.conceptId}`);
        console.log(
          `  出现记录 ${result.occurrences} 行，外来先修边 ${result.edges} 条（status=proposed）`,
        );
        return 0;
      }

      const proposalId = Math.trunc(options.reject as number);
      if (!Number.isFinite(proposalId) || proposalId <= 0) {
        console.error(`--reject 后面要一个正整数编号，收到 ${String(options.reject)}。`);
        return 2;
      }
      if (options.dryRun) {
        console.log(`--dry-run：会把提案 ${proposalId} 标成 rejected，没有写库。`);
        return 0;
      }
      const result = await rejectProposal(pool as never, {
        proposalId,
        operator,
        note: options.why ?? undefined,
      });
      if (!result.ok) {
        console.error(`没有拒绝：${result.reason ?? 'unknown'}`);
        return 2;
      }
      console.log(
        `已拒绝：提案 ${proposalId}（行保留，下次同一份材料再来自增 seen_count，不会再问）`,
      );
      return 0;
    }

    const status = options.status as 'proposed' | 'accepted' | 'rejected' | null;
    const tri = options.tri as 'hit' | 'suspect' | 'miss' | null;
    const rows = await readProposals(pool as never, {
      ...(status ? { status } : {}),
      ...(tri ? { tri } : {}),
      limit: options.limit,
    });

    // F7：被拒过、但证据后来变成「命中」的提案**不在默认队列里**（默认只读
    // proposed）。如果这里不单独捞一次，它们就永远看不见 —— 而人恰恰最该重看
    // 这一批：上次拒绝时它是 miss，现在外来侧说是某个概念的命中。拒绝冻结的
    // 是人的决定，证据变了就该让人再拍一次；自动接受是不许的（那会覆盖人）。
    // 只在列表模式下查：--accept / --reject 走上一个分支，用不到这份清单。
    const rejectedHits = await readProposals(pool as never, {
      status: 'rejected',
      tri: 'hit',
      limit: options.limit,
    });

    type ListedProposal = Awaited<ReturnType<typeof readProposals>>[number];
    const hasPage = (signal: ListedProposal['signals'][number]): boolean =>
      signal.stageId !== '' && signal.sceneId !== '';
    // JSON 里也带上「被拒过」的痕迹（decidedBy / decisionNote）与匹配目标：
    // 下游哪怕只读 JSON 也能区分「待裁」和「人已经拒过一次、现在证据变了」。
    const listShape = (row: ListedProposal) => ({
      id: row.id,
      tri: row.tri,
      status: row.status,
      externalSource: row.externalSource,
      externalName: row.externalName,
      matchedConceptId: row.matchedConceptId,
      acceptedConceptId: row.acceptedConceptId,
      decidedBy: row.decidedBy,
      decisionNote: row.decisionNote,
      seenCount: row.seenCount,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      signals: row.signals,
    });

    if (options.json) {
      // ★ 形状从「裸数组」变成 `{ queue, rejectedButHit }`：队列语义多了一层，
      //   再压成一个数组会让「rejected 的 hit」看起来像是待裁。仓里没有程序
      //   消费这个输出（只有人 + 脚本自己），所以这个破坏性改动是安全的。
      console.log(
        JSON.stringify(
          { queue: rows.map(listShape), rejectedButHit: rejectedHits.map(listShape) },
          null,
          2,
        ),
      );
      return 0;
    }

    if (rows.length === 0 && rejectedHits.length === 0) {
      console.log('队列是空的（没有待裁的提案）。');
      return 0;
    }

    if (rows.length > 0) {
      // --status rejected/accepted 时别再说「待裁」—— 那会让人以为队列里全是没裁的。
      const heading = status === null || status === 'proposed' ? '待裁提案' : `${status} 提案`;
      console.log(`${heading} ${rows.length} 条（最多 ${options.limit}）：`);
    } else {
      console.log('没有待裁的提案。');
    }
    for (const row of rows) {
      const pageSignals = row.signals.filter(hasPage).length;
      const textSignals = row.signals.length - pageSignals;
      // 「N 页证据」只在真有页时才说；CLI --enqueue 写进来的本来就是无页的
      // 纯文字证据（F10a），一律叫「页」会让人以为库里丢了页。
      const evidence =
        `${pageSignals} 页证据` + (textSignals > 0 ? ` + ${textSignals} 条无页证据` : '');
      console.log(
        `  #${String(row.id).padStart(3)} ${row.tri.padEnd(7)} ${row.status.padEnd(8)} ` +
          `${row.externalName}（${row.externalSource}）· 见过 ${row.seenCount} 次 · ` +
          `${evidence} · 最后 ${formatDate(row.lastSeenAt)}`,
      );
      for (const signal of row.signals.slice(0, 3)) {
        // 无页时**不打印** `stage//` 与孤零零的「」—— 那是「没页」被硬塞进
        // 「页/quote」模板的样子。人看到的应该是一句原文，不是一个空壳。
        const where = hasPage(signal) ? `${signal.stageId}/${signal.sceneId}` : '（无页）';
        const parts = [where];
        if (signal.quote !== '') parts.push(`「${signal.quote}」`);
        const anchors = signal.anchorsHit ?? [];
        if (anchors.length > 0) parts.push(`锚词 ${anchors.join('、')}`);
        console.log(`        ${parts.join(' ')}`);
      }
      if (row.signals.length > 3) {
        console.log(`        …还有 ${row.signals.length - 3} 条证据`);
      }
    }

    if (rejectedHits.length > 0) {
      console.log('');
      console.log(
        `★ 被拒过、但证据现在变成「命中」的 ${rejectedHits.length} 条 —— ` +
          '拒绝冻结的是人的决定，不是证据：',
      );
      for (const row of rejectedHits) {
        const target = row.matchedConceptId ?? '-';
        console.log(
          `  #${String(row.id).padStart(3)} ${row.externalName}（${row.externalSource}）· ` +
            `上次是 ${row.decidedBy ?? '?'} 在 ${formatDate(row.decidedAt)} 拒的 · 现在匹配到 ${target}`,
        );
        if (row.decisionNote) console.log(`        当时的理由：${row.decisionNote}`);
        const quoted = row.signals.find((signal) => signal.quote !== '');
        if (quoted) console.log(`        现在的证据：「${quoted.quote}」`);
        console.log(
          `        要翻案就 --accept ${row.id} --operator <你>；不翻就让它继续躺着（不会再自动变）。`,
        );
      }
    }

    console.log('');
    console.log(
      "裁决：--accept <编号> --operator <你> / --reject <编号> --operator <你> --why '<理由>'",
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
    console.error(`失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
