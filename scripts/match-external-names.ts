/**
 * 把一批**外来概念名**跑一遍三段匹配，看它们各落哪一段。
 *
 * ## 为什么是一个脚本，不是 HTTP 路由
 *
 * 匹配本身不写库（见 `lib/persistence/xq-three-way-match.ts` 文件头），
 * 而它唯一的真实调用方是「有人拿来一门外来课程」这个一次性动作。
 * 挂成路由就要回答鉴权、限流、批量大小、超时 —— 全是为一个还没有调用方的
 * 端点付的代价。
 *
 * ## 输入
 *
 * `--names <file.json>`，数组，每项：
 *
 * ```json
 * [
 *   { "name": "构造", "kind": "concept", "senseAnchors": ["构造题"], "mappedAncestors": [] }
 * ]
 * ```
 *
 * 只有 `name` 必填。`senseAnchors` 是该名字在**外来课程上下文里**的锚词 ——
 * 不给就等于「外来侧没说话」，那时带锚的候选**不会**被否决（见模块文件头
 * 「没给锚不等于锚不符」）。`--stage` 用来判信号 B ②（候选在这门课里讲过没有）。
 *
 * ## 输出
 *
 * 逐名字一行 `tri  reason  名字  → 候选`，末尾一段分档统计。
 * `--json` 打整份结果（含每个候选的信号与是否被否决），供人复核。
 *
 * ## 它不会做的事
 *
 * 不写 occurrence、不建概念。这两件事在 J §3.5 里各自有前置条件，且都需要
 * 人先批过 —— 匹配器自己不落一行。
 *
 * ## `--enqueue`：把报告变成一条待裁的提案
 *
 * 只有 `--enqueue` 才会写 `xq_intake_proposal`，而且还要 `--execute`。
 *
 * - `--task <taskId>` 必填：挂在哪个任务下。**这里不新建任务** —— 任务要带
 *   `goal` 与一批对齐单元，而「只有任务没有单元」与「单元还没算」在库里长得
 *   一模一样（见 `xq-intake-task.ts` 文件头）。任务该由 `scripts/intake-begin.ts`
 *   开，它是唯一知道「这次导入为了什么」的地方。
 * - `--source <graph>` 必填：`xq_intake_proposal` 的唯一键是
 *   `(external_source, external_name, external_kind)`。给一个默认值等于把两门
 *   不同课的同名概念混成一条提案，而它们的证据完全不是一回事。
 *
 * ★ **证据页留空**：这份清单里只有名字，没有外来课程的页。J §4.1 要求
 * `signals` 带页证据，这里如实写 `[]` —— 于是人批了之后 `promoteProposal`
 * 写 0 行出现记录（它会照实报 `occurrences: 0`）。要给证据就得先有外来课的
 * 页，那是导入器的事，不是这个脚本能编的。
 *
 * ★ **提案行上只留 `tri`，不留 `reason`**：`reason` 是**这次判定的解释**，
 * 会随判据演进而改词（`bigram-uncalibrated` 在 τ 标定后已改名
 * `bigram-similar`）。存进库会让同一列在两个时期表示两件事 —— 它是给人
 * 当场看的，不是给库看的。
 */

import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';

interface RegisterHooks {
  registerHooks?: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      nextResolve: (specifier: string, context: unknown) => { url: string },
    ) => { url: string };
  }) => void;
}

// ★ 与 scripts/ 里其它 xq 脚本同一条坑：`pg` 的 ESM 入口找不到 `pg-pool` 的默认
//   导出，必须把 `esm/index.mjs` 指回 `index.js`。钩子必须在任何动态 import
//   之前装好 —— 所以这里不用 top-level await（`tsx` 走 cjs 输出时会报
//   `Top-level await is currently not supported with the "cjs" output format`）。
const registerHooks = (nodeModule as unknown as RegisterHooks).registerHooks;
if (typeof registerHooks === 'function') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const base = nextResolve(specifier, context);
      if (specifier === 'pg-pool') {
        return { ...base, url: base.url.replace(/[\/]esm[\/]index\.mjs$/, '/index.js') };
      }
      return base;
    },
  });
}

