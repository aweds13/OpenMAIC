import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { buildPlanFreezeTool } from '@/lib/server/agent-runtime/plan-freeze-tools';
import type { SceneOutline } from '@/lib/types/generation';

/**
 * ★ `plan_freeze { action: "revise" }` **现在真的改计划**（2026-10-07 修）。
 *
 * ── 原来它只记一次理由 ──────────────────────────────────────────
 * 老实现只调 `revisePlan()`（记修订理由），**一个条目都不动**。而提示词、门槛的
 * 拒绝信息、`freeze` 的回复**三处都在教模型**「改计划要用 revise 写明理由」——
 * **那是我们写的一句假话**：唯一能写条目的是 `add`，而它按 order 覆盖。
 *
 * 实测代价（`stage-GYvpbYB_aN`）：agent 一边拆页一边补条目，条目静默消失 4 条
 * （37/40/46/47），最后把计划当成"容量只有 47 条"，并据此给学习者做了规划。
 *
 * 这一组钉它现在能表达的三件事：
 * **`shift`（拆页 ⇒ 页号顺延）** · **`removeOrders`** · **`entries`**，
 * 以及一条对照：**只传 reason 时明说"没有改任何条目"**（别让模型以为改了）。
 */

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> })
    .content.map((part) => part.text ?? '')
    .join('\n');
}

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

function harness(outline: AppDocumentOutline | undefined) {
  // ★ `revise` 只对**已冻结**的计划有意义（未冻结时它会拒 —— 那是对的）。
  //   在这里统一冻上，免得测试之间靠"上一条恰好写了文件"的顺序依赖。
  const dir = process.env.OPENMAIC_PLAN_FREEZE_DIR ?? join(process.cwd(), 'data', 'plan-freeze');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'stage-1.json'),
    JSON.stringify({
      stageId: 'stage-1',
      frozen: true,
      frozenAt: 1,
      frozenEntryCount: 1,
      revision: 0,
      revisions: [],
    }),
    'utf8',
  );
  const h = { outline, saved: [] as AppDocumentOutline[] };
  const tool = buildPlanFreezeTool({
    loadOutline: async () => h.outline,
    loadPages: async () => [],
    saveOutline: async (_stageId, next) => {
      h.outline = next;
      h.saved.push(next);
      return true;
    },
  });
  return {
    h,
    orders: () => (h.outline?.outlines ?? []).map((entry) => entry.order),
    call: (params: Record<string, unknown>) =>
      (
        tool as unknown as { execute(id: string, params: unknown): Promise<unknown> }
      ).execute('c', { stageId: 'stage-1', ...params }),
  };
}

describe('★ plan_freeze revise 真的改计划', () => {
  it('★ shift：拆页后让后面全部顺延（这是原来完全没有的原语）', async () => {
    const { h, orders, call } = harness(
      outlineWith([
        [5, 'a'],
        [6, 'b'],
        [7, 'c'],
      ]),
    );
    const result = await call({
      action: 'revise',
      reason: '把第 6 页拆成两页，后面的页号顺延',
      shift: { fromOrder: 6, delta: 1 },
    });

    // ★ 6 是**空出来**的（这正是"腾位子"的意思），不是被填上。
    expect(orders()).toEqual([5, 7, 8]);
    expect(h.saved).toHaveLength(1);
    expect(textOf(result)).toContain('平移 +1');
  });

  it('shift 会撞出重复 order 时 ⇒ 整批拒绝、一个字都不改', async () => {
    // delta = -1 会把 order 5 撞到 4 —— 而 4 已经存在。
    const { h, orders, call } = harness(
      outlineWith([
        [4, 'a'],
        [5, 'b'],
      ]),
    );
    const result = await call({
      action: 'revise',
      reason: '往前挪',
      shift: { fromOrder: 5, delta: -1 },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('两份条目');
    expect(orders()).toEqual([4, 5]);
    expect(h.saved).toHaveLength(0);
  });

  it('removeOrders：页面没了就删条目', async () => {
    const { h, orders, call } = harness(
      outlineWith([
        [5, 'a'],
        [6, 'b'],
        [7, 'c'],
      ]),
    );
    await call({ action: 'revise', reason: '第 6 页删掉了', removeOrders: [6] });

    expect(orders()).toEqual([5, 7]);
    expect(h.saved).toHaveLength(1);
  });

  it('entries：写/改条目（与 add 同一套 upsert）', async () => {
    const { h, orders, call } = harness(outlineWith([[5, 'a']]));
    await call({
      action: 'revise',
      reason: '补上第 6 页',
      entries: [{ order: 6, title: 'b', brief: '新的一页' }],
    });

    expect(orders()).toEqual([5, 6]);
    expect(h.outline?.outlines.find((e) => e.order === 6)?.title).toBe('b');
  });

  it('★ 对照：只传 reason ⇒ 明说"没有改任何条目"（别让模型以为改了）', async () => {
    const { h, call } = harness(outlineWith([[5, 'a']]));
    const result = await call({ action: 'revise', reason: '我改了一下' });

    const text = textOf(result);
    expect(text).toContain('已记下第 1 次修订');
    expect(text).toContain('没有改任何条目');
    expect(h.saved).toHaveLength(0);
  });
});
