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
  formatLayoutFindings,
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
    const findings = checkLayout([{ type: 'text', left: 40, top: 40, width: 400, height: 60, content: long }]);
    expect(findings.some((f) => f.code === 'text-does-not-fit')).toBe(true);
    expect(formatLayoutFindings(findings)).toContain('加一页');
  });

  it('★ 字号过小：低于 14px 要报（"缩成灰块"是学习者点过名的失败模式）', () => {
    const findings = checkLayout([
      { type: 'text', left: 40, top: 40, width: 400, height: 120, content: '<p style="font-size: 11px;">短句</p>' },
    ]);
    expect(findings.some((f) => f.code === 'font-too-small')).toBe(true);
  });

  it('★ 重叠：压住 15% 以上才报，贴边不算（背景块 + 文字是正常设计）', () => {
    const heavy = checkLayout([
      { type: 'shape', left: 100, top: 100, width: 200, height: 100 },
      { type: 'text', left: 110, top: 105, width: 200, height: 100 },
    ]);
    expect(heavy.some((f) => f.code === 'overlaps')).toBe(true);
    const graze = checkLayout([
      { type: 'shape', left: 100, top: 100, width: 200, height: 100 },
      { type: 'text', left: 295, top: 100, width: 200, height: 100 },
    ]);
    expect(graze.some((f) => f.code === 'overlaps')).toBe(false);
  });

  it('★ 正常的页**一个字都不多说**（诊断不能变成噪声）', () => {
    const findings = checkLayout([
      {
        type: 'text', left: 40, top: 40, width: 920, height: 200,
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
    expect(maxFontSizePx('<p style="font-size: 16px;">a</p><p style="font-size: 32px;">b</p>')).toBe(32);
    expect(maxFontSizePx('<p>没有字号</p>')).toBeUndefined();
    expect(estimateTextHeightPx('<p>一</p>', 400, 20)).toBeGreaterThan(0);
  });
});