interface NameInput {
  name?: unknown;
  kind?: unknown;
  senseAnchors?: unknown;
  mappedAncestors?: unknown;
}

interface Options {
  names: string | null;
  stage: string | null;
  json: boolean;
  limit: number;
  enqueue: boolean;
  execute: boolean;
  task: string | null;
  source: string | null;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    names: null,
    stage: null,
    json: false,
    limit: 200,
    enqueue: false,
    execute: false,
    task: null,
    source: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--names') options.names = argv[index + 1] ?? null;
    else if (arg === '--stage') options.stage = argv[index + 1] ?? null;
    else if (arg === '--limit') options.limit = Number(argv[index + 1] ?? '200');
    else if (arg === '--json') options.json = true;
    else if (arg === '--enqueue') options.enqueue = true;
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--task') options.task = argv[index + 1] ?? null;
    else if (arg === '--source') options.source = argv[index + 1] ?? null;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法：tsx scripts/match-external-names.ts --names names.json',
          '[--stage stage-xxx] [--limit N] [--json]',
          '--enqueue --task <taskId> --source <graph> [--execute]   # 把结果写成待裁提案',
        ].join(' '),
      );
      process.exit(0);
    } else if (arg.startsWith('--')) {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 200;
  return options;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (options.names === null) {
    console.error('缺少 --names <file.json>（外来概念名清单）');
    return 2;
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error('DATABASE_URL 没有设置。');
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.names, 'utf8')) as unknown;
  } catch (error) {
    console.error(
      `读不了 ${options.names}：${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  if (!Array.isArray(raw)) {
    console.error(`${options.names} 的顶层必须是数组。`);
    return 2;
  }
  const inputs = raw
    .map(
      (item): NameInput => (typeof item === 'object' && item !== null ? (item as NameInput) : {}),
    )
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name.trim() : '',
      kind: typeof item.kind === 'string' ? item.kind : undefined,
      senseAnchors: stringList(item.senseAnchors),
      mappedAncestors: stringList(item.mappedAncestors),
    }))
    .filter((item) => item.name !== '')
    .slice(0, options.limit);

  if (inputs.length === 0) {
    console.error('清单里没有一条带 name 的。');
    return 2;
  }

  // ★ `--enqueue` 的两个必填参数在这里拦，不留到 SQL 层 —— 唯一键是
  //   `(external_source, external_name, external_kind)`，`external_source`
  //   给个默认值会把两门课的同名概念并成一条，而这件事不报错、只是少一条。
  if (options.enqueue && (options.task === null || options.task.trim() === '')) {
    console.error('--enqueue 需要 --task <taskId>（任务由 scripts/intake-begin.ts 开）。');
    return 2;
  }
  if (options.enqueue && (options.source === null || options.source.trim() === '')) {
    console.error('--enqueue 需要 --source <graph>（同一名字来自两门课是两条提案）。');
    return 2;
  }
  if (!options.enqueue && (options.task !== null || options.source !== null)) {
    console.error('--task / --source 只在 --enqueue 时有意义。');
    return 2;
  }

  const { Pool } = (await import('pg')) as unknown as {
    Pool: new (config: { connectionString: string }) => {
      query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      end: () => Promise<void>;
    };
  };
  const pool = new Pool({ connectionString });

  try {
    const { decideThreeWay, loadMatchFacts } =
      await import('../lib/persistence/xq-three-way-match');
    const facts = await loadMatchFacts(pool as never);

    const results = inputs.map((item) => {
      const result = decideThreeWay(
        {
          externalName: item.name,
          externalKind: item.kind,
          senseAnchors: item.senseAnchors,
          mappedAncestors: item.mappedAncestors,
          stageId: options.stage ?? undefined,
        },
        facts,
      );
      return { input: item, result };
    });

    const tally: Record<string, number> = { hit: 0, suspect: 0, miss: 0 };
    const byReason: Record<string, number> = {};
    for (const item of results) {
      tally[item.result.tri] = (tally[item.result.tri] ?? 0) + 1;
      byReason[item.result.reason] = (byReason[item.result.reason] ?? 0) + 1;
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            stage: options.stage,
            total: results.length,
            tally,
            byReason,
            results: results.map((item) => ({
              name: item.input.name,
              senseAnchors: item.input.senseAnchors,
              tri: item.result.tri,
              reason: item.result.reason,
              matchedConceptId: item.result.matchedConceptId,
              bestSimilarity: item.result.bestSimilarity,
              candidates: item.result.candidates.map((candidate) => ({
                conceptId: candidate.conceptId,
                canonicalName: candidate.canonicalName,
                signals: candidate.signals,
                vetoed: candidate.vetoed,
                senseTooThin: candidate.senseTooThin,
                anchors: candidate.anchors,
              })),
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    console.log(
      `三段匹配：${results.length} 个外来名字${options.stage ? `（课程 ${options.stage}）` : ''}`,
    );
    for (const item of results) {
      const { result } = item;
      const candidates =
        result.candidates.length === 0
          ? ''
          : `  → ${result.candidates
              .map(
                (candidate) =>
                  `${candidate.canonicalName}${
                    candidate.vetoed
                      ? '（否决）'
                      : candidate.senseTooThin
                        ? '（锚太薄，不敢判）'
                        : `(${candidate.signals.join('+')})`
                  }`,
              )
              .join(' / ')}`;
      console.log(
        `  ${result.tri.padEnd(7)} ${result.reason.padEnd(22)} ${item.input.name}${candidates}`,
      );
    }
    console.log('');
    console.log(
      `命中 ${tally.hit} / 存疑 ${tally.suspect} / 未命中 ${tally.miss}` +
        `（${Object.entries(byReason)
          .map(([reason, count]) => `${reason} ${count}`)
          .join('，')}）`,
    );
    if (!options.enqueue) {
      console.log(
        '只是报告：一行都没写（加 --enqueue --task <id> --source <graph> 才进提案队列）。',
      );
      return 0;
    }

    // ---- 进队 ----
    const { recordProposal } = await import('../lib/persistence/xq-intake-proposal');
    const evidenceOf = (item: (typeof results)[number]) =>
      item.result.candidates.length === 0
        ? []
        : [
            {
              // 只有名字、没有页：证据页留空是**如实**，不是遗漏。
              stageId: '',
              sceneId: '',
              pageHash: null,
              quote: `${item.input.name} → ${item.result.candidates
                .map((candidate) => candidate.canonicalName)
                .join(' / ')}`,
              anchorsHit: item.input.senseAnchors,
            },
          ];

    if (!options.execute) {
      console.log('');
      console.log(
        `没加 --execute：一行都没写。本来会进队 ${results.length} 条` +
          `（hit ${tally.hit} / suspect ${tally.suspect} / miss ${tally.miss}，` +
          `来源 ${options.source}，任务 ${options.task}）。`,
      );
      return 0;
    }

    const queued: Record<string, number> = { created: 0, seen: 0, accepted: 0 };
    for (const item of results) {
      const outcome = await recordProposal(pool as never, {
        taskId: options.task ?? undefined,
        externalSource: options.source ?? '',
        externalName: item.input.name,
        externalKind: item.input.kind ?? 'concept',
        tri: item.result.tri,
        matchedConceptId: item.result.matchedConceptId ?? undefined,
        signals: evidenceOf(item),
      });
      if (outcome.created) queued.created += 1;
      else queued.seen += 1;
      if (outcome.status === 'accepted') queued.accepted += 1;
    }

    console.log('');
    console.log(
      `进队完成：新建 ${queued.created} 条 / 已存在又见一次 ${queued.seen} 条` +
        `（其中 hit 自动归并 ${queued.accepted} 条，不需要人裁）。`,
    );
    console.log(
      `按 ${options.task} 与 ${options.source} 记；下一步：scripts/review-intake-proposals.ts --tri suspect`,
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
