/**
 * 草稿纸 —— 给一个**注意力有限**的 agent 用的工作记忆。
 *
 * ── 为什么需要（这是用户的原话）──────────────────────────────────
 *
 * 「我认为它注意力有限，需要一个类似草稿纸的方式，帮它记录，然后通知他，并且这个记录
 *   可以把临时的与可复用信息区分，和我们的材料库联动。」
 *
 * ── 它治的是什么病（有实测数字）─────────────────────────────────
 *
 * 实测那个真生成过页面的会话：生成第一页之前做了 **59 次对外取证**，但
 * `fetch_url` **75** 次 vs `read_material` **20** 次，GitHub MCP 整个部署只调了 **5** 次，
 * 没有任何"回头核对"的痕迹。**病不是"不查"，是"读到的线索没有落点"** ——
 * 读了就往下走，没有地方写下"这份有用 / 这份跟前面矛盾 / 这条我打算写进课里"。
 *
 * 所以本模块的核心不是"再多记点东西"，是**给「判断」一个落点**：
 * `source`（我读到了什么）→ `claim`（我打算写什么，靠哪些 source 撑着）→ 归类。
 * 「归类」这一步就是那个缺失的判断动作。
 *
 * ── 两层：临时的 vs 可复用的 ────────────────────────────────────
 *
 * | 层 | 在这张纸上 | 出口 |
 * |---|---|---|
 * | **临时** | `status: 'open'` 的条目 —— 会话内的工作记忆，随便写，随时丢 | `drop` |
 * | **可复用** | `status: 'promoted'` 的条目 | **进材料库**（`promotedTo: mat_...`） |
 *
 * ★ **它不是第二份材料库，是材料库的候场区（漏斗）。** 可复用的东西只有一条出口：
 *   走已有的 `update_materials` 进材料库；这张纸只留一个指针。避免"两个库"这种重复功能。
 *
 * ── 编号：为什么是 `s001` 这种短号 ──────────────────────────────
 *
 * 用户明确要求「它往里写时也要写编号」。编号必须满足四条：
 *   1. **稳定** —— 写下的号永远指同一个条目，引用不会烂；
 *   2. **不复用** —— 删掉的号不回收，否则"我引用的 s003"会指到别的东西上；
 *   3. **短** —— 索引是要进上下文的，`mat_d72xx6vnsh27bg5wp5bghh4wd0` 那种 30 字符的号
 *      乘 50 行就是 1500 字符的纯噪声；
 *   4. **可排序** = 创建顺序。
 *
 * 所以：**单调递增的 `s001`**（`nextSeq` 独立于 `items.length`，删条目不回退号）。
 * 升级进材料库时**不改材料库的编号规则** —— 材料库照旧分配它的 `mat_...`，
 * 这张纸记下 `promotedTo` 做单向映射（已有数据里全是 `mat_...`，动它就是破坏数据）。
 *
 * ── 通知：走工具结果，不走系统提示词（这条是硬约束）──────────────
 *
 * 系统提示词**一次运行只读一次**，而草稿纸在运行中间一直在变 —— 它没法用提示词通知。
 * 而且每变一次整个前缀缓存就废（见 AGENTS.md §1.2）。所以：
 *   · 系统提示词里只放**一句恒定的话**（有这张纸、在哪、怎么写）；
 *   · **通知 = 每次写/读的结果里把当前索引还给它**；
 *   · 关键节点（生成页之前）给一句"还有 N 条未归类"。
 */
import { stripMarkup } from '@/lib/quiz/coverage-gap';

/** 条目类型。`source`/`claim` 是"取证"，`todo`/`note` 是"待办与零碎"。 */
export type ScratchKind = 'source' | 'claim' | 'todo' | 'note';

/**
 * 条目状态。前三个是**临时层**，最后一个是**可复用层**。
 *
 * `open`（还没判断）→ `kept`（判断：留着待定）/ `dropped`（判断：弃）/ `promoted`（升级进材料库）。
 * ★ `open` 的数量就是"欠的判断题"—— 所以它可以被算出来，成为给 agent 的提醒。
 */
export type ScratchStatus = 'open' | 'kept' | 'dropped' | 'promoted';

/** 读的深度。用户明确说过阅读是**渐进式**的：先大概，再判断，再深入。 */
export type ScratchDepth = 'skim' | 'deep';

