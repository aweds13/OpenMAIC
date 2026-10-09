/**
 * `code` 元素在**幻灯片上**长什么样 —— 两条：**不许有仿编辑器顶栏**、**行号默认关**。
 *
 * ── 为什么这两条要钉住（2026-10-09）──────────────────────────────
 *
 * 这个元素是那轮"把存量代码块转成 `code` 元素"做出来的，第一页（Day02 第 21 页）
 * 转完给用户看，他的原话是「**感觉这个代码块丑丑的**」。量了一遍，不只是丑：
 *
 * | | 实测（盒子 250×127，5 行代码） |
 * |---|---|
 * | 顶栏（仿 macOS 三点 + `JAVA` 标签） | **32px + 1px**，占盒子高度的 **26%** |
 * | 加上内边距与 5 行 × 22.4px | 代码区只剩 **93px** 装 **128px** ⇒ **纵向溢出 35px** |
 * | 行号槽 `3.5em` | ≈ **49px + 16px**，占盒子宽度 **20%** ⇒ **横向溢出 47px** |
 *
 * 也就是：**第 5 行的 `}` 看不见、最长一行右边被切**。照抄代码的人会以为
 * `System.out.print("*");` 就长那样。
 *
 * 修法：顶栏整条删掉（浅底 + 细边框就够）、行号**默认关**（它是 per-element 开关 ——
 * 盒子够宽时才划算；实测 268px 宽开行号仍横向溢出 13px）。
 *
 * ── 这套判据是干什么的 ─────────────────────────────────────────
 *
 * 它**不测美术**，测的是"那两样东西有没有偷偷回来"：
 * 顶栏一旦被谁加回去，`boxShadow`/三点的断言就红；行号默认值一旦改回 `true`，
 * 第二条就红。没有这两条，上面那 35px / 47px 的溢出会**静默复发**。
 */
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseCodeElement } from '@/components/slide-renderer/components/element/CodeElement/BaseCodeElement';

const LINES = [
  'for (int i=1; i<=3; i++) {',
  '  for (int j=1; j<=3; j++) {',
  '    System.out.print("*");',
  '  } System.out.println();',
  '}',
];

const elementInfo = (over: Record<string, unknown> = {}) =>
  ({
    id: 'code_TEST0001',
    type: 'code',
    left: 360,
    top: 180,
    width: 268,
    height: 142,
    rotate: 0,
    language: 'java',
    lines: LINES.map((content, index) => ({ id: `code_TEST0001-l${index + 1}`, content })),
    ...over,
  }) as never;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // 与 tests/components 里其它渲染测试同一套（仓库没有 @testing-library）。
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(info: unknown) {
  act(() => {
    root.render(createElement(BaseCodeElement, { elementInfo: info as never }));
  });
  return container;
}

describe('★ `code` 元素：幻灯片上不许有仿编辑器顶栏，行号默认关', () => {
  it('★ 代码本身要真的渲染出来（五行都在）', () => {
    const dom = render(elementInfo());
    for (const line of LINES) {
      expect(dom.textContent).toContain(line.trim());
    }
  });

  it('★ 没有仿 macOS 编辑器的顶栏：不许有红黄绿三点，也不许有语言标签', () => {
    const dom = render(elementInfo());
    const colors = Array.from(dom.querySelectorAll<HTMLElement>('div')).map((node) => node.style.background);
    // 顶栏那三个点用的是这三个色（见 git 历史里的 #ff5f57 / #febc2e / #28c840）
    for (const trafficLight of ['rgb(255, 95, 87)', '#ff5f57', 'rgb(254, 188, 46)', '#febc2e', 'rgb(40, 200, 64)', '#28c840']) {
      expect(colors, `顶栏的圆点回来了（${trafficLight}）`).not.toContain(trafficLight);
    }
    expect(dom.textContent?.toUpperCase()).not.toContain('JAVA');
  });

  it('★ 卡片本身要"安静"：没有投影（投影 + 圆角 + 三点合起来才像浮起来的窗口）', () => {
    const dom = render(elementInfo());
    const box = dom.querySelector<HTMLElement>('.element-content');
    expect(box).not.toBeNull();
    expect(box?.style.boxShadow).toBe('');
  });

  it('★ 行号**默认不显示**（改成 `true` 会让这条红 —— 那是上面 20% 宽度被吃掉的原因）', () => {
    const dom = render(elementInfo());
    const numbers = Array.from(dom.querySelectorAll<HTMLElement>('span'))
      .map((node) => node.textContent?.trim())
      .filter((text) => text !== undefined && /^[1-9]$/.test(text));
    expect(numbers, '行号槽默认不该出现').toEqual([]);
  });

  it('★ 但行号仍是**可用**的开关（盒子够宽时打开它）', () => {
    const dom = render(elementInfo({ showLineNumbers: true }));
    const numbers = Array.from(dom.querySelectorAll<HTMLElement>('span'))
      .map((node) => node.textContent?.trim())
      .filter((text) => text !== undefined && /^[1-9]$/.test(text));
    expect(numbers).toEqual(['1', '2', '3', '4', '5']);
  });
});
