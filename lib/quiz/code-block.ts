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
 *
 * ★ **2026-10-09 复量后的更正**：上面那句"中文注释不是排除条件"当时**只做到了"不因为出现中文
 *   就整条丢掉"**，没有做到"**带注释的行照样算代码行**" —— 判据要求 `;` 是**最后一个字符**，
 *   于是 `int a = 7 / 2;      // 3` 被判成"不以 `;` 收尾"⇒ 带行尾注释的真代码块**整批落进
 *   第二批**（实测 Day02 28 个候选里 **6** 个）。这与本意直接矛盾，是**判据写窄了**。
 *   ⇒ 现在分两步：**整行注释不进分母**、**`;`/`{}` 后面允许跟一个行尾注释**。
 *   复现：`OPENMAIC_CODE_BLOCK_LIVE_TSV=<dump> TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/code-block-live.test.ts`
 */
export type CodeBlockVerdict = 'code-element' | 'keep-inline';

export interface CodeBlockCandidate {
  type?: unknown;
  content?: unknown;
}

/** 转换的输入：一个**已存库**的 `text` 元素（几何字段要原样带过去）。 */
export interface CodeBlockSource extends CodeBlockCandidate {
  left?: unknown;
  top?: unknown;
  width?: unknown;
  height?: unknown;
  rotate?: unknown;
}

/** 转换的输出：能直接写进 `canvas.elements[]` 的 `code` 元素草稿。 */
export interface CodeElementDraft {
  id: string;
  type: 'code';
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
  language: string;
  lines: { id: string; content: string }[];
  showLineNumbers: boolean;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * `text` 元素 → `code` 元素草稿（几何**不变**，只换内容形态）。
 *
 * ★ **`id` 由调用方给**：元素身份不是这个函数的秘密，而且同一个输入要能重复产出同一份
 *   草稿（可测）；随机 id 会让"转换是不是等价的"无法比对。
 *
 * ★ 两个实打实的坑（都是照着真数据量出来的，别改回去）：
 *   1. **缩进是 `U+00A0`（不换行空格），不是 `&nbsp;` 实体** —— 实测第 21 页那个双层 `for`
 *      的 `content` 里 `&nbsp;` 出现 **0** 次、`U+00A0` 出现 **8** 次。
 *      只替换实体就会把代码拍成左对齐（缩进全丢），而缩进正是"嵌套了几层"的唯一线索。
 *   2. **剥标签必须在反转义之前**：`List&lt;String&gt;` 先反转义就变成 `List<String>`，
 *      接着会被 `<[^>]+>` 当成标签吃掉（实测第 53 页就是这么丢掉类型参数的）。
 *      顺序反过来（先剥后解）才是对的。
 *
 * 行首缩进**保留**、只去行尾空白；空行丢弃（`code` 元素的行数组不该有占位空行）。
 */
export function codeElementFromText(
  element: CodeBlockSource,
  options: { id: string; language: string; showLineNumbers?: boolean },
): CodeElementDraft {
  const html = typeof element.content === 'string' ? element.content : '';
  const lines: { id: string; content: string }[] = [];
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null = paragraph.exec(html);
  while (match !== null) {
    const text = (match[1] ?? '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;|\u00a0/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+$/, '');
    if (text.trim().length > 0) {
      lines.push({ id: `${options.id}-l${lines.length + 1}`, content: text });
    }
    match = paragraph.exec(html);
  }
  return {
    id: options.id,
    type: 'code',
    left: asNumber(element.left),
    top: asNumber(element.top),
    width: asNumber(element.width),
    height: asNumber(element.height),
    rotate: asNumber(element.rotate),
    language: options.language,
    lines,
    showLineNumbers: options.showLineNumbers ?? true,
  };
}

/** 判据只用元素自己（`type` / `content`），不看页面 —— 便于将来批量过一遍。 */
export function codeBlockVerdict(element: CodeBlockCandidate): CodeBlockVerdict {
  if (element.type !== 'text') return 'keep-inline';
  const html = typeof element.content === 'string' ? element.content : '';
  if (html.length === 0) return 'keep-inline';

  // ① 整体等宽：**每一段**都得是等宽字体（行内一处 monospace 不算）
  // ★ 用**前瞻**切：切出来的每一段自带 `<p …>` 开标签，于是下面 `replace(/<[^>]+>/g)` 能把
  //   冒头的 ` style="font-size:14px; …">` 一起剥掉。原来用 `split(/<p\b/i)` 会把这个残片留下
  //   （它前面没有 `<`），行首残留又会让 ③ 的"整行注释"判定全线失效。
  //   ★★ **前瞻切法没有那个前导空串** ⇒ 这里**不能**再 `.slice(1)`：
  //      加上它会**静默丢掉每一段的第一行**（实测：`; // 注释` 那组三条只剩两条、
  //      `http://` 那组只剩一条）。第一行的丢失不会报错，只会让判定偏保守 ——
  //      是 `tests/quiz/code-block.test.ts` 里那条 `http://` 对照抓出来的。
  const paragraphs = html.split(/(?=<p\b)/i);
  if (paragraphs.length === 0) return 'keep-inline';
  const mono = paragraphs.filter((part) => /monospace|Courier/i.test(part)).length;
  if (mono < paragraphs.length) return 'keep-inline';

  const lines = paragraphs
    .map((part) =>
      part
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .trim(),
    )
    .filter((line) => line.length > 0);

  // ② ≥2 行：多行代码块才是"有行序可讲"的那批
  if (lines.length < 2) return 'keep-inline';

  // ③ **整行注释不算代码行**：`// 50 是 int 字面量` 既不以 `;` 收尾、也不是"要执行的一行"，
  //    把它算进分母会稀释比例（实测 p12 el12 就是被这个判掉的）。
  const codeLines = lines.filter((line) => !line.startsWith('//'));
  if (codeLines.length === 0) return 'keep-inline';

  // ④ 有结构，而且是**过半的行**以 `;` / `{` / `}` 结尾（或含 `=>`）。
  //    ★ 为什么要求"过半"而不是"出现过"：教学路线图
  //      `1.1 映射与函数 → 1.2 数列的极限 →` / `… 1.4 函数的连续性;` 里**恰好**有个分号，
  //      按"出现过就算"会被判成代码块 —— 而那正是我拿来反对"自动替换"的例子。
  //      按"过半"：代码块几乎每行都以 `;`/`{`/`}` 收尾；路线图不会。
  //    ★ **行尾注释要放行**（2026-10-09 复量补的）：`int a = 7 / 2;      // 3` 是**代码行**，
  //      它只是把 `;` 放在了行尾注释前面。原来按"`;` 必须是最后一个字符"判 ⇒
  //      **带行尾注释的真代码块被整批判成 keep-inline**（实测 Day02 28 个候选里 6 个，
  //      含 p15 el7 / p25 el3 / p25 el10 / p36 el11 / p12 el12）。
  //      这与本文件开头那句"中文注释不是排除条件"自相矛盾 —— 是判据写窄了，不是数据的问题。
  //      ★ 注意写成 `[;{}](\s*\/\/.*)?$` 而**不是**先把 `//` 之后切掉：后者会把
  //      `VALUES('x', 'http://x');` 里的 `//` 当注释切开（实测 p57 el12 会因此变红）。
  const endings = codeLines.filter(
    (line) => /[;{}](\s*\/\/.*)?$/.test(line) || line.includes('=>'),
  ).length;
  if (endings * 2 <= codeLines.length) return 'keep-inline';

  return 'code-element';
}
