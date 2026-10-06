/**
 * 材料库 —— agent 自己维护的文件夹。
 *
 * 这层的要害在**写**：材料清单是产出，不是输入。所以测试重点：
 *   1. topic 经过严格 slug 校验 —— 路径穿越在正则层面就不可能；
 *   2. append 不覆盖已有内容，replace 才覆盖；
 *   3. 索引注入会把**磁盘上真实存在**的主题补进去（模型可能忘了更新索引表，
 *      不补就会以为某个主题不存在而重复新建）；
 *   4. 读不到就整个不注入。
 *
 * 跟其它上下文文件一样：先设 env 再**动态导入**（路径是加载时求值的）。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

type MaterialsModule = typeof import('@/lib/server/agent-runtime/materials-library');

const PREV = process.env.OPENMAIC_MATERIALS_DIR;

afterEach(() => {
  if (PREV === undefined) delete process.env.OPENMAIC_MATERIALS_DIR;
  else process.env.OPENMAIC_MATERIALS_DIR = PREV;
  vi.resetModules();
});

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), 'materials-dir-'));
}

async function loadWith(dir: string | undefined): Promise<MaterialsModule> {
  if (dir === undefined) delete process.env.OPENMAIC_MATERIALS_DIR;
  else process.env.OPENMAIC_MATERIALS_DIR = dir;
  vi.resetModules();
  return import('@/lib/server/agent-runtime/materials-library');
}

/** 工具 execute 的窄类型，够用即可。 */
type AnyTool = {
  execute: (
    id: string,
    params: never,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

describe('materials library tools', () => {
  it('read_materials lists the index and the topics actually on disk', async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, 'INDEX.md'), '| 主题 | 说明 |\n|---|---|\n| dart | x |\n', 'utf8');
    writeFileSync(join(dir, 'dart-flutter.md'), '## 骨架\n', 'utf8');

    const mod = await loadWith(dir);
    const out = await (mod.buildReadMaterialsTool() as unknown as AnyTool).execute(
      'c1',
      {} as never,
    );

    expect(out.content[0].text).toContain('| dart | x |');
    expect(out.content[0].text).toContain('dart-flutter');
  });

  it('read_materials refuses a topic that escapes the folder', async () => {
    const mod = await loadWith(emptyDir());
    const tool = mod.buildReadMaterialsTool() as unknown as AnyTool;

    for (const bad of ['../secret', 'a/b', '..', 'A-B', 'x.md']) {
      const out = await tool.execute('c1', { topic: bad } as never);
      expect(out.isError, `topic ${bad} 应当被拒`).toBe(true);
      expect(out.content[0].text).toContain('Invalid topic');
    }
  });

  it('update_materials append keeps what was already there', async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, 'dart-flutter.md'), '# 原有内容\n', 'utf8');

    const mod = await loadWith(dir);
    await (mod.buildUpdateMaterialsTool() as unknown as AnyTool).execute('c1', {
      topic: 'dart-flutter',
      content: '新增一行',
      mode: 'append',
    } as never);

    const after = readFileSync(join(dir, 'dart-flutter.md'), 'utf8');
    expect(after).toContain('原有内容');
    expect(after).toContain('新增一行');
  });

  it('update_materials replace overwrites, and creates a missing topic file', async () => {
    const dir = emptyDir();
    const mod = await loadWith(dir);
    const tool = mod.buildUpdateMaterialsTool() as unknown as AnyTool;

    const created = await tool.execute('c1', {
      topic: 'java-backend',
      content: '# Java 后端\n',
      mode: 'replace',
    } as never);
    expect(created.isError).toBeFalsy();
    expect(existsSync(join(dir, 'java-backend.md'))).toBe(true);

    await tool.execute('c2', {
      topic: 'java-backend',
      content: '# 重写\n',
      mode: 'replace',
    } as never);
    expect(readFileSync(join(dir, 'java-backend.md'), 'utf8')).toBe('# 重写\n');
  });

  it('update_materials accepts INDEX as the topic', async () => {
    const dir = emptyDir();
    const mod = await loadWith(dir);
    const out = await (mod.buildUpdateMaterialsTool() as unknown as AnyTool).execute('c1', {
      topic: 'INDEX',
      content: '# 索引\n',
      mode: 'replace',
    } as never);

    expect(out.isError).toBeFalsy();
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe('# 索引\n');
  });
});

describe('resolveMaterialsIndex', () => {
  it('is null when nothing is configured', async () => {
    const mod = await loadWith(undefined);
    expect(mod.resolveMaterialsIndex()).toBeNull();
  });

  it('is null for an empty folder with no index', async () => {
    const mod = await loadWith(emptyDir());
    expect(mod.resolveMaterialsIndex()).toBeNull();
  });

  it('injects topics found on disk even when INDEX.md is missing', async () => {
    // 索引表可能没更新 —— 磁盘上的事实必须补进去，
    // 否则模型会以为该主题不存在而重复新建。
    const dir = emptyDir();
    writeFileSync(join(dir, 'rust.md'), '# Rust\n', 'utf8');

    const mod = await loadWith(dir);
    const index = mod.resolveMaterialsIndex();
    expect(index).toContain('rust');
  });
});

describe('materialsIndexPromptBlock', () => {
  it('makes the gather → ask → record order explicit', async () => {
    const mod = await loadWith(undefined);
    const block = mod.materialsIndexPromptBlock('# 索引\n');

    expect(block).toContain('## Materials library');
    // 用户的核心要求：清单是 agent 问过之后写出来的，不是用户预填的。
    expect(block).toContain('Ask before recording');
    // 找材料而不是等材料。
    expect(block).toContain('web_search');
    // 别凭书名猜内容（最容易犯的错）。
    expect(block).toContain('Do not reconstruct a material');
    // 索引本体必须在里面。
    expect(block).toContain('# 索引');
  });
});
