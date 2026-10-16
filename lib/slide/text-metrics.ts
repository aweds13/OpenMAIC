/**
 * 文本框的排版度量 —— **渲染器与版面检查读的是同一个数**。
 *
 * ── 为什么它单独在一个文件里（2026-10-10，两轮实测逼出来的）──────────
 *
 * 「文字装不装得下」是**可算的**（元素本来就带坐标），但算它的参数**必须是渲染器
 * 实际用的值**。行高原先写在两处、而且是两个独立的字面量：
 *   · 渲染器的 Tailwind class：`BaseTextElement` / `TextElement` 的 `leading-[1.5]`；
 *   · 版面检查里的常数：`lib/quiz/layout-check.ts`（**曾经是 1.6 —— 错的那个**）。
 *
 * 两个字面量各自都能漂，而代价是实测过的：同一批 23 个盒子，行高 **1.5** 时用真 Edge
 * 量出真溢出 **3** 条，**1.6** 时 **20+** 条 ⇒ 估算的精确率只有 **13%**。
 *
 * ── 现在的形状 ────────────────────────────────────────────────
 *
 * · 渲染器把 `TEXT_LINE_HEIGHT` / `TEXT_PADDING_PX` **显式写进 DOM**（元素自己带
 *   `lineHeight` 时仍然优先 —— 库里确实有 1.15 那种页面）；
 * · `layout-check.ts`（`checkLayout` / `estimateTextHeightPx`）直接 import 这里；
 * · 判据在 `tests/components/slide-renderer/text-line-height-pin.test.ts`：渲染出来的
 *   DOM 与检查器的回落值必须是同一个数，且渲染器里不许再出现行高字面量。
 *
 * ★ **改这里的数 = 改所有页面的行高**（库里 1084 个 text 元素里**只有 5 个**带
 *   `lineHeight`：1.15×1、1.5×4 ⇒ 剩下那 1079 个生效的就是这个回落值）。
 *   要改先拿真 Edge 重量（`_tools/openmaic/diagnostics/measure-slide-fit.mjs`）。
 */

/** 一行文字的盒高相对字号的倍数。渲染器与检查器共用的**唯一**来源。 */
export const TEXT_LINE_HEIGHT = 1.5;

/**
 * `.element-content` 的内边距（`box-sizing: border-box`）——
 * 可用宽度是 `width − 2 × 这个值`，不是盒子全宽。
 *
 * ★ 渲染器**无条件**加这个内边距（`BaseTextElement` 与 `TextElement` 都是这一条路径）。
 *   实测本部署 1084 个 text 元素里**没有一个**的内容自带 `padding` ⇒ 那条"内容自带
 *   insets 时按 0 算"的分支在这里是死的，但它仍然是错的假设（见结论库）。
 */
export const TEXT_PADDING_PX = 10;
