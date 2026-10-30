/**
 * `review_course` —— 对抗性内容审查。
 *
 * 这一组判据钉的是**隔离**与**诚实**，不是"审查得好不好"：
 * 审查质量靠提示词，而那三条纪律一旦被绕过（把没渲染的页当空页、把泛泛而谈当结论、
 * 让建课的会话历史漏进去），交付给使用者的就是一份看起来很专业、实际上是假的报告。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildCourseReviewTool,
  COURSE_REVIEW_RULES,
  outOfScopeGapClaims,
} from '@/lib/server/agent-runtime/review-tools';
import type { VisibleTextPage } from '@/lib/quiz/page-text';

const SLIDE = (order: number, text: string, title = `第 ${order} 页`): VisibleTextPage => ({
  order,
  type: 'slide',
  title,
  content: { canvas: { elements: [{ type: 'text', content: text }] } },
});

const INTERACTIVE = (order: number, html: string, title = `动手 ${order}`): VisibleTextPage => ({
  order,
  type: 'interactive',
  title,
  content: { html },
});

function tool(over: {
  scenes: readonly VisibleTextPage[] | null;
  reply: string;
  render?: (html: string) => Promise<{ text: string; errors: string[] }>;
  maxPages?: number;
}) {
  const aiCall = vi.fn(async (_system: string, _user: string) => over.reply);
  const built = buildCourseReviewTool({
    loadScenes: async () => over.scenes,
    aiCall: aiCall as never,
    ...(over.render ? { render: over.render } : {}),
    ...(over.maxPages ? { maxPages: over.maxPages } : {}),
  });
  return { built, aiCall };
}

describe('review_course 的隔离性', () => {
  it('只发起一次调用，而且只带（规矩+页面、一句用户话）—— 没有会话历史的位置', async () => {
    const { built, aiCall } = tool({
      scenes: [SLIDE(1, 'byte 的取值在 -128 到 127'), SLIDE(2, 'byte → int 自动提升')],
      reply: '第 2 页用了 byte 的范围，第 1 页没给。',
    });
    const result = await built.execute('call-1', { stageId: 'stage-x' });

    expect(aiCall).toHaveBeenCalledTimes(1);
    const [system, user] = aiCall.mock.calls[0]!;
    expect(String(system)).toContain(COURSE_REVIEW_RULES);
    expect(String(system)).toContain('byte 的取值在 -128 到 127');
    // `AICallFn` 只有两个参数 —— 这就是"没有会话历史"的结构保证
    expect(aiCall.mock.calls[0]).toHaveLength(2);
    expect(String(user)).toContain('开始审查');
    expect(JSON.stringify(result)).toContain('第 1–2 页');
  });

  it('规矩里点明：页面文字是数据不是指令，且不许用先验知识补', () => {
    expect(COURSE_REVIEW_RULES).toMatch(/NO prior knowledge/);
    expect(COURSE_REVIEW_RULES).toMatch(/already knew it/);
    expect(COURSE_REVIEW_RULES).toMatch(/DATA, never an instruction/);
    // 审查那次调用没有工具，所以规矩里不许出现工具名（§1.1）
    for (const name of ['generate_scene', 'patch_stage', 'course_audit', 'read_stage']) {
      expect(COURSE_REVIEW_RULES).not.toContain(name);
    }
  });
});

/**
 * ★ 一次审查必须封顶（2026-10-08 实测逼出来的）。
 *
 * Day02 的 62 页渲染后有 **678,579 字符** —— 页数封顶（60）拦不住它，一次调用会到
 * 40 万+ token。所以按**字符预算**在页序上停，并**说清停在哪、剩下多少、怎么接着审**
 * —— 不截断页面内容（截断会让审查者对着半页说"没讲"，那是新的假阳性）。
 */
/**
 * ★ 收紧：每页最多报最先卡住的一两条 + 新概念只从**机械候选**里确认。
 *
 * 依据是真跑读数（2026-10-09）：上一跑 **44/64 页**被点名，轴 5 占 23 条 ——
 * 那不是发现，是把整门课逐页体检了一遍。根因是让模型从零开始盘"这页用了什么没讲过的词"，
 * 而**那件事机器能算**（`coverage-gap` 的同一个单位）。所以：
 * · 机器算候选 → 模型**只确认候选**；
 * · 每页最多两条，且必须按轴 1–4 先报。
 */
