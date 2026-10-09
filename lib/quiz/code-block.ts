/**
 * 「这段文字该不该是 `code` 元素」—— **两批，不一刀切**（2026-10-09）。
 *
 * ── 由来：存量 948 个 text 元素里有多少该转成 `code` 元素？──
 *
 * 实测（全库 110 张 slide）：松尺能"命中" 69 个，但它把
 *   · 教学路线图 `1.1 映射与函数 → 1.2 数列的极限 → …`
 *   · 工作流图 `clone → 分支 → push → PR → merge`
 *   · 要点列表里提到 `git`
 * 都算成了"代码/命令行" —— **那把尺不能用来动手**。
 *
 * 收紧之后（整体等宽 + 有结构 + 不因中文标点排除）Day02 剩 **26 个**，
 * 而这 26 个里还得分两批：
 *
 * | 批 | 判据 | 怎么处理 |
 * |---|---|---|
 * | **多行代码块** | 整体等宽 **且 ≥2 行** **且有结构**（`;` / `{}` / `=>`） | **转 `code` 元素** —— 有行号、能指某一行，正好用来讲"执行顺序" |
 * | **单行片段** | 上面任一条不满足 | **留在 `text` 里** —— 转成代码块反而挤版式，而且**没有行序可讲** |
 *
 * ★ 中文注释**不是**排除条件（`// 写法 A：跳到下一页` 是真代码，误杀过 9 条）；
 *   `•`（项目符号）与 `→` **只当标记**，不做硬排除（第 36 页 `// 父类引用 → 子类对象` 也是真代码）。
 */
export type CodeBlockVerdict = 'code-element' | 'keep-inline';

export interface CodeBlockCandidate {
  type?: unknown;
  content?: unknown;
}

/** 判据只用元素自己（`type` / `content`），不看页面 —— 便于将来批量过一遍。 */
export function codeBlockVerdict(element: CodeBlockCandidate): CodeBlockVerdict {
  if (element.type !== 'text') return 'keep-inline';
  const html = typeof element.content === 'string' ? element.content : '';
  if (html.length === 0) return 'keep-inline';

  // ① 整体等宽：**每一段**都得是等宽字体（行内一处 monospace 不算）
  const paragraphs = html.split(/<p\b/i).slice(1);
  if (paragraphs.length === 0) return 'keep-inline';
  const mono = paragraphs.filter((part) => /monospace|Courier/i.test(part)).length;
  if (mono < paragraphs.length) return 'keep-inline';

  const lines = paragraphs
    .map((part) => part.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').trim())
    .filter((line) => line.length > 0);

  // ② ≥2 行：多行代码块才是"有行序可讲"的那批
  if (lines.length < 2) return 'keep-inline';

  // ③ 有结构，而且是**过半的行**以 `;` / `{` / `}` 结尾（或含 `=>`）。
  //    ★ 为什么要求"过半"而不是"出现过"：教学路线图
  //      `1.1 映射与函数 → 1.2 数列的极限 →` / `… 1.4 函数的连续性;` 里**恰好**有个分号，
  //      按"出现过就算"会被判成代码块 —— 而那正是我拿来反对"自动替换"的例子。
  //      按"过半"：代码块几乎每行都以 `;`/`{`/`}` 收尾；路线图不会。
  const endings = lines.filter((line) => /[;{}]$/.test(line) || line.includes('=>')).length;
  if (endings * 2 <= lines.length) return 'keep-inline';

  return 'code-element';
}
