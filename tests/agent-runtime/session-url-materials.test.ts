import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ★ 材料库里的 URL 必须喂进会话的 **URL 信任闸**（2026-10-07 修）。
 *
 * ── 由来：一条实测出来的自相矛盾 ────────────────────────────────
 * 信任闸原来只被三处喂：`web_search` 结果 / 会话初始提示词 / 每条用户消息。
 * **材料库不在其中** ⇒ agent 用 `read_materials` 读到材料文件里写着的 URL、
 * 照着 `fetch_url` 去抓，**被自己的闸拒**（`url_not_in_session`）。
 * 用户"登记资料"这个正确动作**没有生效**。
 *
 * 实测那次：材料里写着 `runoob.com` / `start.spring.io` / 4 条 `github.com`，
 * 而用户让 agent 参考的 Oracle / Spring 文档**一条都抓不到**。
 *
 * 这一组钉三件事：**材料 URL 进来了** · **提示词那条没被弄坏** ·
 * **材料这一段失败时不拖垮建会话**（而提示词那一段失败**仍然要中止**）。
 */

const PREV = process.env.OPENMAIC_MATERIALS_DIR;

afterEach(() => {
  if (PREV === undefined) delete process.env.OPENMAIC_MATERIALS_DIR;
  else process.env.OPENMAIC_MATERIALS_DIR = PREV;
  vi.resetModules();
});

/** `materialsDir` 是**模块加载时**求值的（config.ts 读 process.env）⇒ 必须重置模块再导入。 */
async function loadStore(dir: string | undefined) {
  if (dir === undefined) delete process.env.OPENMAIC_MATERIALS_DIR;
  else process.env.OPENMAIC_MATERIALS_DIR = dir;
  vi.resetModules();
  return import('@/lib/server/agent-runtime/store');
}

function materialDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'materials-trust-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  return dir;
}

/** 假 store：只记录登记了什么，以及在什么条件下该抛。 */
function fakeStore(throwWhen: (urls: string[]) => boolean) {
  const calls: Array<{ id: string; urls: string[]; source: string }> = [];
  return {
    calls,
    store: {
      registerSessionUrls: async (id: string, urls: string[], source: string) => {
        if (throwWhen(urls)) throw new Error('boom');
        calls.push({ id, urls, source });
        return urls;
      },
    },
  };
}

const META = {
  id: 'session-1',
  ownerId: 'owner-1',
  prompt: '讲 Java',
  stageId: 'stage-1',
  existingCourse: false,
  status: 'queued',
  attempt: 0,
  deliveredUserMessageSeq: 0,
  createdAt: 1,
  updatedAt: 1,
} as never;

const TX = {} as never;

const ORACLE = 'https://docs.oracle.com/javase/tutorial/java/concepts/index.html';

/**
 * ★ 超时放宽到 **30s**（照 `batch-export-real-builders.test.ts` 的成例）。
 *
 * 理由：`materialsDir` 是**模块加载时**求值的，所以每条用例都要
 * `vi.resetModules()` + 动态 `import('.../store')`。**第一次**那条要付整条依赖链
 * （persistence provider / pg / 材料库…）的代价 —— 整包并行时实测 **5.6s**，
 * 直接撞上 5s 默认超时并**伪装成断言失败**（"expected false to be true"）。
 * 单跑 0.1s。这是负载假红，不是回归。
 */
describe('★ 建会话时把材料库里的 URL 也登记进信任闸', { timeout: 30_000 }, () => {
  it('材料主题文件里写的 URL 会被登记（这是修的那条）', async () => {
    const dir = materialDirWith({
      'INDEX.md': '# 索引\n',
      'java-backend.md': `## 官方文档\n\n- Oracle 教程 ${ORACLE}\n`,
    });
    const mod = await loadStore(dir);
    const { store, calls } = fakeStore(() => false);

    await mod.registerBootstrapSessionUrls(store as never, TX, META);

    const registered = calls.flatMap((call) => call.urls);
    expect(registered.some((url) => url.includes('docs.oracle.com'))).toBe(true);
    // source 沿用 'user'：这些是**用户登记的资料**，不是 agent 自己搜出来的。
    expect(calls.every((call) => call.source === 'user')).toBe(true);
  });

  it('INDEX.md 里的 URL 也算（两个文件都要读）', async () => {
    const dir = materialDirWith({
      'INDEX.md': `- 参考 https://start.spring.io\n`,
    });
    const mod = await loadStore(dir);
    const { store, calls } = fakeStore(() => false);

    await mod.registerBootstrapSessionUrls(store as never, TX, META);

    expect(calls.flatMap((c) => c.urls).some((url) => url.includes('start.spring.io'))).toBe(true);
  });

  it('提示词那一条没被弄坏（用户当场说的 URL 仍然进闸）', async () => {
    const dir = materialDirWith({ 'INDEX.md': '# 空\n' });
    const mod = await loadStore(dir);
    const { store, calls } = fakeStore(() => false);

    await mod.registerBootstrapSessionUrls(store as never, TX, {
      ...(META as Record<string, unknown>),
      prompt: '看 https://example.com/a',
    } as never);

    expect(calls.flatMap((c) => c.urls).some((url) => url.includes('example.com'))).toBe(true);
  });

  it('★ 材料这一段登记失败【不拖垮建会话】（钩子跑在建会话那个事务里）', async () => {
    const dir = materialDirWith({ 'java-backend.md': `- ${ORACLE}\n` });
    const mod = await loadStore(dir);
    // 让"含 oracle 的那一批"抛。
    const { store } = fakeStore((urls) => urls.some((url) => url.includes('oracle')));

    await expect(
      mod.registerBootstrapSessionUrls(store as never, TX, META),
    ).resolves.toBeUndefined();
  });

  it('★ 但提示词那一段失败【仍然要抛】——别把隔离做过头', async () => {
    const dir = materialDirWith({ 'INDEX.md': '# 空\n' });
    const mod = await loadStore(dir);
    // 第一批（提示词）就抛。
    const { store } = fakeStore((urls) => urls.length > 0);

    await expect(
      mod.registerBootstrapSessionUrls(store as never, TX, {
        ...(META as Record<string, unknown>),
        prompt: '看 https://example.com/a',
      } as never),
    ).rejects.toThrow();
  });

  it('材料目录没配 ⇒ 安静地只登记提示词（不抛）', async () => {
    const mod = await loadStore(undefined);
    const { store, calls } = fakeStore(() => false);

    await mod.registerBootstrapSessionUrls(store as never, TX, META);

    expect(calls).toHaveLength(1);
  });
});
