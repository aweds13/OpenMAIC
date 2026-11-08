/**
 * 页级挂载：从「一页的大纲条目」推出「这一页提到了哪些概念」。
 *
 * ── 这张图为什么需要这一层 ──────────────────────────────────────
 *
 * 概念是一等公民，页不是。一页讲什么，由「这页挂了哪些概念、各占多重」
 * 决定；同一页可以半页讲 A、顺手提一句 B，权重就是那个差别。所以落库的
 * 是 `xq_concept_occurrence(concept_id, stage_id, scene_id, weight, source)`，
 * 不是「页 → 概念」的一对多。
 *
 * ── 为什么必须 stage_id + scene_id ──────────────────────────────
 *
 * 234 页里 35 个 scene id 跨 stage 复用，其中 34 个连页面类型都不同。只用
 * scene id 挂载，两个不同课的页会被算成同一页。
 *
 * ── 匹配为什么这么严 ────────────────────────────────────────────
 *
 * 实测过一次按名字匹配的代价：拿「构造」当概念名做匹配，算竞图里它指
 * 「构造题」、Java 课里指「构造方法」，一次就把 8 页错挂上去。所以本模块
 * **不做子串包含**，只做两级：
 *
 * 1. 一个 keyPoint 整串就是一个概念短语 ⇒ 整串（去空白后）与别名表逐字相等，
 *    权重 1.0；整串归一化后相等 ⇒ 0.8。
 * 2. 标题/正文是句子 ⇒ 先按标点与空白切成**词段**，词段（不是子串）与别名
 *    表相等才算命中，标题 0.6、正文 0.4。
 *
 * 第 2 条的「词段」是保护而不是放宽：`构造方法` 没有标点也没有空白，切完
 * 还是一个整体词段，所以它永远匹配不到一个叫 `构造` 的概念；而
 * `switch 与 else if 的取舍` 切成 `switch` / `else` / `if` 三段，三段各自
 * 整段命中，这才是人读标题时做的事。
 */
import { normalizeConceptName } from './ids';
import type { SeedGraph } from './seed';

/** 一条待落库的「页 ← 概念」关系（还没换成数据库 id）。 */
export interface OccurrenceDraft {
  /** 种子里的概念 key；落库时换成 `xq_concept.id`。 */
  conceptKey: string;
  /** 页所在课程。同一个 scene id 可能出现在多门课里，必须带。 */
  stageId: string;
  /** 页 id。 */
  sceneId: string;
  /** 1.0 / 0.8 / 0.6 / 0.4，见文件头。 */
  weight: number;
  /** 命中落在哪一层，落 `xq_concept_occurrence.source`。 */
  source: 'keypoint' | 'title' | 'body';
}

/** 推导一页的挂载所需的输入。除 `stageId` / `sceneId` 外全部可缺。 */
export interface OutlinePageInput {
  stageId: string;
  sceneId: string;
  /** 该页对应 outline entry 的 `keyPoints`（实测 234 页里只有 37 页非空）。 */
  keyPoints?: string[];
  /** 页标题（`document_scenes.data->>'title'`）。 */
  title?: string;
  /** 正文纯文本（可选；画布类页面的过度抓取由调用方负责）。 */
  body?: string;
}

/** 一个概念命中的强度档位，与权重一一对应。 */
export interface ConceptHit {
  conceptKey: string;
  /** 命中的是哪一个写法（别名表里的那一条），用于事后核对。 */
  matchedForm: string;
}

/**
 * 别名索引：归一化写法 → 概念 key。
 *
 * 同一个归一化写法只允许有一个主人 —— 这条约束由 `buildSeedGraph()` 在
 * 构造时保证（冲突直接抛），这里再兜一次，发现冲突就抛，绝不「随便挑一个」。
 */
export type ConceptAliasIndex = Map<string, string>;

/**
 * 摊平标题/正文用的分隔符。
 *
 * 刻意**不含**中日韩文字本身：中文没有词间空格，所以 `构造方法` 这种复合词
 * 切不开 —— 这正是我们要的（切开就会让短概念名骑到长词上）。
 * 含空白：英文标题里 `while / do-while` 靠它切成两段。
 */
