/**
 * 练习脚手架的**工具** —— 把一页课落成 `课程与学习\练习\` 里一个能打开的文件夹。
 *
 * ── 为什么必须有这个文件 ────────────────────────────────────────
 *
 * `lib/practice/scaffold.ts` 只生成**内容**；没有工具去调它，它就是死代码。
 * 而目标里明确要求"不是死代码"。所以生成与落盘在这里接上。
 *
 * ── 落点（AGENTS.md §6.8 的归属表）──────────────────────────────
 *
 * `课程与学习\练习\<stageId>\<NN-标题>\` —— **不是** `个人数据\`（那里只放学习成长
 * 的东西），**不是** `_tools\openmaic\diagnostics\`（那里放 harness 调试产物）。
 *
 * ── 安全（这一层是真正把关的地方）──────────────────────────────
 *
 * 1. **文件夹名**由 `practiceDirName()` sanitize（去非法字符、截断）；
 * 2. **每个文件路径**过 `isSafeRelativePath()`（相对、无 `..`、无盘符）；
 * 3. **兜底**：落盘前 `resolve(target)` 必须在 `resolve(root)` 之下 —— 前两层是判据，
 *    这一层是"判据错了也要挡住"。
 * 4. **不覆盖已有的练习**：文件夹已存在且 `overwrite !== true` ⇒ 直接拒绝并说明。
 *    学习者可能正在里面写代码，顺手覆盖 = 删掉他的工作。
 * 5. **不起进程**：工具只写文件。跑命令是**学习者自己**在 VS Code 里按 Ctrl+Shift+B。
 *    这样 web 服务不需要拿到"执行任意命令"的能力。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
  buildScaffold,
  PRACTICE_RESULT,
  PRACTICE_RUNNER,
  type PracticeCheck,
  type PracticeFile,
  type PracticeLanguage,
} from '@/lib/practice/scaffold';

export const PRACTICE_TOOL_NAMES = ['practice_scaffold', 'practice_result'] as const;

/** 练习根目录。默认按 §6.8 落在 `课程与学习\练习\`。 */
export function practiceRoot(): string {
  return process.env.OPENMAIC_PRACTICE_DIR ?? 'D:\\文档\\jelly_ware\\课程与学习\\练习';
}

/**
 * 一门课一个子目录。stageId 只用来拼路径，所以做白名单替换。
 *
 * ★ 根目录参数是必须的：工具要用 `deps.root`（测试可覆盖），而默认值是部署配置。
 *   前一版把这段逻辑在工具里**内联重写了一遍**，于是 `practiceStageDir` 变成 0 引用的
 *   死代码，而且两份实现会漂。现在只有这一处实现。
 */
export function practiceStageDir(stageId: string, root: string = practiceRoot()): string {
  const safe = stageId.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown-stage';
  return join(root, safe);
}

const PRACTICE_PARAMS = Type.Object({
  stageId: Type.String({ description: 'The course this exercise belongs to.' }),
  order: Type.Integer({ minimum: 1, description: 'The page this exercise comes from.' }),
  title: Type.String({ description: 'Exercise name — becomes part of the folder name.' }),
  brief: Type.String({
    description:
      'What the learner practises and **how it is judged**. Goes at the top of the README. ' +
      'Write it so they can tell whether they are done without asking you.',
  }),
  language: Type.Union(
    [
      Type.Literal('java'),
      Type.Literal('python'),
      Type.Literal('node'),
      Type.Literal('shell'),
      Type.Literal('git'),
    ],
    {
      description: 'Drives the VS Code encoding settings; the checks themselves are just commands.',
    },
  ),
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({
          description: 'Relative path inside the exercise folder. No "..", no drive.',
        }),
        content: Type.String(),
      }),
      { description: 'Starter files the learner will edit. Keep them small.' },
    ),
  ),
  checks: Type.Array(
    Type.Object({
      name: Type.String({ description: 'What this check verifies, in one line.' }),
      command: Type.String({
        description:
          'A command to run inside the exercise folder (Windows cmd semantics). ' +
          'For Java just write `javac Main.java` / `java Main` — the runner adds the UTF-8 flags itself.',
      }),
      expectExitCode: Type.Optional(Type.Integer()),
      expectStdoutContains: Type.Optional(Type.Array(Type.String())),
      expectStdoutNotContains: Type.Optional(Type.Array(Type.String())),
    }),
    {
      minItems: 1,
      description: 'At least one. Without a check this is not an exercise — it is "have a go".',
    },
  ),
  overwrite: Type.Optional(
    Type.Boolean({
      description:
        'Leave unset. Setting true deletes whatever is already in that exercise folder — ' +
        'including work the learner has done there.',
    }),
  ),
});

