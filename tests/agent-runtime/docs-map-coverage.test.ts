import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * 上游自己带来的文件（`origin/main` 树里的路径）。
 *
 * ★ 2026-10-17 合并上游 1.2.0-rc.1 之后补的：`57fbcc4..HEAD` 里现在也包含上游那
 * 80 个提交带来的 1451 个文件，而它们**不是本 fork 的新增**。判据的本意（本文件
 * 头部）是"本 fork 独有的文件"，所以按 `origin/main` 逐路径剔除。
 *
 * 口径**没有放宽**：fork 自己碰过的每个新增文件、每个顶层条目，仍然逐个要求进地图
 * （剔除集合来自上游的树，不是来自本判据的结论）；git 不可用时返回 `null`，
 * 调用方退回"不剔除"的旧行为。
 */
function upstreamTree(): Set<string> | null {
  try {
    const out = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'lib', 'app', 'components'],
      { encoding: 'utf8' },
    );
    return new Set(
      out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  } catch {
    return null;
  }
}

/** 上游自己改过的路径（`57fbcc4..origin/main`）。理由同 `upstreamTree()`。 */
function upstreamChanged(): Set<string> | null {
  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.quotepath=false', 'diff', '--name-only', `${BASELINE}..origin/main`],
      { encoding: 'utf8' },
    );
    return new Set(
      out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  } catch {
    return null;
  }
}

/** 取"基线以来新增的源码文件"。git 不可用 / 基线不在时返回 `null`（跳过而不是误报）。 */
function forkAddedSources(): string[] | null {
  try {
    const out = execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        '--diff-filter=A',
        `${BASELINE}..HEAD`,
        '--',
        'lib',
        'app',
        'components',
      ],
      { encoding: 'utf8' },
    );
    const upstream = upstreamTree();
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes('.test.'))
      .filter((line) => !upstream?.has(line));
  } catch {
    return null;
  }
}

describe('★ AGENTS.md 文件地图与现实对账', () => {
  it('地图里提到的每个源码路径都真的存在（没有悬空条目）', () => {
    // 跳过通配（`packages/@openmaic/**`）、依赖与运行期数据。
    // ★ `tests/` 与 `scripts/` 也要查：文档里那些「回归 pin」正是**测试文件路径**
    //   （"改这个模块时先看这两条"）—— 文件名一改，文档就把人指向不存在的文件。
    //   这个洞是第 23 轮发现的：原来只匹配 `lib|app|components`。
    const paths = [
      ...AGENTS.matchAll(/`((?:lib|app|components|tests|scripts)\/[\w.\/-]+\.(?:ts|tsx|mjs|js))`/g),
    ].map((m) => m[1]!);
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
    expect(missing, `这些是本 fork 新增的文件，但没写进 §2 地图：\n${missing.join('\n')}`).toEqual(
      [],
    );
  });
});

/**
 * ★ 文档里点名的**符号**必须真的还在。
 *
 * ── 来历（实测抓到过真的）──────────────────────────────────────
 * 2026-10-07：手册 §6.3 写着 **`RUNNING_MAP`**，而那个符号**在代码里根本不存在**
 * （真实的闸是 `ctx.running.size < config.maxConcurrent`）。照着它去搜会一无所获 ——
 * 而这一节正是"坑"清单，**教错比不教更糟**。同一天 §1.1 也是同类（教人去手改一个
 * 已经是派生的允许表）。
 *
 * 判据：`AGENTS.md` 里 `` `name()` `` 与 `` `UPPER_SNAKE` `` 形状的引用，
 * 必须在**源码或测试**里找得到。带 `Xxx` 的是占位模式（`resolveXxxCapability()`），跳过。
 */
describe('★ AGENTS.md 里点名的符号还在', () => {
  const CORPUS_DIRS = ['lib', 'app', 'components', 'tests', 'scripts'];

  function sourceBlob(): string {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(join(process.cwd(), dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          walk(rel);
        } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
          out.push(readFileSync(join(process.cwd(), rel), 'utf8'));
        }
      }
    };
    for (const dir of CORPUS_DIRS) walk(dir);
    return out.join('\n');
  }

  it('每个被点名的函数与常量都还能在源码里找到', () => {
    const blob = sourceBlob();
    expect(blob.length, '语料是空的 —— 目录名写错了').toBeGreaterThan(100_000);

    const calls = [
      ...new Set([...AGENTS.matchAll(/`([a-zA-Z_][A-Za-z0-9_]*)\(\)`/g)].map((m) => m[1]!)),
    ];
    const consts = [...new Set([...AGENTS.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((m) => m[1]!))];
    expect(calls.length, '一个函数都没解析到 —— 正则或文档格式变了').toBeGreaterThan(3);

    // `resolveXxxCapability()` 是**占位模式**（告诉你要照着写一个），不是符号。
    const missingCalls = calls.filter((name) => !name.includes('Xxx') && !blob.includes(name));
    const missingConsts = consts.filter((name) => !blob.includes(name));

    expect(
      [...missingCalls.map((n) => `${n}()`), ...missingConsts],
      `AGENTS.md 点了名但源码/测试里找不到（照着它去搜会一无所获）：`,
    ).toEqual([]);
  });
});

