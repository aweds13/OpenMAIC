import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildScratchTool,
  readScratchpad,
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

  it('★ promote refuses without a materialId, and points at the library rule', async () => {
    await call({ action: 'write', text: '要进材料库的' });
    const refused = await call({ action: 'promote', id: 's001' });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(textOf(refused)).toContain('只收用户确认要用的');
    expect(textOf(refused)).toContain('留在草稿纸上');
  });

  it('promote records the pointer once the id is given', async () => {
    await call({ action: 'write', text: '要进材料库的' });
    const done = await call({ action: 'promote', id: 's001', materialId: 'mat_abc' });
    expect(textOf(done)).toContain('已进材料库');
    expect(textOf(done)).toContain('mat_abc');
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
