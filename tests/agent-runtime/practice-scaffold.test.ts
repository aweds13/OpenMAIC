import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PracticeSpec } from '@/lib/practice/scaffold';
import {
  buildScaffold,
  isSafeRelativePath,
  PRACTICE_CHECKS,
  PRACTICE_RESULT,
  PRACTICE_RUNNER,
  practiceDirName,
  validateSpec,
} from '@/lib/practice/scaffold';
import {
  buildPracticeResultTool,
  buildPracticeScaffoldTool,
  practiceStageDir,
} from '@/lib/server/agent-runtime/practice-tools';

const SPEC = {
  title: '两数之和',
  brief: '读两个整数，打印它们的和。判据：对 1 2 输出 3。',
  language: 'node' as const,
  files: [{ path: 'main.mjs', content: 'console.log(0);\n' }],
  checks: [
    { name: '输出是 3', command: 'node main.mjs', expectStdoutContains: ['3'] },
  ],
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'practice-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content
    .map((part) => part.text ?? '')
    .join('\n');
}

describe('文件夹名与路径安全', () => {
  it('pads the order and strips characters Windows forbids', () => {
    expect(practiceDirName(3, '两数之和')).toBe('03-两数之和');
    // ★ `<g>` 会被 stripMarkup 当作 HTML 标签**删掉**（标题来自 slide 的 HTML，这是对的）。
    //   第一版测试期望 `…f g h i`，被这一条抓住了 —— 不是 bug，是判据先剥标记再 sanitize。
    expect(practiceDirName(12, 'a/b:c*d?e"f<g>h|i')).toBe('12-a b c d e f h i');
    expect(practiceDirName(1, '   ')).toBe('01-practice');
  });

  it('★ rejects anything that could escape the exercise folder', () => {
    expect(isSafeRelativePath('main.py')).toBe(true);
    expect(isSafeRelativePath('src/main.py')).toBe(true);
    expect(isSafeRelativePath('../outside.txt')).toBe(false);
    expect(isSafeRelativePath('src/../../outside.txt')).toBe(false);
    expect(isSafeRelativePath('C:/windows/x.txt')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('')).toBe(false);
  });
});

describe('spec 校验（不合格当场拒，不生成半个练习）', () => {
  it('names every problem', () => {
    const problems = validateSpec({
      title: '',
      brief: '  ',
      language: 'node',
      files: [{ path: '../x', content: '' }],
      checks: [{ name: '', command: '' }],
    });
    expect(problems.join('\n')).toContain('title');
    expect(problems.join('\n')).toContain('brief');
    expect(problems.join('\n')).toContain('不安全');
    expect(problems.join('\n')).toContain('command');
  });

  it('★ refuses a spec with no checks — "have a go" is not an exercise', () => {
    expect(validateSpec({ ...SPEC, checks: [] }).join('')).toContain('至少要有一条');
    expect(() => buildScaffold({ ...SPEC, checks: [] }, { stageId: 's', order: 1 })).toThrow();
  });
});

describe('生成的文件', () => {
  it('always ships the runner, the checks, a README and the VS Code config', () => {
    const scaffold = buildScaffold(SPEC, { stageId: 'stage-a', order: 3 });
    const paths = scaffold.files.map((file) => file.path);
    expect(paths).toContain(PRACTICE_RUNNER);
    expect(paths).toContain(PRACTICE_CHECKS);
    expect(paths).toContain('README.md');
    expect(paths).toContain('.vscode/settings.json');
    expect(paths).toContain('.vscode/tasks.json');
    expect(scaffold.dirName).toBe('03-两数之和');
    // 学习者的起始文件标 generated:false，生成物标 true —— 二者不能混。
    expect(scaffold.files.find((f) => f.path === 'main.mjs')?.generated).toBe(false);
    expect(scaffold.files.find((f) => f.path === PRACTICE_RUNNER)?.generated).toBe(true);
  });

  it('pins UTF-8 in the VS Code settings, and adds the JVM flags for java', () => {
    const node = JSON.parse(
      buildScaffold(SPEC, { stageId: 's', order: 1 }).files.find(
        (f) => f.path === '.vscode/settings.json',
      )?.content ?? '{}',
    );
    expect(node['files.encoding']).toBe('utf8');
    expect(node['java.debug.settings.vmArgs']).toBeUndefined();

    const java = JSON.parse(
      buildScaffold({ ...SPEC, language: 'java' }, { stageId: 's', order: 1 }).files.find(
        (f) => f.path === '.vscode/settings.json',
      )?.content ?? '{}',
    );
    expect(java['java.debug.settings.vmArgs']).toContain('stdout.encoding=UTF-8');
  });

  it('makes "run the checks" the default build task (so Ctrl+Shift+B works)', () => {
    const tasks = JSON.parse(
      buildScaffold(SPEC, { stageId: 's', order: 1 }).files.find(
        (f) => f.path === '.vscode/tasks.json',
      )?.content ?? '{}',
    );
    expect(tasks.tasks[0].command).toContain(PRACTICE_RUNNER);
    expect(tasks.tasks[0].group).toEqual({ kind: 'build', isDefault: true });
  });

  it('tells the learner about the GBK trap in the README for java', () => {
    const readme = buildScaffold({ ...SPEC, language: 'java' }, { stageId: 's', order: 1 }).files.find(
      (f) => f.path === 'README.md',
    )?.content;
    expect(readme).toContain('-encoding UTF-8');
    expect(readme).toContain('stdout.encoding=UTF-8');
  });
});

