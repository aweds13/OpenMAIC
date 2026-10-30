/**
 * ★ 「该不该是 `code` 元素」的两批规则（2026-10-09）。
 *
 * 这组判据钉的是**两批的边界**：多行代码块该转；单行片段留在 text 里。
 * 边界错一边的代价是实打实的 —— 多转会把一行表达式挤成一个带行号的黑框，
 * 少转会漏掉"能指某一行讲执行顺序"的那批。
 */
import { describe, expect, it } from 'vitest';
import { Check, Errors } from 'typebox/value';

import { codeBlockVerdict, codeElementFromText } from '@/lib/quiz/code-block';
import { SlideElementInputSchema } from '@/lib/server/agent-runtime/course-edit/element-schema';

const element = (content: string) => ({ type: 'text', content });

describe('★ 代码块：多行转 code 元素 / 单行留 text', () => {
  it('★ 多行 + 整体等宽 + 有结构 ⇒ code-element（Day02 第 21 页那种双层 for）', () => {
    const html =
      '<p style="font-family:monospace;">for (int i=1; i&lt;=3; i++) {</p>' +
      '<p style="font-family:monospace;">&nbsp;&nbsp;for (int j=1; j&lt;=3; j++) {</p>' +
      '<p style="font-family:monospace;">&nbsp;&nbsp;&nbsp;&nbsp;System.out.print(i*j);</p>' +
      '<p style="font-family:monospace;">&nbsp;&nbsp;}</p>' +
      '<p style="font-family:monospace;">}</p>';
    expect(codeBlockVerdict(element(html))).toBe('code-element');
  });

  it('★ 单行片段 ⇒ keep-inline（转成代码块反而挤版式，也没行序可讲）', () => {
    expect(
      codeBlockVerdict(
        element('<p style="font-family:monospace;">int a = 1500000000, b = 1500000000;</p>'),
      ),
    ).toBe('keep-inline');
  });

  it('★ 只有一处行内等宽、其余是正文 ⇒ keep-inline（"行内代码"不是代码块）', () => {
    const html =
      '<p style="font-size:16px;">一行配置对象：<span style="font-family: monospace;">obj..a=1..b=2</span></p>' +
      '<p style="font-size:16px;">替代 Java Builder，更简洁</p>';
    expect(codeBlockVerdict(element(html))).toBe('keep-inline');
  });

  it('★ 教学路线图（→ 串起来的章节名）⇒ keep-inline（这是收紧判据的理由之一）', () => {
    const html =
      '<p style="font-family:monospace;">路线：1.1 映射与函数 → 1.2 数列的极限 →</p>' +
      '<p style="font-family:monospace;">1.3 函数的极限（含无穷大量）→ 1.4 函数的连续性;</p>';
    // ★ 它整体等宽、还有两行、**恰好**一个分号 —— 按"出现过结构就算"会被判成代码块。
    //   改成"**过半**的行以 `;`/`{`/`}` 收尾"之后，它正确地留在 text 里。
    expect(codeBlockVerdict(element(html))).toBe('keep-inline');
  });

  it('★ 非 text 元素 / 空内容 ⇒ keep-inline（不误伤别的类型）', () => {
    expect(codeBlockVerdict({ type: 'shape', content: '<p>a;</p><p>b;</p>' })).toBe('keep-inline');
    expect(codeBlockVerdict(element(''))).toBe('keep-inline');
  });
});

/**
 * ★ 2026-10-09 复量补的一组：**行尾注释**。
 *
 * 上面那句"中文注释不是排除条件"原来只做到"不因为出现中文就整条丢掉"，
 * 没做到"**带注释的行照样算代码行**" —— 判据要 `;` 是**最后一个字符**，
 * 于是 `int a = 7 / 2;      // 3` 被判成"不以 `;` 收尾"。
 * 实测代价：Day02 28 个候选里 **6** 个真代码块被整批推进第二批。
 */
describe('★ 代码块：行尾注释不算"没有结构"', () => {
  it('★ 每行都是 `; // 注释` ⇒ 仍然是 code-element（修之前整批落进第二批）', () => {
    const html =
      '<p style="font-family:monospace;">int a = 7 / 2;      // 3</p>' +
      '<p style="font-family:monospace;">double b = 7 / 2.0; // 3.5</p>' +
      '<p style="font-family:monospace;">int c = 7 % 2;      // 1</p>';
    expect(codeBlockVerdict(element(html))).toBe('code-element');
  });

  it('★ 整行注释不进分母（它既不以 `;` 收尾，也不是"要执行的一行"）', () => {
    const html =
      '<p style="font-family:monospace;">byte b = 50; // 合法</p>' +
      '<p style="font-family:monospace;">System.out.println(b); // 输出 50</p>' +
      '<p style="font-family:monospace;">// 50 是 int 字面量，但值在 byte 范围内</p>' +
      '<p style="font-family:monospace;">// 参与运算就不同了（下一页）</p>';
    // 分母是 2（两行真代码），不是 4。按 4 算就是 2*2 <= 4 ⇒ 被误判成 keep-inline。
    expect(codeBlockVerdict(element(html))).toBe('code-element');
  });

  it('★ 全是注释 ⇒ keep-inline（一条注释不是一段代码）', () => {
    const html =
      '<p style="font-family:monospace;">// 第一行说明</p>' +
      '<p style="font-family:monospace;">// 第二行说明</p>';
    expect(codeBlockVerdict(element(html))).toBe('keep-inline');
  });

  it('★ `http://` 里的 `//` 不是注释开头 ⇒ 不许把它当注释切掉', () => {
    // 反面：如果实现改成"先把 `//` 之后切掉再判结尾"，这条会变红
    //（`VALUES('x', 'http://x');` 会被切成 `… 'http:`）。
    const html =
      '<p style="font-family:monospace;">SELECT name FROM websites;</p>' +
      "<p style=\"font-family:monospace;\">INSERT INTO websites(name, url) VALUES('x', 'http://x');</p>";
    expect(codeBlockVerdict(element(html))).toBe('code-element');
  });

  it('★ 教学路线图仍然 keep-inline（放宽注释那条不许把这条一起放了）', () => {
    const html =
      '<p style="font-family:monospace;">路线：1.1 映射与函数 → 1.2 数列的极限 →</p>' +
      '<p style="font-family:monospace;">1.3 函数的极限 → 1.4 函数的连续性; // 本章</p>';
    expect(codeBlockVerdict(element(html))).toBe('keep-inline');
  });
});

