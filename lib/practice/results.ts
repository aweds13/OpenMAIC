/**
 * 把磁盘上的练习结果读成「学习者状态的一部分」。
 *
 * ── 为什么是磁盘，而不是写进 `runtime_records` ─────────────────
 *
 * T9 的目标是"练习结果回流到错题本"。最直觉的实现是给 `runtime_records` 加一条写入 ——
 * 但实测（2026-10-07）**服务端根本没有写那条表的路径**：只有浏览器端的
 * `lib/quiz/runtime.ts` 通过 `store.appendRecord` 写。要做服务端写，就得新开一条
 * 能接受外部写入的通道（端点或写入器）—— 那是**给 web 服务加新能力**，
 * 而收益只是"少读一个文件"。
 *
 * 所以这里换个方向：**不动写入侧，让读取侧多认一个来源。**
 * `学习状态.md` 本来就是**机器每次重写**的派生文件（人写的 `学习画像.md` 一个字不动），
 * 它多一个来源，学习者看到的东西是一样的，而**没有新增任何可被外部写入的面**。
 *
 * ── 它只管读和渲染，不碰写 ───────────────────────────────────
 *
 * 落盘由 `check.mjs`（学习者在 VS Code 里跑）完成；本模块只读。
 * 状态文件的写入由 `learner-state.ts` 负责 —— 职责不重叠。
 *
 * ── 有界（这里读的是**目录**，不是我们自己的数据）────────────────
 *
 * 练习目录是学习者的东西：他可能往里放别的东西、可能有半截的 JSON、
 * 可能有很多旧练习。所以：**固定三层深度**（root/stage/dir/result.json）、
 * **条数上限**、**读不动或解析不了就跳过**，绝不因为一个坏文件把整次刷新搞挂。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PRACTICE_RESULT } from '@/lib/practice/scaffold';

export interface PracticeFailedCheck {
  /** 判据名（runner 写进 result.json 的 `name`）。 */
  name: string;
  /** **原样**带出失败原因 —— 结论里要能看到"输出里没有：-1"这种具体话。 */
  problems: string[];
}

export interface PracticeResultEntry {
  stageId: string;
  /** 文件夹名，如 `01-两数之和`。 */
  dirName: string;
  /** 从文件夹名里解出的页号；解不出就用 0（排序用，不显示为页号）。 */
  order: number;
  title: string;
  ranAt: string;
  total: number;
  passed: number;
  failed: number;
  failedChecks: PracticeFailedCheck[];
}

/** 文件夹名是 `<NN>-<标题>`（由 `practiceDirName()` 生成）。 */
export function parsePracticeDirName(
  dirName: string,
): { order: number; title: string } | undefined {
  const match = /^(\d{1,3})-(.+)$/.exec(dirName.trim());
  if (!match) return undefined;
  const order = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(order)) return undefined;
  return { order, title: match[2]!.trim() };
}

function normalizeEntry(
  stageId: string,
  dirName: string,
  raw: unknown,
): PracticeResultEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const parsed = parsePracticeDirName(dirName);
  // `ranAt` 缺失不算坏 —— 老文件可能没有；只是排到最后。
  const ranAt = typeof record.ranAt === 'string' ? record.ranAt : '';
  const total = typeof record.total === 'number' ? record.total : 0;
  const passed = typeof record.passed === 'number' ? record.passed : 0;
  const failed = typeof record.failed === 'number' ? record.failed : Math.max(0, total - passed);

  const failedChecks: PracticeFailedCheck[] = [];
  if (Array.isArray(record.results)) {
    for (const item of record.results) {
      if (!item || typeof item !== 'object') continue;
      const check = item as Record<string, unknown>;
      if (check.ok === true) continue;
      failedChecks.push({
        name: typeof check.name === 'string' ? check.name : '(无名判据)',
        problems: Array.isArray(check.problems)
          ? check.problems.filter((value): value is string => typeof value === 'string')
          : [],
      });
    }
  }

  return {
    stageId,
    dirName,
    order: parsed?.order ?? 0,
    title: parsed?.title ?? dirName,
    ranAt,
    total,
    passed,
    failed,
    failedChecks,
  };
}

export interface ReadPracticeResultsOptions {
  /** 条数上限。练习目录是学习者自己的地方，可能攒了很多。 */
  maxFiles?: number;
}

/**
 * 扫 `<root>/<stageId>/<dir>/result.json`。
 *
 * **永不抛**：坏 JSON、读不动的文件、不是目录的东西，一律跳过。
 * 一次刷新读不到东西，退化成"没有练习记录"，而不是让整个学习状态刷新失败。
 */
export async function readPracticeResults(
  root: string,
  options: ReadPracticeResultsOptions = {},
): Promise<PracticeResultEntry[]> {
  const maxFiles = options.maxFiles ?? 200;
  const entries: PracticeResultEntry[] = [];

  let stageDirs: string[];
  try {
    stageDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  for (const stageId of stageDirs) {
    if (entries.length >= maxFiles) break;
    let exerciseDirs: string[];
    try {
      exerciseDirs = (await readdir(join(root, stageId), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const dirName of exerciseDirs) {
      if (entries.length >= maxFiles) break;
      try {
        const text = await readFile(join(root, stageId, dirName, PRACTICE_RESULT), 'utf8');
        const entry = normalizeEntry(stageId, dirName, JSON.parse(text));
        if (entry) entries.push(entry);
      } catch {
        // 没跑过 / 半截文件 / 不是 JSON —— 跳过，不当作错误。
        continue;
      }
    }
  }

  // 最近的在前。没有 `ranAt` 的排最后。
  return entries.sort((a, b) => (a.ranAt < b.ranAt ? 1 : a.ranAt > b.ranAt ? -1 : 0));
}

/**
 * 渲染成 `学习状态.md` 里的一节。**没有内容时返回 `''`** ——
 * 让调用方保持"没东西就不写文件"的既有性质（写一份空状态只是提示词噪声）。
 */
export function formatPracticeResultsForState(
  entries: readonly PracticeResultEntry[],
  options: { maxItems?: number } = {},
): string {
  if (entries.length === 0) return '';
  const maxItems = options.maxItems ?? 8;
  const shown = entries.slice(0, maxItems);
  const withFailures = shown.filter((entry) => entry.failed > 0);

  const lines = [
    '## 练习（真的跑过代码的那些）',
    '',
    '> 来源：练习文件夹里的 `result.json`（**不是** `runtime_records`）。',
    '> 这些是"动手做"的结果，与上面的自检页结果是两回事。',
    '',
    ...shown.map((entry) => {
      const head = `- **${entry.dirName}**（${entry.ranAt || '时间未知'}）：${entry.passed}/${entry.total} 通过`;
      if (entry.failed === 0) return head;
      return [
        head,
        ...entry.failedChecks.map(
          (check) =>
            `  - ✗ ${check.name}${check.problems.length ? ` —— ${check.problems.join('；')}` : ''}`,
        ),
      ].join('\n');
    }),
  ];

  if (entries.length > shown.length) {
    lines.push('', `（还有 ${entries.length - shown.length} 份更早的练习没列出来。）`);
  }
  if (withFailures.length > 0) {
    lines.push(
      '',
      '**没过的那几条就是该回去讲的东西** —— 回到对应的讲解页补讲或拆页，' +
        '不要只是把同一条练习再发一遍。',
    );
  }
  return lines.join('\n');
}
