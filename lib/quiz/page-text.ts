/**
 * 「学生实际看得见的文字」—— 一门课里**一页到底给学生看了什么**的唯一单位。
 *
 * ── 为什么必须有这一个单位（这是被三次假阳性逼出来的）──────────────
 *
 * 一次零基础审查 agent 的干跑里，它报了 **5 页"没有题干、没有代码、参考答案是空的"**，
 * 全是假的 —— 因为喂给它的文本只抽了 `slide` 的正文。实测：
 *
 * | 类型 | 正文在哪 | n |
 * |---|---|---|
 * | `slide` | `content.canvas.elements[].content`（**是 HTML**） | 55 |
 * | `quiz` | `content.questions[]` 的题干 / 选项 / 解析 | 4 |
 * | `pbl` | `content.projectV2` 的标题 / gains / roles[].description | 4 |
 * | `interactive` | **`content.html` 是一份完整的自包含文档，正文由它自己的 `<script>` 在 `init()` 里建出来** | 20 |
 *
 * interactive 那 20 页里，**8 页（第 17/28/36/38/42/44/52/57 页）的数据只存在于内联 JS 字面量里**
 * ⇒ 任何"抽静态文本"的做法都会把它们看成空页。实测 jsdom 真跑 `init()` 之后：
 * 第 28 页 48,080 字符的 html → **34,952 字**正文（含「参考答案」「检查项」「已通过 0 / 3」）。
 *
 * ── 和 `coverage-gap.extractTaughtText` 的关系：同一把尺子，**方向相反** ──
 *
 * `extractTaughtText` **故意少收**（它自己的注释写着：少收让"已教"变小 ⇒ 偏向误报覆盖缺口）。
 * 审查 agent 需要的是**尽量全收** —— 少收一页，它就会指着那页说"你没讲"。
 * 所以两者**不能共用策略**，只能共用 `stripMarkup`（HTML 必须剥，见 AGENTS.md §6.7）。
 * 本模块是"全收"的那一侧。
 *
 * ── 渲染失败必须退回源码，并且**说出来** ─────────────────────────
 *
 * 实测第 17 页：它从 CDN 引 KaTeX，jsdom 无网 ⇒ `renderMathInElement is not defined`
 * ⇒ 它的 `DOMContentLoaded` 抛异常、`init()` 没跑完 ⇒ 正文 **0 字**。
 * 如果不处理，这个失败就会变成新一代"报空页"的假阳性源 —— 和大模型审查上一轮犯的是同一个错。
 * 所以渲染失败/空结果一律 `mode: 'source'`，把源码交出去，并带一句 note 让审查者知道
 * 自己读的是源码而不是学生看到的东西。
 *
 * ── 已知边界（照实说）────────────────────────────────────────────
 *
 * · 渲染靠 **jsdom**（进程内、离线、可测），不是真 Chromium。它**不加载外部资源**
 *   （CDN 的 CSS/JS 一律没有），所以依赖 CDN 全局的页要走桩表（见 `CDN_GLOBAL_STUBS`）。
 *   另一条路是 8730 的真浏览器，但它只收 http(s)，而工作台**没有"深链到某一页"的参数**
 *   （只有 `?course=` / `?session=`），要走它得先加一个只读的单页路由。
 * · `jsdom` **只许动态 import**（仓里有成例：`use-export-pptx` 那条"重东西不许静态 import"，
 *   静态引会把整个解析器拖进主 bundle）。
 */
import { stripMarkup } from '@/lib/quiz/coverage-gap';

/** 审计/审查看到的一页。只需身份与内容，不依赖生成包的类型。 */
export interface VisibleTextPage {
  order: number;
  type?: string;
  title?: string;
  content: unknown;
}

/**
 * 审查 agent 拿到的这一页文本。
 *
 * `mode` 是**给模型看的**，不是给日志看的：`source` 表示"这不是学生看到的东西"，
 * 审查者据此必须把结论降级（例如不能断言"这一页没讲 X"，只能说"我在源码里没找到 X"）。
 */
