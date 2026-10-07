import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildScratchTool,
  readScratchpad,
  scratchPromptBlock,
  scratchpadFile,
  writeScratchpad,
} from '@/lib/server/agent-runtime/scratch-tools';
import { emptyScratchpad } from '@/lib/scratch/scratchpad';

let dir: string;
const tool = () => buildScratchTool({ ownerId: 'anon:test-owner' });

/** 工具结果里的文本。 */
function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((part) => part.text ?? '').join('\n');
}

async function call(params: Record<string, unknown>) {
  return tool().execute('call', params as never);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scratchpad-'));
  process.env.OPENMAIC_SCRATCHPAD_DIR = dir;
});

afterEach(async () => {
  delete process.env.OPENMAIC_SCRATCHPAD_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('草稿纸文件层', () => {
  it('starts empty for an owner with no file, and never throws', async () => {
    expect((await readScratchpad('nobody')).items).toEqual([]);
  });

  it('round-trips and keeps owners apart', async () => {
    await writeScratchpad('a', emptyScratchpad());
    expect(scratchpadFile('a').startsWith(dir)).toBe(true);
    expect(scratchpadFile('anon:test-owner')).toContain('anon_test-owner');
    expect(scratchpadFile('../../etc/passwd').startsWith(dir)).toBe(true);
  });

  it('repairs a corrupt file instead of throwing', async () => {
    await writeFile(scratchpadFile('broken'), '{ nope', 'utf8');
    expect((await readScratchpad('broken')).items).toEqual([]);
  });
});

describe('scratch 工具', () => {
  it('★ write returns the new id AND the whole index back (that is the notification)', async () => {
    const result = await call({ action: 'write', kind: 'source', text: '某篇讲封装', source: 'https://x', depth: 'deep' });
    const text = textOf(result);
    expect(text).toContain('s001');
    expect(text).toContain('== 草稿纸');
    expect(text).toContain('精读');
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('★ names a claim that has fewer than two sources', async () => {
    await call({ action: 'write', kind: 'source', text: '来源一', source: 'https://a' });
    const one = await call({ action: 'write', kind: 'claim', text: '封装把数据藏起来', sources: ['s001'] });
    expect(textOf(one)).toContain('只有 1 个来源');
    expect(textOf(one)).toContain('别把它写进课里');

    const two = await call({ action: 'write', kind: 'claim', text: '有了两个来源', sources: ['s001', 's002'] });
    // ★ 断言要收紧到**这一条**：索引回读里可能因为别的未归类条目而出现同一句提醒
    //   （第一版就栽在这里 —— 它断的是整段文本，被 s001 的提醒穿透了）。
    expect(textOf(two)).not.toContain('★ s003');
  });

  it('classify records the judgement', async () => {
    await call({ action: 'write', text: '一条待判断的' });
    const kept = await call({ action: 'classify', id: 's001', status: 'kept' });
    expect(textOf(kept)).toContain('留着待定');
    const dropped = await call({ action: 'classify', id: 's001', status: 'dropped' });
    expect(textOf(dropped)).toContain('已弃');
  });

  it('★ promote refuses without a topic, and explains that topics are the real unit', async () => {
    await call({ action: 'write', text: '要进材料库的' });
    // ★ 这条路的语义只在**配了材料库**时成立（没配库时 promote 直接整体拒绝，见下一组用例）。
    const refuse = (params: Record<string, unknown>) =>
      buildScratchTool({ ownerId: 'anon:test-owner', materialTopics: ['java-basics'] }).execute('c', params as never);
    const refused = await refuse({ action: 'promote', id: 's001' });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(textOf(refused)).toContain('只收用户确认要用的');
    // 不返回 id 这件事必须写清楚，否则模型会去找一个不存在的东西。
    expect(textOf(refused)).toContain('不返回任何 id');
    expect(textOf(refused)).toContain('java-basics');
  });

  it('★ refuses a topic that does not exist on disk (this WAS the silent path)', async () => {
    // 原来接受任意 materialId：编一个也会被记下、回话还说"已进材料库" —— 静默说谎。
    // 而且那个参数**任何工具都不会产生**（update_materials 不返回 id）。
    await call({ action: 'write', text: '要进材料库的' });
    const refused = await buildScratchTool({
      ownerId: 'anon:test-owner',
      materialTopics: ['java-basics'],
    }).execute('c', { action: 'promote', id: 's001', topic: '编的主题' } as never);
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(textOf(refused)).toContain('没有主题');
    expect(textOf(refused)).toContain('java-basics');
    expect(textOf(refused)).toContain('指向空气');

    // ★ 而且它**没有**被记成 promoted —— 判据要断"状态真的没变"，
    //   不能只看回话（回话可以是对的而状态已经写坏）。
    const index = await call({ action: 'index' });
    expect(textOf(index)).not.toContain('== 已进材料库');
  });

  it('★ records the pointer once a REAL topic is given', async () => {
    await call({ action: 'write', text: '要进材料库的' });
    const done = await buildScratchTool({
      ownerId: 'anon:test-owner',
      materialTopics: ['java-basics'],
    }).execute('c', { action: 'promote', id: 's001', topic: 'java-basics' } as never);
    expect(textOf(done)).toContain('已进材料库');
    expect(textOf(done)).toContain('java-basics');
    expect(textOf(done)).toContain('== 已进材料库');
  });

  it('rejects an unknown id loudly, and lists what does exist', async () => {
    await call({ action: 'write', text: '第一条' });
    const bad = await call({ action: 'classify', id: 's999', status: 'kept' });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    expect(textOf(bad)).toContain('没有 s999');
    expect(textOf(bad)).toContain('s001');
  });

  it('rejects a write with no text', async () => {
    const bad = await call({ action: 'write' });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    expect(textOf(bad)).toContain('需要 text');
  });

  it('index and search read it back', async () => {
    await call({ action: 'write', text: 'Java 的条件语句', source: 'https://docs' });
    await call({ action: 'write', text: 'Python 缩进' });
    expect(textOf(await call({ action: 'index' }))).toContain('Java 的条件语句');
    expect(textOf(await call({ action: 'search', query: 'python' }))).toContain('Python 缩进');
    expect(textOf(await call({ action: 'search', query: 'zzz' }))).toContain('没有匹配');
  });

  it('★ survives a round-trip through the file (the pad is really persisted)', async () => {
    await call({ action: 'write', text: '落盘验证' });
    const onDisk = await readScratchpad('anon:test-owner');
    expect(onDisk.items.map((item) => item.id)).toEqual(['s001']);
    expect(onDisk.nextSeq).toBe(2);
  });
});

describe('★ 能力注册：没配材料库的部署里，不许提材料库工具（§1.1）', () => {
  it('omits the materials-library tool when there is no library', async () => {
    const without = buildScratchTool({ ownerId: 'anon:test-owner', materialTopics: null });
    const description = without.description;
    // 没配材料库 ⇒ 描述里一个字都不许提 update_materials
    expect(description).not.toContain('update_materials');
    expect(description).toContain('no materials library');

    const prompt = scratchPromptBlock(false);
    expect(prompt).not.toContain('update_materials');
    expect(prompt).toContain('no materials library in this deployment');

    // promote 的拒绝消息也不许提一个不存在的工具
    await call({ action: 'write', text: '一条候选' });
    const refused = await buildScratchTool({ ownerId: 'anon:test-owner' }).execute('c', {
      action: 'promote',
      id: 's001',
    } as never);
    expect(textOf(refused)).not.toContain('update_materials');
    expect(textOf(refused)).toContain('没有配材料库');
  });

  it('names it when the library is configured', () => {
    const withLibrary = buildScratchTool({ ownerId: 'anon:test-owner', materialTopics: ['java-basics'] });
    const without = buildScratchTool({ ownerId: 'anon:test-owner', materialTopics: null });

    // `update_materials` 出现在**参数描述**里（promote 的 materialId 那一项），
    // 所以按"整份参数表序列化后查"来断 —— 与排版/嵌套层级无关。
    expect(JSON.stringify(withLibrary.parameters)).toContain('update_materials');
    expect(JSON.stringify(without.parameters)).not.toContain('update_materials');

    expect(scratchPromptBlock(true)).toContain('update_materials');
    expect(scratchPromptBlock(true)).not.toContain('no materials library');
    expect(without.description).toContain('no materials library');
  });
});
