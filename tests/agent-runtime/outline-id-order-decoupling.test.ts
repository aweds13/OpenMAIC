import { describe, expect, it } from 'vitest';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { upsertOutlineEntry } from '@/lib/server/agent-runtime/course-outline-write';
import type { SceneOutline } from '@/lib/types/generation';

/**
 * ★ 过期的 `id` 不许让一次写入**偷走另一页的条目**（2026-10-07 修）。
 *
 * ── 由来：这是"计划有容量上限"的最深一层 ────────────────────────
 * `id` 是从 order 推出来的（`p${order}`），而页号被平移过 ⇒ **id 与 order 脱钩**：
 *
 *     新计划里 (12,'p5') (18,'p12') (25,'p18') (28,'p21') …  大面积错位
 *
 * 而 `upsertOutlineEntry` **先按 id 认身份** ⇒ 给 order 21 写 `id: p21` 时，
 * 它会找到那条**正坐在 order 28 上的 `p21`**、把它搬到 21 ⇒ **order 28 空掉**。
 * 于是**每次写入都在搬家**：实测 `backfill` 自称"补了 9 条、原有 50 条一个字没动"，
 * 实际 **50 → 53**（进来 9 条、被偷走 6 条），agent 把这理解成"容量只有 50 条"。
 *
 * ── 修法 ───────────────────────────────────────────────────
 * 两个调用方的 id 语义**不同**，所以**身份键由调用方选**：
 * · `generate_scene` 的 id 是真身份 ⇒ 默认 `matchBy: 'id'`（不变）；
 * · `plan_freeze` / `backfill` 的 id 从 order 推 ⇒ `matchBy: 'order'`（**只认页号**）。
 *   存量那些错位 id 因此**无害**，不需要数据迁移。
 */

function outlineWith(entries: Array<{ id: string; order: number; title: string }>) {
  return {
    outlines: entries.map((entry) => ({
      ...entry,
      type: 'slide',
      description: `brief ${entry.order}`,
    })) as SceneOutline[],
    requirement: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as AppDocumentOutline;
}

/** 典型的错位状态：`p28` 坐在 21 上，`p21` 坐在 28 上。 */
const SWAPPED = [
  { id: 'p28', order: 21, title: '甲' },
  { id: 'p21', order: 28, title: '乙' },
];

describe('★ 身份键由调用方选：过期的 id 不许偷别人的条目', () => {
  it('★ matchBy: "order" ⇒ 写 order 28 只动 order 28，order 21 的条目纹丝不动', () => {
    const result = upsertOutlineEntry(
      outlineWith(SWAPPED),
      { id: 'p28', order: 28, title: '乙改', type: 'slide', description: '新 brief' } as SceneOutline,
      { matchBy: 'order' },
    );
    const after = result.outline?.outlines ?? [];

    // order 21 上那条**还在**（这正是原来会被偷走的那条）。
    expect(after.find((entry) => entry.order === 21)?.title).toBe('甲');
    // order 28 被更新。
    expect(after.find((entry) => entry.order === 28)?.title).toBe('乙改');
    // 条数不变：更新，不是搬家。
    expect(after).toHaveLength(2);
  });

  it('★ 对照：默认 matchBy: "id"（generate_scene 那条路）行为不变', () => {
    const result = upsertOutlineEntry(outlineWith(SWAPPED), {
      id: 'p21',
      order: 99,
      title: '丙',
      type: 'slide',
      description: 'x',
    } as SceneOutline);
    const after = result.outline?.outlines ?? [];

    // 按 id 命中 `p21`（它坐在 order 28 上）⇒ 就地替换成 order 99。这是**既有语义**。
    expect(after.find((entry) => entry.id === 'p21')?.order).toBe(99);
    expect(after.find((entry) => entry.order === 21)?.title).toBe('甲');
  });
});
