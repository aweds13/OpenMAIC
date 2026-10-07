import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatPracticeResultsForState,
  parsePracticeDirName,
  readPracticeResults,
} from '@/lib/practice/results';
import {
  refreshLearnerStateFromRuntime,
  type RefreshLearnerStateOptions,
} from '@/lib/server/agent-runtime/learner-state';
import { PRACTICE_RESULT } from '@/lib/practice/scaffold';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'practice-results-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 在练习根目录里摆一份练习结果。 */
function putResult(
  stageId: string,
  dirName: string,
  body: unknown | string = { total: 2, passed: 1, failed: 1, ranAt: '2026-10-07T10:00:00.000Z' },
): string {
  const dir = join(root, stageId, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, PRACTICE_RESULT),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  );
  return dir;
}

describe('解析文件夹名', () => {
  it('takes the order and the title apart', () => {
    expect(parsePracticeDirName('03-两数之和')).toEqual({ order: 3, title: '两数之和' });
    expect(parsePracticeDirName('12-a b')).toEqual({ order: 12, title: 'a b' });
    expect(parsePracticeDirName('没有页号')).toBeUndefined();
    expect(parsePracticeDirName('x-标题')).toBeUndefined();
  });
});

describe('读练习结果', () => {
  it('returns nothing when the root does not exist (never throws)', async () => {
    expect(await readPracticeResults(join(root, '不存在'))).toEqual([]);
  });

  it('★ skips broken files instead of failing the whole refresh', async () => {
    putResult('stage-a', '01-好的');
    putResult('stage-b', '02-坏JSON', '{ 不是 json');
    mkdirSync(join(root, 'stage-c', '03-没跑过'), { recursive: true });
    writeFileSync(join(root, 'stage-c', '不是目录.txt'), 'x', 'utf8');

    const entries = await readPracticeResults(root);
    expect(entries.map((entry) => entry.dirName)).toEqual(['01-好的']);
  });

  it('carries the failure text through verbatim', async () => {
    putResult('stage-a', '01-两数之和', {
      ranAt: '2026-10-07T10:00:00.000Z',
      total: 2,
      passed: 1,
      failed: 1,
      results: [
        { name: '输出是 3', ok: true },
        { name: '处理负数', ok: false, problems: ['输出里没有：-1'] },
      ],
    });
    const [entry] = await readPracticeResults(root);
    expect(entry?.stageId).toBe('stage-a');
    expect(entry?.order).toBe(1);
    expect(entry?.title).toBe('两数之和');
    expect(entry?.failedChecks).toEqual([{ name: '处理负数', problems: ['输出里没有：-1'] }]);
  });

  it('sorts the most recent first, and tolerates a missing ranAt', async () => {
    putResult('stage-a', '01-早', { total: 1, passed: 1, failed: 0, ranAt: '2026-01-01T00:00:00.000Z' });
    putResult('stage-a', '02-晚', { total: 1, passed: 0, failed: 1, ranAt: '2026-12-31T00:00:00.000Z' });
    putResult('stage-a', '03-没时间', { total: 1, passed: 1, failed: 0 });
    const entries = await readPracticeResults(root);
    expect(entries.map((entry) => entry.dirName)).toEqual(['02-晚', '01-早', '03-没时间']);
  });

  it('respects the file cap (the practice folder is the learner’s own place)', async () => {
    for (let index = 1; index <= 5; index += 1) {
      putResult('stage-a', `${String(index).padStart(2, '0')}-练习${index}`, {
        total: 1,
        passed: 1,
        failed: 0,
        ranAt: `2026-10-0${index}T00:00:00.000Z`,
      });
    }
    expect(await readPracticeResults(root, { maxFiles: 2 })).toHaveLength(2);
  });
});

describe('渲染成学习状态的一节', () => {
  it('returns empty for no results — the caller must stay able to skip writing', async () => {
    expect(formatPracticeResultsForState([])).toBe('');
  });

  it('★ says where it came from, so it cannot be mistaken for runtime_records', async () => {
    // ★ 要带上 results 数组：失败判据是从它里面读的（第一版用默认 body，没有 results，
    //   于是"列不出失败判据"这条断言失败 —— 是测试漏给数据，不是渲染漏写）。
    putResult('stage-a', '01-两数之和', {
      ranAt: '2026-10-07T10:00:00.000Z',
      total: 2,
      passed: 1,
      failed: 1,
      results: [
        { name: '输出是 3', ok: true },
        { name: '处理负数', ok: false, problems: ['输出里没有：-1'] },
      ],
    });
    const text = formatPracticeResultsForState(await readPracticeResults(root));
    expect(text).toContain('不是');
    expect(text).toContain('runtime_records');
    expect(text).toContain('01-两数之和');
    expect(text).toContain('1/2 通过');
    expect(text).toContain('✗ 处理负数');
    expect(text).toContain('该回去讲的东西');
  });

  it('lists a fully-passed exercise without the "go back and teach" line', async () => {
    putResult('stage-a', '01-过了', { total: 1, passed: 1, failed: 0, ranAt: '2026-10-07T00:00:00Z' });
    const text = formatPracticeResultsForState(await readPracticeResults(root));
    expect(text).toContain('1/1 通过');
    expect(text).not.toContain('该回去讲的东西');
  });
});

describe('★ 接线：练习结果真的进 学习状态.md', () => {
  const optionsFor = (): RefreshLearnerStateOptions => ({
    ownerId: 'anon:test-owner',
    path: join(root, '学习状态.md'),
    practiceRoot: root,
    // 没有自检页记录：所有查询返回空。这正是新打开的那条路径。
    queryable: { query: async () => ({ rows: [] }) } as unknown as NonNullable<
      RefreshLearnerStateOptions['queryable']
    >,
  });

  it('★ writes the state file when there are NO quiz records but there ARE practice results', async () => {
    putResult('stage-a', '01-两数之和');
    const options = optionsFor();
    const result = await refreshLearnerStateFromRuntime(options);

    expect(result).not.toBeNull();
    expect(result?.records).toBe(0);
    expect(result?.practiceResults).toBe(1);
    const written = readFileSync(options.path!, 'utf8');
    expect(written).toContain('01-两数之和');
    expect(written).toContain('练习');
  });

  it('★ still returns null when there is neither (no empty state file)', async () => {
    const options = optionsFor();
    const result = await refreshLearnerStateFromRuntime(options);
    expect(result).toBeNull();
    expect(() => readFileSync(options.path!, 'utf8')).toThrow();
  });
});