export interface ScratchItem {
  /** `s001` 形态的短号；永不复用。 */
  id: string;
  kind: ScratchKind;
  /** 一句话。写长了会挤掉索引里别的行，所以有长度上限。 */
  text: string;
  status: ScratchStatus;
  /** 数据里的时间（**不是 `now()`** —— 每次都变的块会让缓存全废）。 */
  createdAt: number;
  sessionId?: string;
  /** `kind==='source'`：从哪读到的（url 或 materialId）。 */
  source?: string;
  /** `kind==='source'`：略读还是精读。 */
  depth?: ScratchDepth;
  /** `kind==='claim'`：**撑住这条说法的来源条目号** —— 交叉验证就看这里。 */
  sources?: string[];
  /** 与哪一条矛盾（用条目号）。矛盾必须浮出来，不许被静默消化。 */
  conflictWith?: string;
  /** 升级进材料库之后的指针（`mat_...`）；本模块**不**去写材料库。 */
  promotedTo?: string;
}

export interface Scratchpad {
  version: 1;
  /** 下一个可用序号 —— 与 `items.length` 无关，删条目**不回退**。 */
  nextSeq: number;
  items: ScratchItem[];
}

export const SCRATCH_TEXT_LIMIT = 200;

export function emptyScratchpad(): Scratchpad {
  return { version: 1, nextSeq: 1, items: [] };
}

/** 归一化：解析出来的东西可能缺字段、可能是旧版本。宁可修好也不要炸。 */
export function normalizeScratchpad(value: unknown): Scratchpad {
  if (typeof value !== 'object' || value === null) return emptyScratchpad();
  const raw = value as { items?: unknown; nextSeq?: unknown };
  const items: ScratchItem[] = [];
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Partial<ScratchItem>;
      if (typeof item.id !== 'string' || typeof item.text !== 'string') continue;
      items.push({
        id: item.id,
        kind: (['source', 'claim', 'todo', 'note'] as const).includes(item.kind as ScratchKind)
          ? (item.kind as ScratchKind)
          : 'note',
        text: item.text,
        status: (['open', 'kept', 'dropped', 'promoted'] as const).includes(
          item.status as ScratchStatus,
        )
          ? (item.status as ScratchStatus)
          : 'open',
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
        ...(typeof item.sessionId === 'string' ? { sessionId: item.sessionId } : {}),
        ...(typeof item.source === 'string' ? { source: item.source } : {}),
        ...(item.depth === 'skim' || item.depth === 'deep' ? { depth: item.depth } : {}),
        ...(Array.isArray(item.sources)
          ? { sources: item.sources.filter((one): one is string => typeof one === 'string') }
          : {}),
        ...(typeof item.conflictWith === 'string' ? { conflictWith: item.conflictWith } : {}),
        ...(typeof item.promotedTo === 'string' ? { promotedTo: item.promotedTo } : {}),
      });
    }
  }
  // nextSeq 至少要比所有已有号大 —— 否则新号会撞上旧号（号复用是最糟的失败）。
  const maxSeq = items.reduce((max, item) => {
    const parsed = Number.parseInt(item.id.replace(/^s/, ''), 10);
    return Number.isFinite(parsed) && parsed > max ? parsed : max;
  }, 0);
  const declared = typeof raw.nextSeq === 'number' ? raw.nextSeq : 0;
  return { version: 1, nextSeq: Math.max(declared, maxSeq + 1), items };
}

/** `s001` —— 3 位不够就自然变长（`s1000`），不截断。 */
export function formatScratchId(seq: number): string {
  return `s${String(seq).padStart(3, '0')}`;
}

export interface AddScratchInput {
  kind: ScratchKind;
  text: string;
  createdAt: number;
  sessionId?: string;
  source?: string;
  depth?: ScratchDepth;
  sources?: string[];
  conflictWith?: string;
}

export interface AddScratchResult {
  pad: Scratchpad;
  item: ScratchItem;
}

/**
 * 写一条。**返回新条目的号** —— 工具必须把这个号写进结果里，否则 agent 手里没有句柄。
 */
