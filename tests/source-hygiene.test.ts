/**
 * 源码卫生：不许把不可见控制字符直接写进源文件。
 *
 * ## 这条为什么存在
 *
 * 2026-11-10 实测抓到四处：`app/api/persistence/[...path]/route.ts`、
 * `lib/learning/xq-review-client.ts`、`lib/persistence/xq-concept-graph.ts`、
 * `tests/persistence/xq-concept-graph.test.ts` —— 里面各有一到五个**真正的
 * NUL 字节**（`0x00`），本意都是写 `\u0000` 这个转义（拿它做复合键的分隔符）。
 *
 * 它们不影响运行（JS 字符串里就是那个字符，复合键照样拼得对），但有三件事
 * 会坏：
 *
 * 1. **`grep` 把整个文件当二进制**（输出 `Binary file ... matches`），
 *    于是所有基于文本的检索都用不了 —— 我自己就因为这一点多绕了两步，
 *    以为那个文件里有别的问题。
 * 2. `git diff` 默认显示 `Binary files differ`，**改了什么完全看不见**，
 *    而这是最需要被看清的文件之一（路由与图谱读侧）。
 * 3. 编辑器与某些工具会静默截断或替换它，本地与别人机器上的复合键可能
 *    对不上，且没有任何报错。
 *
 * 判据是扫字节，不是扫 AST —— 这个东西在源码的任何位置都不该出现，
 * 包括注释与字符串。
 */
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** 只扫会被 `git diff` 当文本看的那些。 */
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.json'];

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.tmp',
]);

function collectFiles(): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(ROOT, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
      } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        out.push(child);
      }
    }
  };
  walk('');
  return out;
}

describe('源码卫生', () => {
  // ★ 这条要遍历整个仓库，单跑约 3.7 秒。默认 5 秒在并行负载下会超时 ——
  //   超时不是「有 NUL」，是「还没扫完」，而假红会让人开始怀疑判据本身。
  it('源文件里没有裸 NUL 字节 —— 复合键要用转义写', () => {
    const files = collectFiles();
    // 这个断言本身也是判据：扫不到文件时这条测试会「通过」而什么都没查。
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const bytes = readFileSync(join(ROOT, file));
      const index = bytes.indexOf(0);
      if (index >= 0) {
        const line = bytes.subarray(0, index).toString('utf8').split('\n').length;
        offenders.push(`${file}:${line}`);
      }
    }

    expect(
      offenders,
      `这些文件里有裸 NUL 字节，会让 grep/diff 当二进制：${offenders.join(', ')}`,
    ).toEqual([]);
  }, 15000);
});
