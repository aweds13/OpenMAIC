import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ★ 文档地图与现实**双向**对账。
 *
 * ── 为什么值得一条判据 ──────────────────────────────────────────
 *
 * `AGENTS.md` §2 的定位是"**改之前先看这里，你要改的东西大概率已经有主了**"。
 * 所以它对**新窗口**来说是唯一的入口：
 * · 文件不在里面 ⇒ 新窗口**不知道它存在** ⇒ 重造一个 / 改错地方；
 * · 里面写着不存在的路径 ⇒ 新窗口照着找不到东西（手册 §11 记过一次真实事故：
 *   `AGENTS.md` 描述了一个**还没进 git** 的功能，别人 checkout 会看到指向不存在文件的文档）。
 *
 * 两个方向都是**静默**的：没有任何东西会报错。
 *
 * ── 为什么用 git 基线而不是手写目录清单 ─────────────────────────
 *
 * 本文件第一版只扫 `lib/practice` + `lib/scratch` 两个目录 —— 那**又是一份手写的镜像**
 * （同一个形状本轮已经在别处抓到三次）。改成从 git 推：**基线 `57fbcc4` 以来新增的
 * 源码文件**就是"本 fork 独有的文件"，这个集合不需要人手维护。
 */
const AGENTS = readFileSync(join(process.cwd(), 'AGENTS.md'), 'utf8');

/** 本 fork 的基线（AGENTS.md §0 记的就是它）。 */
const BASELINE = '57fbcc4';

/** 取"基线以来新增的源码文件"。git 不可用 / 基线不在时返回 `null`（跳过而不是误报）。 */
function forkAddedSources(): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=A', `${BASELINE}..HEAD`, '--', 'lib', 'app', 'components'],
      { encoding: 'utf8' },
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes('.test.'));
  } catch {
    return null;
  }
}

describe('★ AGENTS.md 文件地图与现实对账', () => {
  it('地图里提到的每个源码路径都真的存在（没有悬空条目）', () => {
    // 只查源码树；跳过通配（`packages/@openmaic/**`）、依赖与运行期数据。
    const paths = [...AGENTS.matchAll(/`((?:lib|app|components)\/[\w./-]+\.tsx?)`/g)].map((m) => m[1]!);
    const unique = [...new Set(paths)];
    expect(unique.length, '一个源码路径都没解析到 —— 正则或文档格式变了').toBeGreaterThan(20);

    const missing = unique.filter((path) => !existsSync(join(process.cwd(), path)));
    expect(missing, `AGENTS.md 里提到但这些文件不存在：\n${missing.join('\n')}`).toEqual([]);
  });

  it('★ 基线以来新增的每个源码文件都进了地图（推导版，无需手写清单）', () => {
    const added = forkAddedSources();
    if (added === null) {
      // 没有 git / 基线不在（例如导出的压缩包）—— 跳过，不要误报。
      expect(true).toBe(true);
      return;
    }
    expect(added.length, '一个新增文件都没解析到 —— 基线或路径过滤写错了').toBeGreaterThan(20);

    const missing = added.filter((path) => !AGENTS.includes(path.split('/').at(-1)!));
    expect(missing, `这些是本 fork 新增的文件，但没写进 §2 地图：\n${missing.join('\n')}`).toEqual([]);
  });
});
