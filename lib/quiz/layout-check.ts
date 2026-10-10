/**
 * 版面检查 —— **看不见画面时，把"看得见的那部分"变成可算的**。
 *
 * ── 为什么要有它（2026-10-10，学习者一句话逼出来的）──────────────
 *
 * 他说：**「我这边没有渲染预览的工具，看不到实际画面」**，随后更正为
 * **「我说的是它没有」** —— 指的是 **agent**。
 *
 * 查证属实：`render_scene_preview`（`scene-preview.ts`）**存在**，但
 * `buildScenePreviewTools()` 在没配 `RENDER_SERVICE_URL` 时**直接返回空数组**
 * ⇒ 工具根本不注册 ⇒ **agent 没有眼睛**。这是 §1.1 的规矩（没能力就不注册），
 * 不是 bug。
 *
 * 后果是一整类问题：agent 只能读文本，而**文本投影已知会骗人** —— slide 元素是
 * 绝对定位的，抽出来的却是单列文本（§6.10：实测 6 条版面误报全出在"压平了
 * `left`/`top`，把两栏读成挤在一行"）。于是它当前的待办 ①「编号错乱 7 页 ——
 * 要逐页读原文再挪段落」，正是**看不见画面**的直接代价。
 *
 * ── 这个模块的取舍 ─────────────────────────────────────────────
 *
 * **不追求"看见"，追求"把看得见的那部分变成可算的"。** 版面问题里的绝大部分
 * 其实不需要渲染：元素本来就带坐标。所以这里是**纯函数、不花模型、不依赖服务**，
 * 而且能直接挂进 `scene-diagnostics.ts` 那道闸（两条写入路径共用）。
 *
 * ★ **它只报"可算的"**：溢出、重叠、文字装不下、字号过小。
 *   不碰"好不好看" —— 那件事不可算，硬编一个阈值就是**编数据**。
 */

/** 画布尺寸 —— 与 `BaseCodeElement` 建立盒子时用的那套一致（1000×562.5）。 */
export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 562.5;

/**
 * 可读字号下限。
 *
 * ★ 这个数**不是拍的**：`course-design.ts` 与自学页的密度目标都建立在
 * "1000×562.5 画布在可读字号下"这个前提上，而实测真实课件的正文是 16px 起。
 * 低于 14px 时，「缩成灰块」就是学习者原话里点过的那个失败模式。
 */
export const MIN_READABLE_FONT_PX = 14;

/** 一行文字的盒高相对字号的倍数 —— 与 `AGENTS.md` §2 里 `code` 那组实测同源。 */
const LINE_HEIGHT_RATIO = 1.6;

export interface LayoutElement {
  type?: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  content?: unknown;
  fontSize?: unknown;
}

export interface LayoutFinding {
  /** 机读的类别，供 SQL 统计（别让下游去 parse 人话）。 */
  code:
    | 'overflows-canvas'
    | 'overlaps'
    | 'text-does-not-fit'
    | 'font-too-small'
    | 'no-headroom';
  /** 给人/模型看的一句话，必须点名是哪个元素。 */
  message: string;
}

/** 从一段 HTML 里取最大的那个 `font-size`（正文按它算；取最大是因为标题不该触发"太小"）。 */
export function maxFontSizePx(html: string): number | undefined {
  const sizes = [...html.matchAll(/font-size:\s*([\d.]+)px/gi)].map((match) => Number(match[1]));
  const valid = sizes.filter((size) => Number.isFinite(size) && size > 0);
  return valid.length > 0 ? Math.max(...valid) : undefined;
}

/** 估算一段 HTML 在给定宽度下占多高。**故意保守**（宁可漏报，不要用假数字去拒绝）。 */
export function estimateTextHeightPx(html: string, width: number, fontPx: number): number {
  // 去掉标记后按块统计：每个块算一行起，再按宽度折算换行。
  const blocks = html
    .split(/<\/(?:p|div|li|h[1-6])>/i)
    .map((block) => block.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim())
    .filter((text) => text.length > 0);
  if (blocks.length === 0) return 0;
  // 汉字按 1em、ASCII 按 0.6em 估宽（与等宽那组实测同源，但这是**正文**，取通用值）。
  const charsPerLine = Math.max(1, Math.floor(width / fontPx));
  let lines = 0;
  for (const block of blocks) {
    const wide = [...block].filter((char) => char.charCodeAt(0) > 0x2e80).length;
    const units = wide + (block.length - wide) * 0.6;
    lines += Math.max(1, Math.ceil(units / charsPerLine));
  }
  return lines * fontPx * LINE_HEIGHT_RATIO;
}

