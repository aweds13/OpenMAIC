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
 * 材料面收敛成 5 个工具后，这一层不再注册自己的工具：主题笔记走
 * `read_material` 的 `topic:<slug>` 与 `add_materials` 的 `target: 'note'`，
 * 围栏、分页与错误形状统一由 `./material-tools.ts` 给出。这里测的是它下面的
 * 两个函数 —— 它们是那两个工具唯一碰文件系统的地方。
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

describe('readMaterialTopic', () => {
  it('returns the index and the topics actually on disk', async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, 'INDEX.md'), '| topic | note |\n|---|---|\n| dart | x |\n', 'utf8');
    writeFileSync(join(dir, 'dart-flutter.md'), '## skeleton\n', 'utf8');

    const mod = await loadWith(dir);
    const note = mod.readMaterialTopic('INDEX');

    expect(note.status).toBe('ok');
    if (note.status !== 'ok') return;
    expect(note.content).toContain('| dart | x |');
    expect(note.topics).toEqual(['dart-flutter']);
    // Opaque to the model, but in the same `sha256:` shape the owner-material
    // branch uses, and stable for the same bytes.
    expect(note.revision).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(mod.readMaterialTopic('INDEX')).toMatchObject({ revision: note.revision });
  });

  it('refuses a topic that escapes the folder', async () => {
    const mod = await loadWith(emptyDir());

    for (const bad of ['../secret', 'a/b', '..', 'A-B', 'x.md']) {
      expect(mod.readMaterialTopic(bad).status, `topic ${bad} should be refused`).toBe(
        'invalid_topic',
      );
    }
  });

  it('names the topics that do exist when asked for one that does not', async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, 'rust.md'), '# Rust\n', 'utf8');
    const mod = await loadWith(dir);

    const note = mod.readMaterialTopic('dart-flutter');
    expect(note.status).toBe('not_found');
    if (note.status !== 'not_found') return;
    expect(note.topics).toEqual(['rust']);
  });

  it('says so when no folder is configured', async () => {
    const mod = await loadWith(undefined);
    expect(mod.readMaterialTopic('INDEX').status).toBe('not_configured');
  });
});

describe('writeMaterialTopic', () => {
  it('append keeps what was already there', async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, 'dart-flutter.md'), '# old body\n', 'utf8');

    const mod = await loadWith(dir);
    const written = mod.writeMaterialTopic({
      topic: 'dart-flutter',
      content: 'a new line',
      mode: 'append',
    });
    expect(written.status).toBe('ok');
    if (written.status !== 'ok') return;
    expect(written.created).toBe(false);
    expect(written.appendedChars).toBe('a new line'.length);

    const after = readFileSync(join(dir, 'dart-flutter.md'), 'utf8');
    expect(after).toContain('old body');
    expect(after).toContain('a new line');
    // The revision a write returns names the bytes it wrote, so a follow-up
    // replace can prove it is writing on top of what it read.
    expect(mod.readMaterialTopic('dart-flutter')).toMatchObject({ revision: written.revision });
  });

  it('replace overwrites, and creates a missing topic file', async () => {
    const dir = emptyDir();
    const mod = await loadWith(dir);

    const created = mod.writeMaterialTopic({
      topic: 'java-backend',
      content: '# Java backend\n',
      mode: 'replace',
    });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;
    expect(created.created).toBe(true);
    expect(existsSync(join(dir, 'java-backend.md'))).toBe(true);

    mod.writeMaterialTopic({ topic: 'java-backend', content: '# rewritten\n', mode: 'replace' });
    expect(readFileSync(join(dir, 'java-backend.md'), 'utf8')).toBe('# rewritten\n');
  });

  it('accepts INDEX as the topic', async () => {
    const dir = emptyDir();
    const mod = await loadWith(dir);
    const written = mod.writeMaterialTopic({ topic: 'INDEX', content: '# index\n', mode: 'replace' });

    expect(written.status).toBe('ok');
    expect(readFileSync(join(dir, 'INDEX.md'), 'utf8')).toBe('# index\n');
  });

  it('refuses an oversized body instead of throwing', async () => {
    const mod = await loadWith(emptyDir());
    const written = mod.writeMaterialTopic({
      topic: 'dart-flutter',
      content: 'x'.repeat(200_001),
      mode: 'replace',
    });

    expect(written).toEqual({ status: 'too_large', limit: 200_000 });
  });

  it('says so when no folder is configured', async () => {
    const mod = await loadWith(undefined);
    expect(
      mod.writeMaterialTopic({ topic: 'INDEX', content: '# index\n', mode: 'replace' }).status,
    ).toBe('not_configured');
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
    const block = mod.materialsIndexPromptBlock();

    expect(block).toContain('## Materials library');
    // 用户的核心要求：清单是 agent 问过之后写出来的，不是用户预填的。
    expect(block).toContain('Ask before recording');
    // 找材料而不是等材料。
    expect(block).toContain('web_search');
    // 别凭书名猜内容（最容易犯的错）。
    expect(block).toContain('Do not reconstruct a material');
    // ★ 索引正文**不在**系统提示词里：围栏 nonce 每轮变，进了就把它后面几块推出前缀缓存。
    // 索引由 read_material 以 topic:INDEX 从工具结果给出（围栏在 ./material-tools.ts）。
    expect(block).not.toContain('# index');
    expect(block).toContain('The index itself is not in this prompt');
  });

  it('names only tools the runtime actually registers', async () => {
    const mod = await loadWith(undefined);
    const block = mod.materialsIndexPromptBlock();

    // The three names this block may say, and none of the retired ones.
    expect(block).toContain('`read_material`');
    expect(block).toContain('`add_materials`');
    expect(block).toContain('`list_materials`');
    for (const retired of [
      'read_materials',
      'update_materials',
      'extract_material',
      'wait_for_materials',
      'search_material',
      'list_material_folders',
      'create_material_folder',
      'rename_material_folder',
      'move_materials',
      'rename_material',
    ]) {
      expect(block, `${retired} is retired`).not.toContain(retired);
    }
  });
});
