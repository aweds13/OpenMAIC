import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ★ 文档地图与现实**双向**对账。
 *
 * ── 为什么值得一条判据 ──────────────────────────────────────────
 *
 * `AGENTS.md` 的定位是"**改之前先看这里，你要改的东西大概率已经有主了**"。
 * 所以它对**新窗口**来说是唯一的入口：
 * · 文件不在里面 ⇒ 新窗口**不知道它存在** ⇒ 重造一个 / 改错地方；
 * · 里面写着不存在的路径 ⇒ 新窗口照着找不到东西（手册 §11 记过一次真实事故：
 *   `AGENTS.md` 描述了一个**还没进 git** 的功能，别人 checkout 会看到指向不存在文件的文档）。
 *
 * 两个方向都是**静默**的：没有任何东西会报错。所以这里各钉一条。
 */
const AGENTS = readFileSync(join(process.cwd(), 'AGENTS.md'), 'utf8');

describe('★ AGENTS.md 文件地图与现实对账', () => {
  it('地图里提到的每个源码路径都真的存在（没有悬空条目）', () => {
    // 只查源码树；跳过通配（`packages/@openmaic/**`）、依赖与运行期数据。
    const paths = [...AGENTS.matchAll(/`((?:lib|app|components)\/[\w./-]+\.tsx?)`/g)].map((m) => m[1]!);
    const unique = [...new Set(paths)];
    expect(unique.length, '一个源码路径都没解析到 —— 正则或文档格式变了').toBeGreaterThan(20);

    const missing = unique.filter((path) => !existsSync(join(process.cwd(), path)));
    expect(missing, `AGENTS.md 里提到但这些文件不存在：\n${missing.join('\n')}`).toEqual([]);
  });

  it('本 fork 新建目录下的每个模块都进了地图（没有"存在但没人知道"的文件）', () => {
    // 只扫**整块属于本 fork** 的目录 —— 那不需要任何手写清单，
    // 而 agent-runtime 下混着上游文件，用通配会误报。
    const forkDirs = ['lib/practice', 'lib/scratch'];
    const missing: string[] = [];
    for (const dir of forkDirs) {
      for (const name of readdirSync(join(process.cwd(), dir))) {
        if (!name.endsWith('.ts')) continue;
        if (!AGENTS.includes(name)) missing.push(`${dir}/${name}`);
      }
    }
    expect(missing, `这些文件没写进 §2 地图：\n${missing.join('\n')}`).toEqual([]);
  });
});
