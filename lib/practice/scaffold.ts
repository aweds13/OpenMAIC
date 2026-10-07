/**
 * 练习脚手架 —— 把一页课变成**一个你真能在 VS Code 里打开的文件夹**。
 *
 * ── 用户的原话（这是需求，不是我的设计偏好）────────────────────
 *
 * 「我希望 openmaic 能够创建一个沙箱或者虚拟环境，就是有点类似于我通过打代码，然后呢
 *   正确的话就蹦出某种结果…因为在我电脑上搞的话会觉得有点害怕，也觉得麻烦」
 * 「换一层，或者是我能高效结合 vscode 进行就好，**两个联动到一起**」
 *
 * ── 为什么是"一个通用 runner + 数据"，而不是让 agent 生成脚本 ──
 *
 * agent 生成的是**代码**；如果每个练习都生成一份判题脚本，那份脚本就得跟着练习一起被审。
 * 这里反过来：**runner 是我的代码，只写一次、测一次**；agent 只写 `checks.json`（数据：
 * 要跑什么命令、期望什么）。好处有三：
 *   1. 编码坑**只修一次**（见下），不会每个练习各踩一遍；
 *   2. 数据可校验（形状错了当场拒），代码不可；
 *   3. 换语言不用改 runner。
 *
 * ── ★ 编码坑：这台机器上 Java 的默认输出编码是 GBK ────────────────
 *
 * 实测（2026-10-07，本机）：
 *   native.encoding = GBK   stdout.encoding = GBK
 *   javac Hello.java      → 能编译，但中文字面量被按 GBK 读坏
 *   java Hello            → 输出 `����������� OK`
 *   修法：`javac -encoding UTF-8 X.java` + `java -Dstdout.encoding=UTF-8 -Dfile.encoding=UTF-8 X`
 * 所以 runner 对**每个命令都显式带上 UTF-8**，不依赖用户的终端配置。
 *
 * ── 落点：`课程与学习\练习\` ─────────────────────────────────────
 *
 * 按 AGENTS.md §6.8 的归属表：**课程产物与练习 → `课程与学习\`**，不是 `个人数据\`
 * （那里只放学习成长的东西）、也不是 harness 诊断目录。
 *
 * ── 安全 ───────────────────────────────────────────────────────
 *
 * 本模块**只生成文件内容与名字**，不碰磁盘、不起进程。写盘与路径白名单在调用方
 * （`practice-tools.ts`），跑命令是**学习者自己**在文件夹里跑 —— runner 会把每条命令
 * **先打出来再跑**（不静默）。
 */
import { stripMarkup } from '@/lib/quiz/coverage-gap';

/** runner 的文件名。放常量是因为它是"契约"：README 里会告诉学习者跑它。 */
export const PRACTICE_RUNNER = 'check.mjs';
export const PRACTICE_CHECKS = 'checks.json';
export const PRACTICE_RESULT = 'result.json';

export type PracticeLanguage = 'java' | 'python' | 'node' | 'shell' | 'git';

/** 一条判据：跑一条命令，看它成不成功、输出里有没有该有的东西。 */
export interface PracticeCheck {
  /** 给人看的一句话：这条在验什么。 */
  name: string;
  /** 在练习文件夹里执行的命令（cmd.exe 语义，Windows）。 */
  command: string;
  /** 期望退出码，默认 0。 */
  expectExitCode?: number;
  /** 输出里必须包含的片段（全部都要包含）。 */
  expectStdoutContains?: string[];
  /** 输出里不该出现的片段。 */
  expectStdoutNotContains?: string[];
}

export interface PracticeFile {
  /** 相对练习文件夹的路径。允许子目录，但不许 `..`、不许绝对路径。 */
  path: string;
  content: string;
}

export interface PracticeSpec {
  /** 练习名（会成为文件夹名的一部分）。 */
  title: string;
  /** 这次要练什么、验收标准是什么 —— 会写进 README 的头部。 */
  brief: string;
  language: PracticeLanguage;
  /** 起始文件（学习者要改的那些）。 */
  files?: PracticeFile[];
  /** 判据。**至少要有一条** —— 没有判据的练习只是"随便写写"。 */
  checks: PracticeCheck[];
}

export interface ScaffoldFile extends PracticeFile {
  /** true = 由 runner 生成，不是给学习者改的。 */
  generated: boolean;
}

export interface Scaffold {
  /** 文件夹名（已 sanitize，不含路径分隔符）。 */
  dirName: string;
  files: ScaffoldFile[];
}

/** 文件夹名：可读、稳定、无非法字符。`01-两数之和` 这种。 */
export function practiceDirName(order: number, title: string): string {
  const clean = stripMarkup(title)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  const padded = String(Math.max(1, Math.floor(order))).padStart(2, '0');
  return clean ? `${padded}-${clean}` : `${padded}-practice`;
}

