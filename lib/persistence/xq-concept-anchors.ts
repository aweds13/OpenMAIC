/**
 * 义项锚（`xq_concept.anchors`）—— 这一列决定「同形异义能不能被挡住」。
 *
 * ## 为什么需要这个模块
 *
 * `J-外来课程接入设计.md` §3.4 的闸 2 是唯一带**否决权**的信号：外来课程里的
 * 「构造」如果在我们图里指 OOP，而那一侧的上下文没有 `构造方法` / `构造器`
 * 这类锚词，就一票降级成存疑、不许判命中。实测覆盖率 20/25 = 80%，剩下 5 页
 * 是「漏判成存疑」，方向是对的（漏判多问人一次，错判把 8 页错挂上去）。
 *
 * 但这一列在全库 104 个概念上**一个值都没有**（2026-11-10 实测
 * `count(*) FILTER (WHERE cardinality(anchors) > 0)` = 0）。所以闸 2 今天
 * 没有数据可用 —— 不是「实现漏了」，是「没有燃料」。
 *
 * ## 锚词从哪来（J §8 第 4 条给了两路，这里做第一路）
 *
 * ① 从 234 页正文按共现自动抽，人工只校 top-N；② 人工写（准，但 2686 节点
 * 写不完）。这一版做 ①，并且**只往空列里写**，人改过的锚不会被覆盖。
 *
 * ## 判据的形状：不是词频，是「相对全库的富集」
 *
 * ★ J §3.4 第 4 条实证：`变量 94/234`、`类型 79/234`、`对象 49/234` ——
 * 按命中页数排，排上来的一定是最没用的那几个。所以这里的分数是
 * **lift = (在该概念页面里的覆盖率) / (在全库页面里的覆盖率)**：
 *
 * - 「构造」在 `this 关键字` 的 14 页里出现 14 次（覆盖率 1.00），全库 234 页
 *   里出现约 25 次（0.107）⇒ lift ≈ 9.4。
 * - 「一次」在同样 14 页里出现 7 次（0.50），全库到处都有（≈0.25）⇒ lift ≈ 2.0。
 *
 * 两个都「常见」，但一个说明「讲 this 的页几乎都在讲构造」，另一个不说明任何事。
 *
 * ## 三个刻意的边界
 *
 * - **锚词不许是概念名本身，也不许包含概念名**。「构造方法」这个概念的锚不该
 *   是「构造方法」—— 那不是区分义项，那是重复自己。同理 `字符串` 的锚不能是
 *   `字符串`。
 * - **页数太少的概念不给锚**（`ANCHOR_MIN_PAGES`）。4 页里碰巧一起出现两次
 *   是巧合，不是义项。反过来说：**像 `类与对象` 这样 58 页无处不在的概念，
 *   抽不出锚是正常的**——它没有「专属上下文」，闸 2 对它本来就不该生效
 *   （J §3.2 里 `anchors 为空` 那条分支就是给它们准备的）。
 * - **只往空列里写**。`anchors` 是唯一带否决权的列，人校过的值不能被一次
 *   自动重算抹掉；要重算得显式 `--force`。
 *
 * ## 分词为什么用 `Intl.Segmenter`
 *
 * 中文没有空格，按 n-gram 切（2/3/4 字）会切出大量跨词碎片 —— 实测
 * `变量与类型` 的 top 候选是 `量名` / `的变` / `的是`，全是垃圾。
 * `Intl.Segmenter('zh', { granularity: 'word' })` 是 Node 内置的（本机 Node 24
 * 带完整 ICU），零依赖，切出来是 `继承` / `父类` / `构造` / `方法` 这种真词。
 * 它不完美（`重写` 会被切成 `重`+`写`），但比 n-gram 强一档，而且不用引词典。
 */

import type { Queryable } from '@openmaic/storage/document/pg';

/** 概念至少要在这么多页上出现过，才谈得上「它的专属上下文」。 */
export const ANCHOR_MIN_PAGES = 4;

/** 富集倍数的下限。`2` = 这个词在该概念的页面里出现的比例，是全库平均的两倍。 */
export const ANCHOR_MIN_LIFT = 2;

/** 一个词至少要在这个概念的这么多比例的页面里出现。 */
export const ANCHOR_COVERAGE = 0.5;

/** 无论比例多低，至少要有这么多个页面。三条证据以下不算「常见」。 */
export const ANCHOR_MIN_PAGES_FOR_WORD = 3;

/** 一个概念最多留几个锚。多到十几个就不叫「义项」了。 */
export const ANCHOR_MAX_PER_CONCEPT = 6;