function box(element: LayoutElement): { left: number; top: number; width: number; height: number } | null {
  const { left, top, width, height } = element;
  if (![left, top, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  return { left: left as number, top: top as number, width: width as number, height: height as number };
}

function overlapArea(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
): number {
  const x = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const y = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return x > 0 && y > 0 ? x * y : 0;
}

/**
 * 查一页的版面。**纯函数** —— 输入是元素数组，输出是发现列表。
 *
 * 四类，全都是"可算的"，全都是学习者抱怨过或审查误报过的：
 *   ① 溢出画布（元素伸出 1000×562.5 之外）
 *   ② 元素重叠（矩形相交超过小面积 —— 贴边不算）
 *   ③ 文字装不下（估算高度 > 盒高 ⇒ 内容会被切掉或缩成灰块）
 *   ④ 正文字号过小（< 14px）
 */
export function checkLayout(elements: readonly LayoutElement[]): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  const boxes = elements.map((element, index) => ({ index, element, rect: box(element) }));

  boxes.forEach(({ index, element, rect }) => {
    if (!rect) return;
    const label = element.type ? `${element.type} 元素（第 ${index + 1} 个）` : `第 ${index + 1} 个元素`;

    // ① 溢出画布
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    if (right > CANVAS_WIDTH + 0.5 || bottom > CANVAS_HEIGHT + 0.5 || rect.left < -0.5 || rect.top < -0.5) {
      findings.push({
        code: 'overflows-canvas',
        message:
          `${label}超出画布：它的范围是 left ${Math.round(rect.left)} → ${Math.round(right)}、` +
          `top ${Math.round(rect.top)} → ${Math.round(bottom)}，而画布是 ${CANVAS_WIDTH}×${CANVAS_HEIGHT}。` +
          '超出去的部分学生**看不见**。要么把盒子放大/移位，要么把内容挪到下一页。',
      });
    }

    // ③ 文字装不下（只有带 HTML 正文字段的元素才算）
    const html = typeof element.content === 'string' ? element.content : '';
    if (html.length > 0) {
      const fontPx = maxFontSizePx(html);
      if (fontPx !== undefined) {
        const needed = estimateTextHeightPx(html, rect.width, fontPx);
        if (needed > rect.height + 1) {
          findings.push({
            code: 'text-does-not-fit',
            message:
              `${label}的文字装不下：按 ${fontPx}px、宽 ${Math.round(rect.width)}px 估，` +
              `内容约需 ${Math.round(needed)}px 高，而盒子只有 ${Math.round(rect.height)}px。` +
              '结果就是**末行被切掉**，或者字号被缩成灰块。放不下就**加一页**，不要压字号。',
          });
        }
        // ④ 正文字号过小
        if (fontPx < MIN_READABLE_FONT_PX) {
          findings.push({
            code: 'font-too-small',
            message:
              `${label}的字号是 ${fontPx}px，低于可读下限 ${MIN_READABLE_FONT_PX}px —— ` +
              '屏幕上会是一团灰。要放更多内容就**加页**，不是缩字号。',
          });
        }
      }
    }
  });

  /**
   * ② 重叠：**只有"两段字叠着"才算**。
   *
   * ★★ 2026-10-10 修 —— 这是本检查**第一次在真页面上跑就误报的那一条**。
   *   学习者的反馈：「**第 27 页版式没问题，那批「重叠」果然只是「底板 + 文字」的套叠**」。
   *
   *   我原来的判据是"相交面积 ≥ 较小那个的 15%"，它**分不清两种套叠**：
   *     · **底板 + 文字**（一个 shape 垫在下面装内容）—— 这是**正常设计**，
   *       而且它本来就是**包含**关系（小的整个在大的人里）；
   *     · **两段字叠着** —— 这才是缺陷。
   *
   *   所以改成按**包含 / 相交**分：
   *     · 一个盒子**基本装下**另一个（≥90% 落在里面）⇒ **不算** —— 那是底板/容器；
   *     · 两个都是**文字**元素且部分相交 ⇒ **报**（字压字，一定是坏的）；
   *     · 文字与非文字**部分**相交 ⇒ **也报**（一块色块盖住半行字，同样是坏的）。
   */
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (!a.rect || !b.rect) continue;
      const area = overlapArea(a.rect, b.rect);
      if (area <= 0) continue;
      const areaA = a.rect.width * a.rect.height;
      const areaB = b.rect.width * b.rect.height;
      const smaller = Math.min(areaA, areaB);
      if (smaller <= 0) continue;
      const ratio = area / smaller;
      // ① 包含关系 ⇒ 底板装内容，正常。
      if (ratio >= 0.9) continue;
      const bothText = a.element.type === 'text' && b.element.type === 'text';
      // ② 非文字之间的部分相交（两个色块/两张图）多半是装饰，不报；
      //    只有"至少一个是文字"才是学生看得见的叠字。
      const involvesText = a.element.type === 'text' || b.element.type === 'text';
      if (!involvesText) continue;
      if (ratio < 0.15) continue;
      findings.push({
        code: 'overlaps',
        message:
          `第 ${a.index + 1} 个与第 ${b.index + 1} 个元素**压在一起**` +
          `（重叠面积约 ${Math.round(area)}px²，占较小那个的 ${Math.round(ratio * 100)}%` +
          `${bothText ? '，且两个都是文字' : ''}）。` +
          '学生看到的是字叠着字。要么挪开，要么把其中一个删掉。' +
          '（★ 如果其中一个是**底板**、把内容整个装在它里面，那不算 —— 那是正常设计。）',
      });
    }
  }

  /**
   * ⑤ **这一页还有没有余量** —— 与"溢出"是两件事。
   *
   * ★★ 2026-10-10 加，来自学习者对第 27 页的一个判断：
   *   「左栏那个反例是个片段（`Child(int a, int b) { … }`），外面没有 class；
   *     **补全它需要一整块位置，这个页面的两栏已经排满**」。
   *
   *   也就是说：内容**现在**装得下，但**再往里加任何东西都得先重排**。
   *   "溢出"抓不到这种情况 —— 它没溢出，它只是**满了**。
   *
   *   这条信号是给 agent 的行动建议，不是缺陷：**要改就先拆页/重排，
   *   别试着往缝里塞几个字**（那正是它自己说的"不是换几个字的事"）。
   *
   *   算法：把画布切成 40×24 的格子，标出被元素盖住的格，数空格占比。
   *   粗，但**可算**，而且这里要的只是"有没有一整块空地"，不是精确面积。
   */
  const COLS = 40;
  const ROWS = 24;
  const covered = new Set<number>();
  for (const { rect } of boxes) {
    if (!rect) continue;
    const x0 = Math.max(0, Math.floor((rect.left / CANVAS_WIDTH) * COLS));
    const x1 = Math.min(COLS - 1, Math.ceil(((rect.left + rect.width) / CANVAS_WIDTH) * COLS) - 1);
    const y0 = Math.max(0, Math.floor((rect.top / CANVAS_HEIGHT) * ROWS));
    const y1 = Math.min(ROWS - 1, Math.ceil(((rect.top + rect.height) / CANVAS_HEIGHT) * ROWS) - 1);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) covered.add(y * COLS + x);
    }
  }
  /**
   * ★★ **量的是"最大一块空地"，不是"空白面积占比"** —— 这一条被夹具当场纠正过。
   *
   * 我原来数空格占比（阈值 10%），结果"**两栏排满**"那页**没被报出来**：
   * 它的空白有 **24%**（页边距 + 栏间距），可那些全是**细条**，
   * 一条都放不下"补全一个片段"所需的一整块。
   *
   * 所以改成：在网格上求**最大的全空矩形**（柱状图最大矩形，40×24=960 格，很便宜），
   * 再看它够不够放一块内容。
   */
  const heights = new Array<number>(COLS).fill(0);
  let bestCells = 0;
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      heights[x] = covered.has(y * COLS + x) ? 0 : (heights[x] ?? 0) + 1;
    }
    // 单调栈：以每一列为高的最大矩形
    const stack: number[] = [];
    for (let x = 0; x <= COLS; x += 1) {
      const h = x === COLS ? 0 : (heights[x] ?? 0);
      while (stack.length > 0 && (heights[stack[stack.length - 1]!] ?? 0) >= h) {
        const top = stack.pop()!;
        const width = stack.length === 0 ? x : x - stack[stack.length - 1]! - 1;
        bestCells = Math.max(bestCells, (heights[top] ?? 0) * width);
      }
      stack.push(x);
    }
  }
  const cellW = CANVAS_WIDTH / COLS;
  const cellH = CANVAS_HEIGHT / ROWS;
  const freeRatio = 1 - covered.size / (COLS * ROWS);
  // ★ 一块"能放内容"的空地：至少 300×140px（约 12×6 格）—— 那是补一段说明/一个片段的最小尺寸。
  const MIN_BLOCK_CELLS = Math.ceil(300 / cellW) * Math.ceil(140 / cellH);
  if (boxes.length >= 2 && bestCells < MIN_BLOCK_CELLS) {
    findings.push({
      code: 'no-headroom',
      message:
        `这一页**已经排满了**：最大的一块空地只有约 ${Math.round(
          Math.sqrt(bestCells) * cellW,
        )}px 见方（空白总面积 ${Math.round(freeRatio * 100)}%，但都是页边距和栏间距那种细条）。` +
        '现在没溢出，但**再往里加任何内容都得先动版面** —— ' +
        '要补一块东西（补全一个片段、加一段说明），先把这一页**拆成两页**或重排，' +
        '**别试着往缝里塞几个字**。',
    });
  }

  return findings;
}

/** 把发现拼成一段给模型看的文本 —— 与 `scene-diagnostics.ts` 里别的诊断同一形状。 */
export function formatLayoutFindings(findings: readonly LayoutFinding[]): string {
  if (findings.length === 0) return '';
  return (
    `**版面**（这些是算出来的，不是猜的 —— 你看不到画面，但坐标是确定的）：\n` +
    findings.map((finding) => `· ${finding.message}`).join('\n')
  );
}