describe('★ runner 真的能跑（不是"看起来对"）', () => {
  function writeScaffold(spec: PracticeSpec): string {
    const scaffold = buildScaffold(spec, { stageId: 'stage-a', order: 1 });
    const dir = join(root, scaffold.dirName);
    for (const file of scaffold.files) {
      const target = join(dir, file.path);
      // 测试自己建目录（生产侧由 practice_scaffold 工具负责）。
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    }
    return dir;
  }

  it('writes result.json, exits 0 and reports PASS for a correct answer', () => {
    const spec = { ...SPEC, files: [{ path: 'main.mjs', content: 'console.log(1 + 2);\n' }] };
    const dir = writeScaffold(spec);
    const run = spawnSync('node', [PRACTICE_RUNNER], { cwd: dir, encoding: 'utf8' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('✓ 通过');
    // ★ 先打印命令再执行 —— 学习者要能看见自己机器上跑了什么。
    expect(run.stdout).toContain('$ node main.mjs');

    const result = JSON.parse(readFileSync(join(dir, PRACTICE_RESULT), 'utf8'));
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(join(dir, PRACTICE_RESULT))).toBe(true);
  });

  it('exits non-zero and says why when the answer is wrong', () => {
    const spec = { ...SPEC, files: [{ path: 'main.mjs', content: 'console.log(0);\n' }] };
    const dir = writeScaffold(spec);
    const run = spawnSync('node', [PRACTICE_RUNNER], { cwd: dir, encoding: 'utf8' });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('✗ 不通过');
    const result = JSON.parse(readFileSync(join(dir, PRACTICE_RESULT), 'utf8'));
    expect(result.failed).toBe(1);
    expect(result.results[0].problems.join('')).toContain('输出里没有');
  });

  it('★ adds the UTF-8 flags to java commands by itself (the GBK trap)', () => {
    const spec = {
      ...SPEC,
      language: 'java' as const,
      files: [{ path: 'Main.java', content: 'public class Main { }\n' }],
      checks: [
        // 故意写得"裸"：不加任何编码参数 —— runner 必须自己补上。
        { name: '能编译', command: 'javac Main.java', expectExitCode: 0 },
      ],
    };
    const dir = writeScaffold(spec);
    const run = spawnSync('node', [PRACTICE_RUNNER], { cwd: dir, encoding: 'utf8' });
    expect(run.stdout).toContain('javac -encoding UTF-8 Main.java');
  });
});

describe('practice_scaffold 工具', () => {
  it('writes the folder and tells the learner exactly what to do', async () => {
    const tool = buildPracticeScaffoldTool({ root });
    const result = await tool.execute('c', { stageId: 'stage-a', order: 3, ...SPEC } as never);
    const text = textOf(result);

    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(text).toContain('练习已生成');
    expect(text).toContain('Ctrl+Shift+B');
    // ★ 明说它没有起进程 —— 这是安全性的可读承诺。
    expect(text).toContain('没有**替你打开 VS Code，也没有执行任何命令');
    // 直接用 deps.root 构造 —— `practiceStageDir()` 读的是 env/默认根，不是这里的 deps.root。
    expect(existsSync(join(root, 'stage-a', '03-两数之和', PRACTICE_RUNNER))).toBe(true);
  });

  it('★ derives the stage folder from one place (root override included)', () => {
    // 这条同时钉住"唯一实现"：工具与测试都用 practiceStageDir，不许各写一份。
    expect(practiceStageDir('stage-a', root)).toBe(join(root, 'stage-a'));
    expect(practiceStageDir('../../evil', root)).toBe(join(root, '______evil'));
  });

  it('★ refuses to overwrite an exercise folder that already exists', async () => {
    const tool = buildPracticeScaffoldTool({ root });
    await tool.execute('c', { stageId: 'stage-a', order: 3, ...SPEC } as never);
    const second = await tool.execute('c', { stageId: 'stage-a', order: 3, ...SPEC } as never);

    expect((second as { isError?: boolean }).isError).toBe(true);
    expect(textOf(second)).toContain('没有动它');
    expect(textOf(second)).toContain('overwrite: true');
  });

  it('rejects an unsafe file path and a check-less spec, loudly', async () => {
    const tool = buildPracticeScaffoldTool({ root });
    const unsafe = await tool.execute('c', {
      stageId: 'stage-a',
      order: 1,
      ...SPEC,
      files: [{ path: '../../escape.txt', content: 'x' }],
    } as never);
    expect((unsafe as { isError?: boolean }).isError).toBe(true);
    expect(textOf(unsafe)).toContain('不安全');

    const noChecks = await tool.execute('c', {
      stageId: 'stage-a',
      order: 1,
      ...SPEC,
      checks: [],
    } as never);
    expect((noChecks as { isError?: boolean }).isError).toBe(true);
  });
});

describe('practice_result（把结果读回来给 agent）', () => {
  const resultTool = () => buildPracticeResultTool({ root });

  it('★ says plainly that the learner has not run the checks yet', async () => {
    const scaffold = buildPracticeScaffoldTool({ root });
    await scaffold.execute('c', { stageId: 'stage-a', order: 3, ...SPEC } as never);

    const read = await resultTool().execute('c', { stageId: 'stage-a', order: 3 } as never);
    expect((read as { isError?: boolean }).isError).toBe(true);
    expect(textOf(read)).toContain('还没有跑过判据');
    expect(textOf(read)).toContain('Ctrl+Shift+B');
  });

  it('★ reports which checks failed and what to go back and teach', async () => {
    const scaffold = buildPracticeScaffoldTool({ root });
    const written = await scaffold.execute('c', { stageId: 'stage-a', order: 3, ...SPEC } as never);
    const dir = (written as { details: { dir: string } }).details.dir;
    writeFileSync(
      join(dir, PRACTICE_RESULT),
      JSON.stringify({
        ranAt: '2026-10-07T00:00:00.000Z',
        total: 2,
        passed: 1,
        failed: 1,
        results: [
          { name: '输出是 3', ok: true },
          { name: '处理负数', ok: false, problems: ['输出里没有：-1'] },
        ],
      }),
      'utf8',
    );

    const read = await resultTool().execute('c', { stageId: 'stage-a', order: 3 } as never);
    const text = textOf(read);
    expect(text).toContain('1/2 通过');
    expect(text).toContain('✓ 输出是 3');
    expect(text).toContain('✗ 处理负数');
    expect(text).toContain('输出里没有：-1');
    // 失败时要说清下一步是"回去讲"，不是重发练习。
    expect(text).toContain('该讲的东西');
    // ★ 两个来源要分开说清楚：**没有**写 runtime_records，但**会**进 学习状态.md。
    //   第一版这里断的是"没有进错题本" —— 那时确实没进；接上磁盘来源之后
    //   那句话就成了假话，断言跟着改（否则测试会保护一句错的提示）。
    expect(text).toContain('不是');
    expect(text).toContain('会进');
    // ★ 模型可见的文字里**不许出现我的表名** —— 它不需要知道，而且第 8 轮那条
    //   不变式（tool-name-invariant）正是靠这个把表名当幽灵工具抓了出来。
    expect(text).not.toContain('runtime_records');
    const details = (read as { details: { persistedToRuntimeRecords: boolean; feedsLearnerState: boolean } }).details;
    expect(details.persistedToRuntimeRecords).toBe(false);
    expect(details.feedsLearnerState).toBe(true);
  });

  it('lists the exercises when a page has more than one, instead of guessing', async () => {
    const scaffold = buildPracticeScaffoldTool({ root });
    await scaffold.execute('c', { stageId: 'stage-a', order: 3, ...SPEC } as never);
    await scaffold.execute('c', {
      stageId: 'stage-a',
      order: 3,
      ...SPEC,
      title: '另一道',
    } as never);
    const read = await resultTool().execute('c', { stageId: 'stage-a', order: 3 } as never);
    expect((read as { isError?: boolean }).isError).toBe(true);
    expect(textOf(read)).toContain('请用 title 指定');
  });
});