/**
 * 停用词 —— 这条清单是**数据**，不是判据。
 *
 * 只收两类：① 汉语里没有实义的连接与指示成分（`这个` / `所以` / `已经`）；
 * ② 整套课程里到处都在讲的动作与容器（`调用` / `打印` / `输出` / `代码`）。
 * 第二类其实 lift 会自己压下去，但留着能把候选位让给更具体的词。
 *
 * ★ 刻意**不**收 `继承` / `构造` / `分支` 这种真正的义项词 —— 它们正是要找的东西。
 */
export const ANCHOR_STOP_WORDS: readonly string[] = [
  '这个',
  '那个',
  '什么',
  '怎么',
  '可以',
  '就是',
  '不是',
  '一个',
  '一些',
  '一种',
  '我们',
  '你们',
  '他们',
  '它的',
  '我是',
  '这里',
  '那里',
  '时候',
  '因为',
  '所以',
  '但是',
  '如果',
  '然后',
  '现在',
  '已经',
  '还是',
  '这样',
  '那样',
  '自己',
  '一下',
  '一遍',
  '一点',
  '一行',
  '一句',
  '东西',
  '问题',
  '方法',
  '地方',
  '内容',
  '情况',
  '部分',
  '系统',
  '代码',
  '程序',
  '需要',
  '必须',
  '应该',
  '可能',
  '知道',
  '看到',
  '觉得',
  '开始',
  '结束',
  '出来',
  '起来',
  '上面',
  '下面',
  '里面',
  '外面',
  '之前',
  '之后',
  '以后',
  '以前',
  '同时',
  '其实',
  '当然',
  '最后',
  '第一',
  '第二',
  '第三',
  '例如',
  '比如',
  '包括',
  '通过',
  '进行',
  '使用',
  '调用',
  '返回',
  '打印',
  '输出',
  '输入',
  '执行',
  '运行',
  '结果',
  '类型',
  '变量',
  '函数',
  '对象',
  '参数',
  '字段',
  '名字',
  '数据',
  '直接',
  '一次',
];

/** 一个字太少（`类` 会命中几乎每一页），七个字以上基本是句子片段。 */
const WORD_MIN_CHARS = 2;
const WORD_MAX_CHARS = 6;
const CJK_WORD = /^[\u4e00-\u9fff]+$/;

/**
 * 不能出现在词首或词尾的字。
 *
 * `Intl.Segmenter` 切中文时会切出 `的是` / `那一` / `面上` / `要写` / `藏起来`
 * 这类**跨词碎片** —— 它们不是任何一个义项，只是几个字碰巧挨在一起。汉语的
 * 虚成分几乎都是单字，所以「首尾是虚字 ⇒ 不是词」这条启发式能一网打尽，
 * 比逐条往停用词里加可维护得多。
 *
 * ★ 刻意只收虚字：构造 / 继承 / 多态 / 抽象 / 封装 这些真义项词首尾都是实字，
 * 不会被误杀。
 */
const EDGE_CHARS = new Set(
  [
    ...'的了着过是在上下里外这那么吗呢吧啊与和及或从向把被让使为以于其之而则就都也还很更最不没要会能可该',
    ...'你他我她它们一二三四五六七八九十些个种样来去',
  ].join(''),
);

const WORD_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

/**
 * 一页正文切成「像词的实义片段」。返回**去重**后的集合。
 *
 * 判据只有三条：`isWordLike`、纯中文、长度 2–6。英文标识符（`setState`、
 * `ArrayList`）刻意不收 —— 它们在概念名里就带着，抽出来是重复自己。
 */
export function segmentAnchorWords(text: string): string[] {
  const out = new Set<string>();
  if (text === '') return [];
  for (const piece of WORD_SEGMENTER.segment(text)) {
    if (!piece.isWordLike) continue;
    const word = piece.segment;
    if (!CJK_WORD.test(word)) continue;
    if (EDGE_CHARS.has(word[0]) || EDGE_CHARS.has(word[word.length - 1])) continue;
    if (word.length < WORD_MIN_CHARS || word.length > WORD_MAX_CHARS) continue;
    if (ANCHOR_STOP_WORDS.includes(word)) continue;
    out.add(word);
  }
  return [...out];
}

/** 一个候选锚。`coverage` 与 `lift` 都保留，报告里能看出它是怎么算出来的。 */
export interface AnchorCandidate {
  readonly word: string;
  /** 在概念的多少页里出现过。 */
  readonly pages: number;
  /** `pages / 概念的页数`。 */
  readonly coverage: number;
  /** `coverage / 全库覆盖率`。 */
  readonly lift: number;
}