export interface PracticeToolDeps {
  /** 覆盖根目录（测试用）。 */
  root?: string;
}

function text(message: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: {},
    ...(isError ? { isError: true } : {}),
  };
}

export function buildPracticeScaffoldTool(
  deps: PracticeToolDeps = {},
): AgentTool<typeof PRACTICE_PARAMS, unknown> {
  return {
    name: 'practice_scaffold',
    label: 'Scaffold a runnable exercise',
    description:
      'Turn a page into a **folder the learner opens in VS Code** and actually runs: starter files, ' +
      'a generic runner (`check.mjs`) that executes the checks first and prints each command before ' +
      'running it, and `.vscode/` settings that pin UTF-8 (this machine defaults Java output to GBK). ' +
      'They press Ctrl+Shift+B to run the checks; the result lands in `result.json` next to the code. ' +
      'You supply starter files and checks as **data** — never generate the runner itself. ' +
      'This tool writes no code execution: it only creates files.',
    parameters: PRACTICE_PARAMS,
    executionMode: 'sequential',
    async execute(_id: string, params: Static<typeof PRACTICE_PARAMS>) {
      const root = resolve(deps.root ?? practiceRoot());
      const stageDir = practiceStageDir(params.stageId, root);

      let scaffold;
      try {
        scaffold = buildScaffold(
          {
            title: params.title,
            brief: params.brief,
            language: params.language as PracticeLanguage,
            files: (params.files ?? []) as PracticeFile[],
            checks: params.checks as PracticeCheck[],
          },
          { stageId: params.stageId, order: params.order },
        );
      } catch (error) {
        return text(
          `练习脚手架不合格：${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }

      const target = join(stageDir, scaffold.dirName);

      // ★ 兜底：判据错了也要挡住"写到练习目录外面去"。
      const inside = resolve(target);
      if (inside !== root && !inside.startsWith(root + sep)) {
        return text(`路径越界，拒绝写入：${inside} 不在 ${root} 之下。`, true);
      }

      // ★ 不覆盖学习者可能正在写的东西。
      if (existsSync(target) && params.overwrite !== true) {
        return text(
          `这个练习文件夹已经存在：${target}\n` +
            '**没有动它**（学习者可能正在里面写代码）。要看当前内容直接用上面的路径；' +
            '确实要重做这一页就再调一次并显式传 `overwrite: true` —— 那会**删掉文件夹里已有的东西**。',
          true,
        );
      }

      const written: string[] = [];
      for (const file of scaffold.files) {
        // 第二层：逐个文件再挡一次（scaffold 已经校验过，这里是纵深）。
        const filePath = resolve(target, file.path);
        if (!filePath.startsWith(resolve(target) + sep)) {
          return text(`文件路径越界，拒绝写入：${file.path}`, true);
        }
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, file.content, 'utf8');
        written.push(
          file.generated ? `${file.path}（生成，别改）` : `${file.path}（要改的就是它）`,
        );
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `练习已生成：${target}\n` +
              written.map((line) => `  · ${line}`).join('\n') +
              '\n\n学习者要做的：用 VS Code 打开这个文件夹，改上面标了"要改"的文件，' +
              `然后按 **Ctrl+Shift+B**（或跑 \`node ${PRACTICE_RUNNER}\`）验。` +
              '判据每条都会先打印命令再执行，跑完把结果写进 `result.json`。' +
              '\n\n我**没有**替你打开 VS Code，也没有执行任何命令 —— 这一步是他自己的。',
          },
        ],
        details: {
          dir: target,
          files: scaffold.files.map((file) => ({ path: file.path, generated: file.generated })),
          checks: scaffold.files.length,
        },
      };
    },
  };
}

