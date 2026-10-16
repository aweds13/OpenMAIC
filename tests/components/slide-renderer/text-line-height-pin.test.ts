/**
 * 文本框的行高（与内边距）**只有一个来源** —— 渲染器写进 DOM 的那个数，就是检查器读的那个数。
 *
 * ── 为什么这条要钉住（2026-10-10，两轮实测逼出来的）──────────────────
 *
 * 「文字装不装得下」是可算的，但算它的参数**必须是渲染器实际用的值**。原先行高写在两处、
 * 是两个各自会漂的字面量：渲染器 class 里的 `leading-[1.5]`，和版面检查里的常数（**1.6**）。
 *
 * | | 同一批 23 个盒子（真 Edge 量） |
 * |---|---|
 * | 按 1.5 判 | 真溢出 **3** 条（第 50 页 el14 / 第 55 页 el10 / 第 74 页 el14） |
 * | 按 1.6 判 | **20+** 条 ⇒ 精确率 **3/23 ≈ 13%** |
 *
 * 而库里 **1084 个 text 元素只有 5 个**带 `lineHeight`（1.15×1、1.5×4）⇒ 剩下 1079 个
 * 生效的都是"回落值"。所以这个数一旦两侧不一致，检查器就会**整批判错**，而不是偶尔错。
 *
 * ── 这套判据在守什么（四道）─────────────────────────────────────
 *
 * 1. 渲染出来的 DOM 里**看得见行高**（不再只靠 class —— class 的值检查器读不到）；
 * 2. 元素自己带 `lineHeight` 时**仍然优先**（库里那些 1.15 的页面不能被抹平）；
 * 3. 检查器算出来的高度**就是**用这个数算的（把盒子高度卡在 1.5↔1.6 之间：1.6 会报、1.5 不报）；
 * 4. 源码里**不许再出现**行高/内边距字面量（两个写入侧 + 检查器都 import 同一份）。
 *
 * 变异一次就知道有没有用：把 `TEXT_LINE_HEIGHT` 改成 1.6 ⇒ 第 3 条红；把 class 里的
 * `leading-[1.5]` 加回去 ⇒ 第 1、4 条红；把 `elementInfo.lineHeight ?? …` 的回落删掉 ⇒ 第 1 条红。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseTextElement } from '@/components/slide-renderer/components/element/TextElement/BaseTextElement';
import { checkLayout, estimateTextHeightPx, type LayoutElement } from '@/lib/quiz/layout-check';
import { TEXT_LINE_HEIGHT, TEXT_PADDING_PX } from '@/lib/slide/text-metrics';

/** 同一个文本框的两个渲染站点：播放（只读）与编辑器。 */
const RENDER_SITES = [
  'components/slide-renderer/components/element/TextElement/BaseTextElement.tsx',
  'components/slide-renderer/components/element/TextElement/index.tsx',
];
const CHECKER = 'lib/quiz/layout-check.ts';

const elementInfo = (over: Record<string, unknown> = {}) =>
  ({
    id: 'text_TEST0001',
    type: 'text',
    left: 100,
    top: 100,
    width: 400,
    height: 120,
    rotate: 0,
    content: '<p style="font-size: 20px">装得下吗</p>',
    ...over,
  }) as never;

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/**
 * 尺子：源码里还留着行高/内边距**字面量**的文件（class 里的 `leading-[…]` / `p-[…px]`）。
 *
 * 先剥注释：这个文件本身会**解释**那段历史（注释里当然会出现 `leading-[1.5]` 这些字样），
 * 要守的是代码里的 class，不是散文。
 */