/** 一个概念的身份与它在哪些页上。`pageKey` 由调用方保证唯一。 */
export interface ConceptPages {
  readonly conceptId: string;
  readonly name: string;
  readonly pageKeys: readonly string[];
}

export interface ProposeAnchorsInput {
  readonly concepts: readonly ConceptPages[];
  /** `pageKey → 这一页的正文`。缺页当成空串，不抛。 */
  readonly pageText: ReadonlyMap<string, string>;
  /** 全库页数（不是 `pageText.size` —— 有页没出现在 occurrences 里也要计入分母）。 */
  readonly totalPages: number;
}

/**
 * 算每个概念的候选锚。纯函数、不碰库。
 *
 * 排序：`lift` 降序，同 `lift` 按 `pages` 降序，再同按词的码点序（`localeCompare`
 * 会随 ICU 版本变，判据不能靠它）。
 */
export function proposeAnchors(input: ProposeAnchorsInput): Map<string, AnchorCandidate[]> {
  const { concepts, pageText, totalPages } = input;
  const result = new Map<string, AnchorCandidate[]>();
  if (totalPages <= 0) return result;

  // 全库文档频次 —— 分母只有一个，先算一遍。
  const documentFrequency = new Map<string, number>();
  for (const text of pageText.values()) {
    for (const word of segmentAnchorWords(text)) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }

  for (const concept of concepts) {
    if (concept.pageKeys.length < ANCHOR_MIN_PAGES) continue;
    const inPages = new Map<string, number>();
    for (const key of concept.pageKeys) {
      for (const word of segmentAnchorWords(pageText.get(key) ?? '')) {
        inPages.set(word, (inPages.get(word) ?? 0) + 1);
      }
    }
    const needed = Math.max(
      ANCHOR_MIN_PAGES_FOR_WORD,
      Math.ceil(concept.pageKeys.length * ANCHOR_COVERAGE),
    );
    const candidates: AnchorCandidate[] = [];
    for (const [word, pages] of inPages) {
      if (pages < needed) continue;
      // ★ 锚不许是概念名的一部分，也不许把概念名包进去 —— 那是重复自己，不是区分义项。
      if (concept.name.includes(word) || word.includes(concept.name)) continue;
      const coverage = pages / concept.pageKeys.length;
      const lift = coverage / ((documentFrequency.get(word) ?? 1) / totalPages);
      if (lift < ANCHOR_MIN_LIFT) continue;
      candidates.push({ word, pages, coverage, lift });
    }
    candidates.sort(
      (a, b) => b.lift - a.lift || b.pages - a.pages || compareCodePoints(a.word, b.word),
    );
    if (candidates.length > 0) {
      result.set(concept.conceptId, candidates.slice(0, ANCHOR_MAX_PER_CONCEPT));
    }
  }
  return result;
}

function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 一次锚词重算的读数。 */
export interface AnchorSyncReport {
  /** 库里有几个概念（含退休/合并的）。 */
  readonly concepts: number;
  /** 有页可算的概念数（≥ `ANCHOR_MIN_PAGES`）。 */
  readonly eligible: number;
  /** 算出来至少一个锚的概念数。 */
  readonly withAnchors: number;
  /** 候选词总数。 */
  readonly candidates: number;
  /**
   * 这一次要写的概念数 —— `execute` 时就是真写进去的行数。
   *
   * ★ 不加 `execute` 时它**不是 0**：报告是给人看的，`--dry-run` 说「要写 36 个」
   * 才是这份报告的意义。真写了几行由脚本自己并排打印（写前/写后），
   * 不用这个字段兼职两个含义。
   */
  readonly written: number;
  /** 已有锚、因此跳过的概念数（人写过的值不动）。 */
  readonly kept: number;
  /** 算出来但库里已经有锚、这次不覆盖的（`kept` 的明细，方便人对着改）。 */
  readonly keptDetail: readonly { conceptId: string; name: string; existing: readonly string[] }[];
  readonly writtenDetail: readonly {
    conceptId: string;
    name: string;
    anchors: readonly string[];
  }[];
  readonly execute: boolean;
}

interface ConceptRow extends Record<string, unknown> {
  id: string;
  canonical_name: string;
  anchors: string[] | null;
}

interface OccurrenceRow extends Record<string, unknown> {
  concept_id: string;
  stage_id: string;
  scene_id: string;
}

interface PageRow extends Record<string, unknown> {
  stage_id: string;
  id: string;
  data: unknown;
}

