/**
 * 「改完这一页，它现在读得通吗」—— **带上下文**的轻量审查。
 *
 * 用户的原话是这一条的全部理由：「但是有的上面的 ppt 讲了，**不能孤立地看**」。
 * 所以这组判据钉的就是那三件：① 前面讲过的**不许**算成缺口；② 只报**这一页**；
 * ③ 验不成**不许**当成"没问题"、更不许挡住写入。
 */
import { describe, expect, it, vi } from 'vitest';

import { collectPageWithEarlier, reviewPageWithContext } from '@/lib/server/agent-runtime/page-review';
import type { VisibleTextPage } from '@/lib/quiz/page-text';

const slide = (order: number, text: string): VisibleTextPage => ({
  order,
  type: 'slide',
  title: `第 ${order} 页标题`,
  content: { canvas: { elements: [{ type: 'text', content: text }] } },
});

describe('★ 带上下文的单页审查', () => {
  it('★ 前面讲过的页要**一起**给模型，并且明说"学生已经读过"', async () => {
    const aiCall = vi.fn(async (_system: string, _user: string) => '第 3 页没问题。');
    const result = await reviewPageWithContext(
      { scenes: [slide(1, 'byte 的范围是 -128 到 127'), slide(2, '算术运算符'), slide(3, '用 byte 存年龄')], order: 3 },
      { aiCall: aiCall as never },
    );
    expect(result?.pages).toEqual([1, 2, 3]);
    const [system] = aiCall.mock.calls[0]!;
    // ① 上下文真的进去了（否则就是"孤立地看"）
    expect(String(system)).toContain('byte 的范围是 -128 到 127');
    expect(String(system)).toContain('学生已经读过');
    // ② 规矩里明说"前面讲过的不算缺口"
    expect(String(system)).toMatch(/anywhere above the last page/);
    // ③ 只谈这一页
    expect(String(system)).toMatch(/Report ONLY problems that belong to the LAST page/);
    // 「只谈最后一页」在**用户话**里（system 里那条是英文规矩）
    expect(String(aiCall.mock.calls[0]![1])).toContain('只谈最后一页');
  });

  it('★ 上下文按"从最近往前"取，且**这一页总是全量**（截断它等于让它看起来没讲）', async () => {
    const long = '甲'.repeat(500);
    const collected = await collectPageWithEarlier(
      { scenes: [slide(1, long), slide(2, long), slide(3, '这一页很短但不能被砍')], order: 3 },
      { maxContextChars: 600 },
    );
    // 预算 600：只能装下紧邻的第 2 页（500），第 1 页装不下 ⇒ 不带
    expect(collected?.earlier.map((page) => page.order)).toEqual([2]);
    expect(collected?.target.text).toContain('这一页很短但不能被砍');
  });

  it('★ 渲染失败的 interactive 页不冒充"学生读过的东西"', async () => {
    const interactive: VisibleTextPage = {
      order: 2,
      type: 'interactive',
      title: '动手页',
      content: { html: '<html><body><script>init()</script></body></html>' },
    };
    const collected = await collectPageWithEarlier(
      { scenes: [interactive, slide(3, '目标页')], order: 3 },
      { render: async () => ({ text: '', errors: ['缺 CDN 全局'] }) },
    );
    // 它只产出源码 ⇒ 不进上文（否则会得出"前面讲过"的假结论）
    expect(collected?.earlier).toEqual([]);
  });

  it('★ 模型没给出话 ⇒ 返回 null（"没验成"不是"没问题"）', async () => {
    const empty = await reviewPageWithContext(
      { scenes: [slide(1, 'x')], order: 1 },
      { aiCall: (async () => '   ') as never },
    );
    expect(empty).toBeNull();
  });

  it('★ 没有这一页 ⇒ null（不抛）', async () => {
    const missing = await reviewPageWithContext(
      { scenes: [slide(1, 'x')], order: 9 },
      { aiCall: (async () => 'x') as never },
    );
    expect(missing).toBeNull();
  });

  it('★ 第一页也能审（前面没有任何页，规矩里说明白）', async () => {
    const aiCall = vi.fn(async (_system: string, _user: string) => '第 1 页没问题。');
    await reviewPageWithContext({ scenes: [slide(1, '开场')], order: 1 }, { aiCall: aiCall as never });
    expect(String(aiCall.mock.calls[0]![0])).toContain('这是第一页');
  });
});
