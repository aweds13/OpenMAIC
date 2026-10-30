import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { buildPlanFreezeTool } from '@/lib/server/agent-runtime/plan-freeze-tools';
import type { SceneOutline } from '@/lib/types/generation';

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content
    .map((part) => part.text ?? '')
    .join('\n');
}

interface Harness {
  outline: AppDocumentOutline | undefined;
  pages: { order: number; title: string; type: string }[] | null;
  saved: AppDocumentOutline[];
  tool: ReturnType<typeof buildPlanFreezeTool>;
}

function harness(init: {
  outline?: AppDocumentOutline;
  pages?: { order: number; title: string; type: string }[] | null;
}): Harness {
  const h: Harness = {
    outline: init.outline,
    pages: init.pages === undefined ? [] : init.pages,
    saved: [],
    tool: undefined as never,
  };
  h.tool = buildPlanFreezeTool({
    loadOutline: async () => h.outline,
    loadPages: async () => h.pages,
    saveOutline: async (_stageId, outline) => {
      h.outline = outline;
      h.saved.push(outline);
      return true;
    },
  });
  return h;
}

function outlineWith(entries: Partial<SceneOutline>[]): AppDocumentOutline {
  return {
    outlines: entries as SceneOutline[],
    requirement: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as AppDocumentOutline;
}

function entry(order: number, title: string, description: string): Partial<SceneOutline> {
  return { id: `p${order}`, order, title, type: 'slide', description };
}

const PAGES = [
  { order: 1, title: '第一页', type: 'slide' },
  { order: 2, title: '第二页', type: 'quiz' },
  { order: 3, title: '第三页', type: 'slide' },
];

describe('plan_freeze backfill', () => {
  it('★ derives the missing entries from the pages a course already has', async () => {
    const h = harness({ outline: outlineWith([]), pages: PAGES });
    const result = await h.tool.execute('c', { stageId: 'stage-a', action: 'backfill' } as never);

    expect(h.saved).toHaveLength(1);
    expect(h.outline?.outlines?.map((item) => item.order)).toEqual([1, 2, 3]);
    expect(h.outline?.outlines?.map((item) => item.title)).toEqual(['第一页', '第二页', '第三页']);
    expect(h.outline?.outlines?.[1]?.type).toBe('quiz');
    expect(textOf(result)).toContain('补了 3 条');
  });

  it('★ never overwrites a brief that is already there (the safety property)', async () => {
    // 第 1 页有手写的 brief；第 2、3 页没有。backfill 只能补 2 和 3。
    const h = harness({
      outline: outlineWith([entry(1, '第一页', '手写的 brief，不许动')]),
      pages: PAGES,
    });
    const result = await h.tool.execute('c', { stageId: 'stage-a', action: 'backfill' } as never);

    const first = h.outline?.outlines?.find((item) => item.order === 1);
    expect(first?.description).toBe('手写的 brief，不许动');
    // "一个字没动"只出现在**真的补了东西**那一版的回话里 —— 所以断第一次的结果。
    expect(textOf(result)).toContain('原有 1 条**一个字没动**');
  });

  it('★ marks the derived brief as derived — a backfilled entry must not look like real intent', async () => {
    const h = harness({ outline: outlineWith([]), pages: PAGES });
    await h.tool.execute('c', { stageId: 'stage-a', action: 'backfill' } as never);
    for (const item of h.outline?.outlines ?? []) {
      expect(item.description).toContain('backfilled');
    }
  });

  it('says it did nothing when the plan already covers every page', async () => {
    const h = harness({
      outline: outlineWith([entry(1, 'a', 'x'), entry(2, 'b', 'y'), entry(3, 'c', 'z')]),
      pages: PAGES,
    });
    const result = await h.tool.execute('c', { stageId: 'stage-a', action: 'backfill' } as never);
    expect(h.saved).toHaveLength(0);
    expect(textOf(result)).toContain('没有补任何东西');
  });

  it('refuses loudly when there is nothing to derive from', async () => {
    const empty = harness({ outline: outlineWith([]), pages: [] });
    const noPages = await empty.tool.execute('c', {
      stageId: 'stage-a',
      action: 'backfill',
    } as never);
    expect((noPages as { isError?: boolean }).isError).toBe(true);
    expect(textOf(noPages)).toContain('没有任何已落盘的页面');

    const noEnvelope = harness({ outline: undefined, pages: PAGES });
    const noOutline = await noEnvelope.tool.execute('c', {
      stageId: 'stage-a',
      action: 'backfill',
    } as never);
    expect((noOutline as { isError?: boolean }).isError).toBe(true);
    expect(textOf(noOutline)).toContain('没有计划信封');
  });

  it('reports a failed save instead of pretending it worked', async () => {
    const h = harness({ outline: outlineWith([]), pages: PAGES });
    const failing = buildPlanFreezeTool({
      loadOutline: async () => h.outline,
      loadPages: async () => PAGES,
      saveOutline: vi.fn(async () => false),
    });
    const result = await failing.execute('c', { stageId: 'stage-a', action: 'backfill' } as never);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('没能写盘');
  });
});

describe('plan_freeze 仍有的动作没被 backfill 弄坏', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness({ outline: outlineWith([]), pages: PAGES });
  });

  it('status says it is not frozen', async () => {
    expect(
      textOf(await h.tool.execute('c', { stageId: 's', action: 'status' } as never)),
    ).toContain('未冻结');
  });

  it('add still writes entries and freeze still refuses an empty plan', async () => {
    const empty = harness({ outline: outlineWith([]), pages: PAGES });
    const refused = await empty.tool.execute('c', { stageId: 's', action: 'freeze' } as never);
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(textOf(refused)).toContain('不能冻结');
  });
});
