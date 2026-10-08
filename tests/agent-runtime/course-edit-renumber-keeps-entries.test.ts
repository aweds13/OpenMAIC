import { describe, expect, it } from 'vitest';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { renumberCourseOrders } from '@/lib/server/agent-runtime/course-edit/tools';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

/**
 * ★ `renumberCourseOrders` 在 **reorder** 时不许丢掉对不上页面的计划条目。
 *
 * ── 由来（2026-10-07 实测数据丢失）──────────────────────────────
 * 这个函数被两个语义完全不同的 op 调用：
 * · **`delete`** —— 对不上页面的条目**本来就该消失**（有既有判据钉着，别动）；
 * · **`reorder`** —— 对不上的条目**绝不能丢**，它代表"计划里有、页面还没做"。
 *
 * 原来没有参数、**两条路都丢** ⇒ 实测：agent 补进 9 条、同时丢掉 9 条
 * （`stage-GYvpbYB_aN` 始终 50 条），于是把这理解成"**计划容量只有 50 条**"，
 * 并据此给学习者做了规划。**不是容量，是这条路在删。**
 *
 * ★ 我第一次"修"这里时没区分调用方、直接保留全部，被 delete 那条判据挡下，
 *   于是整个撤回 —— **撤回是错的**：该修的是让调用方表态。
 */

function scene(id: string, order: number): Scene {
  return { id, order, title: id, type: 'slide', stageId: 's' } as Scene;
}

function outline(): AppDocumentOutline {
  return {
    outlines: [
      { id: 'a', order: 1, title: 'A', type: 'slide', description: 'a' },
      { id: 'b', order: 2, title: 'B', type: 'slide', description: 'b' },
      { id: 'orphan', order: 9, title: '计划里有、页面还没做', type: 'slide', description: 'z' },
    ] as SceneOutline[],
    requirement: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as AppDocumentOutline;
}

const SCENES = [scene('a', 1), scene('b', 2)];

describe('★ renumberCourseOrders：delete 丢、reorder 不丢', () => {
  it('★ reorder（dropUnmatched: false）⇒ 对不上的条目**保留**', () => {
    const next = renumberCourseOrders(SCENES, outline(), { dropUnmatched: false });
    const ids = (next.outline?.outlines ?? []).map((entry) => entry.id);
    expect(ids).toContain('orphan');
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('★ delete（默认）⇒ 对不上的条目**照旧丢弃**（既有语义别弄坏）', () => {
    const next = renumberCourseOrders(SCENES, outline());
    const ids = (next.outline?.outlines ?? []).map((entry) => entry.id);
    expect(ids).not.toContain('orphan');
    expect(ids).toEqual(['a', 'b']);
  });
});