function literalOffenders(files: { path: string; text: string }[]): string[] {
  return files
    .filter((file) => {
      const code = file.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return /leading-\[|["'\s]p-\[\d+px\]/.test(code);
    })
    .map((file) => file.path);
}

/** 尺子：在检查器里**重新定义**这两个常数（`const LINE_HEIGHT_RATIO = …` 那种）。 */
function redefinesMetrics(text: string): boolean {
  return /const\s+(?:LINE_HEIGHT_RATIO|TEXT_PADDING_PX)\s*=/.test(text);
}

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

const renderText = (over: Record<string, unknown> = {}) => {
  act(() => root.render(createElement(BaseTextElement, { elementInfo: elementInfo(over) })));
  const box = container.querySelector<HTMLElement>('.element-content');
  if (box === null) throw new Error('没渲染出 .element-content —— 选择器或组件结构变了');
  return box;
};

describe('行高/内边距：渲染器那一侧看得见', () => {
  it('★ 元素没有 lineHeight 时，渲染器把回落值**显式写进 DOM**', () => {
    const box = renderText();
    expect(box.style.lineHeight).toBe('1.5');
    expect(box.style.padding).toBe('10px');
    // 不许再靠 class 里的字面量：class 里的值检查器读不到，就是漂的源头。
    expect(box.className).not.toMatch(/leading-\[/);
    expect(box.className).not.toMatch(/p-\[/);
  });

  it('★ 元素自己带 lineHeight 时**仍然优先**（库里那 5 个带字段的元素）', () => {
    expect(renderText({ lineHeight: 1.15 }).style.lineHeight).toBe('1.15');
    expect(renderText({ lineHeight: 2 }).style.lineHeight).toBe('2');
  });

  it('★ 常量本身是这个数 —— 改它等于改所有页面的行高，必须先重量', () => {
    // 钉字面量不是仪式：库里 1079/1084 个 text 元素生效的就是它。
    expect(TEXT_LINE_HEIGHT).toBe(1.5);
    expect(TEXT_PADDING_PX).toBe(10);
  });
});

describe('行高/内边距：检查器读的是同一个数', () => {
  // 20 个汉字、20px 字号、盒宽 200 ⇒ 可用宽 180 ⇒ 每行 9 个字 ⇒ 3 行 ⇒ 高 = 3×20×行高。
  const content = `<p style="font-size: 20px">${'中'.repeat(20)}</p>`;
  const element = (height: number): LayoutElement => ({
    type: 'text',
    left: 0,
    top: 0,
    width: 200,
    height,
    content,
  });
  const fits = (height: number) =>
    checkLayout([element(height)]).filter((finding) => finding.code === 'text-does-not-fit');

  it('★ 估算高度 = 行数 × 字号 × 这个行高（1.6 会是 96，那就整批误报）', () => {
    expect(estimateTextHeightPx(content, 200, 20)).toBe(3 * 20 * TEXT_LINE_HEIGHT);
    expect(estimateTextHeightPx(content, 200, 20)).toBe(90);
    // 可用宽度扣的是**渲染器那个内边距**，不是盒子全宽：不扣就会算成 2 行。
    expect(estimateTextHeightPx(content, 200, 20, TEXT_LINE_HEIGHT, true)).toBe(
      2 * 20 * TEXT_LINE_HEIGHT,
    );
  });

  it('★★ 盒高卡在 1.5 与 1.6 之间：1.5 判"装得下"、1.6 判"装不下" —— 两侧同源的硬证据', () => {
    expect(fits(92)).toHaveLength(0); // 需要 90px，盒子 92px ⇒ 装得下
    expect(fits(80).length).toBeGreaterThan(0); // 需要 90px，盒子 80px ⇒ 真的装不下（差额 > 一行）
    // 若这条红在"盒高 92"那一行：检查器的行高与渲染器不一致了（1.6 需要 96px）。
  });
});

describe('行高/内边距：只许有一个来源', () => {
  it('★★ 两个渲染站点 + 检查器都 import 同一份，且没有谁再写字面量', () => {
    const sites = RENDER_SITES.map((path) => ({ path, text: read(path) }));
    // 阳性对照：尺子抓得到字面量，否则下面那个 `[]` 是空的空转。
    expect(
      literalOffenders([
        {
          path: 'synthetic',
          text: 'className="element-content p-[10px] leading-[1.5] break-words"',
        },
      ]),
    ).toEqual(['synthetic']);
    expect(literalOffenders(sites)).toEqual([]);
    for (const site of sites) expect(site.text).toContain("from '@/lib/slide/text-metrics'");

    const checker = read(CHECKER);
    expect(checker).toContain("from '@/lib/slide/text-metrics'");
    expect(redefinesMetrics('const LINE_HEIGHT_RATIO = 1.5;')).toBe(true); // 阳性对照
    expect(redefinesMetrics(checker)).toBe(false);
  });
});
