import { describe, expect, it } from 'vitest';

import {
  addScratchItem,
  claimsNeedingSecondSource,
  classifyScratchItem,
  emptyScratchpad,
  formatScratchId,
  formatScratchIndex,
  formatScratchReminder,
  markScratchPromoted,
  normalizeScratchpad,
  openScratchItems,
  pruneScratchpad,
  scratchConflicts,
  searchScratchItems,
  SCRATCH_TEXT_LIMIT,
  type Scratchpad,
} from '@/lib/scratch/scratchpad';

const T0 = 1_700_000_000_000;

function write(
  pad: Scratchpad,
  input: { kind?: 'source' | 'claim' | 'todo' | 'note'; text: string; createdAt?: number; [key: string]: unknown },
) {
  return addScratchItem(pad, {
    kind: 'note',
    createdAt: T0,
    ...input,
  } as Parameters<typeof addScratchItem>[1]);
}

describe('编号', () => {
  it('assigns short sequential ids and returns the new id', () => {
    const first = write(emptyScratchpad(), { text: '第一条' });
    expect(first.item.id).toBe('s001');
    const second = write(first.pad, { text: '第二条' });
    expect(second.item.id).toBe('s002');
  });

  it('★ never reuses an id after an item is dropped', () => {
    // 号复用是最糟的失败：agent 手里的 "s003" 会指到别的东西上。
    let pad = emptyScratchpad();
    pad = write(pad, { text: 'a' }).pad;
    pad = write(pad, { text: 'b' }).pad;
    const third = write(pad, { text: 'c' });
    pad = classifyScratchItem(third.pad, 's003', 'dropped');
    const fourth = write(pad, { text: 'd' });
    expect(fourth.item.id).toBe('s004');
  });

  it('pads to three digits and grows instead of truncating', () => {
    expect(formatScratchId(1)).toBe('s001');
    expect(formatScratchId(999)).toBe('s999');
    expect(formatScratchId(1000)).toBe('s1000');
  });

  it('normalize keeps nextSeq ahead of every existing id', () => {
    // 手写的/被截断的文件不能让下一个号撞上旧号。
    const pad = normalizeScratchpad({
      items: [{ id: 's042', text: 'x', kind: 'note', status: 'open', createdAt: T0 }],
    });
    expect(pad.nextSeq).toBe(43);
    expect(normalizeScratchpad(null).items).toEqual([]);
    expect(normalizeScratchpad({ items: [null, 7, { text: '没有号' }] }).items).toEqual([]);
  });

  it('normalize repairs unknown kinds/statuses instead of throwing', () => {
    const pad = normalizeScratchpad({
      items: [{ id: 's001', text: 'x', kind: '???', status: '???', createdAt: 'nope' }],
    });
    expect(pad.items[0]?.kind).toBe('note');
    expect(pad.items[0]?.status).toBe('open');
    expect(pad.items[0]?.createdAt).toBe(0);
  });
});

describe('写入', () => {
  it('strips markup and truncates long text (the index has to stay small)', () => {
    const withHtml = write(emptyScratchpad(), { text: '<p style="font-size:16px">真话</p>' });
    expect(withHtml.item.text).toBe('真话');
    expect(withHtml.item.text).not.toContain('font-size');

    const long = write(emptyScratchpad(), { text: '啊'.repeat(500) });
    expect(long.item.text.length).toBe(SCRATCH_TEXT_LIMIT);
    expect(long.item.text.endsWith('…')).toBe(true);
  });

  it('keeps source metadata and de-duplicates the sources list', () => {
    const result = write(emptyScratchpad(), {
      kind: 'claim',
      text: '封装把数据藏起来',
      sources: ['s001', 's001', 's002'],
    });
    expect(result.item.sources).toEqual(['s001', 's002']);
    expect(result.item.status).toBe('open');
  });
});