/**
 * ★ 动过的**一级条目**必须写进手册。
 *
 * ── 来历（实测抓到过真的）──────────────────────────────────────
 * 2026-10-07：§0 写着"改动**全部在** `lib/` `app/` `tests/` 和 `skills/agent-runtime/`"，
 * 而 `git diff` 显示还动了 **`components/`（7 个文件，含 2 个新增）** 和 **`next.config.ts`**。
 * `components/` 里有 reading-page 那套与批量下载对话框 —— 新窗口读到"改动全在那四个根"
 * 就**不会去 `components/` 找**（而 §12 的表格里偏偏列着 `components/canvas/canvas-area.tsx`，
 * 文档自相矛盾）。`next.config.ts` 里那条 `allowedDevOrigins` 更是**完全没被记录**。
 *
 * 判据：基线以来动过的每个一级条目，都必须在 `AGENTS.md` 里出现过。
 * （文档自身那几个 —— `AGENTS.md` / `二开说明.md` / `复盘/` —— 跳过。）
 */
describe('★ 动过的一级条目都写在手册里', () => {
  it('每个被改动的顶层目录/文件都在 AGENTS.md 里出现过', () => {
    let roots: string[] | null = null;
    try {
      // ★ `-c core.quotepath=false` 是**必须的**：git 默认会把非 ASCII 文件名
      //   八进制转义并加引号（`"\\344\\272\\214..."`），于是 `AGENTS.md` / `复盘`
      //   这种中文路径永远匹配不上 —— 判据会报**假阳性**（第一次跑就报了 2 个）。
      const out = execFileSync(
        'git',
        ['-c', 'core.quotepath=false', 'diff', '--name-only', `${BASELINE}..HEAD`],
        { encoding: 'utf8' },
      );
      // 上游自己改过的一级条目不算本 fork 的改动（2026-10-17 合上游后加的，
      // 理由见 `upstreamTree()`；剔除的是上游的改动集合，不是判据自己的结论）。
      const upstream = upstreamChanged();
      roots = [
        ...new Set(
          out
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .filter((line) => !upstream?.has(line))
            .map((line) => line.split('/')[0]!),
        ),
      ];
    } catch {
      roots = null;
    }
    if (roots === null) {
      expect(true).toBe(true);
      return;
    }
    expect(roots.length, '一个改动都没解析到 —— 基线写错了').toBeGreaterThan(3);

    // 这几项**就是**文档自身，当然不会在正文里被"提到"。
    const selfReferential = new Set(['AGENTS.md', '二开说明.md', '复盘']);
    const missing = roots.filter((root) => !selfReferential.has(root) && !AGENTS.includes(root));
    expect(missing, `这些顶层条目被改过，但手册里没有它们 —— 新窗口不会去那里找：`).toEqual([]);
  });
});

/**
 * ★ `AGENTS.md` 不能逼近注入预算 —— 超了会**静默截断**。
 *
 * ── 为什么这条最重要 ────────────────────────────────────────────
 * 手册 §7 记着一次**实测**：本文件涨到 **65807 字节** ⇒ 被截到 **65242**，
 * 也就是说从某处开始的结论**不再进入新窗口，而读的人不知道自己少读了**。
 * 这是这份文档里唯一"会静默地少给信息"的失效模式 —— 而它**完全可预测**。
 *
 * 判据把预警线设在 **56000**（硬预算 65536 之下留 ~9.5KB），
 * 到线就红，逼你把该搬的搬去 `复盘/已结案结论.md`（那里是结论库，不参与注入）。
 */
describe('★ AGENTS.md 的注入预算', () => {
  it('显著低于 65536 字节（超了会被静默截断）', () => {
    const bytes = Buffer.byteLength(AGENTS, 'utf8');
    expect(bytes, '文件大小解析异常').toBeGreaterThan(1000);
    expect(
      bytes,
      `AGENTS.md 已 ${bytes} 字节，逼近 65536 的注入硬预算。` +
        '超了会被**静默截断**（§7 有实测：65807 → 65242），从某处开始的结论不再进入新窗口。' +
        '请把变更不频繁的段落搬到 `复盘/已结案结论.md`，本文件只留规则与指针。',
    ).toBeLessThan(56_000);
  });
});

/**
 * ★ 表格列数一致性（2026-10-07 加）。
 *
 * 起因：我往 §2 的一行里追了一格，那一行就变成 **4 列**、而表头是 3 列 ——
 * 渲染出来多一个空格子，**而当时所有判据都是绿的**（它们只查路径 / 符号 / 一级条目）。
 * 文档的**结构**坏掉时，没有东西会红。这条补上。
 */
describe('★ AGENTS.md 的表格结构', () => {
  it('每个表格块里，每一行的列数都与表头一致', () => {
    // 用模块级的 AGENTS（已经读过一次）—— 别自己再 readFileSync 一遍。
    const lines = AGENTS.split(String.fromCharCode(10));
    const cells = (line: string): number =>
      line
        .trim()
        // ★ 先去掉**转义管道** `\|` —— 表格里写 `\|` 是合法写法（§6.2 那张表就用了），
        //   把它算成列分隔符是**判据比它声称的更宽**（我第一次跑就栽在这上面）。
        .split(String.fromCharCode(92) + '|')
        .join('')
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|').length;
    const problems: string[] = [];
    let header: number | null = null;
    let inTable = false;
    lines.forEach((line, index) => {
      const isRow = line.trim().startsWith('|') && line.trim().endsWith('|');
      const isSeparator = /^\s*\|[\s:|-]+\|\s*$/.test(line);
      if (!isRow) {
        inTable = false;
        header = null;
        return;
      }
      if (!inTable) {
        inTable = true;
        header = cells(line);
        return;
      }
      if (isSeparator) return;
      if (header !== null && cells(line) !== header) {
        problems.push(`第 ${index + 1} 行：${cells(line)} 列，表头是 ${header} 列`);
      }
    });
    expect(problems).toEqual([]);
  });
});
