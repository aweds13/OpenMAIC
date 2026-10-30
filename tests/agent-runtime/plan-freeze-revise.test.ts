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
  return (result as { content: Array<{ text?: string }> }).content
    .map((part) => part.text ?? '')
    .join('\n');
}

function outlineWith(entries: Array<[number, string]>): AppDocumentOutline {
  return {
    outlines: entries.map(([order, title]) => ({
      id: `p${order}`,
      order,
      title,
      type: 'slide',
      // ★ 夹具要**规格内**（有单元抬头 + keyPoints）：2026-10-09 起 `revise` 会
      //   统计规格缺口，裸条目会把数字带偏 —— 那测的就不是本文件要测的东西了。
      keyPoints: [`第 ${order} 页的小点`],
      description: `【Unit U${order} · explanation 1/1】brief ${order}`,
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
      (tool as unknown as { execute(id: string, params: unknown): Promise<unknown> }).execute('c', {
        stageId: 'stage-1',
        ...params,
      }),
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

/**
 * ★★ `revise` 这条写入路径也要报**规格缺口**（2026-10-09）。
 *
 * ── 由来：一个真实跑出来的洞 ──────────────────────────────────────
 *
 * 闸（`freezePlan` 的 `planSpecGaps`）我只挂在 `freeze` 上。可是**改造一门老课走的是
 * `revise`** —— `add` 有"撞到别的标题就拒"的守卫，成批重写只能用 `revise`。
 * 于是：**最需要验的那条路，恰好是闸照不到的那条。**
 *
 * 这不是假想：真实跑的一次重写写进 **149 条**，其中 **18 条 `keyPoints` 是空的、
 * 4 条练习没写难度、还缺 14 个 order** —— 全程**一句提示都没有**。
 * 而那 18 条空着的 `keyPoints`，每一条都让那一页的生成提示词**少一格**
 * （页面生成器只看得到 title / brief / keyPoints）。
 *
 * 这正是手册 §1.1：「**加一个新闸时，顺手问一句『另一条写入路径呢』**」。
 *
 * ★ 这里**报而不拒**（与 `freeze` 的硬拒不同，故意的）：`revise` 是修一门
 *   **已经存在**的课的路，整批拒掉会挡住修复本身 —— 那次 149 条已经写完了。
 */
describe('★★ revise 要报规格缺口（闸照不到的那条写入路径）', () => {
  // ★ 用**工具参数**的名字（`brief` / `unit` / `role`），不是 `SceneOutline` 的字段名 ——
  //   这两套名字不一样，混了就会被静默丢掉（本轮真栽过，故 schema 里加了 `description` 别名）。
  const complete = (order: number) => ({
    order,
    title: `第 ${order} 页`,
    type: 'slide',
    keyPoints: [`小点 ${order}`],
    unit: `U${order}`,
    role: 'explanation 1/1',
    brief: `brief ${order}`,
  });

  it('★ 有缺口 ⇒ 回话里报出**具体数字**，并点出后果', async () => {
    const { call } = harness(outlineWith([[1, '第 1 页']]));
    const result = await call({
      action: 'revise',
      reason: '按单元重排',
      entries: [complete(1), { order: 2, title: '第 2 页', type: 'slide' }],
    });
    const out = textOf(result);
    expect(out).toContain('计划里还有缺口');
    expect(out).toContain('1 条没有单元');
    expect(out).toContain('`keyPoints` 是空的');
    // ★ 要说出**后果**，否则"补一下"没有分量。
    expect(out).toContain('少一格');
  });

  it('★ 练习缺难度也要报（它是"由易到难"唯一的落点）', async () => {
    const { call } = harness(outlineWith([[1, '第 1 页']]));
    const result = await call({
      action: 'revise',
      reason: '补练习',
      entries: [
        {
          order: 2,
          title: '改错：三处',
          type: 'interactive',
          keyPoints: ['小点'],
          unit: 'U1',
          role: 'practice 1/1 · form: fix-the-bug',
          brief: 'brief',
        },
      ],
    });
    expect(textOf(result)).toContain('练习没写难度');
  });

  it('★ 规格内就**一个字都不多说**（诊断不能变成噪声）', async () => {
    const { call } = harness(outlineWith([[1, '第 1 页']]));
    const result = await call({
      action: 'revise',
      reason: '按单元重排',
      entries: [complete(1), complete(2)],
    });
    expect(textOf(result)).not.toContain('计划里还有缺口');
  });

  it('★ `backfill` 派生的条目**不算账**（否则老课永远在报缺口）', async () => {
    // 前提：计划里**本来就有**一条 backfill 派生条目（那才是老课的样子）。
    const outline = outlineWith([[1, '第 1 页']]);
    (outline.outlines as SceneOutline[]).push({
      id: 'p2',
      order: 2,
      title: '第 2 页',
      type: 'slide',
      description: 'backfilled from the existing page (the original brief was never recorded)',
    } as SceneOutline);
    const { call } = harness(outline);
    const result = await call({ action: 'revise', reason: '只挪页号', entries: [complete(3)] });
    expect(textOf(result)).not.toContain('计划里还有缺口');
  });
});