export function addScratchItem(pad: Scratchpad, input: AddScratchInput): AddScratchResult {
  const item: ScratchItem = {
    id: formatScratchId(pad.nextSeq),
    kind: input.kind,
    text: cleanText(input.text),
    status: 'open',
    createdAt: input.createdAt,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.depth ? { depth: input.depth } : {}),
    ...(input.sources?.length ? { sources: [...new Set(input.sources)] } : {}),
    ...(input.conflictWith ? { conflictWith: input.conflictWith } : {}),
  };
  return {
    pad: { ...pad, nextSeq: pad.nextSeq + 1, items: [...pad.items, item] },
    item,
  };
}

/** 剥标记 + 压空白 + 截断。条目会进索引，长文本会挤掉别的行。 */
function cleanText(text: string): string {
  const flat = stripMarkup(text).replace(/\s+/g, ' ').trim();
  return flat.length > SCRATCH_TEXT_LIMIT ? `${flat.slice(0, SCRATCH_TEXT_LIMIT - 1)}…` : flat;
}

export function findScratchItem(pad: Scratchpad, id: string): ScratchItem | undefined {
  return pad.items.find((item) => item.id === id);
}

/** 归类：这就是那个"判断"动作。 */
export function classifyScratchItem(
  pad: Scratchpad,
  id: string,
  status: Exclude<ScratchStatus, 'promoted'>,
): Scratchpad {
  return {
    ...pad,
    items: pad.items.map((item) => (item.id === id ? { ...item, status } : item)),
  };
}

/** 升级进材料库之后记下指针 —— 本模块**不**负责写材料库。 */
export function markScratchPromoted(pad: Scratchpad, id: string, materialId: string): Scratchpad {
  return {
    ...pad,
    items: pad.items.map((item) =>
      item.id === id ? { ...item, status: 'promoted', promotedTo: materialId } : item,
    ),
  };
}

/**
 * ★ 可算的"不断求证"读数：**只有不足两个来源撑着的 claim**。
 *
 * 这是整个模块最值钱的一行 —— 它把"缺少不断求证"从一句感受变成一个数字。
 * 判据就是用户要的那件事：一个要写进课里的说法，**得有第二个来源**。
 */
export function claimsNeedingSecondSource(pad: Scratchpad): ScratchItem[] {
  return pad.items.filter(
    (item) => item.kind === 'claim' && item.status !== 'dropped' && (item.sources?.length ?? 0) < 2,
  );
}

/** 欠的判断题：还 `open` 着的条目数。 */
export function openScratchItems(pad: Scratchpad): ScratchItem[] {
  return pad.items.filter((item) => item.status === 'open');
}

/** 浮出来的矛盾（必须给 agent 看见，不许静默消化）。 */
export function scratchConflicts(pad: Scratchpad): ScratchItem[] {
  return pad.items.filter((item) => item.conflictWith && item.status !== 'dropped');
}

const KIND_LABEL: Record<ScratchKind, string> = {
  source: '来源',
  claim: '说法',
  todo: '待办',
  note: '笔记',
};

const STATUS_LABEL: Record<ScratchStatus, string> = {
  open: '未归类',
  kept: '留着',
  dropped: '已弃',
  promoted: '已进材料库',
};

/**
 * 渲染索引。**分两段**：临时层（未归类 + 留着）和已经进材料库的。
 *
 * 临时层默认只给最近 `recentLimit` 条 —— 它是工作记忆，旧条目不配占注意力。
 */