/**
 * 文件路径安全：只允许相对路径，且不许跳出文件夹。
 *
 * ★ 这是**必须在生成侧就挡住**的东西：`files[].path` 来自 agent。
 *   `path.resolve(root, '..\\..\\x')` 会写到练习目录外面去。
 */
export function isSafeRelativePath(path: string): boolean {
  const flat = path.replace(/\\/g, '/').trim();
  if (!flat || flat.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(flat)) return false;
  return !flat.split('/').some((part) => part === '..' || part === '');
}

/** 校验一份 spec，返回人类的错误信息（空数组 = 通过）。 */
export function validateSpec(spec: PracticeSpec): string[] {
  const problems: string[] = [];
  if (!spec.title.trim()) problems.push('title 不能为空（它决定文件夹名）');
  if (!spec.brief.trim()) problems.push('brief 不能为空（README 要靠它说清验收标准）');
  if (spec.checks.length === 0) {
    problems.push('checks 至少要有一条 —— 没有判据的练习只是"随便写写"，不算练习');
  }
  for (const [index, check] of spec.checks.entries()) {
    if (!check.name.trim()) problems.push(`checks[${index}].name 不能为空`);
    if (!check.command.trim()) problems.push(`checks[${index}].command 不能为空`);
  }
  for (const file of spec.files ?? []) {
    if (!isSafeRelativePath(file.path)) {
      problems.push(`files[].path 不安全："${file.path}"（要相对路径，且不许 .. ）`);
    }
  }
  return problems;
}

/**
 * 生成 `check.mjs` —— 通用 runner。
 *
 * 它做四件事：打印每条命令 → 跑 → 比对 → 写 `result.json`。
 * **先打印再跑**是刻意的：学习者要能看见自己机器上到底执行了什么。
 */
export function buildRunnerSource(): string {
  return `#!/usr/bin/env node
/**
 * 练习判据 runner —— 由 OpenMAIC 生成，**不需要改**。
 *
 *   node check.mjs
 *
 * 判据写在 ${PRACTICE_CHECKS} 里（数据）。这个文件只负责跑它、比对、写结果。
 * 每条命令都会**先打印再执行** —— 你能看见自己机器上跑了什么。
 *
 * 结果写到 ${PRACTICE_RESULT}：那是回流给 OpenMAIC 的那份记录。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checks = JSON.parse(readFileSync(join(here, '${PRACTICE_CHECKS}'), 'utf8'));

/** ★ 显式 UTF-8：这台机器 Java 的默认输出编码是 GBK（实测 stdout.encoding=GBK）。 */
function withEncoding(command) {
  return command
    .replace(/\\bjavac\\b/g, 'javac -encoding UTF-8')
    .replace(/\\bjava\\s+(?!-D)/g, 'java -Dstdout.encoding=UTF-8 -Dfile.encoding=UTF-8 ');
}

const results = [];
let failed = 0;

for (const check of checks) {
  const command = withEncoding(check.command);
  console.log('');
  console.log('▶ ' + (check.name || command));
  console.log('  $ ' + command);

  const run = spawnSync(command, { cwd: here, shell: true, encoding: 'utf8' });
  const stdout = (run.stdout || '') + (run.stderr || '');
  if (stdout.trim()) console.log(stdout.trimEnd().split('\\n').map((l) => '    ' + l).join('\\n'));

  const problems = [];
  const expectedCode = check.expectExitCode ?? 0;
  if (run.status !== expectedCode) {
    problems.push('退出码是 ' + run.status + '，期望 ' + expectedCode);
  }
  for (const needle of check.expectStdoutContains || []) {
    if (!stdout.includes(needle)) problems.push('输出里没有：' + needle);
  }
  for (const needle of check.expectStdoutNotContains || []) {
    if (stdout.includes(needle)) problems.push('输出里不该有：' + needle);
  }

  const ok = problems.length === 0;
  if (!ok) failed += 1;
  console.log(ok ? '  ✓ 通过' : '  ✗ 不通过 — ' + problems.join('；'));
  results.push({ name: check.name, command, ok, problems });
}

const summary = {
  // ★ 时间戳取"跑完的时刻"，但它是**记录**不是提示词，所以不影响任何缓存。
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.length - failed,
  failed,
  results,
};
writeFileSync(join(here, '${PRACTICE_RESULT}'), JSON.stringify(summary, null, 2) + '\\n', 'utf8');

console.log('');
console.log(failed === 0
  ? '✅ 全部 ' + results.length + ' 条通过。结果已写进 ${PRACTICE_RESULT}。'
  : '❌ ' + failed + '/' + results.length + ' 条不通过。结果已写进 ${PRACTICE_RESULT}。');
process.exit(failed === 0 ? 0 : 1);
`;
}

