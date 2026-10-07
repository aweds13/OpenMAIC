/**
 * 覆盖缺口检查 —— 「这道题考的东西，前面讲过吗？」
 *
 * ── 为什么是差集，不是让 AI 再看一遍 ────────────────────────────────
 *
 * 用户的原话：「解析里用来支撑正确答案的词，AI 难免有注意不到的风险怎么办更稳妥」。
 *
 * 让另一个模型"找找有没有漏"，风险原样搬过去，还多一层"你不知道它漏了什么"。
 * 所以这里换掉判据的类型：**不问"AI 认识不认识这个词"，只问"这个词在更早的
 * 页面里出现过吗"**。这个问题有确定答案，因此没有"注意不到"这回事。
 *
 * ── 粒度：按**内容块**比，不是按字符比（第一版就是这么错的）────────────
 *
 * 第一版对整段文字做字符级最长匹配，剩下的连续区间算缺口。**在中文上完全不成立**：
 * 中文没有词边界，任何改写都会产生一大段"新"文字。实测真实课程（4 个自检页）
 * 报出 **345 段缺口**，绝大多数是「的是大小关系而非布尔值）；选项 D」这种措辞碎片，
 * 真信号（「抽象」）被埋在底下。**98% 噪声的报告 = 没人会读 = 等于漏报。**
 *
 * 现在先把两侧都切成**内容块**：标点/空白/功能字（的、是、和、而、非……）都是
 * 分隔符，所以「和抽象是面向」切出「抽象」「面向」；再用"这段字符串在已教文本里
 * 出现过吗"判断。实测同一批数据缺口从 **345 段降到几十段，且以术语为主**。
 *
 * ── 方向仍然是宁可误报，不可漏报 ──────────────────────────────────
 *
 *   · 抽取"已教文本"用**白名单键**（只收已知的文本字段），**故意可能少收**：
 *     少收 ⇒ 已教侧变小 ⇒ 更容易报缺口 ⇒ 偏向误报。方向是对的。
 *   · 所以它**不判对错，只交证据**：输出是"这几个词在更早页面里没出现过"，
 *     由 agent / 人决定是补讲、改写，还是标成"本课不展开"。
 */

/** 一道待查的题（题干 / 选项 / 解析 都要查）。 */
export interface AssessedQuestion {
  id: string;
  question: string;
  options?: readonly string[];
  analysis?: string;
}

/** 一处缺口：一个在更早页面里没出现过的内容块，以及它在哪出现过。 */
export interface CoverageGap {
  term: string;
  /** 出现过这个词的位置：`题干` / `选项` / `解析`。 */
  sources: string[];
}

export interface FindUncoveredTermsInput {
  questions: readonly AssessedQuestion[];
  /** 本页**之前**所有页面抽出来的文本，拼成的一段。 */
  taughtText: string;
  /** 课程显式声明「本课不展开」的词 —— 命中就不报。 */
  deferred?: readonly string[];
  /**
   * 同一个块至少要在这个题目集合里出现几次才报。默认 1（不过滤）。
   *
   * 跨页面的过滤用 `findCourseCoverageGaps` —— 只有它知道**全课程**的计数。
   */
  minOccurrences?: number;
  /**
   * 外部给的频率表（键为小写）。`findCourseCoverageGaps` 用它传**全课程**的计数 ——
   * 单页自己数会漏掉"这个词在别的自检页里也出现过"这件事。
   */
  occurrenceCounts?: ReadonlyMap<string, number>;
}

/** 短于这个长度的块不报：单字噪声远多于信号。 */
const MIN_TERM = 2;

/**
 * 功能字 —— **既是分隔符，也说明"这一段不是术语"**。
 *
 * 中文的改写几乎都发生在这些字上（「封装是把数据藏起来」→「封装用于隐藏数据」），
 * 所以把它们当边界切，剩下的块才是可能承载概念的单元。
 */
const FUNCTION_CHARS = new Set(
  // ★ 不要写 `.values()`：`String.prototype.values` 不是标准方法。它在 vitest/
  //   Next 下能跑，但在裸 tsx 脚本里直接抛 `S.values is not a function` ——
  //   同一份代码在两种环境里行为不同，正是最该避免的那种坑。
  [...'的了是在和与或及也都很就这不我你他她它们个之其所以为对从到把被而且但等如若则并么呢吗吧啊呀哦嗯任何某些该另再又更最将会能要可'],
);

