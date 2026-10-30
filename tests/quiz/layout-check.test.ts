/**
 * ★★ 版面检查 —— **看不见画面时，把"看得见的那部分"变成可算的**（2026-10-10）。
 *
 * 学习者一句话逼出来的：**「我这边没有渲染预览的工具，看不到实际画面」**，
 * 随后更正为「**我说的是它没有**」—— 指 agent。
 *
 * 查证属实：`render_scene_preview` 存在，但没配 `RENDER_SERVICE_URL` 时
 * `buildScenePreviewTools()` **直接返回空数组** ⇒ 工具不注册 ⇒ **它没有眼睛**。
 * 于是它只能读文本，而文本投影已知会骗人（§6.10：压平 `left`/`top` 把两栏读成一行）。
 *
 * 这组判据钉的是"**可算**"那一半：溢出 / 重叠 / 文字装不下 / 字号过小。
 * 全都是坐标和字号能推出来的，不需要渲染。
 */
import { describe, expect, it } from 'vitest';

import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  checkLayout,
  estimateTextHeightPx,
  formatLayoutDelta,
  formatLayoutFindings,
  layoutDelta,
  layoutFindingKey,
  maxFontSizePx,
} from '@/lib/quiz/layout-check';

describe('★★ 版面检查（agent 看不见画面时的替代）', () => {
  it('★ 溢出画布：元素伸出 1000×562.5 之外要被抓到', () => {
    const findings = checkLayout([{ type: 'text', left: 900, top: 500, width: 300, height: 100 }]);
    expect(findings.some((f) => f.code === 'overflows-canvas')).toBe(true);
    expect(formatLayoutFindings(findings)).toContain('超出画布');
  });

  it('★ 刚好贴边**不算**溢出（别把正常版面报成问题）', () => {
    const findings = checkLayout([
      { type: 'text', left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    ]);
    expect(findings.filter((f) => f.code === 'overflows-canvas')).toHaveLength(0);
  });

  it('★ 文字装不下：按字号和宽度估算高度，超过盒高就报', () => {
    const long = `<p style="font-size: 20px;">${'这一句话很长，'.repeat(40)}</p>`;
    const findings = checkLayout([
      { type: 'text', left: 40, top: 40, width: 400, height: 60, content: long },
    ]);
    expect(findings.some((f) => f.code === 'text-does-not-fit')).toBe(true);
    expect(formatLayoutFindings(findings)).toContain('加一页');
  });

  /**
   * ★★ 行高常数必须是**渲染器实际用的那个**（2026-10-10 真 Edge 实测）。
   *
   * 原来写死 **1.6**，而真渲染器读 `elementInfo.lineHeight`，库里绝大多数 text 元素
   * **没有这个字段** ⇒ 生效的是宿主 CSS（Tailwind preflight 的 `html{line-height:1.5}`）。
   * 6.7% 的偏差落在"刚好装得下（余 2px）"的那批盒子上 ⇒ Day02 估算报 23 条装不下，
   * 真 Edge 只有 **3 条**真溢出。
   */
  it('★★ 估算用的行高是渲染器的 1.5，不是以前写死的 1.6', () => {
    // 3 行 × 16px × 1.5 = 72px ⇒ 盒高 72 刚好放得下；按 1.6 会算成 76.8px ⇒ 误报
    const html = `<p style="font-size: 16px;">${'字'.repeat(60)}</p>`;
    expect(estimateTextHeightPx(html, 360, 16)).toBeCloseTo(72, 5);
    const box = { type: 'text', left: 0, top: 0, width: 360, height: 72, content: html };
    expect(checkLayout([box]).some((f) => f.code === 'text-does-not-fit')).toBe(false);
  });

  it('★ 元素自己的 lineHeight 优先（渲染器读的就是它）', () => {
    const html = `<p style="font-size: 16px;">${'字'.repeat(60)}</p>`;
    const box = {
      type: 'text',
      left: 0,
      top: 0,
      width: 360,
      height: 72,
      content: html,
      lineHeight: 2,
    };
    // 1.5 时刚好 72 ⇒ 放得下；元素说 2 倍行高 ⇒ 96 ⇒ 装不下
    expect(checkLayout([box]).some((f) => f.code === 'text-does-not-fit')).toBe(true);
  });

  it('★ 可用宽度要扣掉 `.element-content` 的 10px 内边距（不然会漏报）', () => {
    // 24 个汉字 @16px：全宽 400 能排一行(25) ⇒ 1 行 24px；扣掉内边距后 380 ⇒ 23/行 ⇒ 2 行 48px
    const html = `<p style="font-size: 16px;">${'字'.repeat(24)}</p>`;
    expect(estimateTextHeightPx(html, 400, 16, 1.5, true)).toBeCloseTo(24, 5);
    expect(estimateTextHeightPx(html, 400, 16, 1.5, false)).toBeCloseTo(48, 5);
  });

  /**
   * ★★ 差额在**一行之内**时，估算**不许冒充结论**（2026-10-10）。
   *
   * 真 Edge 量出来的事实：估算的误差**两边都有**，而且**没有阈值能分开真假** ——
   * 真溢出的第 50 页 el14 估算差额只有 +12px，误报的第 7 页 el8 却是 +26px。
   * 所以一行之内的一律降级成"**可能**装不下 / 这不是结论 / 要渲染确认"，并**给出工具名**。
   */
  it('★★ 边界（差额 ≤ 一行）⇒ 说"可能"、"这不是结论"，并给出渲染确认的工具', () => {
    const html = `<p style="font-size: 16px;">${'字'.repeat(24)}</p>`; // 2 行 = 48px
    const box = { type: 'text', left: 0, top: 0, width: 400, height: 30, content: html };
    const found = checkLayout([box]).find((f) => f.code === 'text-does-not-fit');
    expect(found).toBeDefined();
    // 48 − 30 = 18px < 一行 24px ⇒ 边界
    expect(found!.message).toContain('可能');
    expect(found!.message).toContain('这不是结论');
    expect(found!.message).toContain('measure-slide-fit.mjs');
  });

  it('★ 超过一行 ⇒ 仍然照直说（别把真问题也软化成"可能"）', () => {
    const html = `<p style="font-size: 16px;">${'字'.repeat(24)}</p>`; // 2 行 = 48px
    const box = { type: 'text', left: 0, top: 0, width: 400, height: 20, content: html };
    const found = checkLayout([box]).find((f) => f.code === 'text-does-not-fit');
    // 48 − 20 = 28px > 24px ⇒ 不是边界
    expect(found!.message).not.toContain('可能');
    expect(found!.message).toContain('超过一行');
  });

  it('★ 字号过小：低于 14px 要报（"缩成灰块"是学习者点过名的失败模式）', () => {
    const findings = checkLayout([
      {
        type: 'text',
        left: 40,
        top: 40,
        width: 400,
        height: 120,
        content: '<p style="font-size: 11px;">短句</p>',
      },
    ]);
    expect(findings.some((f) => f.code === 'font-too-small')).toBe(true);
  });

  it('★ 贴边不算重叠（刚好挨着是正常版面）', () => {
    const graze = checkLayout([
      { type: 'shape', left: 100, top: 100, width: 200, height: 100 },
      { type: 'text', left: 300, top: 100, width: 200, height: 100 },
    ]);
    expect(graze.some((f) => f.code === 'overlaps')).toBe(false);
  });

  it('★★ **「底板 + 文字」不算重叠** —— 这是本检查第一次真跑就误报的那条', () => {
    // 学习者的反馈：「第 27 页版式没问题，那批「重叠」果然只是「底板 + 文字」的套叠」。
    // 底板把内容**整个装在里面** —— 那是正常设计，不是叠字。
    const panel = checkLayout([
      { type: 'shape', left: 60, top: 80, width: 880, height: 400 },
      { type: 'text', left: 90, top: 110, width: 820, height: 340 },
    ]);
    expect(panel.some((f) => f.code === 'overlaps')).toBe(false);
  });

  it('★★ 两个**文字**元素相交 ⇒ 报（字压字一定是坏的）', () => {
    const stacked = checkLayout([
      { type: 'text', left: 100, top: 100, width: 300, height: 120 },
      { type: 'text', left: 140, top: 130, width: 300, height: 120 },
    ]);
    expect(stacked.some((f) => f.code === 'overlaps')).toBe(true);
    expect(formatLayoutFindings(stacked)).toContain('两个都是文字');
  });

  it('★ 色块盖住半行字 ⇒ 报（至少一个是文字）', () => {
    const covered = checkLayout([
      { type: 'text', left: 100, top: 100, width: 300, height: 120 },
      { type: 'shape', left: 200, top: 120, width: 300, height: 200 },
    ]);
    expect(covered.some((f) => f.code === 'overlaps')).toBe(true);
  });

  it('★ 两个**非文字**元素大面积相交 ⇒ 不报（装饰性叠放，学生不会看到"叠字"）', () => {
    // ★ 相交必须够大（这里 56%）才走得到那条分支 —— 只交 1% 的话 15% 阈值先把它挡了，
    //   测的就成了阈值而不是"非文字不报"。**变异测试当场抓到过这一点。**
    const decor = checkLayout([
      { type: 'shape', left: 100, top: 100, width: 200, height: 200 },
      { type: 'image', left: 150, top: 150, width: 200, height: 200 },
    ]);
    expect(decor.some((f) => f.code === 'overlaps')).toBe(false);
  });

  it('★ 正常的页**一个字都不多说**（诊断不能变成噪声）', () => {
    const findings = checkLayout([
      {
        type: 'text',
        left: 40,
        top: 40,
        width: 920,
        height: 200,
        content: `<p style="font-size: 24px;">${'一句话。'.repeat(6)}</p>`,
      },
    ]);
    expect(findings).toHaveLength(0);
    expect(formatLayoutFindings(findings)).toBe('');
  });

  it('★ 缺坐标的元素**跳过**，不猜（宁可不报，不要用假数字去拒绝）', () => {
    expect(checkLayout([{ type: 'text', content: '<p>没有坐标</p>' }])).toHaveLength(0);
  });

  it('★ 两个小工具：取最大字号 / 估算高度', () => {
    expect(
      maxFontSizePx('<p style="font-size: 16px;">a</p><p style="font-size: 32px;">b</p>'),
    ).toBe(32);
    expect(maxFontSizePx('<p>没有字号</p>')).toBeUndefined();
    expect(estimateTextHeightPx('<p>一</p>', 400, 20)).toBeGreaterThan(0);
  });
});

/**
 * ★★ 「**这一页已经排满了**」—— 与"溢出"是两件事（2026-10-10）。
 *
 * 来自学习者对第 27 页的判断：
 * 「左栏那个反例是个片段（`Child(int a, int b) { … }`），外面没有 class；
 *  **补全它需要一整块位置，这个页面的两栏已经排满**」。
 *
 * 内容**现在**装得下，但**再往里加任何东西都得先重排** —— "溢出"抓不到它。
 * 这条信号是**行动建议**（要改就先拆页），不是缺陷。
 */
describe('★★ 页面余量：满了但没溢出', () => {
  it('★ 两栏排满 ⇒ 报 no-headroom，并说清"要改就先拆页"', () => {
    const findings = checkLayout([
      { type: 'text', left: 40, top: 40, width: 440, height: 480 },
      { type: 'text', left: 520, top: 40, width: 440, height: 480 },
    ]);
    expect(findings.some((f) => f.code === 'no-headroom')).toBe(true);
    const text = formatLayoutFindings(findings);
    expect(text).toContain('已经排满了');
    expect(text).toContain('拆成两页');
  });

  it('★ 留有余量 ⇒ 一个字都不说（别把正常的页报成"满了"）', () => {
    const findings = checkLayout([
      { type: 'text', left: 40, top: 40, width: 400, height: 200 },
      { type: 'text', left: 520, top: 40, width: 400, height: 200 },
    ]);
    expect(findings.some((f) => f.code === 'no-headroom')).toBe(false);
  });

  it('★ 只有一个元素时不报（单块内容占满是正常的，谈不上"没地方加"）', () => {
    const findings = checkLayout([{ type: 'text', left: 0, top: 0, width: 1000, height: 562.5 }]);
    expect(findings.some((f) => f.code === 'no-headroom')).toBe(false);
  });
});

/**
 * ★★ 改前/改后差集 —— **「是不是我改坏的」必须可算**（2026-10-10）。
 *
 * 学习者的原话：「**新增两处盒子高度不足……都是既有问题，我的改动是等长的**」。
 * 写入后诊断只在**写完**之后算一遍，所以它说得出"这页有 2 处装不下"，
 * 说不出"**改前就有这 2 处**"—— 而那句话纯算术、不需要渲染、不需要人眼。
 */
describe('★★ 版面差集：这次改动引入了什么 / 哪些是既有的', () => {
  const box = (height: number, content: string) => ({
    type: 'text',
    left: 0,
    top: 0,
    width: 400,
    height,
    content,
  });
  // 2 行 = 48px，盒高 30 ⇒ 边界（差额 18px < 一行 24px）
  const overflowing = `<p style="font-size: 16px;">${'字'.repeat(24)}</p>`;
  const fine = `<p style="font-size: 16px;">短句</p>`;

  it('★★ 同一条问题（只是估算数字变了）⇒ 算【既有】，不算新增', () => {
    const before = checkLayout([box(30, overflowing)]);
    // 多一个字 ⇒ 估算数字会变，但它还是同一条问题、挂在同一个元素上
    const after = checkLayout([box(30, overflowing.replace('</p>', '啊'.repeat(23) + '</p>'))]);
    expect(before[0]!.message).not.toBe(after[0]!.message);
    const delta = layoutDelta(before, after);
    expect(delta.added).toHaveLength(0);
    expect(delta.kept).toHaveLength(1);
  });

  it('★ 既有问题 ⇒ 人话直说"没有引入新的问题""不是你这次改出来的"', () => {
    const before = checkLayout([box(30, overflowing)]);
    const text = formatLayoutDelta(layoutDelta(before, checkLayout([box(30, overflowing)])));
    expect(text).toContain('没有引入新的问题');
    expect(text).toContain('不是你这次改出来的');
  });

  it('★ 新引入 ⇒ 点名"这次改动新引入了 N 处"', () => {
    const delta = layoutDelta(checkLayout([box(30, fine)]), checkLayout([box(30, overflowing)]));
    expect(delta.added).toHaveLength(1);
    expect(formatLayoutDelta(delta)).toContain('新引入了 1 处');
  });

  it('★ 改好了 ⇒ 说"修掉了"，不说成新增', () => {
    const delta = layoutDelta(checkLayout([box(30, overflowing)]), checkLayout([box(30, fine)]));
    expect(delta.removed).toHaveLength(1);
    expect(delta.added).toHaveLength(0);
    expect(formatLayoutDelta(delta)).toContain('修掉了 1 处');
  });

  it('★ 换了一个元素出问题 ⇒ 是**新增**（身份带元素下标）', () => {
    const before = checkLayout([
      box(30, overflowing),
      { type: 'text', left: 0, top: 200, width: 400, height: 30, content: fine },
    ]);
    const after = checkLayout([
      { type: 'text', left: 0, top: 0, width: 400, height: 30, content: fine },
      box(30, overflowing),
    ]);
    const delta = layoutDelta(before, after);
    expect(delta.added.map((f) => f.elementIndex)).toEqual([1]);
    expect(delta.removed.map((f) => f.elementIndex)).toEqual([0]);
  });

  it('★ 什么都没变 ⇒ 空串（调用方就别多说话）', () => {
    expect(
      formatLayoutDelta(layoutDelta(checkLayout([box(30, fine)]), checkLayout([box(30, fine)]))),
    ).toBe('');
  });

  it('★ 页面级的发现（没有元素下标）身份就是 code 本身', () => {
    expect(layoutFindingKey({ code: 'no-headroom', message: 'x' })).toBe('no-headroom');
    expect(
      layoutFindingKey({ code: 'overlaps', message: 'x', elementIndex: 1, elementIndex2: 3 }),
    ).toBe('overlaps:1,3');
  });
});
