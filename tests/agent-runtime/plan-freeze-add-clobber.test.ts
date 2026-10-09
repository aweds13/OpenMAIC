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

/**
 * ★★ `add` 必须真的把**单元 / 角色 / 小点 / 难度**写进计划（2026-10-09）。
 *
 * ── 这一条是"让 OpenMAIC 自己规划单元"缺的那一环 ────────────────────
 *
 * 提示词里写着"计划是**教学设计**，不是页表"：要拆单元、要 `keyPoints` 非空、
 * 练习条目要带难度。**而工具的 schema 原来根本不收这四个字段，映射也不写** ⇒
 * 它们被**静默丢掉**。用户问「这个计划以后能不能让 openmaic 来做」——
 * 答案是：**改之前不能**，因为写计划的工具承载不了这个设计。
 *
 * 这正是本仓 §1.1 那条的形状（提示词承诺了工具没有的能力），只是方向反过来。
 *
 * ★ 判据钉的是**落盘结果**，不是提示词文本：光改措辞而映射没跟上，这条会红。
 */
describe('★ add 要把单元·角色·小点·难度真的写进计划', () => {
  it('★★ 四个字段都落到 SceneOutline 里（单元/角色/难度进 brief 抬头，小点进 keyPoints）', async () => {
    const { h, call } = harness(outlineWith([[1, '已有页']]));
    const result = await call({
      action: 'add',
      entries: [
        {
          order: 2,
          title: '三元运算符：一行写完 if-else',
          type: 'slide',
          brief: '讲清三元的结构与求值顺序。',
          unit: 'U18 ternary',
          role: 'explanation 1/2',
          keyPoints: ['三元的结构', '求值顺序'],
        },
        {
          order: 3,
          title: '改错：这三处三元写法哪里错',
          type: 'interactive',
          brief: '给出三处写错的三元。',
          unit: 'U18 ternary',
          role: 'practice 2/3 · form: fix-the-bug',
          keyPoints: ['优先级'],
          difficulty: 'medium',
        },
      ],
    });
    // 写盘成功的最强信号：信封里真的多了两条（不看回话措辞 —— 措辞会变，落盘不会）。
    expect(h.saved.length).toBeGreaterThan(0);
    expect((h.outline?.outlines ?? []).length).toBe(3);
    expect(textOf(result)).not.toContain('拒');

    const written = (h.outline?.outlines ?? []) as unknown as Array<Record<string, unknown>>;
    const explain = written.find((e) => e.order === 2);
    const practice = written.find((e) => e.order === 3);

    // ① 小点：上游本来就有这个字段，一直空着 —— 现在必须填。
    expect(explain?.keyPoints).toEqual(['三元的结构', '求值顺序']);
    // ② 单元 / 角色 / 难度：合成进 brief 抬头（SceneOutline 上游只读，不加字段）。
    expect(String(explain?.description)).toContain('【Unit U18 ternary · explanation 1/2】');
    expect(String(explain?.description)).toContain('讲清三元的结构与求值顺序。');
    expect(String(practice?.description)).toContain('difficulty: medium');
    expect(String(practice?.description)).toContain('form: fix-the-bug');
    // ③ 没给难度的**不该**凭空长出一个 difficulty。
    expect(String(explain?.description)).not.toContain('difficulty:');
  });

  it('★ `quiz` 页的难度另外落进 `quizConfig`；`interactive` 页**不硬塞**（那是编数据）', async () => {
    const { h, call } = harness(outlineWith([[1, '已有页']]));
    await call({
      action: 'add',
      entries: [
        { order: 2, title: '选择：哪条命令验证安装', type: 'quiz', brief: 'x', difficulty: 'easy' },
        { order: 3, title: '写作：写一个 for', type: 'interactive', brief: 'y', difficulty: 'hard' },
      ],
    });
    const written = (h.outline?.outlines ?? []) as unknown as Array<Record<string, unknown>>;
    expect(written.find((e) => e.order === 2)?.quizConfig).toMatchObject({ difficulty: 'easy' });
    expect(written.find((e) => e.order === 3)?.quizConfig).toBeUndefined();
    expect(String(written.find((e) => e.order === 3)?.description)).toContain('difficulty: hard');
  });
});

/**
 * ★★ `brief` 与 `description` 是**同一个东西的两个名字** —— 只认一个就会静默丢。
 *
 * `SceneOutline`（计划里的形状）把这个字段叫 **`description`**；
 * 而 `plan_freeze` 的**工具参数**叫 **`brief`**。两个名字指同一件事。
 *
 * 只认 `brief` 的后果不是报错，是**写进去的条目一个字都没有** ——
 * TypeBox 默认不拒多余属性，处理时只读 `brief`，于是 `description` 被**静默丢掉**。
 * 本轮实测栽过：夹具传 `description`，写进计划的条目光秃秃的，而这种丢法在回话里
 * **没有任何迹象**。所以 schema 现在两个名字都收（`brief` 优先）。
 *
 * ★ 判据钉的是**落盘结果**：光在 schema 里挂个名字、映射不读它，这条会红。
 */
describe('★★ brief / description 是同一个字段的两个名字', () => {
  it('★ 只给 `description` 也要真的写进计划（不许静默丢）', async () => {
    const { h, call } = harness(outlineWith([[1, '已有页']]));
    await call({
      action: 'add',
      entries: [{ order: 2, title: '第 2 页', type: 'slide', description: '只给了 description' }],
    });
    const written = (h.outline?.outlines ?? []) as unknown as Array<Record<string, unknown>>;
    expect(String(written.find((e) => e.order === 2)?.description)).toContain('只给了 description');
  });

  it('★ 两个都给时 `brief` 赢（工具参数的正式名字）', async () => {
    const { h, call } = harness(outlineWith([[1, '已有页']]));
    await call({
      action: 'add',
      entries: [
        { order: 2, title: '第 2 页', type: 'slide', brief: '用 brief', description: '用 description' },
      ],
    });
    const written = (h.outline?.outlines ?? []) as unknown as Array<Record<string, unknown>>;
    const text = String(written.find((e) => e.order === 2)?.description);
    expect(text).toContain('用 brief');
    expect(text).not.toContain('用 description');
  });
});