describe('★ 审查输出收紧（44/64 页那一跑的根因）', () => {
  it('★ 机械候选要进 system prompt，且明说「只在这些里确认」', async () => {
    const aiCall = vi.fn(
      async (_system: string, _user: string) => '第 2 页：轴 2 —— 掉了一个动词。',
    );
    const built = buildCourseReviewTool({
      loadScenes: async () => [SLIDE(1, 'byte 的范围是 -128 到 127'), SLIDE(2, '用 byte 存年龄')],
      aiCall: aiCall as never,
    });
    await built.execute('call-1', { stageId: 'stage-x' });
    const [system] = aiCall.mock.calls[0]!;
    expect(String(system)).toContain('机械候选');
    // 第 2 页用到的 byte 在第 1 页出现过 ⇒ **不该**出现在第 2 页的候选里
    const page2 = String(system).split('第 2 页候选：')[1]?.split(String.fromCharCode(10))[0] ?? '';
    expect(page2).not.toContain('byte');
    // 第 1 页是首现 ⇒ 它本身是候选
    expect(String(system)).toContain('第 1 页候选');
    expect(String(system)).toMatch(/只在这些里确认/);
  });

  /**
   * ★★ 「前面所有页」必须是**全课的前面**，不是"这一段的前面"（2026-10-09 补）。
   *
   * 上面那条判据用的是**一次调用就给两页**的夹具，前缀恰好在本段里 ⇒ 照不到这个洞。
   * 真跑是**分段**的（字符预算 ⇒ 8 段各审一截），而 `earlierChunks` 原来只从本段第一页起累
   * ⇒ 从第 22 页那一段开始，前缀是**空的** ⇒ 那一段每个词都成了"从没出现过"的候选。
   * 实测代价：第 22–29 段的候选里出现「Java」「代码」「编辑器里写」—— 第 1–21 页早就讲过；
   * 审查者照候选把它们判成"真缺口"。**假阳性是工具自己造出来的。**
   */
  it('★★ 从中途开始审（fromOrder 落在第二页）时，前面那一页的词**仍然不算候选**', async () => {
    const aiCall = vi.fn(
      async (_system: string, _user: string) => '第 2 页：轴 2 —— 掉了一个动词。',
    );
    const built = buildCourseReviewTool({
      loadScenes: async () => [SLIDE(1, 'byte 的范围是 -128 到 127'), SLIDE(2, '用 byte 存年龄')],
      aiCall: aiCall as never,
    });
    await built.execute('call-1', { stageId: 'stage-x', fromOrder: 2 });
    const [system] = aiCall.mock.calls[0]!;
    // 正文里只有第 2 页（第 1 页没给），但它属于"前面所有页" ⇒ 它的词不许再当候选。
    expect(String(system)).toContain('# 本次给你的正文：第 2–2 页');
    const page2 = String(system).split('第 2 页候选：')[1]?.split(String.fromCharCode(10))[0] ?? '';
    expect(page2).not.toContain('byte');
  });

  /**
   * ★★ 提示词必须说清"这是**全课**的第几页"，并给一份**全课目录**（2026-10-09 补）。
   *
   * 原来那一行是「课程页面（共 N 页）」，而 N 是**本次调用**的页数 ⇒ 模型据此刻断言
   * 「本材料只有 8 页」「第 1 页不存在」「没有名为《条件语句》的页」。实测第 22–29、30–33
   * 两段都是这么错的 —— 那是审出来的假阳性里最大的一类（跨页引用被当成悬空引用）。
   */
  it('★★ 说清"全课共 N 页"并列出目录，别让模型把这一段当成整门课', async () => {
    const aiCall = vi.fn(
      async (_system: string, _user: string) => '第 2 页：轴 2 —— 掉了一个动词。',
    );
    const built = buildCourseReviewTool({
      loadScenes: async () => [
        SLIDE(1, 'byte 的范围是 -128 到 127', '类型'),
        SLIDE(2, '用 byte 存年龄', '变量'),
        SLIDE(3, '后面的页', '条件语句：if / else 怎么让程序分岔'),
      ],
      aiCall: aiCall as never,
      maxChars: 30,
    });
    await built.execute('call-1', { stageId: 'stage-x' });
    const system = String(aiCall.mock.calls[0]![0]);
    expect(system).toContain('全课目录（共 3 页）');
    // 没进正文的那一页，标题也要在目录里 —— 否则模型会说"没有《条件语句》那一页"。
    expect(system).toContain('第 3 页《条件语句：if / else 怎么让程序分岔》');
    expect(system).toContain('全课有 3 页');
    // 反面：不许再出现"课程页面（共 N 页）"这种会被读成"整门课就这么多"的说法。
    expect(system).not.toContain('课程页面（共');
  });

  it('★ 每页最多两条 + 轴 1–4 先报 + 「不清楚」不许单独报', async () => {
    const aiCall = vi.fn(async (_system: string, _user: string) => '第 1 页：没问题。');
    const built = buildCourseReviewTool({
      loadScenes: async () => [SLIDE(1, '内容')],
      aiCall: aiCall as never,
    });
    await built.execute('call-1', { stageId: 'stage-x' });
    const system = String(aiCall.mock.calls[0]![0]);
    // ★ 不设条数上限（上限会**静默丢掉真问题**）：靠"同轴合并"限长，并明说**不许为省条目丢真问题**
    expect(system).toMatch(/NO per-page count limit/);
    expect(system).toMatch(/Merge everything on the same axis into ONE entry/);
    expect(system).toMatch(/Never drop a real blocker to fit a budget/);
    expect(system).not.toMatch(/hard cap/);
    expect(system).toMatch(/1–4 first/);
    expect(system).toMatch(/「Unclear」 alone is not actionable/);
  });
});