/** 题干里到处都是的套话，不该被当成"没讲过的概念"。 */
const BOILERPLATE = new Set([
  '选项', '下列', '下面', '以下', '哪个', '哪些', '哪一', '什么', '说法', '描述',
  '正确', '错误', '判断', '关于', '该项', '一项', '一道', '这道', '那种', '哪种',
  '因为', '所以', '例如', '比如', '应该', '可以', '需要', '可能', '属于', '的是',
  '以上', '都是', '不是', '没有', '一个', '一种', '一下', '时候', '其中', '这段',
]);

/**
 * 剥掉标记，只留可读文字。
 *
 * ★ 为什么必须有：`document_scenes` 里 slide 元素的 `content` **就是 HTML** ——
 *   实测原文形如
 *   `<p style="font-size: 32px;"><strong>Java 条件语句：和 Python 有什么不同</strong></p>`。
 *   不剥的话，"已教文本"会把 `font` / `style` / `size` / `16px` / `monospace` /
 *   `Consolas` 这些 **CSS 关键词**当成讲过的词收进来 —— 实测注入的词表前 12 个
 *   全是它们，**那块注入比不注入更糟**（等于告诉出题器"允许用的词是 font、style"）。
 */
export function stripMarkup(text: string): string {
  if (!/[<>]/.test(text)) return text;
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把一段文字切成**内容块**：标点、空白、功能字都是边界。
 *
 * ASCII 部分保留整词（`private` / `getter` / `String`），因为对技术课程来说
 * 它们恰恰是最强信号。
 */
export function contentChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    const chunk = current.trim();
    current = '';
    if (!chunk) return;
    if (chunk.length < MIN_TERM) return;
    if (BOILERPLATE.has(chunk)) return;
    if (/^[\d\p{P}\p{S}]+$/u.test(chunk)) return;
    chunks.push(chunk);
  };
  // 防御性再剥一次：这个函数是**共享单位**，两侧（已教 / 待查）都从这里过 ——
  // 在入口剥掉标记，比要求每个调用点都记得剥要可靠。
  for (const char of stripMarkup(text)) {
    if (FUNCTION_CHARS.has(char) || /[\s\p{P}\p{S}]/u.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return chunks;
}

/**
 * 从一页的 `content` 里抽出可读文本。
 *
 * ★ 规则是**「字符串只在白名单键下才收，容器永远往下走」** —— 不是"白名单键才遍历"。
 * 第一版写成后者，结果 `canvas` / `questions` 不是文本字段，遍历在顶层就停了，
 * 什么都收不到（测试当场抓住）。
 *
 * ★ 仍然**故意可能少收**：少收会让"已教"这一侧变小，于是更容易报缺口 —— 也就是
 * 偏向误报，正是我们要的方向（见模块头）。所以宁可漏掉某个新内容类型的字段，
 * 也不要把整个 JSON 的字符串都拼进来 —— 那会把键名、id、选项字母也算成"讲过"，
 * 反而制造漏报。
 */
const TEXT_FIELDS = new Set([
  'text',
  'content',
  'label',
  'title',
  'question',
  'options',
  'analysis',
  'concept',
  'description',
  'code',
  'commentPrompt',
]);

export function extractTaughtText(value: unknown): string {
  const parts: string[] = [];
  /** `key` 是这个节点**挂在哪个键下面** —— 数组元素继承外层键。 */
  const walk = (node: unknown, key: string | undefined, depth: number): void => {
    if (depth > 12 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      // `id` / `answer` / `value` / `type` 这类是**结构**（题号、答案字母、类型名），
      // 不是讲过的内容。把它们算进"已教"会让 `A`、`q1` 变成"讲过"，毫无意义。
      // slide 的 content 是 HTML —— 这里必须剥，否则 haystack 里全是 CSS 关键词。
      if (key !== undefined && TEXT_FIELDS.has(key)) parts.push(stripMarkup(node));
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
  walk(value, undefined, 0);
  return parts.join('\n').replace(/\s+/g, ' ').trim();
}

/** 从若干页面里抽出「这一页之前」的全部已教文本。 */
export function taughtTextBefore(
  scenes: readonly { order: number; content: unknown }[],
  beforeOrder: number,
): string {
  return scenes
    .filter((scene) => scene.order < beforeOrder)
    .sort((left, right) => left.order - right.order)
    .map((scene) => extractTaughtText(scene.content))
    .filter(Boolean)
    .join('\n');
}

function sameTerm(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * 数一遍这些块**各出现几次**（跨题干/选项/解析）。
 *
 * 这是术语抽取里"频率 + 新颖度"的那一半。为什么必须有：讲解页和自检页是**各自
 * 独立生成**的，措辞必然不同，所以「这段字面在讲解页出现过吗」对**散文**永远为假 ——
 * 实测真实课程里绝大多数报出来的是「因此比较内容应使用」这种一次性句子碎片。
 * 而真术语会**反复出现**（一道题里题干、选项、解析各提一次）。于是：
 *
 *   新颖（没在已教里出现过）+ 重复（≥minOccurrences）≈ 术语
 *   新颖 + 只出现一次                            ≈ 措辞
 *
 * 这是无词典条件下唯一站得住的判据，而且它仍然是**可算的**。
 */
function countChunks(questions: readonly AssessedQuestion[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const question of questions) {
    const texts = [question.question, question.analysis, ...(question.options ?? [])];
    for (const text of texts) {
      if (!text) continue;
      for (const chunk of contentChunks(text)) {
        const key = chunk.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * 找出"只在题目侧出现、更早页面里没有"的内容块。
 *
 * 返回的是**证据不是判决**：命中不等于错（可能本页正要讲它，也可能它在更早的
 * 材料/材料库里讲过但没落成页面）。调用方要么补讲、要么改写、要么标成不展开。
 */
export function findUncoveredTerms(input: FindUncoveredTermsInput): CoverageGap[] {
  const haystack = input.taughtText.replace(/\s+/g, ' ');
  const deferred = input.deferred ?? [];
  const minOccurrences = input.minOccurrences ?? 1;
  const byTerm = new Map<string, CoverageGap>();
  const counts = input.occurrenceCounts ?? countChunks(input.questions);

  for (const question of input.questions) {
    const fields: [string, string | undefined][] = [
      ['题干', question.question],
      ['解析', question.analysis],
      ...(question.options ?? []).map((option): [string, string] => ['选项', option]),
    ];
    for (const [source, text] of fields) {
      if (!text) continue;
      for (const chunk of contentChunks(text)) {
        // 这段字符串在已教文本里出现过 ⇒ 讲过了（用整串包含，不用词相等：
        // 「父类引用」出现在已教文本里就算讲过，不必要求它也正好是一个块）。
        if (haystack.includes(chunk)) continue;
        if (deferred.some((word) => sameTerm(word, chunk))) continue;
        if ((counts.get(chunk.toLowerCase()) ?? 0) < minOccurrences) continue;
        const existing = [...byTerm.values()].find((gap) => sameTerm(gap.term, chunk));
        if (existing) {
          if (!existing.sources.includes(source)) existing.sources.push(source);
          continue;
        }
        byTerm.set(chunk, { term: chunk, sources: [source] });
      }
    }
  }

  // 长的排前面：越长的块越可能是真术语，而不是残留的碎片。
  return [...byTerm.values()].sort(
    (left, right) => right.term.length - left.term.length || left.term.localeCompare(right.term),
  );
}

/**
 * 把缺口分成两类 —— **这是给读者的第一层判断，不是语言学分类**。
 *
 * ── 为什么必须分（2026-10-07 实测）──────────────────────────────
 * 这段旁注原来只报一个总数（「94 段…还有 82 段」），于是 agent 把它读成了
 * **一份待办清单**，来回问「你要我做哪些」。而实测那 94 条里：
 * · 含代码/英文术语的（`plugin` / `ALTER` / `GROUP` / `build` …）—— 讲课页用中文写时
 *   最容易真的没讲，**这一类值得逐条看**；
 * · 纯中文长片段（「子类自动拥有父类成员」这种从句子中间切下来的）——
 *   讲解页与自检页是**各自独立生成**的，措辞必然不同，**按定义不算缺口**。
 *
 * 判据只一条：**含拉丁字母**。它是启发式，不是定理（见返回值里的 `kind` 命名），
 * 但它把"值得看"和"通常不用动"分开了，而原来那个总数把它们混成一个数。
 */
export function splitCoverageGaps(gaps: readonly CoverageGap[]): {
  code: CoverageGap[];
  prose: CoverageGap[];
} {
  const code: CoverageGap[] = [];
  const prose: CoverageGap[] = [];
  for (const gap of gaps) {
    (hasLatinLetter(gap.term) ? code : prose).push(gap);
  }
  return { code, prose };
}

/** 含拉丁字母 ⇒ 当成"代码/英文术语"那一类（见 `splitCoverageGaps` 的说明）。 */
function hasLatinLetter(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/** 把缺口渲染成给 agent 的一段诊断（可算的东西，不需要模型参与）。 */
export function formatCoverageGaps(
  gaps: readonly CoverageGap[],
  options: { maxTerms?: number; maxProse?: number } = {},
): string {
  if (gaps.length === 0) return '';
  const maxCode = options.maxTerms ?? 20;
  const maxProse = options.maxProse ?? 3;
  const { code, prose } = splitCoverageGaps(gaps);

  const lines = [
    `Quiz coverage check — ${gaps.length} 段文字在这一页**之前**的任何页面里都没出现过。` +
      `其中**含代码/英文的 ${code.length} 段**（最可能是真没讲），` +
      `**纯中文片段 ${prose.length} 段**（多数只是措辞不同）。`,
  ];

  if (code.length > 0) {
    lines.push('', `含代码/英文的（这一类值得逐条看）：`);
    lines.push(
      ...code.slice(0, maxCode).map((gap) => `- 「${gap.term}」 — 出现在${gap.sources.join('、')}`),
    );
    if (code.length > maxCode) lines.push(`- …还有 ${code.length - maxCode} 段`);
  }

  if (prose.length > 0) {
    lines.push('', `纯中文片段（举例，不必逐条改）：`);
    lines.push(...prose.slice(0, maxProse).map((gap) => `- 「${gap.term}」`));
    if (prose.length > maxProse) lines.push(`- …另有 ${prose.length - maxProse} 段同类片段`);
  }

  lines.push(
    '',
    '★ **这个数不是验收指标**：它随页面**顺序**（只跟"这一页之前"比）和**措辞**涨落 ——',
    '实测同一页改对一道题反而 92→94，重排页序后另一页 151→92。**别拿它的升降当改好了没。**',
    '',
    '这些**不一定是错**（可能本页正要讲它）。但按「练习只能考教过的」这条规矩，每一条都要二选一：',
    '① 相关概念在更早的页面讲过 → 用讲过的说法重写这道题；',
    '② 它本来就该是这一页要讲的 → 说明这是新引入，别默认学习者已经知道；',
    '③ 本课不展开 → 明确标出来（并考虑把它从题干里去掉，别拿它当干扰项）。',
  );
  return lines.join('\n');
}

/**
 * 一页课程。
 *
 * ★ 传进来的必须是**全部页面**（讲解页 / 交互页也要，`questions` 给空数组），
 *   否则"已教"这一侧只剩自检页 —— 实测踩过：只传自检页时第一张自检页的
 *   「已教 0 字」，于是满屏都是缺口，报告直接失去意义。
 *   只有 `questions` 非空的页会被报告；其余页只贡献已教文本。
 */
export interface CoveragePage {
  sceneId: string;
  order: number;
  title: string;
  questions: readonly AssessedQuestion[];
  content?: unknown;
}

export interface PageCoverageReport {
  page: CoveragePage;
  /** 这一页之前累计的已教字数 —— 读报告时用它判断"是新课程所以缺得多"。 */
  taughtChars: number;
  gaps: CoverageGap[];
}

/**
 * 整门课跑一遍：**频率按全课程算，缺口按每页算**。
 *
 * 为什么必须分成两级：一个词是不是术语，看的是它在**整门课**里反复出现（题干、
 * 选项、解析各一次），而"讲过没有"看的是**这一页之前**。单页自己数频率会把
 * 跨页复现的术语漏掉。
 */
export function findCourseCoverageGaps(
  pages: readonly CoveragePage[],
  options: { deferred?: readonly string[]; minOccurrences?: number } = {},
): PageCoverageReport[] {
  const ordered = [...pages].sort((left, right) => left.order - right.order);

  const globalCounts = new Map<string, number>();
  for (const page of ordered) {
    for (const [chunk, count] of countChunks(page.questions)) {
      globalCounts.set(chunk, (globalCounts.get(chunk) ?? 0) + count);
    }
  }

  const minOccurrences = options.minOccurrences ?? 2;
  const allPages = ordered.map((entry) => ({ order: entry.order, content: entry.content }));

  const reports: PageCoverageReport[] = [];
  for (const page of ordered) {
    // 没有题的页不会被报告，但它**参与"已教"** —— 这正是它们存在的意义。
    if (page.questions.length === 0) continue;
    // 已教 = 这一页之前**所有**页（含讲解页），不只是之前的自检页。
    const taughtText = taughtTextBefore(allPages, page.order);
    const gaps = findUncoveredTerms({
      questions: page.questions,
      taughtText,
      minOccurrences,
      occurrenceCounts: globalCounts,
      ...(options.deferred ? { deferred: options.deferred } : {}),
    });
    reports.push({ page, taughtChars: taughtText.length, gaps });
  }
  return reports;
}