const SELECT_CONCEPTS_SQL = `SELECT id, canonical_name, anchors
  FROM xq_concept
 WHERE status = 'active'
 ORDER BY canonical_name`;

const SELECT_OCCURRENCES_SQL = `SELECT concept_id, stage_id, scene_id FROM xq_concept_occurrence`;

const SELECT_PAGES_SQL = `SELECT stage_id, id, data FROM document_scenes`;

const UPDATE_ANCHORS_SQL = `UPDATE xq_concept SET anchors = $2::text[], updated_at = now() WHERE id = $1`;

/** 页键。和 `xq_concept_occurrence` 的主键口径一致：`stage + scene` 才算一页。 */
export function pageKeyOf(stageId: string, sceneId: string): string {
  return `${stageId}\u0000${sceneId}`;
}

/**
 * 重算并（可选）写入义项锚。
 *
 * 顺序：读概念 → 读出现记录 → 读页正文 → 纯函数算 → 只给**空锚**的概念写。
 * 页正文走 `staticPageText()`（与出现记录同一个单位，`modules.md` 里那条裁决）。
 */
export async function syncConceptAnchors(
  queryable: Queryable,
  options: { execute?: boolean; force?: boolean } = {},
): Promise<AnchorSyncReport> {
  const execute = options.execute === true;
  const force = options.force === true;

  const conceptRows = (await queryable.query<ConceptRow>(SELECT_CONCEPTS_SQL)).rows;
  const occurrenceRows = (await queryable.query<OccurrenceRow>(SELECT_OCCURRENCES_SQL)).rows;
  const pageRows = (await queryable.query<PageRow>(SELECT_PAGES_SQL)).rows;

  // ★ 动态 import：`staticPageText` 在 `lib/quiz/page-text.ts`，那个模块顶层引了
  // 一批渲染相关的东西；同步器只在脚本里跑，不希望把它挂进任何启动路径。
  const { staticPageText } = await import('../quiz/page-text');

  const pageText = new Map<string, string>();
  for (const row of pageRows) {
    const data = (row.data ?? {}) as { order?: number; type?: string; content?: unknown };
    const text = staticPageText({
      order: typeof data.order === 'number' ? data.order : 0,
      type: typeof data.type === 'string' ? data.type : 'slide',
      content: data.content,
    });
    pageText.set(pageKeyOf(row.stage_id, row.id), text ?? '');
  }

  const pagesByConcept = new Map<string, string[]>();
  for (const row of occurrenceRows) {
    const list = pagesByConcept.get(row.concept_id) ?? [];
    list.push(pageKeyOf(row.stage_id, row.scene_id));
    pagesByConcept.set(row.concept_id, list);
  }

  const concepts: ConceptPages[] = [];
  for (const row of conceptRows) {
    const pageKeys = pagesByConcept.get(row.id);
    if (!pageKeys || pageKeys.length === 0) continue;
    concepts.push({ conceptId: row.id, name: row.canonical_name, pageKeys });
  }

  const proposed = proposeAnchors({ concepts, pageText, totalPages: pageText.size });

  const existingById = new Map<string, string[]>();
  const nameById = new Map<string, string>();
  for (const row of conceptRows) {
    nameById.set(row.id, row.canonical_name);
    existingById.set(row.id, Array.isArray(row.anchors) ? row.anchors : []);
  }

  const keptDetail: { conceptId: string; name: string; existing: readonly string[] }[] = [];
  const writtenDetail: { conceptId: string; name: string; anchors: readonly string[] }[] = [];
  let candidates = 0;
  for (const [conceptId, list] of proposed) {
    candidates += list.length;
    const existing = existingById.get(conceptId) ?? [];
    const name = nameById.get(conceptId) ?? conceptId;
    if (existing.length > 0 && !force) {
      keptDetail.push({ conceptId, name, existing });
      continue;
    }
    writtenDetail.push({ conceptId, name, anchors: list.map((c) => c.word) });
  }

  if (execute) {
    for (const item of writtenDetail) {
      await queryable.query(UPDATE_ANCHORS_SQL, [item.conceptId, item.anchors]);
    }
  }

  keptDetail.sort((a, b) => compareCodePoints(a.name, b.name));
  writtenDetail.sort((a, b) => compareCodePoints(a.name, b.name));

  return {
    concepts: conceptRows.length,
    eligible: concepts.length,
    withAnchors: proposed.size,
    candidates,
    written: writtenDetail.length,
    kept: keptDetail.length,
    keptDetail,
    writtenDetail,
    execute,
  };
}
