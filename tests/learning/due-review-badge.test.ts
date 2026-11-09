import { describe, expect, it } from 'vitest';
import { badgeText } from '@/components/learning/due-review-badge';

/**
 * 首页复习角标的**判定**（不渲染组件：仓里没有 React 渲染测试库，
 * 而这组件真正会错的地方是「什么时候该说话」）。
 *
 * 三种状态必须分得开：
 * - 读到 0 ⇒ 不说（没有到期复习是常态，一块「0」是噪声）。
 * - 读到 n > 0 ⇒ 说 n。
 * - **没读到（`null`）⇒ 也不说**。
 *
 * 第三条最要紧。把「没读到」画成「没有」正是复习页自己最不该犯的错 ——
 * `due-review-list.tsx` 里 `readFailed` 与 `empty` 是两句不同的话。
 * 角标只有一块地方，说不了两句话，所以它沉默；代价是「今天有 3 关却没提示」，
 * 而反过来（明明有 3 关却说没有）会让人真的不去复习。
 */
describe('复习角标显示什么', () => {
  it('没读到 —— 沉默，不许画成「0 关」', () => {
    expect(badgeText(null)).toBeNull();
  });

  it('读到 0 —— 也沉默（没有到期复习是常态）', () => {
    expect(badgeText(0)).toBeNull();
  });

  it('读到正数就写那个数', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(3)).toBe('3');
    expect(badgeText(49)).toBe('49');
  });

  it('★ 到上限写「50+」而不是「50」—— 服务端只回到 50 条，再多的看不到', () => {
    expect(badgeText(50)).toBe('50+');
    expect(badgeText(200)).toBe('50+');
  });

  it('负数当没有（服务端不会回，但别让一块「-1」挂上去）', () => {
    expect(badgeText(-1)).toBeNull();
  });
});
