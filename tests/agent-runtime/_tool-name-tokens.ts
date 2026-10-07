/**
 * 共享的测试工具：从"模型能看到的文字"里抽出**像工具名**的标识符。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────
 *
 * 同一把尺子有两处要用：一处量**本 fork 自己的模块**（`tool-name-invariant.test.ts`），
 * 一处量**整个装配出来的提示词**（`runner-course-search-registration.test.ts`）。
 * 两份实现必然漂 —— 而漂了之后，两处会给出不同的结论，比只有一处更糟。
 *
 * ── 判据（窄，但正是要抓的形状）────────────────────────────────
 *
 * 反引号里、小写开头、**含下划线**、后面跟空白/反引号/左括号的标识符。
 *
 * 要求"含下划线"是为了排掉字段名（`stageId`）、文件名（`check.mjs`）、
 * 大写常量（`NOVEL_P90`）。
 *
 * ★ 前瞻 `(?=[\s`(])` 是必需的：工具名有两种写法 —— 裸的（`` `plan_freeze` ``）
 *   和**调用形状**的（`` `practice_scaffold { stageId, … }` ``）。
 *   第一版只抓裸的，漏掉调用形状 —— 也就是说它**比自己声称的窄**，却照样全绿。
 *   那给的是假信心，不是覆盖。
 */
export function toolLikeTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)(?=[\s`(])/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * 报告 `text` 里提到的、**不在 `allowed` 里**的工具名。
 *
 * 返回空数组 = 干净。返回非空 = 有幽灵（模型会去找一个不存在的东西）。
 */
export function phantomToolNames(text: string, allowed: ReadonlySet<string>): string[] {
  return toolLikeTokens(text).filter((token) => !allowed.has(token));
}

/**
 * 反引号里、**camelCase** 的标识符（例如 `` `materialId` ``、`` `nextOffset` ``）。
 *
 * 用途与 `toolLikeTokens` 互补：工具名是 snake_case，**参数名是 camelCase**。
 * 所以这两个形状可以分开判：snake_case 的必须是已注册的**工具**，
 * camelCase 的必须是某个已注册工具的**参数**。
 *
 * ★ 为什么需要它（实测来历）：第 10 轮我把 `scratch` 的 `materialId` 参数改成了 `topic`。
 *   工具名那半边有判据（`toolLikeTokens`），而**参数名这半边没有** ——
 *   残留的 `materialId` 会让模型传一个不存在的参数，且**没有任何东西会报错**。
 */
export function paramLikeTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)(?=[\s`(])/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

/** 收集一组工具的**参数名**（顶层 + 数组元素那一层）。 */
export function declaredParamNames(
  tools: readonly { parameters?: unknown }[],
): Set<string> {
  const names = new Set<string>();
  const walk = (schema: unknown, depth: number): void => {
    if (!schema || typeof schema !== 'object' || depth > 2) return;
    const record = schema as Record<string, unknown>;
    const props = record.properties;
    if (props && typeof props === 'object') {
      for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
        names.add(key);
        walk(value, depth + 1);
      }
    }
    if (record.items) walk(record.items, depth + 1);
    for (const branch of (record.anyOf as unknown[] | undefined) ?? []) walk(branch, depth + 1);
    for (const branch of (record.oneOf as unknown[] | undefined) ?? []) walk(branch, depth + 1);
  };
  for (const tool of tools) walk(tool.parameters, 0);
  return names;
}

/**
 * **调用位**上的工具名（`` `工具名` `` **之外**的写法）。
 *
 * ── 为什么要单独一条（`toolLikeTokens` 覆盖不到的地方）──────────
 * `toolLikeTokens` 要求**反引号**。而提示词里可能不带反引号就让人去调一个工具：
 *
 *     call course_search(query=…)        ← 没有反引号，但显然是"去调它"
 *     use read_scene to inspect the page
 *
 * 这类写法**不会被反引号判据抓到** —— 而它和第 11 轮修掉的那 4 处是同一个后果
 * （模型去调一个它没有的工具）。所以判据要按**调用位**认，而不是按格式认。
 *
 * ── 为什么不能简单放宽成"任何裸 snake_case"（实测过）──────────────
 * 那样会报 16 个假阳性：15 个来自上游的**改名对照表**
 * （`read_scene → read_stage`，那是**故意**出现旧名的），1 个是块标题
 * （`## untrusted_content_policy`）。这两类都**不在调用位**上。
 *
 * ── 还要再排除一类：**带限定语的提及**（第二次实测逼出来的）────────
 * 放宽成"调用位"之后，真提示词里仍然报出一个 `render_scene_preview` ——
 * 而它**是正确写法**，因为它带着限定语：
 *
 *     "Use render_scene_preview selectively … **when the render capability is available**"
 *     "inspect every imported page with … render_scene_preview **when that tool is registered**"
 *
 * 这两句正是 §1.1 想要的写法（"没配就别说"）。所以判据的真正范围是
 * **"无条件地让人去调一个没注册的工具"** —— 句子里有 `when/if` + 可用性词就算合格。
 */
const AVAILABILITY = /\b(?:available|registered|configured|enabled|present)\b/i;

/** 这个名字所在的**那一句**里，有没有"有条件的"限定语。 */
function isQualified(text: string, index: number, name: string): boolean {
  const from = Math.max(0, text.lastIndexOf('.', index) + 1);
  const to = text.indexOf('.', index + name.length);
  const sentence = text.slice(from, to === -1 ? Math.min(text.length, index + 400) : to);
  return /\b(?:when|if|whenever)\b/i.test(sentence) && AVAILABILITY.test(sentence);
}

export function calledToolTokens(text: string): string[] {
  const found = new Set<string>();

  // ① 名字后面紧跟 `(` —— 调用形状。`(?<![A-Za-z0-9_`])` 排除反引号那种（已由另一条判据覆盖）。
  for (const match of text.matchAll(/(?<![A-Za-z0-9_`])([a-z][a-z0-9]*_[a-z0-9_]+)\s*\(/g)) {
    if (!isQualified(text, match.index!, match[1]!)) found.add(match[1]!);
  }

  // ② "call / use / run / invoke / try + 名字" —— 祈使句里让人去调。
  for (const match of text.matchAll(/\b(?:call|use|run|invoke|try)\s+([a-z][a-z0-9]*_[a-z0-9_]+)\b/gi)) {
    if (!isQualified(text, match.index!, match[1]!)) found.add(match[1]!);
  }

  return [...found];
}

