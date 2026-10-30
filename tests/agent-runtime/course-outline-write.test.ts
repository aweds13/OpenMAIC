import { describe, expect, it } from 'vitest';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { upsertOutlineEntry } from '@/lib/server/agent-runtime/course-outline-write';
import type { SceneOutline } from '@/lib/types/generation';

function outline(entries: SceneOutline[]): AppDocumentOutline {
  return {
    outlines: entries,
    requirement: 'Day 1',
    generationComplete: true,
    producer: 'server-job',
    createdAt: 1,
    updatedAt: 1,
  } as AppDocumentOutline;
}

function entry(init: Partial<SceneOutline> & { id: string; order: number }): SceneOutline {
  return {
    title: `第 ${init.order} 页`,
    type: 'slide',
    description: `brief ${init.order}`,
    ...init,
  } as SceneOutline;
}

describe('upsertOutlineEntry', () => {
  it('appends the first page into an empty plan (the agent-minted stage case)', () => {
    const result = upsertOutlineEntry(outline([]), entry({ id: 'p1', order: 1 }));
    expect(result.changed).toBe(true);
    expect(result.outline?.outlines).toHaveLength(1);
    expect(result.outline?.outlines[0]?.description).toBe('brief 1');
    // 信封的其它字段必须原样保留 —— 它们不是我们该动的。
    expect(result.outline?.requirement).toBe('Day 1');
    expect(result.outline?.generationComplete).toBe(true);
    expect(result.outline?.producer).toBe('server-job');
  });

  it('does not invent an envelope when there is none', () => {
    // 没有信封时什么都不做：行为与今天一致（brief 仍不落盘），而不是落一半。
    expect(upsertOutlineEntry(undefined, entry({ id: 'p1', order: 1 }))).toEqual({
      outline: undefined,
      changed: false,
    });
  });

  it('replaces by outlineId and keeps its position (regeneration)', () => {
    const before = outline([
      entry({ id: 'p1', order: 1, description: '旧的一页' }),
      entry({ id: 'p2', order: 2 }),
    ]);
    const result = upsertOutlineEntry(
      before,
      entry({ id: 'p1', order: 1, description: '重生成后的' }),
    );

    expect(result.changed).toBe(true);
    expect(result.outline?.outlines).toHaveLength(2);
    expect(result.outline?.outlines[0]?.description).toBe('重生成后的');
    // 身份匹配优先于 order：不能因为 order 相同就换到别的位置上去。
    expect(result.outline?.outlines[1]?.id).toBe('p2');
  });

  it('falls back to the page order when the id is unknown', () => {
    const before = outline([entry({ id: 'p1', order: 1 }), entry({ id: 'p2', order: 2 })]);
    const result = upsertOutlineEntry(
      before,
      entry({ id: 'brand-new', order: 2, description: '覆盖第 2 页' }),
    );

    expect(result.changed).toBe(true);
    expect(result.outline?.outlines).toHaveLength(2);
    expect(result.outline?.outlines[1]?.description).toBe('覆盖第 2 页');
    expect(result.outline?.outlines[1]?.id).toBe('brand-new');
  });

  it('appends and re-sorts when neither identity nor order matches', () => {
    const before = outline([entry({ id: 'p3', order: 3 })]);
    const result = upsertOutlineEntry(before, entry({ id: 'p1', order: 1 }));
    expect(result.outline?.outlines.map((item) => item.order)).toEqual([1, 3]);
  });

  it('reports no change (and returns the SAME reference) for an identical entry', () => {
    // 调用方靠这个标志跳过整篇 saveDocument —— 重生成一页但内容一字未改时不该写库。
    const page = entry({ id: 'p1', order: 1 });
    const before = outline([page]);
    const result = upsertOutlineEntry(before, entry({ id: 'p1', order: 1 }));

    expect(result.changed).toBe(false);
    expect(result.outline).toBe(before);
  });

  it('notices a change in each field we own', () => {
    const base = entry({ id: 'p1', order: 1 });
    const before = outline([base]);
    const variants: Partial<SceneOutline>[] = [
      { title: '换了标题' },
      { type: 'quiz' },
      { description: '换了 brief' },
      { keyPoints: ['材料事实'] },
      { widgetType: 'simulation' },
      { quizConfig: { questionCount: 6 } as SceneOutline['quizConfig'] },
    ];
    for (const variant of variants) {
      const result = upsertOutlineEntry(before, { ...base, ...variant } as SceneOutline);
      expect(result.changed, `variant ${JSON.stringify(variant)} should change`).toBe(true);
    }
  });

  it('tolerates an envelope whose outlines field is missing', () => {
    const noEntries = { requirement: 'x' } as unknown as AppDocumentOutline;
    const result = upsertOutlineEntry(noEntries, entry({ id: 'p1', order: 1 }));
    expect(result.changed).toBe(true);
    expect(result.outline?.outlines).toHaveLength(1);
  });
});
