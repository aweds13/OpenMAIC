/**
 * ★ 机械辅助检验：**字数带**（2026-10-08）—— 挂在两条写入路径共用的那处诊断里。
 *
 * 为什么机械层只做"太薄 / 过大"两头，中间**一个字都不说**：
 * 那句「每页 350–400 字」是**容量实测**，不是配额也不是上限（六条优先级里字数排最后）。
 * · 太薄（< 120）⇒ 知识没落到屏幕上（实测默认产出平均 61 汉字/页，真实课件 352–390）；
 * · 过大（> 800）⇒ **布局风险**（画布装不下，溢出或缩成灰块），不是"你写多了"；
 * · 120–800 之间**闭嘴** —— 那里只有带上下文的 LLM 审查有资格说话（page-review.ts）。
 */
import { describe, expect, it } from 'vitest';

import {
  sceneWriteDiagnosticsWithReview,
  sceneWriteDiagnostics,
  OVERFLOW_RISK_CHARS,
  THIN_PAGE_CHARS,
} from '@/lib/server/agent-runtime/scene-diagnostics';
import type { Scene } from '@/lib/types/stage';

const slide = (text: string): Scene =>
  ({
    id: 's1',
    stageId: 'stage-test',
    order: 1,
    type: 'slide',
    title: '一页',
    content: { type: 'slide', canvas: { elements: [{ type: 'text', content: text }] } },
    actions: [],
  }) as unknown as Scene;

const run = (text: string) =>
  sceneWriteDiagnostics({ scenes: [slide(text)], scene: slide(text), outline: undefined });

describe('★ 字数带（机械层）', () => {
  it('★ 太薄 ⇒ 说一句，并指向"加页"而不是"塞长句"', () => {
    const result = run('短');
    expect(result.bodyChars).toBeLessThan(THIN_PAGE_CHARS);
    expect(result.densityText).toContain('只有');
    expect(result.densityText).toMatch(/加页/);
  });

  it('★ 过大 ⇒ 说成**布局风险**，并指向"拆页"，不是"删内容"', () => {
    const result = run('字'.repeat(OVERFLOW_RISK_CHARS + 50));
    expect(result.bodyChars).toBeGreaterThan(OVERFLOW_RISK_CHARS);
    expect(result.densityText).toMatch(/布局风险/);
    expect(result.densityText).toMatch(/拆成 2–3 页/);
    // ★ 不许说成"你写多了"（那是把容量当配额 —— 正是这一轮改掉的那个错）
    expect(result.densityText).toMatch(/不是「你写多了」/);
  });

  it('★ 中间那段（120–800）机械层闭嘴', () => {
    const result = run('字'.repeat(400));
    expect(result.densityText).toBe('');
    expect(result.bodyChars).toBe(400);
  });

  it('★ 非 slide 页不算字数（正文不在 canvas 里）', () => {
    const quiz = {
      ...(slide('字'.repeat(10)) as unknown as Record<string, unknown>),
      type: 'quiz',
    } as unknown as Scene;
    const result = sceneWriteDiagnostics({ scenes: [quiz], scene: quiz, outline: undefined });
    expect(result.bodyChars).toBe(0);
    expect(result.densityText).toBe('');
  });
});

/**
 * ★ LLM 那一半：写入之后**连上下文**再审一遍这一页（`page-review.ts`）。
 *
 * 三件必须钉住的（否则就是"半成品挂在写入路径上"）：
 * ① 传了 `reviewPage` ⇒ 结论**拼进工具回话**（agent 看得见）；
 * ② 审查**抛错要吞掉** —— 没验成就是没验成，**绝不能让写入失败**；
 * ③ 没传 ⇒ **一个字不加**（部署没配模型时，行为与以前完全一致）。
 */
describe('★ 写入后带上下文再审一遍（LLM 那一半）', () => {
  const input = () => ({
    scenes: [slide('这一页的内容')],
    scene: slide('这一页的内容'),
    outline: undefined,
  });

  it('★ 传了 reviewPage ⇒ 结论与"带前面讲过的页"一起拼进回话', async () => {
    const result = await sceneWriteDiagnosticsWithReview(input(), {
      reviewPage: async () => ({ findings: '第 1 页：轴 2 —— 掉了一个动词。' }),
    });
    expect(result.pageReviewText).toContain('掉了一个动词');
    expect(result.pageReviewText).toMatch(/前面已经讲过的页/);
  });

  it('★ 审查抛错 ⇒ 吞掉，机械那一半照常（绝不让写入失败）', async () => {
    const result = await sceneWriteDiagnosticsWithReview(input(), {
      reviewPage: async () => {
        throw new Error('模型挂了');
      },
    });
    expect(result.pageReviewText).toBe('');
    expect(result.bodyChars).toBeGreaterThan(0);
  });

  it('★ 没传 ⇒ 一个字不加', async () => {
    const result = await sceneWriteDiagnosticsWithReview(input());
    expect(result.pageReviewText).toBe('');
  });
});

/**
 * ★★ 版面的**改前/改后差集**（2026-10-10）。
 *
 * 学习者原话：「**新增两处盒子高度不足……都是既有问题，我的改动是等长的**」——
 * 他在替工具做因果判断。`patch_stage` 现在把**改动前那一页**也传进来，
 * 于是"这次引入了什么 / 哪些是既有的"变成回话里的一句话。
 */
describe('★★ 版面差集：patch_stage 才拿得到"改前那一页"', () => {
  const page = (text: string, height: number): Scene =>
    ({
      id: 's1',
      stageId: 'stage-test',
      order: 1,
      type: 'slide',
      title: '一页',
      content: {
        type: 'slide',
        canvas: {
          elements: [{ type: 'text', left: 0, top: 0, width: 400, height, content: text }],
        },
      },
      actions: [],
    }) as unknown as Scene;
  // 24 个汉字 @16px、可用宽 380 ⇒ 2 行 = 48px
  const overflowing = `<p style="font-size: 16px;">${'字'.repeat(24)}</p>`;

  it('★★ 改前就有（等长改动）⇒ 明说"不是这次改出来的"', () => {
    const result = sceneWriteDiagnostics({
      scenes: [page(overflowing, 30)],
      scene: page(overflowing.replace('字', '文'), 30),
      previousScene: page(overflowing, 30),
      outline: undefined,
    });
    expect(result.layoutDeltaText).toContain('不是你这次改出来的');
    expect(result.layoutDelta.added).toHaveLength(0);
    expect(result.layoutDelta.kept).toHaveLength(1);
  });

  it('★ 这次改出来的 ⇒ 点名"新引入了"', () => {
    const result = sceneWriteDiagnostics({
      scenes: [page(overflowing, 30)],
      scene: page(overflowing, 30),
      previousScene: page('短句', 30),
      outline: undefined,
    });
    expect(result.layoutDeltaText).toContain('新引入了 1 处');
  });

  it('★ 没给 previousScene（generate_scene 写新页）⇒ 一个字都不说', () => {
    const result = sceneWriteDiagnostics({
      scenes: [page(overflowing, 30)],
      scene: page(overflowing, 30),
      outline: undefined,
    });
    expect(result.layoutDeltaText).toBe('');
    expect(result.layoutDelta).toEqual({ added: [], removed: [], kept: [] });
  });
});
