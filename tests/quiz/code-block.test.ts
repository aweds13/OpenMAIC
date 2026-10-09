/**
 * ★ 「该不该是 `code` 元素」的两批规则（2026-10-09）。
 *
 * 这组判据钉的是**两批的边界**：多行代码块该转；单行片段留在 text 里。
 * 边界错一边的代价是实打实的 —— 多转会把一行表达式挤成一个带行号的黑框，
 * 少转会漏掉"能指某一行讲执行顺序"的那批。
 */
import { describe, expect, it } from 'vitest';

import { codeBlockVerdict } from '@/lib/quiz/code-block';

const element = (content: string) => ({ type: 'text', content });

describe('★ 代码块：多行转 code 元素 / 单行留 text', () => {
  it('★ 多行 + 整体等宽 + 有结构 ⇒ code-element（Day02 第 21 页那种双层 for）', () => {
    const html =
      '<p style="font-family:monospace;">for (int i=1; i&lt;=3; i++) {</p>' +
      '<p style="font-family:monospace;">&nbsp;&nbsp;for (int j=1; j&lt;=3; j++) {</p>' +
      '<p style="font-family:monospace;">&nbsp;&nbsp;&nbsp;&nbsp;System.out.print(i*j);</p>' +
      '<p style="font-family:monospace;">&nbsp;&nbsp;}</p>' +
      '<p style="font-family:monospace;">}</p>';
    expect(codeBlockVerdict(element(html))).toBe('code-element');
  });

  it('★ 单行片段 ⇒ keep-inline（转成代码块反而挤版式，也没行序可讲）', () => {
    expect(codeBlockVerdict(element('<p style="font-family:monospace;">int a = 1500000000, b = 1500000000;</p>'))).toBe(
      'keep-inline',
    );
  });

  it('★ 只有一处行内等宽、其余是正文 ⇒ keep-inline（"行内代码"不是代码块）', () => {
    const html =
      '<p style="font-size:16px;">一行配置对象：<span style="font-family: monospace;">obj..a=1..b=2</span></p>' +
      '<p style="font-size:16px;">替代 Java Builder，更简洁</p>';
    expect(codeBlockVerdict(element(html))).toBe('keep-inline');
  });

  it('★ 教学路线图（→ 串起来的章节名）⇒ keep-inline（这是收紧判据的理由之一）', () => {
    const html =
      '<p style="font-family:monospace;">路线：1.1 映射与函数 → 1.2 数列的极限 →</p>' +
      '<p style="font-family:monospace;">1.3 函数的极限（含无穷大量）→ 1.4 函数的连续性;</p>';
    // ★ 它整体等宽、还有两行、**恰好**一个分号 —— 按"出现过结构就算"会被判成代码块。
    //   改成"**过半**的行以 `;`/`{`/`}` 收尾"之后，它正确地留在 text 里。
    expect(codeBlockVerdict(element(html))).toBe('keep-inline');
  });

  it('★ 非 text 元素 / 空内容 ⇒ keep-inline（不误伤别的类型）', () => {
    expect(codeBlockVerdict({ type: 'shape', content: '<p>a;</p><p>b;</p>' })).toBe('keep-inline');
    expect(codeBlockVerdict(element(''))).toBe('keep-inline');
  });
});