describe('★ 字符预算：一次审查不许把整门课塞进去', () => {
  it('★ 超预算就停在预算处，并告诉调用方用 fromOrder 接着审', async () => {
    const big = (order: number): VisibleTextPage => SLIDE(order, '字'.repeat(900));
    const { built, aiCall } = tool({
      scenes: [big(1), big(2), big(3)],
      reply: '第 2 页用了前面没讲的东西。',
    });
    const result = (await built.execute('call-1', { stageId: 'stage-x' })) as {
      details: {
        charsBudget: number;
        charsUsed: number;
        remainingPages: number;
        pageCount: number;
      };
      content: { text: string }[];
    };
    // 默认预算 120k，而这里每页只有 900 字 —— 先确认没被误伤（三页全进）
    expect(result.details.pageCount).toBeGreaterThan(0);
    const [system] = aiCall.mock.calls[0]!;
    expect(String(system)).toContain('第 1 页');
  });

  it('★ 预算调小 ⇒ 停在预算处、说清还剩几页、怎么接着审', async () => {
    const big = (order: number): VisibleTextPage => SLIDE(order, '字'.repeat(400));
    const aiCall = vi.fn(async () => '第 1 页的问题。');
    const built = buildCourseReviewTool({
      loadScenes: async () => [big(1), big(2), big(3)],
      aiCall: aiCall as never,
      maxChars: 500,
    });
    const result = (await built.execute('call-1', { stageId: 'stage-x' })) as {
      details: { pageCount: number; remainingPages: number; charsUsed: number };
      content: { text: string }[];
    };
    expect(result.details.pageCount).toBe(1);
    expect(result.details.remainingPages).toBe(2);
    expect(result.content[0]?.text).toContain('还有 2 页没进这次调用');
    expect(result.content[0]?.text).toContain('fromOrder: 2');
  });
});