/**
 * ★ 转换器（`codeElementFromText`）：从"该转"到"真的转"。
 *
 * 这里夹具用的是**第 21 页那个元素的原文**（含库里的 `U+00A0` 缩进），
 * 因为这条路上两个坑都只有真数据才现形：
 *   ① 缩进存的是 `U+00A0`，不是 `&nbsp;`；② 剥标签必须在反转义之前。
 * 最后一条判据把它对着**仓库自己的元素合同**（`SlideElementInputSchema`）验 ——
 * 上一次真去写这一页的人就是死在合同上（`patch_stage rejected at op 1: … must have
 * required properties content, defaultFontName, defaultColor`），所以这一条必须钉住。
 */
describe('★ text → code 元素：转换器', () => {
  // 第 21 页 el9 的真实 content（缩进是 U+00A0，实测 &nbsp; 出现 0 次）
  const page21 =
    '<p style="font-size: 14px; font-family: Consolas, monospace;">for (int i=1; i&lt;=3; i++) {</p>' +
    '<p style="font-size: 14px; font-family: Consolas, monospace;">\u00a0\u00a0for (int j=1; j&lt;=3; j++) {</p>' +
    '<p style="font-size: 14px; font-family: Consolas, monospace;">\u00a0\u00a0\u00a0\u00a0System.out.print("*");</p>' +
    '<p style="font-size: 14px; font-family: Consolas, monospace;">\u00a0\u00a0} System.out.println();</p>' +
    '<p style="font-size: 14px; font-family: Consolas, monospace;">}</p>';
  const source = {
    type: 'text',
    content: page21,
    left: 370,
    top: 188,
    width: 250,
    height: 127,
    rotate: 0,
  };

  it('★ 行数与行内容对得上，`<=` 还原成 `<`', () => {
    const draft = codeElementFromText(source, { id: 'code_TEST0001', language: 'java' });
    expect(draft.lines.map((line) => line.content)).toEqual([
      'for (int i=1; i<=3; i++) {',
      '  for (int j=1; j<=3; j++) {',
      '    System.out.print("*");',
      '  } System.out.println();',
      '}',
    ]);
  });

  it('★ 缩进必须活下来（库里是 U+00A0，只认 `&nbsp;` 会把代码拍成左对齐）', () => {
    const draft = codeElementFromText(source, { id: 'code_TEST0001', language: 'java' });
    expect(draft.lines[2]?.content.startsWith('    ')).toBe(true);
    expect(draft.lines[2]?.content).not.toContain('\u00a0');
  });

  it('★ 几何原样带过去（转换只换内容形态，不动版式）', () => {
    const draft = codeElementFromText(source, { id: 'code_TEST0001', language: 'java' });
    expect({
      left: draft.left,
      top: draft.top,
      width: draft.width,
      height: draft.height,
      rotate: draft.rotate,
    }).toEqual({
      left: 370,
      top: 188,
      width: 250,
      height: 127,
      rotate: 0,
    });
  });

  it('★ `List&lt;String&gt;` 不许被当成标签吃掉（剥标签在反转义之前）', () => {
    const draft = codeElementFromText(
      {
        type: 'text',
        content:
          '<p style="font-family:monospace;">List&lt;String&gt; names = new ArrayList&lt;&gt;();</p>',
      },
      { id: 'code_TEST0002', language: 'java' },
    );
    expect(draft.lines[0]?.content).toBe('List<String> names = new ArrayList<>();');
  });

  it('★ 行 id 与元素 id 都是确定的（同一个输入 → 同一份草稿）', () => {
    const first = codeElementFromText(source, { id: 'code_TEST0001', language: 'java' });
    const second = codeElementFromText(source, { id: 'code_TEST0001', language: 'java' });
    expect(first).toEqual(second);
    expect(first.lines.map((line) => line.id)).toEqual([
      'code_TEST0001-l1',
      'code_TEST0001-l2',
      'code_TEST0001-l3',
      'code_TEST0001-l4',
      'code_TEST0001-l5',
    ]);
  });

  it('★★ 产物必须过仓库自己的元素合同（上一次真去写这一页就死在这里）', () => {
    const draft = codeElementFromText(source, { id: 'code_TEST0001', language: 'java' });
    // `id` 不在合同里（服务端拥有身份），所以验之前摘掉 —— 与 `add_element` 的输入一致。
    const { id: _id, ...contract } = draft;
    expect(Check(SlideElementInputSchema, contract)).toBe(true);
    if (!Check(SlideElementInputSchema, contract)) {
      console.log(JSON.stringify(Errors(SlideElementInputSchema, contract), null, 2));
    }
    // 对照：少一个必需字段就必须被判不合格（证明这把尺子真的在量）
    const { language: _language, ...missing } = contract;
    expect(Check(SlideElementInputSchema, missing)).toBe(false);
  });
});
