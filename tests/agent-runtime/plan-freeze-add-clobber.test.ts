import { describe, expect, it } from 'vitest';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { buildPlanFreezeTool } from '@/lib/server/agent-runtime/plan-freeze-tools';
import type { SceneOutline } from '@/lib/types/generation';

/**
 * ★ `plan_freeze add` 不许**静默覆盖**别的页的条目（2026-10-07 修）。
 *
 * ── 由来：一次实测出来的数据丢失 ────────────────────────────────
 * `upsertOutlineEntry` 按 **order** 认身份 ⇒ 往一个已被占用的 order 写，就是
 * **覆盖**原来那一页的条目，而且**不报错**。而拆页/插页之后页号会顺延，
 * agent 给新页写的 order 恰好落在既有条目上 ⇒ 它"补一次、洞往后挪一格"。
 *
 * 实测（`stage-GYvpbYB_aN`）：**51 页 / 计划只剩 47 条**，缺 `37, 40, 46, 47`。
 * agent 把这理解成**工具的容量只有 47 条**，并据此告诉学习者"要再拆页就得先重排计划"
 * —— 那是在对着我们的 bug 做规划。
 *
 * 这一组钉三件事：**会覆盖就拒** · **同标题重写放行**（那是 add 的正常用法）·
 * **换一个空 order 就放行**（补空洞是安全的那条路）。
 */

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> })
    .content.map((part) => part.text ?? '')
    .join('\n');
}

function harness(outline: AppDocumentOutline | undefined) {
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
    call: (params: Record<string, unknown>) =>
      (
        tool as unknown as {
          execute(id: string, params: unknown): Promise<unknown>;
        }
      ).execute('c', { stageId: 'stage-1', ...params }),
  };
}

function outlineWith(entries: Array<[number, string]>): AppDocumentOutline {
  return {
    outlines: entries.map(([order, title]) => ({
      id: `p${order}`,
      order,
      title,
      type: 'slide',
      description: `${title} 的 brief`,
    })) as SceneOutline[],
    requirement: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as AppDocumentOutline;
}

describe('★ plan_freeze add 不许静默覆盖别的页', () => {
  it('往已被占用的 order 写【另一个标题】⇒ 拒，并说明这是什么情况', async () => {
    const { h, call } = harness(outlineWith([[5, '条件语句'], [6, '循环']]));
    const result = await call({
      action: 'add',
      entries: [{ order: 6, title: '动手：写正负判断', brief: '新拆出来的一页' }],
    });

    const text = textOf(result);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('add 被拒绝');
    expect(text).toContain('第 6 页已被《循环》占用');
    // 一个字都没写盘。
    expect(h.saved).toHaveLength(0);
  });

  it('同一个 order + 【同一个标题】⇒ 放行（重写这一页的 brief 是 add 的正常用法）', async () => {
    const { h, call } = harness(outlineWith([[5, '条件语句'], [6, '循环']]));
    const result = await call({
      action: 'add',
      entries: [{ order: 6, title: '循环', brief: '把 brief 写细一点' }],
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(h.saved).toHaveLength(1);
    expect(h.outline?.outlines.find((e) => e.order === 6)?.description).toBe('把 brief 写细一点');
  });

  it('★ 别把正常写计划也拒掉：往【空 order】写 ⇒ 放行（补空洞就是这条路）', async () => {
    const { h, call } = harness(outlineWith([[5, '条件语句'], [7, '循环']]));
    const result = await call({
      action: 'add',
      entries: [{ order: 6, title: '动手：写正负判断', brief: '补上缺的那条' }],
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(h.saved).toHaveLength(1);
    expect(h.outline?.outlines.map((e) => e.order).sort((a, b) => a - b)).toEqual([5, 6, 7]);
  });

  it('多条一起写：只要有一条会覆盖，整批都不写（原子）', async () => {
    const { h, call } = harness(outlineWith([[5, '条件语句'], [6, '循环']]));
    const result = await call({
      action: 'add',
      entries: [
        { order: 8, title: '新的一页', brief: 'b' },
        { order: 6, title: '又是新的一页', brief: 'b' },
      ],
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(h.saved).toHaveLength(0);
  });
});
