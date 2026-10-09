/**
 * ★★ **可编辑画布**（旧的那条 —— 本部署实际走的就是它）也必须认得 `code`。
 *
 * ── 这一条是用户的一张截图逼出来的 ──────────────────────────────
 *
 * 他看到的不是样式问题，而是一个灰盒子写着：
 *
 * ```
 * code element (not implemented)
 * ```
 *
 * 出处：`components/slide-renderer/Editor/Canvas/EditableElement.tsx` —— 它的元素表里
 * **根本没有 `code`**，于是走了下面那个占位分支。
 *
 * ── 为什么"给 code 加了渲染器"其实是**三处**（这才是真正的坑）──────
 *
 * | 路径 | 认不认 `code` |
 * |---|---|
 * | 播放：`ScreenElement` → 我们自己的 `BaseCodeElement` | 认 |
 * | **旧的可编辑画布：`Editor/Canvas` → `EditableElement`** | **原来不认**（就是这张截图） |
 * | 新渲染器：`@openmaic/renderer` 的 `SlideCanvas` → **上游自带的** `BaseCodeElement` | 认，**但那是上游的独立实现**（`packages/@openmaic/**` 只读，我们改不到） |
 *
 * 而 `.env.local` **没有** `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED`
 * ⇒ `isEditorRendererEnabled()` 为假 ⇒ `SlideCanvas` 用**旧的** `Editor/Canvas`
 * ⇒ 走的就是中间那条。所以用户看到占位块，而我把播放那条路的样式改得再好看也没用。
 *
 * ★ 这条判据钉的就是中间那一处。**改成"新渲染器"之后它的覆盖会失效** —— 那时候
 * 要盯的是上游那份实现（同样有仿 macOS 顶栏，但我们动不了，只能记进 `AGENTS.md`）。
 */
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CODE_ELEMENT = {
  id: 'code_TEST0001',
  type: 'code',
  left: 360,
  top: 180,
  width: 268,
  height: 142,
  rotate: 0,
  language: 'java',
  showLineNumbers: false,
  lines: [
    { id: 'code_TEST0001-l1', content: 'for (int i=1; i<=3; i++) {' },
    { id: 'code_TEST0001-l2', content: '  System.out.print("*");' },
    { id: 'code_TEST0001-l3', content: '}' },
  ],
};

/**
 * `EditableElement` 要一个场景上下文（`useSceneData` / `useSceneSelector`）。
 * 按 `tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts` 的成例打桩 ——
 * 这里要验的是**元素表有没有 `code`**，不是场景上下文本身。
 */
vi.mock('@/lib/contexts/scene-context', () => ({
  SceneProvider: ({ children }: { children: ReactNode }) => children,
  useSceneData: () => ({ sceneId: 'scene-1', updateSceneData: () => undefined }),
  useSceneSelector: () => ({
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: { backgroundColor: '#ffffff', themeColors: [], fontColor: '#333333', fontName: 'Inter' },
    elements: [CODE_ELEMENT],
  }),
}));

describe('★ 可编辑画布（旧的那条）必须认得 `code`', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  it('★ 传一个 `code` 元素进去，不许再出现 `(not implemented)` 占位块，而且要真的画出代码', async () => {
    const { EditableElement } = await import('@/components/slide-renderer/Editor/Canvas/EditableElement');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(EditableElement, {
          elementInfo: CODE_ELEMENT as never,
          elementIndex: 1,
          isMultiSelect: false,
          selectElement: () => undefined,
          openLinkDialog: () => undefined,
        }),
      );
    });

    const text = container.textContent ?? '';
    // ① 占位块必须消失（这就是用户截图里的那行字）
    expect(text).not.toContain('not implemented');
    // ② 而且**真的画出来了** —— 只看"没报错"会漏掉"渲染成空"这种情况
    expect(text).toContain('System.out.print');

    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    // ★ 30s：`await import` 会把 Operate / radix 整条依赖链拉进来，整包并行时 5s 会误红
    //   （与 `session-url-materials` 那条负载假红同因，本仓已记在 AGENTS §3.1）。
  }, 30_000);
});

/**
 * ★★ **第三处元素表**：选中时的"操作层"（缩放手柄/旋转）。
 *
 * 用户截图那次我只补了可编辑画布的**渲染**表；测出来的同一形状还有一处 ——
 * `Editor/Canvas/Operate/index.tsx` 也不认 `code`。缺了它，选中代码块**没有缩放手柄**
 * （调用处 `isSelected && CurrentOperateComponent` 直接短路）。而代码块的盒子恰恰最需要手调：
 * 它的内部开销与 `text` 元素不同（内边距 24 + 每行 1.6×字号 + 边框 2），
 * 照抄 `text` 的盒子会把内容挤出去 —— Day02 第 21 页就是这么坏的。
 *
 * ★ 这条判据**不去读源码文本**（那个手法本仓栽过一次：行为零变化也会碎），
 *   而是钉一条**派生关系**：`ElementTypes` 里有几种元素，操作层就得有几种。
 *   将来加新元素类型却漏了这张表，它会直接红。
 */
describe('★ 三处元素表：`code` 都要在（操作层这张用派生关系钉）', () => {
  it('★ 操作层覆盖 `ElementTypes` 的**全部**类型，且含 `code`', async () => {
    const { ELEMENT_OPERATE_COMPONENTS } = await import(
      '@/components/slide-renderer/Editor/Canvas/Operate/index'
    );
    const { ElementTypes } = await import('@openmaic/dsl');
    expect(Object.keys(ELEMENT_OPERATE_COMPONENTS).sort()).toEqual(Object.values(ElementTypes).sort());
    expect(ELEMENT_OPERATE_COMPONENTS[ElementTypes.CODE]).toBeTruthy();
  }, 30_000);
});