describe('review_course 的诚实性', () => {
  it('渲染失败的页在提示词里带 [NOT RENDERED]，并警告结论要降级', async () => {
    const { built, aiCall } = tool({
      scenes: [SLIDE(1, '正常的讲解页'), INTERACTIVE(2, '<html><body>外壳</body></html>')],
      reply: '第 2 页我没法判断（第 2 页是源码）。',
      render: async () => ({ text: '', errors: ['renderMathInElement is not defined'] }),
    });
    const result = await built.execute('call-1', { stageId: 'stage-x' });
    const [system] = aiCall.mock.calls[0]!;
    expect(String(system)).toContain('[NOT RENDERED]');
    expect(String(system)).toMatch(/not executed|source/i);
    expect(
      (result as { details: { notRenderedPages: number[] } }).details.notRenderedPages,
    ).toEqual([2]);
    expect(JSON.stringify(result)).toContain('没能渲染');
  });

  it('渲染成功的页不带 NOT RENDERED，而且正文用的是渲染结果', async () => {
    const { built, aiCall } = tool({
      scenes: [INTERACTIVE(3, '<html><body>空</body></html>')],
      reply: '第 3 页的参考答案在第 3 页里，但没有讲解。',
      render: async () => ({ text: '参考答案：int n = -7 时走 if 分支', errors: [] }),
    });
    await built.execute('call-1', { stageId: 'stage-x' });
    const [system] = aiCall.mock.calls[0]!;
    expect(String(system)).not.toContain('[NOT RENDERED]');
    expect(String(system)).toContain('参考答案：int n = -7 时走 if 分支');
  });

  it('★ 没有页码引用的结论不算数（isError），不当成证据交出去', async () => {
    const { built } = tool({
      scenes: [SLIDE(1, 'x')],
      reply: '整体上有些地方讲得不够清楚，建议补充更多例子。',
    });
    const result = (await built.execute('call-1', { stageId: 'stage-x' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/带页码|不算数/);
  });

  it('空页会被点名，并进 details（全量出口）', async () => {
    const { built } = tool({
      scenes: [
        SLIDE(1, '有正文'),
        { order: 19, type: 'slide', title: '嵌套循环', content: { canvas: { elements: [] } } },
      ],
      reply: '第 19 页整页没有正文（第 1 页有）。',
    });
    const result = (await built.execute('call-1', { stageId: 'stage-x' })) as {
      details: {
        emptyPages: number[];
        pageModes: { order: number; mode: string; chars: number }[];
      };
      content: { text: string }[];
    };
    expect(result.details.emptyPages).toEqual([19]);
    expect(result.content[0]?.text).toContain('一个字都没有');
    expect(result.details.pageModes).toHaveLength(2);
  });

  it('范围过滤 + 按页序排 + 上限', async () => {
    const { built, aiCall } = tool({
      scenes: [SLIDE(3, 'c'), SLIDE(1, 'a'), SLIDE(2, 'b')],
      reply: '第 2 页的问题。',
      maxPages: 2,
    });
    const result = (await built.execute('call-1', { stageId: 'stage-x', fromOrder: 2 })) as {
      details: { pageCount: number };
    };
    const [system] = aiCall.mock.calls[0]!;
    expect(result.details.pageCount).toBe(2);
    expect(String(system).indexOf('第 2 页')).toBeLessThan(String(system).indexOf('第 3 页'));
    expect(String(system)).not.toContain('### 第 1 页');
  });

  it('没有页面时 isError，且不发起模型调用', async () => {
    const { built, aiCall } = tool({ scenes: null, reply: 'x' });
    const result = (await built.execute('call-1', { stageId: 'stage-x' })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(aiCall).not.toHaveBeenCalled();
  });
});

/**
 * ★★ 孤立阅读：审查者**越界点名**（2026-10-10 实测逼出来的）。
 *
 * 学习者转来的一条：复审只拿到第 44–46 页时，报了一串
 * 「`main` / `static` / `List` / `void` / `System.out.println` 都没解释」。
 * 量下来**候选没算错** —— 这 5 个词**一个都不在那三页的候选里**，
 * 它们首次出现在**第 4 / 10 页**（`npx vitest run tests/agent-runtime/_isolated-reading-probe.test.ts`
 * 那支临时探针跑出来的读数）。也就是说：
 *
 *   · **工具给的证据是对的**：候选 = 首次出现的词，那三页的候选是
 *     「定义接口、travel、只写声明」/「命中一、chain、分支全部跳过」/「泛型方法、三件事」；
 *   · **是审查者自己点名了**：提示词里"只在这些里确认"拦不住模型。
 *   · 而且提示词里那句「或**任何前面一页**解释了它 ⇒ 不是缺口」是**问不出答案的问题** ——
 *     候选的定义就是"前面所有页都没出现过"，而它又看不到那些页。
 *
 * 所以两处都改：① 把那个无法回答的问句从提示词里删掉，并明说"没出现在候选里的一律不许报"；
 * ② 事后**用机器把那类条目指名作废**（§4：提示词约束不住的东西，必须在代码里给默认值）。
 */
describe('★★ 孤立阅读：越界点名的"没解释"要用机器作废', () => {
  it('★ 提示词不再问"前面哪一页解释了它"（那个问题审查者无法核对）', async () => {
    const { built, aiCall } = tool({
      scenes: [SLIDE(1, 'void 表示没有返回值'), SLIDE(2, '写一个 travel 接口')],
      reply: '第 2 页：轴 2 —— 掉了一个动词。',
    });
    await built.execute('call-1', { stageId: 'stage-x', fromOrder: 2 });
    const [system] = aiCall.mock.calls[0]!;
    // 反例：原来那句「本页后文或任何前面一页解释了它 ⇒ 不是缺口」必须消失。
    expect(String(system)).not.toMatch(/任何前面一页解释了它/);
    expect(String(system)).not.toMatch(/neither that page nor any earlier page explains it/);
    // 正解：明说"前面讲过没有"不是它能核对的，且候选之外一律不许报。
    expect(String(system)).toMatch(/不是你能核对的/);
    expect(String(system)).toMatch(/没出现在候选里的词一律不许报/);
    expect(String(system)).toMatch(/not yours to judge and not/);
  });

  it('★★ 报告点名"没解释"、但该词本段之前就出现过 ⇒ 机器作废，并给出它真正的首现页', async () => {
    const { built } = tool({
      scenes: [
        SLIDE(1, 'void 表示没有返回值，static 表示属于类'),
        SLIDE(2, '写一个 travel 接口，别的先不管'),
      ],
      reply: '第 2 页：轴 5 —— 这一页用了 `void` 和 `static`，但没解释。',
    });
    const result = (await built.execute('call-1', { stageId: 'stage-x', fromOrder: 2 })) as {
      content: { text: string }[];
      details: { outOfScopeClaims: { term: string; firstOrder: number }[] };
    };
    expect(result.content[0]!.text).toContain('机器复核');
    expect(result.content[0]!.text).toContain('直接丢掉');
    // 首现页要报出来 —— 那才是可行动的信息（"第 1 页已经讲过"）。
    expect(result.content[0]!.text).toContain('首次出现在**第 1 页**');
    const terms = result.details.outOfScopeClaims.map((claim) => claim.term);
    expect(terms).toContain('void');
    expect(terms).toContain('static');
    expect(result.details.outOfScopeClaims.every((claim) => claim.firstOrder === 1)).toBe(true);
  });

  it('★ 不误伤真缺口：候选里的词（本页首现）被点名"没解释"**不**作废', async () => {
    const { built } = tool({
      scenes: [SLIDE(1, 'void 表示没有返回值'), SLIDE(2, '写一个 travel 接口，别的先不管')],
      reply: '第 2 页：轴 5 —— `travel` 在第 2 页第一次出现，却没解释。',
    });
    const result = (await built.execute('call-1', { stageId: 'stage-x', fromOrder: 2 })) as {
      content: { text: string }[];
      details: { outOfScopeClaims: unknown[] };
    };
    expect(result.details.outOfScopeClaims).toEqual([]);
    expect(result.content[0]!.text).not.toContain('机器复核');
  });

  it('★ 不误伤 1–4：没写"没解释"这类字样的引用条目，哪怕引了前文的词也原样留着', async () => {
    const { built } = tool({
      scenes: [SLIDE(1, 'void 表示没有返回值'), SLIDE(2, '写一个 travel 接口，别的先不管')],
      reply: '第 2 页：轴 1 —— 这句话把 `void` 说成"返回空"，和它的实际含义矛盾。',
    });
    const result = (await built.execute('call-1', { stageId: 'stage-x', fromOrder: 2 })) as {
      content: { text: string }[];
      details: { outOfScopeClaims: unknown[] };
    };
    expect(result.details.outOfScopeClaims).toEqual([]);
    expect(result.content[0]!.text).toContain('说成"返回空"');
  });

  it('★ 复合词按**首个内容块**定首现页（`System.out.println` 在库里是三个块）', () => {
    const firstSeen = new Map<string, number>([
      ['System', 4],
      ['out', 4],
      ['println', 4],
      ['泛型方法', 46],
    ]);
    const claims = outOfScopeGapClaims(
      '第 46 页：`System.out.println` 没解释。\n第 46 页：`泛型方法` 没解释。',
      firstSeen,
      44,
    );
    expect(claims.map((claim) => claim.term)).toEqual(['System.out.println']);
    expect(claims[0]!.firstOrder).toBe(4);
  });

  it('★ 纯函数边界：没有"没解释"字样、或首现在本段之后 ⇒ 一条都不作废', () => {
    const firstSeen = new Map<string, number>([
      ['main', 1],
      ['Stream', 60],
    ]);
    // 没有标记词 ⇒ 不看
    expect(outOfScopeGapClaims('第 50 页：轴 1 —— `main` 那句话讲反了。', firstSeen, 44)).toEqual(
      [],
    );
    // 首现在本段**之后** ⇒ 那是"这一页之后才讲"，不该被机器抹掉
    expect(outOfScopeGapClaims('第 50 页：`Stream` 没解释。', firstSeen, 44)).toEqual([]);
    // 首现落在**本段之内** ⇒ 是候选，可能是真缺口
    expect(outOfScopeGapClaims('第 50 页：`Stream` 没解释。', firstSeen, 60)).toEqual([]);
  });
});