describe('★ 可算的"不断求证"读数', () => {
  it('finds claims with fewer than two sources — that is the whole point', () => {
    let pad = emptyScratchpad();
    pad = write(pad, { kind: 'claim', text: '只有一个来源的说法', sources: ['s001'] }).pad;
    pad = write(pad, { kind: 'claim', text: '两个来源的说法', sources: ['s001', 's002'] }).pad;
    pad = write(pad, { kind: 'claim', text: '一个来源都没有的说法' }).pad;

    const need = claimsNeedingSecondSource(pad);
    expect(need.map((item) => item.text)).toEqual(['只有一个来源的说法', '一个来源都没有的说法']);
  });

  it('does not nag about a claim that was already dropped', () => {
    let pad = write(emptyScratchpad(), { kind: 'claim', text: '算了吧', sources: ['s001'] }).pad;
    pad = classifyScratchItem(pad, 's001', 'dropped');
    expect(claimsNeedingSecondSource(pad)).toEqual([]);
  });

  it('counts what is still unclassified — that is the "owed judgement"', () => {
    let pad = emptyScratchpad();
    pad = write(pad, { text: 'a' }).pad;
    pad = write(pad, { text: 'b' }).pad;
    pad = write(pad, { text: 'c' }).pad;
    pad = classifyScratchItem(pad, 's001', 'kept');
    expect(openScratchItems(pad).map((item) => item.id)).toEqual(['s002', 's003']);
  });

  it('surfaces contradictions instead of letting them be digested silently', () => {
    let pad = write(emptyScratchpad(), { kind: 'claim', text: '说法 A', sources: ['s001', 's002'] }).pad;
    pad = write(pad, { kind: 'claim', text: '与 A 冲突', conflictWith: 's001', sources: ['s003', 's004'] }).pad;
    expect(scratchConflicts(pad).map((item) => item.id)).toEqual(['s002']);
  });
});

describe('归类与升级', () => {
  it('classify flips status, promote records the material pointer', () => {
    let pad = write(emptyScratchpad(), { text: '值得留' }).pad;
    pad = classifyScratchItem(pad, 's001', 'kept');
    expect(pad.items[0]?.status).toBe('kept');

    pad = markScratchPromoted(pad, 's001', 'mat_abc123');
    expect(pad.items[0]?.status).toBe('promoted');
    expect(pad.items[0]?.promotedTo).toBe('mat_abc123');
    expect(openScratchItems(pad)).toEqual([]);
  });
});

describe('索引', () => {
  it('renders two sections and marks what needs attention', () => {
    let pad = emptyScratchpad();
    pad = write(pad, { kind: 'source', text: '某篇讲封装', source: 'https://x', depth: 'deep', createdAt: T0 }).pad;
    pad = write(pad, { kind: 'claim', text: '封装把数据藏起来', sources: ['s001'], createdAt: T0 + 1 }).pad;
    pad = write(pad, { kind: 'claim', text: '冲突的说法', conflictWith: 's002', sources: ['s001', 's003'], createdAt: T0 + 2 }).pad;
    // 升级**备用条目**，不是来源条目 —— 否则来源条目离开临时段，就钉不住"精读"标记。
    pad = write(pad, { kind: 'note', text: '值得进材料库的', createdAt: T0 + 3 }).pad;
    pad = markScratchPromoted(pad, 's004', 'mat_zzz');

    const index = formatScratchIndex(pad);
    expect(index).toContain('== 草稿纸');
    expect(index).toContain('== 已进材料库');
    expect(index).toContain('s001');
    expect(index).toContain('mat_zzz');
    expect(index).toContain('与 s002 矛盾');
    expect(index).toContain('只有 1 个来源');
    expect(index).toContain('精读');
  });

  it('shows only the most recent scratch items and says how many were hidden', () => {
    let pad = emptyScratchpad();
    for (let index = 0; index < 5; index += 1) {
      pad = write(pad, { text: `第 ${index} 条`, createdAt: T0 + index }).pad;
    }
    const index = formatScratchIndex(pad, { recentLimit: 2 });
    expect(index).toContain('第 4 条');
    expect(index).toContain('第 3 条');
    expect(index).not.toContain('第 0 条');
    expect(index).toContain('还有 3 条更早的');
  });

  it('says "empty" rather than rendering nothing', () => {
    expect(formatScratchIndex(emptyScratchpad())).toContain('（空）');
  });

  it('hides dropped items by default', () => {
    let pad = write(emptyScratchpad(), { text: '没用的' }).pad;
    pad = classifyScratchItem(pad, 's001', 'dropped');
    expect(formatScratchIndex(pad)).not.toContain('没用的');
    expect(formatScratchIndex(pad, { includeDropped: true })).toContain('s001');
  });
});