export interface VisiblePageText {
  order: number;
  title: string;
  type: string;
  text: string;
  mode: 'static' | 'rendered' | 'source';
  /** 渲染失败等原因，一句话。非空时审查者必须知道。 */
  note?: string;
}

/**
 * jsdom 里不存在的**浏览器/CDN 全局**的空实现。
 *
 * 页面自己 `init()` 之前常常先调这些（数学公式、代码高亮、图表）。缺一个就抛异常，
 * 而它们**都在 `DOMContentLoaded` 的回调里** —— 抛了就再也走不到 `init()`，正文全空。
 * 桩成空函数就能让 `init()` 跑完：学生看不到公式的渲染结果，但**文字**都还在。
 */
const CDN_GLOBAL_STUBS: Record<string, unknown> = {
  renderMathInElement: () => undefined,
  katex: { render: () => undefined, renderToString: () => '' },
  MathJax: { typesetPromise: () => Promise.resolve(), startup: { promise: Promise.resolve() } },
  hljs: { highlightAll: () => undefined, highlightElement: () => undefined },
  mermaid: { initialize: () => undefined, run: () => Promise.resolve() },
  CodeMirror: () => undefined,
  Prism: { highlightAll: () => undefined },
};

/** `slide` 的正文：文本元素的 `content` 是 HTML，表格的 `data[][].text` 是纯文本。 */
function slideText(content: unknown): string {
  const canvas = (content as { canvas?: { elements?: unknown[] } } | null)?.canvas;
  const parts: string[] = [];
  const walk = (node: unknown, key: string | undefined, depth: number): void => {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (key === 'content' || key === 'text') parts.push(stripMarkup(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, childKey, depth + 1);
    }
  };
  walk(canvas?.elements ?? [], undefined, 0);
  return parts.filter(Boolean).join(' ');
}