const RESULT_PARAMS = Type.Object({
  stageId: Type.String({ description: 'The course the exercise belongs to.' }),
  order: Type.Integer({ minimum: 1, description: 'The page the exercise came from.' }),
  title: Type.Optional(
    Type.String({
      description:
        'Only needed when several exercises exist for the same page — pass one of the names it lists back.',
    }),
  ),
});

export interface PracticeResultToolDeps {
  root?: string;
}

/**
 * 读回练习结果 —— 这是"两个联动到一起"里**回到 OpenMAIC 的那一半**。
 *
 * ── 它做了什么、没做什么（不许含糊）────────────────────────────
 *
 * ✅ 读 `result.json`，把哪几条过了、哪几条没过、**原样的失败原因**交回给 agent，
 *    让它据此调整（重讲那一页 / 换一道更小的练习 / 拆页）。
 * ❌ **它不写 `runtime_records`**（服务端本来也没有写那条表的路径）。
 * ✅ 但结果**会进 `学习状态.md`** —— 走的是磁盘：`lib/practice/results.ts` 扫练习根目录下的
 *    `result.json`，`learner-state.ts` 把那一节渲染进状态文件。所以下一次运行时 agent
 *    在状态里就看得到它。**两处说法必须一致**，否则这里就成了静默的假话。
 *    原因不是懒：测验记录是**浏览器端**写的（`lib/quiz/runtime.ts` 走
 *    `navigator.locks`），而 `result.json` 是学习者在 VS Code 里跑出来的**磁盘文件**，
 *    两者是跨端的一跳。硬接需要新端点（= 给 web 服务"接受任意脚本写入"的能力），
 *    或者给练习记录写一套自己的折叠器。**这两条都是设计决定，不由我替他定。**
 *    所以这一版把"agent 能看见"做完，并在回话里**明说没写库** —— 静默地假装回流了
 *    比不回流更糟。
 */