/** README：让学习者（和下一个窗口的 agent）一眼知道这是干什么的、怎么跑。 */
export function buildReadme(spec: PracticeSpec, context: { stageId: string; order: number }): string {
  const lines = [
    `# ${spec.title}`,
    '',
    `来自课程 \`${context.stageId}\` 第 ${context.order} 页。`,
    '',
    '## 这次要练什么',
    '',
    spec.brief.trim(),
    '',
    '## 怎么跑',
    '',
    '```',
    `node ${PRACTICE_RUNNER}`,
    '```',
    '',
    `它按 ${PRACTICE_CHECKS} 里的判据逐条跑，每条**先打印命令再执行**；`,
    `跑完把结果写进 ${PRACTICE_RESULT}。`,
    '',
    '## 判据',
    '',
    ...spec.checks.map((check, index) => `${index + 1}. ${check.name}`),
    '',
  ];

  if (spec.language === 'java') {
    lines.push(
      '## Java 的编码注意（这台机器上实测踩到的）',
      '',
      '这台机器 Java 的默认输出编码是 **GBK**，中文会变乱码。runner 已经给每条命令',
      '自动加上 `-encoding UTF-8` / `-Dstdout.encoding=UTF-8`，所以**直接用 runner 跑**就行。',
      '如果你手动跑，要写全：',
      '',
      '```',
      'javac -encoding UTF-8 Main.java',
      'java -Dstdout.encoding=UTF-8 -Dfile.encoding=UTF-8 Main',
      '```',
      '',
    );
  }

  if ((spec.files ?? []).length) {
    lines.push('## 要改的文件', '');
    for (const file of spec.files ?? []) lines.push(`- \`${file.path}\``);
    lines.push('');
  }

  lines.push(
    '---',
    '',
    '这个文件夹是 OpenMAIC 生成的，位于 `课程与学习\\练习\\`。',
    '改坏了不要紧 —— 让 OpenMAIC 重新生成这一页就行。',
    '',
  );
  return lines.join('\n');
}

/**
 * 组装整份脚手架。
 *
 * `generated: true` 的文件**不要手改**：它们由 runner 契约决定，改了就与判据脱节。
 */
export function buildScaffold(spec: PracticeSpec, context: { stageId: string; order: number }): Scaffold {
  const problems = validateSpec(spec);
  if (problems.length) {
    throw new Error(`练习脚手架不合格：${problems.join('；')}`);
  }

  const files: ScaffoldFile[] = (spec.files ?? []).map((file) => ({ ...file, generated: false }));
  files.push({ path: PRACTICE_CHECKS, content: `${JSON.stringify(spec.checks, null, 2)}\n`, generated: true });
  files.push({ path: PRACTICE_RUNNER, content: buildRunnerSource(), generated: true });
  files.push({ path: 'README.md', content: buildReadme(spec, context), generated: true });

  // ★ 与 VS Code 的"联动"靠**配置**，不靠起进程：用户要"两个联动到一起"，而配置集成
  //   既做到了联动，又不需要给 web 服务"起进程"的能力（那正是我一路在避免的东西）。
  files.push({ path: '.vscode/settings.json', content: vscodeSettings(spec), generated: true });
  files.push({ path: '.vscode/tasks.json', content: vscodeTasks(), generated: true });

  return { dirName: practiceDirName(context.order, spec.title), files };
}

/**
 * `.vscode/settings.json` —— 把**编码**钉死在项目里。
 *
 * 这台机器 Java 默认输出编码是 GBK（实测）。不钉的话，学习者每开一个新文件夹就再踩一次。
 * 钉进 `.vscode/settings.json` 之后，VS Code 一打开这个文件夹就生效，**他什么都不用做**。
 */
export function vscodeSettings(spec: PracticeSpec): string {
  const settings: Record<string, unknown> = {
    'files.encoding': 'utf8',
    'files.eol': '\n',
  };
  if (spec.language === 'java') {
    // 与 runner 里那条 `-Dstdout.encoding=UTF-8` 是同一个修法，只是走 VS Code 的调试参数。
    settings['java.debug.settings.vmArgs'] = '-Dstdout.encoding=UTF-8 -Dfile.encoding=UTF-8';
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * `.vscode/tasks.json` —— 让"跑判据"变成 **Ctrl+Shift+B**（默认构建任务）。
 *
 * 这是"两个联动到一起"里最实用的一格：在 VS Code 里改完代码，按一下就跑判据，
 * 不用切回浏览器、也不用记命令。
 */
export function vscodeTasks(): string {
  const task = {
    version: '2.0.0',
    tasks: [
      {
        label: '跑判据',
        type: 'shell',
        command: `node ${PRACTICE_RUNNER}`,
        group: { kind: 'build', isDefault: true },
        presentation: { reveal: 'always', panel: 'dedicated' },
        problemMatcher: [],
      },
    ],
  };
  return `${JSON.stringify(task, null, 2)}\n`;
}