/** `quiz` 的正文：题干 / 选项文字 / 解析（选项字母 `value` 不算内容）。 */
function quizText(content: unknown): string {
  const questions = (content as { questions?: unknown[] } | null)?.questions ?? [];
  const parts: string[] = [];
  for (const question of questions as Array<Record<string, unknown>>) {
    for (const field of ['question', 'analysis'] as const) {
      const value = question[field];
      if (typeof value === 'string') parts.push(stripMarkup(value));
    }
    for (const option of (question.options as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof option.label === 'string') parts.push(stripMarkup(option.label));
    }
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * `pbl` 的正文：项目标题 / gains / 各角色的 description。
 *
 * ★ **故意不收 `roles[].systemPrompt`** —— 那是**给 agent 的**提示词，学生看不到。
 * 收进来会让审查者拿学生看不见的话去证明"这一页讲过了"。回归 pin 就在测试里。
 */
function pblText(content: unknown): string {
  const project = (content as { projectV2?: Record<string, unknown> } | null)?.projectV2;
  if (!project) return '';
  const parts: string[] = [];
  if (typeof project.title === 'string') parts.push(stripMarkup(project.title));
  for (const gain of (project.gains as unknown[] | undefined) ?? []) {
    if (typeof gain === 'string') parts.push(stripMarkup(gain));
  }
  for (const role of (project.roles as Array<Record<string, unknown>> | undefined) ?? []) {
    for (const field of ['name', 'description'] as const) {
      if (typeof role[field] === 'string') parts.push(stripMarkup(role[field] as string));
    }
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * `interactive` **没有渲染时**能拿到的文字：widget 的数据字段 + 外壳 HTML 的可见文字。
 *
 * 只有渲染失败才用它。`hints` / `solution` / `starterCode` / `testCases[].description`
 * 都是学生点开就能看到的，所以算"可见"。
 */
function interactiveSourceText(content: unknown): string {
  const parts: string[] = [];
  const config = (content as { widgetConfig?: Record<string, unknown> } | null)?.widgetConfig;
  if (config) {
    for (const field of ['description', 'starterCode', 'solution'] as const) {
      const value = config[field];
      if (typeof value === 'string') parts.push(value);
    }
    for (const hint of (config.hints as unknown[] | undefined) ?? []) {
      if (typeof hint === 'string') parts.push(hint);
    }
    for (const test of (config.testCases as Array<Record<string, unknown>> | undefined) ?? []) {
      for (const field of ['description', 'expected'] as const) {
        if (typeof test[field] === 'string') parts.push(test[field] as string);
      }
    }
  }
  const html = (content as { html?: string } | null)?.html;
  if (typeof html === 'string' && !config) parts.push(stripMarkup(html));
  return parts.filter(Boolean).join(' ');
}

/** 静态可读文本 —— `slide` / `quiz` / `pbl` 用它就够（精确）；`interactive` 只是外壳。 */
export function staticPageText(page: VisibleTextPage): string {
  const type = page.type ?? 'slide';
  if (type === 'quiz') return quizText(page.content);
  if (type === 'pbl') return pblText(page.content);
  if (type === 'interactive') return interactiveSourceText(page.content);
  return slideText(page.content);
}

/** 渲染一页 interactive 的 HTML（学生看到的 DOM 文本）。失败就抛，由调用方退回源码。 */
export async function renderPageHtml(
  html: string,
  options?: { timeoutMs?: number },
): Promise<{ text: string; errors: string[] }> {
  // ★ 只许动态 import：静态引会把解析器拖进主 bundle（照 use-export-pptx 那条成例）。
  const { JSDOM, VirtualConsole } = (await import('jsdom')) as typeof import('jsdom');
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
  virtualConsole.on('error', (message: unknown) => errors.push(String(message)));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    virtualConsole,
    beforeParse(window) {
      for (const [name, value] of Object.entries(CDN_GLOBAL_STUBS)) {
        (window as unknown as Record<string, unknown>)[name] = value;
      }
    },
  });
  try {
    // 等 load，再给 `init()` 之后可能排队的微任务/定时器一点时间。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options?.timeoutMs ?? 1_500);
      dom.window.addEventListener('load', () => {
        setTimeout(() => {
          clearTimeout(timer);
          resolve();
        }, 50);
      });
    });
    const text = (dom.window.document.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return { text, errors };
  } finally {
    dom.window.close();
  }
}

/**
 * 一页的「学生可见文字」。
 *
 * `interactive` 走真渲染；渲染抛错或渲染出空文本时，**退回源码并标注** ——
 * 绝不让"没渲染出来"静默变成"这一页是空的"。
 */
export async function learnerVisibleText(
  page: VisibleTextPage,
  deps?: { render?: (html: string) => Promise<{ text: string; errors: string[] }> },
): Promise<VisiblePageText> {
  const type = page.type ?? 'slide';
  const title = page.title ?? '';
  if (type !== 'interactive') {
    return { order: page.order, title, type, text: staticPageText(page), mode: 'static' };
  }

  const html = (page.content as { html?: string } | null)?.html;
  const source = interactiveSourceText(page.content);
  if (typeof html !== 'string' || html.trim().length === 0) {
    return { order: page.order, title, type, text: source, mode: 'source', note: '这一页没有存 HTML，只能读结构里的文字。' };
  }

  const render = deps?.render ?? renderPageHtml;
  try {
    const { text, errors } = await render(html);
    if (text.trim().length > 0) {
      return {
        order: page.order,
        title,
        type,
        text,
        mode: 'rendered',
        ...(errors.length > 0 ? { note: `渲染时有脚本报错（正文仍按渲染结果给）：${errors.slice(0, 2).join(' / ')}` } : {}),
      };
    }
    return {
      order: page.order,
      title,
      type,
      text: source,
      mode: 'source',
      note: `这一页渲染后正文是空的${errors.length > 0 ? `（脚本报错：${errors.slice(0, 2).join(' / ')}）` : ''}，下面是它的源码文字，**不是**学生看到的东西。`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      order: page.order,
      title,
      type,
      text: source,
      mode: 'source',
      note: `这一页渲染失败（${message}），下面是它的源码文字，**不是**学生看到的东西。`,
    };
  }
}