export function buildPracticeResultTool(
  deps: PracticeResultToolDeps = {},
): AgentTool<typeof RESULT_PARAMS, unknown> {
  return {
    name: 'practice_result',
    label: 'Read back a practice result',
    description:
      'Read the `result.json` the learner produced by running the checks in an exercise folder. Tells you ' +
      'which checks passed, which failed, and the exact failure text — so you can adjust (re-explain that ' +
      'page, split it, or set a smaller exercise). The result is **not** stored as a quiz attempt, but it ' +
      '**does** reach `学习状态.md` (the state refresh reads these files from disk), so it is remembered ' +
      'across sessions. Read it after the learner says they ran the checks.',
    parameters: RESULT_PARAMS,
    executionMode: 'sequential',
    async execute(_id: string, params: Static<typeof RESULT_PARAMS>) {
      const root = resolve(deps.root ?? practiceRoot());
      const stageDir = practiceStageDir(params.stageId, root);
      const prefix = `${String(params.order).padStart(2, '0')}-`;

      let names: string[];
      try {
        names = (await readdir(stageDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
          .map((entry) => entry.name)
          .sort();
      } catch {
        return text(
          `这一页还没有练习文件夹（${stageDir} 下没有 ${prefix}*）。` +
            '先用 `practice_scaffold` 生成一个。',
          true,
        );
      }

      if (names.length === 0) {
        return text(
          `这一页还没有练习文件夹（${stageDir} 下没有 ${prefix}*）。` +
            '先用 `practice_scaffold` 生成一个。',
          true,
        );
      }

      const picked = params.title
        ? names.filter((name) => name === params.title || name.endsWith(`-${params.title}`))
        : names;
      if (picked.length === 0) {
        return text(`这一页下没有叫「${params.title}」的练习。现有：${names.join(' / ')}`, true);
      }
      if (picked.length > 1) {
        return text(
          `这一页下有 ${picked.length} 个练习，请用 title 指定一个：\n` +
            names.map((name) => `  · ${name}`).join('\n'),
          true,
        );
      }

      const dir = join(stageDir, picked[0]!);
      let raw: string;
      try {
        raw = await readFile(join(dir, PRACTICE_RESULT), 'utf8');
      } catch {
        // ★ 静默的反面：说清"还没跑"，并给出怎么跑。
        return text(
          `练习 \`${picked[0]}\` **还没有跑过判据**（没有 ${PRACTICE_RESULT}）。\n` +
            `让学习者用 VS Code 打开：${dir}\n` +
            '然后按 **Ctrl+Shift+B**（或跑 `node check.mjs`）。跑完再来读。',
          true,
        );
      }

      let parsed: {
        total?: number;
        passed?: number;
        failed?: number;
        ranAt?: string;
        results?: { name?: string; ok?: boolean; problems?: string[] }[];
      };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return text(
          `${PRACTICE_RESULT} 读不出来（不是合法 JSON）。让他重跑一次 \`node check.mjs\`。`,
          true,
        );
      }

      const lines = [
        `练习 \`${picked[0]}\` 的结果（${parsed.ranAt ?? '时间未知'}）：` +
          `**${parsed.passed ?? 0}/${parsed.total ?? 0} 通过**`,
        '',
        ...(parsed.results ?? []).map(
          (item) =>
            `  ${item.ok ? '✓' : '✗'} ${item.name ?? '(无名)'}${
              item.problems?.length ? ` —— ${item.problems.join('；')}` : ''
            }`,
        ),
      ];
      if ((parsed.failed ?? 0) > 0) {
        lines.push(
          '',
          '★ 没过的那几条就是**下一步该讲的东西** —— 回到对应的讲解页补讲或拆页，' +
            '不要只是把这条练习重发一遍。',
          '★ 注意来源：这条结果**不是**一次答题记录（它没有写数据库），' +
            '但它**会进 `学习状态.md`** —— 状态刷新会从磁盘读这些结果文件，' +
            '所以下一次运行时它还在。',
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: {
          dir,
          total: parsed.total ?? 0,
          passed: parsed.passed ?? 0,
          failed: parsed.failed ?? 0,
          // ★ 两个来源分开写清楚，避免把"进了学习状态"误读成"进了 runtime_records"。
          persistedToRuntimeRecords: false,
          feedsLearnerState: true,
        },
      };
    },
  };
}

/**
 * 系统提示词里的那一句 —— **无参、恒定**（§1.2 前缀缓存）。
 */
export function practicePromptBlock(): string {
  return [
    '## Practice happens in a real folder, not only on the page',
    '',
    'When a page is about **doing** something (writing code, using git), also give the learner a',
    'folder they can really run: `practice_scaffold { stageId, order, title, brief, language, files, checks }`.',
    '',
    '- It writes starter files plus a generic runner and `.vscode/` settings into',
    '  `课程与学习\\练习\\<stageId>\\<NN-标题>\\`. They open it in VS Code and press **Ctrl+Shift+B**.',
    '- You supply the starter files and the **checks as data** — write the commands, never the runner.',
    '  For Java write plain `javac Main.java` / `java Main`: the runner adds the UTF-8 flags',
    '  (this machine defaults Java output to GBK, so unqualified commands produce mojibake).',
    '- **Every check must be falsifiable by the learner alone**: they should be able to tell whether',
    '  they are done without asking you. `brief` must say how it is judged.',
    '- The tool never overwrites an existing exercise folder unless you pass `overwrite: true`',
    "  (that deletes the learner's own work there — do not pass it casually).",
    '- It does **not** open VS Code and does **not** run anything: it only creates files. Running is',
    "  the learner's step, on their own machine, where they can see it happen.",
    '- After they say they ran the checks, read it back with `practice_result { stageId, order }`.',
    '  A failing check tells you **what to go back and teach** — do not just re-issue the exercise.',
    '  That reads a file on disk. The result is not a quiz attempt, but the state refresh picks these',
    '  files up, so it **does** show up in `学习状态.md` on the next run.',
  ].join('\n');
}