const SEGMENT_SEPARATOR = /[\s\u3000：:，,。.；;、／/|｜·・\-—―–_()（）[\]【】「」『』“”"'‘’《》〈〉!！?？~～+＋=&＆#＃]+/;

/**
 * 从种子图建别名索引。
 *
 * 收录 `name` / `nameEn` / 全部 `aliases`，一律先过 `normalizeConceptName`。
 * 不收录 key（`cpp.loop` 这种是内部短名，不该出现在页面文本里）。
 *
 * @param graph `buildSeedGraph()` 的返回（也可以是任意同形状的图）。
 * @returns 归一化写法 → 概念 key。
 * @throws 两个概念归一化后撞了同一个写法时 —— 那意味着按名字找概念有歧义。
 */
export function buildAliasIndex(graph: SeedGraph): ConceptAliasIndex {
  const index: ConceptAliasIndex = new Map();
  for (const concept of graph.concepts) {
    const forms = [concept.name, concept.nameEn, ...(concept.aliases ?? [])];
    for (const form of forms) {
      if (!form) continue;
      const norm = normalizeConceptName(form);
      if (!norm) continue;
      const owner = index.get(norm);
      if (owner && owner !== concept.key) {
        throw new Error(`buildAliasIndex: 别名「${form}」同时属于 ${owner} 与 ${concept.key}`);
      }
      index.set(norm, concept.key);
    }
  }
  return index;
}

/**
 * 整串匹配：一个词段归一化后与别名表逐字相等才算命中。
 *
 * 只看**相等**，不看包含 —— 「构造方法」作为一个词段整体查表，查不到就是查不到，
 * 绝不会退化成「含『构造』」。这是本模块最重要的一行语义。
 *
 * @param text 原始文本（标题或正文的一个词段）。
 * @param index `buildAliasIndex()` 的结果。
 * @returns 命中的概念 key 与写法；没命中返回 `null`。
 */
function matchWhole(text: string, index: ConceptAliasIndex) {
  const norm = normalizeConceptName(text);
  if (!norm) return null;
  const conceptKey = index.get(norm);
  return conceptKey ? { conceptKey, matchedForm: norm } : null;
}

/**
 * 匹配一个 keyPoint，并区分「原文就是概念名」与「归一化后才是」。
 *
 * 别名表里存的全是归一化写法，所以要判断原文档只能拿原文再归一化一次做对照：
 * 原文与归一化结果一模一样 ⇒ 作者写的正是概念名本身（1.0）；否则只差大小写、
 * 全角或空白（0.8）。中文没有大小写与全角差异，所以中文 keyPoint 的命中
 * 基本都落在 1.0 —— 那是对的，课程作者确实是用概念名写的要点。
 *
 * @returns `exact` = 原文逐字命中；`null` = 没命中。
 */
function matchKeyPoint(text: string, index: ConceptAliasIndex) {
  const raw = text.trim();
  if (!raw) return null;
  const norm = normalizeConceptName(raw);
  if (!norm) return null;
  const conceptKey = index.get(norm);
  if (!conceptKey) return null;
  return { conceptKey, exact: raw === norm };
}

/**
 * 从一页的大纲条目推出它挂了哪些概念。
 *
 * 规则（权重依据写在这里，落库时不再打折）：
 *
 * | 命中位置 | 权重 | 依据 |
 * |---|---|---|
 * | keyPoint 原文逐字命中 | 1.0 | 课程作者把这条写成了本页要点，且用的就是概念名本身 |
 * | keyPoint 归一化后命中 | 0.8 | 只差大小写/全角/空白，仍是同一个词，但不是作者原话 |
 * | 标题词段命中 | 0.6 | 标题是这页的主题，但一个词段只是标题的一部分 |
 * | 正文词段命中 | 0.4 | 正文提到 ≠ 这页讲它 |
 *
 * 同一概念在同一页只保留权重最高的一条（`keypoint` > `title` > `body`）。
 *
 * @param input 一页的 stage / scene / keyPoints（`title` / `body` 可选）。
 * @param graph 种子图（或任意同形状图），用于取别名表。
 * @returns 去重后的挂载草稿，按权重降序、再按 conceptKey 升序（结果稳定）。
 */
export function deriveOccurrencesFromOutlines(
  input: OutlinePageInput,
  graph: SeedGraph,
): OccurrenceDraft[] {
  const index = buildAliasIndex(graph);
  const best = new Map<string, OccurrenceDraft>();

  const consider = (conceptKey: string, weight: number, source: OccurrenceDraft['source']) => {
    const prev = best.get(conceptKey);
    if (prev && prev.weight >= weight) return;
    best.set(conceptKey, {
      conceptKey,
      stageId: input.stageId,
      sceneId: input.sceneId,
      weight,
      source,
    });
  };

  for (const keyPoint of input.keyPoints ?? []) {
    const hit = matchKeyPoint(keyPoint, index);
    if (!hit) continue;
    consider(hit.conceptKey, hit.exact ? 1.0 : 0.8, 'keypoint');
  }

  if (input.title) {
    for (const segment of input.title.split(SEGMENT_SEPARATOR)) {
      const hit = matchWhole(segment, index);
      if (hit) consider(hit.conceptKey, 0.6, 'title');
    }
  }

  if (input.body) {
    for (const segment of input.body.split(SEGMENT_SEPARATOR)) {
      const hit = matchWhole(segment, index);
      if (hit) consider(hit.conceptKey, 0.4, 'body');
    }
  }

  return [...best.values()].sort(
    (a, b) => b.weight - a.weight || a.conceptKey.localeCompare(b.conceptKey),
  );
}
