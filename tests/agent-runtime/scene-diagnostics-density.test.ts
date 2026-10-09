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

import { sceneWriteDiagnostics, OVERFLOW_RISK_CHARS, THIN_PAGE_CHARS } from '@/lib/server/agent-runtime/scene-diagnostics';
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
    expect(result.densityText).not.toMatch(/写多了/);
  });

  it('★ 中间那段（120–800）机械层闭嘴', () => {
    const result = run('字'.repeat(400));
    expect(result.densityText).toBe('');
    expect(result.bodyChars).toBe(400);
  });

  it('★ 非 slide 页不算字数（正文不在 canvas 里）', () => {
    const quiz = { ...(slide('字'.repeat(10)) as unknown as Record<string, unknown>), type: 'quiz' } as unknown as Scene;
    const result = sceneWriteDiagnostics({ scenes: [quiz], scene: quiz, outline: undefined });
    expect(result.bodyChars).toBe(0);
    expect(result.densityText).toBe('');
  });
});
