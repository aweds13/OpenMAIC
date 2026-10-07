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
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
  buildScaffold,
  PRACTICE_RUNNER,
  type PracticeCheck,
  type PracticeFile,
  type PracticeLanguage,
} from '@/lib/practice/scaffold';

export const PRACTICE_TOOL_NAMES = ['practice_scaffold'] as const;

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
    { description: 'Drives the VS Code encoding settings; the checks themselves are just commands.' },
  ),
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ description: 'Relative path inside the exercise folder. No "..", no drive.' }),
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
      description:
        'At least one. Without a check this is not an exercise — it is "have a go".',
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
        return text(`练习脚手架不合格：${error instanceof Error ? error.message : String(error)}`, true);
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
        written.push(file.generated ? `${file.path}（生成，别改）` : `${file.path}（要改的就是它）`);
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
    '  (that deletes the learner\'s own work there — do not pass it casually).',
    '- It does **not** open VS Code and does **not** run anything: it only creates files. Running is',
    '  the learner\'s step, on their own machine, where they can see it happen.',
  ].join('\n');
}