describe('检索', () => {
  it('matches on text, source and id', () => {
    let pad = emptyScratchpad();
    pad = write(pad, { text: 'Java 的条件语句', source: 'https://docs.oracle.com/x', createdAt: T0 }).pad;
    pad = write(pad, { text: 'Python 缩进', createdAt: T0 + 1 }).pad;

    expect(searchScratchItems(pad, 'java').map((item) => item.id)).toEqual(['s001']);
    expect(searchScratchItems(pad, 'oracle').map((item) => item.id)).toEqual(['s001']);
    expect(searchScratchItems(pad, 's002').map((item) => item.id)).toEqual(['s002']);
    expect(searchScratchItems(pad, '')).toHaveLength(2);
    // 新的排前面。
    expect(searchScratchItems(pad, '')[0]?.id).toBe('s002');
  });

  it('filters by kind and status', () => {
    let pad = emptyScratchpad();
    pad = write(pad, { kind: 'source', text: '资料', createdAt: T0 }).pad;
    pad = write(pad, { kind: 'todo', text: '要做的事', createdAt: T0 + 1 }).pad;
    expect(searchScratchItems(pad, '', { kinds: ['todo'] }).map((i) => i.id)).toEqual(['s002']);
    expect(searchScratchItems(pad, '', { statuses: ['open'] })).toHaveLength(2);
  });
});

describe('裁剪', () => {
  it('★ only prunes old dropped items — never unjudged or promoted ones', () => {
    let pad = emptyScratchpad();
    pad = write(pad, { text: '早丢的', createdAt: T0 }).pad;
    pad = write(pad, { text: '还没判断的', createdAt: T0 }).pad;
    pad = write(pad, { text: '要进材料库的', createdAt: T0 }).pad;
    pad = classifyScratchItem(pad, 's001', 'dropped');
    pad = markScratchPromoted(pad, 's003', 'mat_keep');

    const pruned = pruneScratchpad(pad, { now: T0 + 72 * 60 * 60 * 1000 });
    expect(pruned.items.map((item) => item.id)).toEqual(['s002', 's003']);
  });

  it('returns the same reference when nothing is prunable (caller can skip the write)', () => {
    const pad = write(emptyScratchpad(), { text: 'x', createdAt: T0 }).pad;
    expect(pruneScratchpad(pad, { now: T0 })).toBe(pad);
  });
});

describe('提醒', () => {
  it('stays silent when nothing is owed', () => {
    // ★ 注意：一条"有 2 个来源"的 claim 只要还 open，就**仍然**是欠的判断题 ——
    //   所以"沉默"的前提是它已经被归类。第一版测试漏了这一步（断言错了）。
    let pad = write(emptyScratchpad(), { kind: 'claim', text: '有据可查', sources: ['s001', 's002'] }).pad;
    expect(formatScratchReminder(pad)).toContain('还没归类');
    pad = classifyScratchItem(pad, 's001', 'kept');
    expect(formatScratchReminder(pad)).toBe('');
    expect(formatScratchReminder(emptyScratchpad())).toBe('');
  });

  it('names the counts of unclassified / conflicting / single-source items', () => {
    let pad = emptyScratchpad();
    pad = write(pad, { kind: 'claim', text: '一个来源', sources: ['s001'] }).pad;
    pad = write(pad, { kind: 'claim', text: '矛盾', conflictWith: 's001', sources: ['s002', 's003'] }).pad;
    const reminder = formatScratchReminder(pad);
    expect(reminder).toContain('还没归类');
    expect(reminder).toContain('矛盾没处理');
    expect(reminder).toContain('只有 1 个来源');
    expect(reminder).toContain('再找一个来源');
  });
});
