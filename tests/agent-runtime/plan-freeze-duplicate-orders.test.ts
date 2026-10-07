import { describe, expect, it } from 'vitest';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { upsertOutlineEntry } from '@/lib/server/agent-runtime/course-outline-write';
import { buildPlanFreezeTool } from '@/lib/server/agent-runtime/plan-freeze-tools';
import type { SceneOutline } from '@/lib/types/generation';

/**
 * ★ 计划里的**重复 order** —— "每补一条就挤掉一条，是等量交换"的真凶。
 *
 * ── 由来（2026-10-07 实测）──────────────────────────────────────
 * `upsertOutlineEntry` 用 `findIndex` 找**第一条**同 order 的条目来替换。
 * 如果计划里已经有**两条 order 相同的条目**，第二条**永远碰不到**：
 * 每次写都在换第一条 ⇒ **总数永远不变**。
 *
 * agent 观察到的正是「每补一条就挤掉一条，是等量交换」，于是它把计划当成
 * **容量卡住了**（51 条 / 56 页，另有一条 order 15 重复），不再尝试补满。
 * **真凶是重复条目，不是容量。**
 *
 * 钉两件事：**写的时候顺手去重** · **`status` 把缺号与重号直接报出来**
 * （缺号和重号都是可算的，不该让模型去猜）。
 */

function outlineWith(entries: Array<[number, string]>): AppDocumentOutline {
  return {
    outlines: entries.map(([order, title]) => ({
      id: `p${order}`,
      order,
      title,
      type: 'slide',
      description: `brief ${order}`,
    })) as SceneOutline[],
    requirement: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as AppDocumentOutline;
}

describe('★ 重复 order 会让"补一条挤掉一条"（等量交换）', () => {
  it('写一个已有两份条目的 order ⇒ 去重成一份，总数真的变了', () => {
    const before = outlineWith([
      [14, 'a'],
      [15, 'b'],
      [15, 'b 的另一份'],
      [16, 'c'],
    ]);
    expect(before.outlines).toHaveLength(4);

    const result = upsertOutlineEntry(before, {
      id: 'p15',
      order: 15,
      title: 'b',
      type: 'slide',
      description: 'brief 15',
    } as SceneOutline);

    const after = result.outline?.outlines ?? [];
    // 去重：只剩一份 15。
    expect(after.filter((entry) => entry.order === 15)).toHaveLength(1);
    expect(after).toHaveLength(3);
    expect(after.map((entry) => entry.order)).toEqual([14, 15, 16]);
  });

  it('没有重复时行为不变（别把正常写计划弄坏）', () => {
    const before = outlineWith([
      [14, 'a'],
      [16, 'c'],
    ]);
    const result = upsertOutlineEntry(before, {
      id: 'p15',
      order: 15,
      title: 'b',
      type: 'slide',
      description: 'brief 15',
    } as SceneOutline);

    expect((result.outline?.outlines ?? []).map((entry) => entry.order)).toEqual([14, 15, 16]);
  });
});

describe('★ plan_freeze status 报出缺号与重号', () => {
  it('缺号与重号都出现在状态里', async () => {
    const outline = outlineWith([
      [1, 'a'],
      [2, 'b'],
      [2, 'b 重复'],
      [5, 'e'],
    ]);
    const tool = buildPlanFreezeTool({
      loadOutline: async () => outline,
      loadPages: async () => [],
      saveOutline: async () => true,
    });
    const result = (await (
      tool as unknown as { execute(id: string, params: unknown): Promise<unknown> }
    ).execute('c', { stageId: 's', action: 'status' })) as {
      content: Array<{ text?: string }>;
    };
    const text = result.content.map((part) => part.text ?? '').join('\n');

    expect(text).toContain('order 重复');
    expect(text).toContain('2');
    expect(text).toContain('缺条目');
    // 1..5 里缺 3、4（order 2 重复，5 存在）。
    expect(text).toContain('3, 4');
  });
});