export function formatScratchIndex(
  pad: Scratchpad,
  options: { recentLimit?: number; includeDropped?: boolean } = {},
): string {
  const recentLimit = options.recentLimit ?? 30;
  const live = pad.items.filter((item) => item.status !== 'dropped');
  const scratch = live
    .filter((item) => item.status !== 'promoted')
    .sort((left, right) => right.createdAt - left.createdAt);
  const shown = scratch.slice(0, recentLimit);
  const promoted = live.filter((item) => item.status === 'promoted');

  const lines: string[] = [];
  const conflictIds = new Set(scratchConflicts(pad).map((item) => item.id));
  const needsSource = new Set(claimsNeedingSecondSource(pad).map((item) => item.id));

  lines.push(`== 草稿纸（临时的 ${scratch.length} 条，显示最近 ${shown.length} 条）==`);
  if (shown.length === 0) lines.push('  （空）');
  for (const item of shown) {
    const marks: string[] = [];
    if (item.status === 'open') marks.push('待归类');
    if (conflictIds.has(item.id)) marks.push(`与 ${item.conflictWith} 矛盾`);
    if (needsSource.has(item.id)) marks.push('**只有 1 个来源**');
    if (item.kind === 'source' && item.depth) marks.push(item.depth === 'deep' ? '精读' : '略读');
    if (item.sources?.length) marks.push(`来源 ${item.sources.join(',')}`);
    lines.push(
      `  ${item.id} | ${KIND_LABEL[item.kind]} | ${item.text}` +
        `${item.source ? ` ⟨${item.source}⟩` : ''}` +
        `${marks.length ? `  [${marks.join(' / ')}]` : ''}`,
    );
  }
  if (scratch.length > shown.length)
    lines.push(`  …还有 ${scratch.length - shown.length} 条更早的`);

  if (promoted.length) {
    lines.push(`== 已进材料库（${promoted.length} 条；内容在材料库里，这里只是指针）==`);
    for (const item of promoted) {
      lines.push(`  ${item.id} | ${item.text} → ${item.promotedTo ?? '?'}`);
    }
  }
  if (options.includeDropped) {
    const dropped = pad.items.filter((item) => item.status === 'dropped');
    if (dropped.length)
      lines.push(`== 已弃（${dropped.length} 条）== ${dropped.map((i) => i.id).join(',')}`);
  }
  return lines.join('\n');
}

/**
 * 检索。
 *
 * ★ **不做向量检索**：草稿纸条目少、结构清楚，关键词/类型/状态过滤就够用，
 *   而且它是确定的、便宜的、可测的。要语义检索就去材料库那边（已有 `search_material`）。
 */
export function searchScratchItems(
  pad: Scratchpad,
  query: string,
  options: {
    kinds?: readonly ScratchKind[];
    statuses?: readonly ScratchStatus[];
    limit?: number;
  } = {},
): ScratchItem[] {
  const needle = query.trim().toLowerCase();
  const limit = options.limit ?? 20;
  return pad.items
    .filter((item) => (options.kinds ? options.kinds.includes(item.kind) : true))
    .filter((item) => (options.statuses ? options.statuses.includes(item.status) : true))
    .filter((item) => {
      if (!needle) return true;
      const haystack = [item.text, item.source ?? '', item.id, ...(item.sources ?? [])]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    })
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit);
}

/**
 * 裁剪：只清**早就丢掉**的条目 —— 它们只是"我判断过它没用"的记录，留着占索引。
 *
 * ★ 刻意**不**裁 `open` / `kept`：那些是还没判断完的东西，删掉就是丢失工作记忆。
 *   而 `promoted` 也不能删（它是指向材料库的指针）。
 */
export function pruneScratchpad(
  pad: Scratchpad,
  options: { now: number; keepDroppedMs?: number },
): Scratchpad {
  const keepDroppedMs = options.keepDroppedMs ?? 48 * 60 * 60 * 1000;
  const items = pad.items.filter(
    (item) => item.status !== 'dropped' || options.now - item.createdAt < keepDroppedMs,
  );
  return items.length === pad.items.length ? pad : { ...pad, items };
}

/** 给 agent 的一句提醒（放在工具结果末尾 / 生成页之前）。没有欠账就不说。 */
export function formatScratchReminder(pad: Scratchpad): string {
  const open = openScratchItems(pad);
  const conflicts = scratchConflicts(pad);
  const needsSource = claimsNeedingSecondSource(pad);
  if (open.length === 0 && conflicts.length === 0 && needsSource.length === 0) return '';
  const parts: string[] = [];
  if (open.length)
    parts.push(
      `**${open.length} 条还没归类**（${open
        .slice(0, 5)
        .map((i) => i.id)
        .join(',')}）`,
    );
  if (conflicts.length) {
    parts.push(`**${conflicts.length} 条矛盾没处理**（${conflicts.map((i) => i.id).join(',')}）`);
  }
  if (needsSource.length) {
    parts.push(
      `**${needsSource.length} 条说法只有 1 个来源**（${needsSource.map((i) => i.id).join(',')}）—— 再找一个来源，或者别把它写进课里`,
    );
  }
  return `草稿纸：${parts.join('；')}。`;
}
