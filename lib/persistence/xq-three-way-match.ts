/**
 * 三段匹配（P2）：一个外来概念名，落到「命中 / 存疑 / 未命中」的哪一段。
 *
 * ## 为什么不是「字面像就算命中」
 *
 * `J-外来课程接入设计.md` §3.2 的判定树要求**至少两个独立信号**才许判命中，
 * 这是规格 SR-F11.9 写死的（不是我们拍的）。只有一个字面信号时必须降级成
 * 存疑 —— 因为「构造」这种名字在我们图里指 OOP（`构造方法` / `构造器`），
 * 在外来算法图里指「构造题」。字面一模一样，语义毫不相干。
 *
 * 实测（J §3.4）：程天学那套图匹配 234 页命中 10 页，其中 **8 页是「构造」误判**。
 * 也就是说「字面命中就写挂载」这条路的错误率是 80%。
 *
 * ## 三个信号，只有第三个带否决权
 *
 * - **A 字面**：归一后命中 `xq_concept_alias`（`ambiguous=false`）或
 *   `xq_concept.canonical_name`。命中多个概念本身就是「歧义」信号。
 * - **B 上下文**：① 外来节点的父/祖先已经映射到某概念，且候选与它在
 *   `xq_concept_edge` 上有 `contains` 或 `prereq` 路径；② 候选在**这门课**
 *   里已有 occurrence；③ `kind` 与 `external_kind` 一致。
 * - **C 义项锚**：候选的 `anchors` 与外来上下文里的 sense-anchor 词求交。
 *   交集非空 = 支持；**交集为空、候选有锚、外来侧给了锚、且锚够厚** = 一票否决。
 *
 * ★ A 与 B 只能加分，C 能为空就否决。这是唯一能挡住「构造」的地方。
 * ★ 但否决有四个前提，缺一个就只是「不敢判」而不是「不符」—— 见下面两节。
 *
 * ## 阈值曾经是 `null`，现在不是了（2026-11-10 标定）
 *
 * J §3.3 的 `bigram τ` 之前一直**待标定**：手上唯一的相似度读数是页级检索
 * （234 页 / 27 查询，`meanP=1.000 / meanR=0.658`），而这里要判的是 2–8 字的
 * 概念名 —— 拿页级阈值套概念名等于用一个没测过的量做硬判据。所以它一度是
 * `null`：只有 bigram 完全不相交（相似度 = 0）才判未命中，有任何重叠都降级成
 * 存疑。
 *
 * ★ 现在标定完了，方法与读数写在 `BIGRAM_TAU` 的注释里。要点是**两边的代价
 * 不对称，但不是「看不看得到」**：三段都会进提案队列（`--enqueue` 逐条写，
 * 不按 `tri` 过滤），差别在 `tri` 这一列**让人怎么读它**。判成 `miss` 读作
 * 「我们图里没有这个东西」，于是一个其实只是换了说法的名字会被当成新概念
 * 收下 —— 那正是这条链最想避免的重复（`构造题` / `构造方法` 那次错挂 8 页，
 * 方向相反但同源）。判成 `suspect` 读作「像，但请人判」。所以 τ 只取到
 * 「离同义变体还有距离」的位置，不取「能把无关名字全判出」的最大值。
 *
 * ## ★ 「没给锚」不等于「锚不符」
 *
 * 判定树原文写的是「候选的 anchors 与上下文 sense-anchor 交集为空 ⇒ 否决」。
 * 字面照做会让**所有带锚的概念**（真库 104 个里 36 个）在外来侧不给锚时
 * 全部被否掉 —— 因为空集与任何集合的交集都是空。实测：拿 104 个种子名喂进去、
 * `senseAnchors` 留空，结果是 `suspect 104 / hit 0`，且其中 36 条的理由写着
 * `all-vetoed`（「被义项锚否决」），而真相是**外来侧根本没说话**。
 *
 * 所以否决有两个前提：候选自己有锚，**并且**外来侧真的给了锚词。少了第二个，
 * 「交集为空」只反映输入缺失，不构成反对证据；那种情况落到 `lexical-only`
 * 存疑（这仍然符合 SR-F11.9：只剩字面时不许判命中）。
 *
 * ## ★ 「我们的词表太薄」也不等于「你错了」（2026-11-10 补）
 *
 * 否决还有第三个前提：**候选的锚词表本身够厚**（`SENSE_VETO_MIN_ANCHORS`）。
 * 真库实测锚数分布 `1:3 / 2:6 / 3:6 / 4:5 / 5:2 / 6:14`，而薄锚与页数无关 ——
 * `PATH 与环境变量` 21 页只有 2 个锚，`构造方法` 9 页只有 1 个（`["编译"]`）。
 *
 * 于是出现一类**自伤**：`构造方法` 拿正确上下文（`构造器` / `父类` / `super` /
 * `实例化`）来，被判 `all-vetoed`；反过来拿错误上下文（`编译`）来，却命中。
 * 单锚概念等于「它只认一个词」，任何同义说法都被当成反对证据。
 *
 * 这不是「谨慎」而是「拿自己的词表薄去怀疑对方」。薄锚时取消否决权，
 * 只保留「支持」的作用，并给出 `sense-too-thin` 这个理由 —— 它明确指向
 * **该去补锚词表**，而不是「这个外来概念不像」。
 *
 * ## ★ 「你说的正是我们登记的名字」也不算不符（2026-11-10 补）
 *
 * 第四个前提是**外来侧的词不等于我们自己登记的名字**。`anchors` 按定义
 * 不许是概念名或别名（见 `xq-concept-anchors.ts` 的边界二：那是重复自己），
 * 于是「外来侧说它在讲 `构造器`」永远不可能与 `构造方法` 的 anchors 相交 ——
 * 而 `构造器` 正是我们给它记的别名。实测 36 个有锚概念里 **25 个**能被自己的
 * 别名否决（85 对），`Git` 被 `版本控制` 否决、`接口` 被 `interface` 否决 ——
 * 越是我们熟悉的概念越容易被拒。所以「命中自己的规范名/别名」也算 sense 支持。
 *
 * ## 这一版刻意不做的事
 *
 * - **不写库**。匹配只回答「哪一段」，写 occurrence / proposal 是 P4 的事。
 *   混在一起会让「为什么这条被写成命中」查不出来。
 * - **不建概念**。未命中就是未命中，哪怕它看起来很像新概念（J §3.5 明写禁止）。
 * - **不查 `pg_trgm`**。J §8 实测：`show_trgm('变量')` 回空数组、
 *   `similarity('变量','变量') = 0` —— 它对中文不起作用。
 */

import { normalizeConceptName } from '@/lib/concepts/ids';
import { readConceptGraph } from '@/lib/persistence/xq-concept-graph';
import type { ConceptGraph, ConceptNode } from '@/lib/persistence/xq-concept-graph';
import type { Queryable } from '@openmaic/storage/document/pg';

/** 三段是封闭集合，不许加第四段（加了就没人能穷举「这段该怎么处理」）。 */
export const MATCH_TRI = ['hit', 'suspect', 'miss'] as const;

export type MatchTri = (typeof MATCH_TRI)[number];

/** 信号名，与 J §3.1 的表格一一对应。 */
export const MATCH_SIGNALS = ['lexical', 'context', 'sense'] as const;

export type MatchSignal = (typeof MATCH_SIGNALS)[number];

/**
 * 字面候选数达到这个值就判存疑（J §3.3 推的值 **2**）。
 *
 * ★ 这个数**没有标定**。它之所以不是 1，是因为「构造」「栈」实测都是 2 个义项；
 * 之所以不是 3，是因为三个候选时要人看了。
 */
export const SUSPECT_CANDIDATE_LIMIT = 2;

/**
 * bigram 相似度阈值：字面索引没命中、且相似度低于它，判 `miss`（2026-11-10 标定）。
 *
 * ★ **0.45 是扫出来的，不是拍的。** 三条数据集（`.tmp/_tau_sweep.mjs`）：
 *
 * | τ | 20 个真·外来名字判出 miss | 20 个留出集判出 miss | 9 个同义变体被误判 miss |
 * |---|---|---|---|
 * | 0.30 | 19/20 | 20/20 | 0/9 |
 * | 0.42 | 20/20 | 20/20 | 0/9 |
 * | 0.50 | 20/20 | 20/20 | 0/9 |
 * | 0.55 | 20/20 | 20/20 | **2/9**（继承机制 / 接口定义） |
 * | 0.60 | 20/20 | 20/20 | **6/9** |
 *
 * 三个集合的来历：
 * - **真·外来名字**（20 个）：`协程调度器` / `向量数据库` / `傅里叶变换` / `动态规划` /
 *   `红黑树` / `状态机` / `编译器优化` / `垃圾回收器` / `零拷贝` / `幂等性设计` /
 *   `分布式锁` / `一致性哈希` / `影子表` / `灰度发布` / `灰度` / `埋点` /
 *   `漏斗分析` / `归因模型` / `特征工程` / `在线学习`。
 * - **留出集**（20 个，防止只在这一批上挑 τ）：`语义搜索` / `知识图谱补全` /
 *   `推荐系统冷启动` / `强化学习策略梯度` / `图神经网络` / `模型蒸馏` / `量化压缩` /
 *   `时序预测` / `异常检测` / `多模态对齐` / `因果推断` / `联邦学习` / `提示注入` /
 *   `检索增强` / `指令微调` / `注意力稀疏化` / `长上下文压缩` / `词表裁剪` /
 *   `推测解码` / `专家混合` —— 这 20 个在 τ=0.30 时就 20/20 全判出。
 * - **同义变体**（9 个，都是不在别名表里、只能靠 bigram 判的真·同概念说法）：
 *   `Stateless` / `合并冲突` / `递归函数` / `空安全机制` / `多态性` / `封装性` /
 *   `继承机制` / `接口定义` / `变量类型` —— 相似度分别是 0.593 / 0.571 / 0.571 /
 *   0.667 / 0.667 / 0.667 / **0.500** / **0.500** / 0.571。这批判成 miss 就是
 *   漏掉一个该问人的词。
 *
 * ⇒ 可用区间 **0.42–0.52**（两端各留 0.05 间隔），取中 **0.45**。
 *
 * ★ 0.50 在纸面上也行（变体最低就是 0.500，判据是严格 `<`），但边界压着 0.500
 * 等于「刚好不误伤」—— 任何一次 `matchKey` 归一化规则的微调都会把它推过去。
 *
 * ★ 另一条路（改判据形状）试过：用「共享 bigram 个数 ≤ 1 就算偶然」代替 τ。
 * 它在 20 个外来名字上 20/20、在 9 个变体上 0/9 误判，看起来同等好；但它把
 * 「共享几个二字窗口」当成了与名字长度无关的量 —— `方法` 与 `方法重载` 只共享
 * 1 个窗口（2 字名只有一个窗口），而这两个是真的同族。留 τ 是因为 Dice 已经
 * 按长度归一化过，再叠一条计数判据等于两个阈值互相牵制。
 */
export const BIGRAM_TAU = 0.45;

/**
 * Dice 的**退化门槛**：两侧名字都短于这个字数时，这个度量给不出「像但没到」（2026-11-13 补）。
 *
 * ★ 数学事实（`.tmp/AUDIT-xq-match.md` 的 F2，这里按两侧长度分开说）：
 * Dice = 2k / ((La−1)+(Lb−1))，k 是共享的二字窗口数。只有两种情形**真的**退化：
 *
 *   · 任一侧 < 2 字：它一个窗口都没有，k 恒为 0 —— 分数恒等于 0，比了也只是
 *     在说「长度不够」，与像不像无关。
 *   · 两侧都只有 2 字：各自一个窗口，k ≤ 1 —— 分数只可能 0 或 1，而「1」就是
 *     名字完全相等，早被 `lexicalIndex` 的字面分支拿走了。
 *
 * ★ 其余「一侧 2 字」的组合**不**退化：分数只剩 0 或 2/Lb，粗，但它同时带着
 * 「外来名原样包含这个二字窗口」与「候选有多长」两个维度（`循环` 对 `循环结构`
 * 是 0.500、对 `循环结构设计` 是 0.400），τ 就是在这上面切的。所以闸门看的是
 * **这一对**，不是「外来名短不短」。
 *
 * ★ 这条边界是量出来的，702 个 MOOCCubeX 中文名（`.tmp/_mooccubex_names.json`）：
 *   · 修前（只比规范名）：存疑 8。
 *   · 别名参与、不设闸：存疑 47。
 *   · 闸在「任一侧 <3」：存疑退回 8 —— 别名救回的 39 条里 **32 条**靠 2 字别名
 *     （`再循环`→`循环` 0.667、`配方法`→`方法` 0.667、`本地终端`→`终端` 0.500），
 *     全被这条闸误杀。所以不能闸「任一侧」。
 *   · 闸在「两侧都 ≤2 或任一侧 <2」（本实现）：存疑 47，`short-name-no-fuzzy`
 *     只剩 7 条，正好是那 7 个单字名（`卡`/`幂`/`桩`/`绳`/`网`/`金`/`ρ`）。
 *
 * ★ 完全相等不受影响：那是 `lexicalIndex` 的字面分支，轮不到这里。
 */
export const MIN_DICE_CHARS = 3;

/**
 * 候选的锚词数低于这个值，就**不许行使否决权**（2026-11-10 补）。
 *
 * ★ 这个数**没有标定**，它是「至少要有几个词才敢说『它不像』」的下限。
 * 取 3 的理由是实测分布：真库 104 个概念里 9 个只有 1–2 个锚，而这 9 个
 * 恰恰都是「有真实页数」的概念（`构造方法` 9 页 / `PATH` 21 页）。
 * 1 个锚等于「只认一个词」，2 个也只够认两个说法 —— 在这个厚度上，
 * 「交集为空」更可能说明我们抽词抽少了，而不是外来名字错了。
 *
 * 反过来，把门槛提到 4 会让 20 个概念失去否决权（`4:5 / 5:2 / 6:14` 里
 * 只有 21 个够厚），否决权就形同虚设。3 是这两者之间唯一说得通的点。
 */
export const SENSE_VETO_MIN_ANCHORS = 3;

/** 一个候选概念的匹配过程。留着是为了回答「为什么它没被选中」。 */
export interface CandidateAssessment {
  readonly conceptId: string;
  readonly canonicalName: string;
  readonly kind: ConceptNode['kind'];
  /** 这个候选命中的信号（`sense` 只在交集非空时出现）。 */
  readonly signals: readonly MatchSignal[];
  /** 被义项锚一票否决 —— 此时它不算「存活候选」。 */
  readonly vetoed: boolean;
  /** 候选自己的锚词（空数组表示「这个概念没有专属上下文」）。 */
  readonly anchors: readonly string[];
  /**
   * 本来会否决、但因为候选的锚词表太薄而没有否决。
   *
   * ★ 单独一个字段，不复用 `vetoed: false` —— 「我判它没问题」与
   * 「我不敢判」在人工队列里要做的事完全不同（后者该去补锚词表）。
   */
  readonly senseTooThin: boolean;
}

export interface ThreeWayInput {
  /** 外来概念名（原样，不归一）。 */
  readonly externalName: string;
  /** 外来节点的类型，用来与候选的 `kind` 比对（信号 B ③）。 */
  readonly externalKind?: string;
  /** 外来节点所在上下文里的义项锚词（信号 C 的左侧）。 */
  readonly senseAnchors: readonly string[];
  /** 外来图里这个节点的父/祖先**已经映射过**的概念 id（信号 B ① 的起点）。 */
  readonly mappedAncestors?: readonly string[];
  /** 当前课程 id —— 候选是否在这门课里已经出现过（信号 B ②）。 */
  readonly stageId?: string;
}

export interface ThreeWayResult {
  readonly tri: MatchTri;
  /** 只有 `tri === 'hit'` 时有值；其余一律 `null`。 */
  readonly matchedConceptId: string | null;
  /** 判成这一段的原因，直接进 `proposal.signals` 与日志。 */
  readonly reason: MatchReason;
  /** 所有字面候选的评估（含被否决的），按 id 排序稳定。 */
  readonly candidates: readonly CandidateAssessment[];
  /** 归一后的名字（查别名时用的就是这个）。 */
  readonly normalizedName: string;
  /**
   * 未命中那一支用到的相似度（没有候选时才有意义，否则 `null`）。
   * 一次都没比过时也是 `null` —— 名字太短（`short-name-no-fuzzy`），给 0 会被读成「比过，毫不相干」。
   */
  readonly bestSimilarity: number | null;
}

export const MATCH_REASONS = [
  'lexical-ambiguous',
  'all-vetoed',
  'context-supported',
  'sense-supported',
  'lexical-only',
  'no-lexical-candidate',
  /**
   * 与某个概念名像到 τ 以上，但没到别名表那一级 —— 像不等于同一个，交给人。
   *
   * ★ 这个理由在 τ 标定前叫 `bigram-uncalibrated`（「没法判」）；标定之后
   * 语义变了：字面没命中、名字又足够像，所以判存疑。
   */
  'bigram-similar',
  /** bigram 低于已标定的 τ（0.45）：字面没命中、名字也不像 —— 判未命中。 */
  'bigram-below-tau',
  /**
   * 名字太短，模糊比对对它无能为力 —— 与「毫不相干」和「像但没到」都不是一回事。
   *
   * ★ 见到这个理由不等于「库里没有相关概念」：它是 Dice 的**定义域**问题（见
   * `MIN_DICE_CHARS`），字面 / 别名分支走不通时，短名本来就没有可判的信号。
   * 想推它只能去补别名或锚词，调 τ 是白调。
   */
  'short-name-no-fuzzy',
  /**
   * 候选的锚词表太薄，否决权不生效 —— 存疑不是「不像」，是「我们还没本钱判」。
   * 见到这个理由该去做的事是补 `xq_concept.anchors`，不是反复看这条名字。
   */
  'sense-too-thin',
] as const;

export type MatchReason = (typeof MATCH_REASONS)[number];

/** 喂给纯判定函数的一切外部事实（全部由调用方查好，函数自己不碰库）。 */
export interface MatchFacts {
  /** 归一后的名字 → 概念 id 列表（含 `canonical_name` 与别名两条来源）。 */
  readonly lexicalIndex: ReadonlyMap<string, readonly string[]>;
  /**
   * 概念 id → 该概念的**全部名字**（规范名 + 别名），归一后去重、码点序排序。
   *
   * ★ 与 `lexicalIndex` 是同一批数据的两面：那一张按名字查概念（字面分支用），
   * 这一张按概念取名字（模糊分支用）。模糊分支只翻那一张，就只会拿规范名去比 ——
   * 别名明明在库里，却进不了相似度，`再循环` 于是永远比不上 `循环`。
   */
  readonly namesByConcept: ReadonlyMap<string, readonly string[]>;
  /** 概念 id → 节点。 */
  readonly nodes: ReadonlyMap<string, ConceptNode>;
  /** 概念 id → 锚词。没有这一列的概念给空数组。 */
  readonly anchors: ReadonlyMap<string, readonly string[]>;
  /** 概念 id → 它在这门课里出现过的 `stage_id` 集合（信号 B ②）。 */
  readonly stages: ReadonlyMap<string, ReadonlySet<string>>;
  /** 「候选与已映射的祖先之间有没有 contains / prereq 路径」这个判断。 */
  readonly connected: (candidateId: string, ancestorId: string) => boolean;
}

/** 归一：与查别名表、与 `xq_concept_alias.alias` 的存储形式完全一致。 */
export function matchKey(name: string): string {
  return normalizeConceptName(name);
}

/**
 * 把 `canonical_name` 与别名摊成一张「归一名字 → 概念 id」的索引。
 *
 * ★ 同一个归一名字可能指多个概念（歧义别名）。**这不是数据脏，是事实**：
 * `xq_concept_alias.ambiguous = true` 的行就是允许一名多指的。所以值是数组。
 */
export function buildLexicalIndex(
  nodes: ReadonlyMap<string, ConceptNode>,
  aliases: readonly { alias: string; conceptId: string }[],
): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  const add = (raw: string, conceptId: string) => {
    const key = matchKey(raw);
    if (key === '') return;
    const existing = index.get(key);
    if (existing === undefined) index.set(key, new Set([conceptId]));
    else existing.add(conceptId);
  };
  for (const node of nodes.values()) add(node.canonicalName, node.id);
  for (const row of aliases) add(row.alias, row.conceptId);
  const out = new Map<string, string[]>();
  for (const [key, ids] of index) out.set(key, [...ids].sort(compareCodePoints));
  return out;
}

/** 码点序比较 —— 不用 `localeCompare`（它随 ICU 版本变，排序会漂）。 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 把 `canonical_name` 与别名摊成一张「概念 id → 全部归一名字」的索引。
 *
 * 模糊分支要回答的是「这个名字在**任何**一个说法下像不像某个概念」，所以它需要
 * 的是这张反查表；`lexicalIndex` 只答「这个名字是不是某个概念的写法」，方向相反。
 */
export function buildNamesByConcept(
  nodes: ReadonlyMap<string, ConceptNode>,
  aliases: readonly { alias: string; conceptId: string }[],
): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  const add = (raw: string, conceptId: string) => {
    const key = matchKey(raw);
    if (key === '') return;
    const existing = index.get(conceptId);
    if (existing === undefined) index.set(conceptId, new Set([key]));
    else existing.add(key);
  };
  for (const node of nodes.values()) add(node.canonicalName, node.id);
  for (const row of aliases) add(row.alias, row.conceptId);
  const out = new Map<string, string[]>();
  for (const [conceptId, names] of index) out.set(conceptId, [...names].sort(compareCodePoints));
  return out;
}

/**
 * 中文 bigram Dice 相似度。
 *
 * 与 `lib/server/agent-runtime/course-edit/apply.ts:395` 的 `bigramCounts` 同一个
 * 度量（2 * 交集 / (|a| + |b|)），但这里判的是两个**名字**，不是「名字 vs 窗口」，
 * 所以不需要滑窗。
 */
export function bigramSimilarity(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left.length < 2 || right.length < 2) {
    // 单字名的 bigram 是空集：只能判「是否完全相等」。
    return left === right && left !== '' ? 1 : 0;
  }
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const gram = left.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let shared = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const gram = right.slice(index, index + 2);
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      shared += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * shared) / (left.length - 1 + (right.length - 1));
}

/** 义项锚求交：返回**命中的锚词**（不是布尔 —— 「几种锚中了」要能区分）。 */
export function senseHits(anchors: readonly string[], senseAnchors: readonly string[]): string[] {
  if (anchors.length === 0 || senseAnchors.length === 0) return [];
  const wanted = new Set(senseAnchors.map((word) => matchKey(word)).filter((word) => word !== ''));
  const hits: string[] = [];
  for (const anchor of anchors) {
    if (wanted.has(matchKey(anchor))) hits.push(anchor);
  }
  return hits;
}

/**
 * 纯判定：三段中的哪一段。
 *
 * 这段代码没有 I/O，所以判据可以直接喂假事实（见
 * `tests/persistence/xq-three-way-match.test.ts` 的纯函数组）。
 */
export function decideThreeWay(input: ThreeWayInput, facts: MatchFacts): ThreeWayResult {
  const normalizedName = matchKey(input.externalName);
  const candidateIds = (normalizedName === '' ? [] : facts.lexicalIndex.get(normalizedName)) ?? [];

  // ── 候选集为空：字面索引里没有，只能靠 bigram 判「像不像」──────────────
  //
  // τ 已标定（0.45，见 `BIGRAM_TAU`），所以这一支是三分而不是两分：
  //   · 名字太短，Dice 给不出可比的分 ⇒ 未命中，理由 `short-name-no-fuzzy`
  //     （见 `MIN_DICE_CHARS`：这一档不是「不像」，是「没得比」）。
  //   · 一个二字窗口都不重合 ⇒ 未命中，理由 `no-lexical-candidate` —— 与
  //     「低于 τ」分开，因为两者要人做的事不同（前者是图里真没有，
  //     后者是我们图里可能有一个换了说法的同一个东西）。
  //   · 0 < 相似度 < τ ⇒ 未命中，理由 `bigram-below-tau`。
  //   · 相似度 ≥ τ ⇒ 存疑，理由 `bigram-similar`。
  //
  // 比对的是「规范名 + 全部别名」（`namesByConcept`）：别名是同一个概念的另一个
  // 说法，模糊分支不认它，`再循环` 就永远够不到 `循环`。
  //
  // ★ `miss` 与 `suspect` 都会进提案队列，区别只在 `tri` 让人怎么读它 ——
  //   见 `BIGRAM_TAU` 注释里那句「不是看不看得到」。
  if (candidateIds.length === 0) {
    const fuzzy = bestNameSimilarity(normalizedName, facts);
    if (!fuzzy.compared) {
      return {
        tri: 'miss',
        matchedConceptId: null,
        reason: 'short-name-no-fuzzy',
        candidates: [],
        normalizedName,
        bestSimilarity: null,
      };
    }
    const best = fuzzy.similarity;
    if (best <= 0) {
      return {
        tri: 'miss',
        matchedConceptId: null,
        reason: 'no-lexical-candidate',
        candidates: [],
        normalizedName,
        bestSimilarity: best,
      };
    }
    if (best < BIGRAM_TAU) {
      return {
        tri: 'miss',
        matchedConceptId: null,
        reason: 'bigram-below-tau',
        candidates: [],
        normalizedName,
        bestSimilarity: best,
      };
    }
    return {
      tri: 'suspect',
      matchedConceptId: null,
      reason: 'bigram-similar',
      candidates: [],
      normalizedName,
      bestSimilarity: best,
    };
  }

  // ── 字面就有歧义：先评估每个候选，但结论已经是存疑 ─────────────────
  const assessed = candidateIds.map((id) => assessCandidate(id, input, facts));

  if (candidateIds.length >= SUSPECT_CANDIDATE_LIMIT) {
    return {
      tri: 'suspect',
      matchedConceptId: null,
      reason: 'lexical-ambiguous',
      candidates: assessed,
      normalizedName,
      bestSimilarity: null,
    };
  }

  const survivors = assessed.filter((candidate) => !candidate.vetoed);
  if (survivors.length === 0) {
    return {
      tri: 'suspect',
      matchedConceptId: null,
      reason: 'all-vetoed',
      candidates: assessed,
      normalizedName,
      bestSimilarity: null,
    };
  }

  // 只有一个字面候选时，`survivors` 最多一条 —— 但防御式收尾，别假设。
  if (survivors.length > 1) {
    return {
      tri: 'suspect',
      matchedConceptId: null,
      reason: 'lexical-ambiguous',
      candidates: assessed,
      normalizedName,
      bestSimilarity: null,
    };
  }

  const survivor = survivors[0];
  const hasSense = survivor.signals.includes('sense');
  const hasContext = survivor.signals.includes('context');
  // ★ 命中 = 「字面」+ 至少一个**别的**信号。`anchors` 非空本身不是信号 ——
  //   它是「义项锚这道闸能不能用」的前提。J §3.2 写「存活 ==1 且（B 支持
  //   或 anchors 非空）⇒ 命中」，那句成立的前提是外来侧**给了**锚、且交集
  //   非空（否则候选已经被否决出局）；给没给这件事本身就是 `hasSense`。
  //   按「anchors 非空就算命中」写会让「字面 + 我们恰好给这个概念存过锚」
  //   变成命中 —— 那仍然只有一个信号，正是 SR-F11.9 禁止的。
  if (hasContext || hasSense) {
    return {
      tri: 'hit',
      matchedConceptId: survivor.conceptId,
      reason: hasSense ? 'sense-supported' : 'context-supported',
      candidates: assessed,
      normalizedName,
      bestSimilarity: null,
    };
  }

  // 只剩字面：不许判命中（SR-F11.9 的原文要求）。
  //
  // ★ 但「为什么只剩字面」有两种，对下一个人要说不同的话：
  //   ① 义项锚看了一眼、不相交（`anchors` 够厚）⇒ 真的可能不是同一个东西；
  //   ② 义项锚**根本不敢看**（候选锚太薄）⇒ 我们还没本钱判，该去补锚词表。
  // 把②也写成 `lexical-only`，人工队列里就会混进一批「看着像但不敢认」的条目，
  // 而它们要做的事（补 anchors）与真正的语义分歧完全不同。
  return {
    tri: 'suspect',
    matchedConceptId: null,
    reason: survivor.senseTooThin ? 'sense-too-thin' : 'lexical-only',
    candidates: assessed,
    normalizedName,
    bestSimilarity: null,
  };
}

function assessCandidate(
  conceptId: string,
  input: ThreeWayInput,
  facts: MatchFacts,
): CandidateAssessment {
  const node = facts.nodes.get(conceptId);
  const anchors = facts.anchors.get(conceptId) ?? [];
  const signals: MatchSignal[] = ['lexical'];

  const hits = senseHits(anchors, input.senseAnchors);
  // ★ 外来侧说的那个词，如果**是我们自己给这个概念登记过的名字**（规范名或
  //   别名），也算语义对上了 —— 「它说它在讲构造器，而 `构造器` 正是我们
  //   给 `构造方法` 记的别名」这句里没有任何分歧可判。
  //
  //   不加这一条会出一个很难看的自伤：`anchors` 按定义**不许**是概念名或
  //   别名（见 `xq-concept-anchors.ts` 的边界二），于是「外来侧用的正是我们
  //   登记的别名」永远不可能与 anchors 相交。实测 36 个有锚概念里 **25 个**
  //   会被自己的别名否决（`Git` 被 `版本控制` 否决、`多态` 被 `动态绑定`
  //   否决、`接口` 被 `interface` 否决）—— 越是我们熟悉的概念越容易被拒。
  const namedByThem = input.senseAnchors.some((word) =>
    facts.lexicalIndex.get(matchKey(word))?.includes(conceptId),
  );
  if (hits.length > 0 || namedByThem) signals.push('sense');

  // ★ 否决有三个前提，缺一不可：
  //   ① 候选**自己**有锚 —— 没锚是「我们对它一无所知」，否决等于凭沉默判罪；
  //   ② 外来侧**真的给了**锚词 —— 否则「交集为空」只是因为左边是空集；
  //   ③ 候选的锚词表**够厚** —— 否则「交集为空」只说明我们抽词抽少了。
  // 把②漏掉会让「没提供上下文」被读成「语义不符」，于是所有带锚的概念
  // 在外来侧不给锚时**全部**被否决 —— 那不是谨慎，是拿信息缺失当反对证据。
  // 把③漏掉则相反：自己词表薄却去怀疑对方。实测 `构造方法` 的锚只有 ["编译"]，
  // 于是语义正确的 `构造器`/`父类`/`super` 全被否决，而错误的 `编译` 反而命中。
  // 「交集为空」里的交集现在有两半：锚词命中，**或者**外来侧用的词是我们自己
  // 登记的规范名/别名（上一段的 `namedByThem`）—— 后者不算「语义不符」。
  const senseAsked = input.senseAnchors.length > 0;
  const anchorsThickEnough = anchors.length >= SENSE_VETO_MIN_ANCHORS;
  const matched = hits.length > 0 || namedByThem;
  const wouldVeto = anchors.length > 0 && senseAsked && !matched;
  const vetoed = wouldVeto && anchorsThickEnough;
  const senseTooThin = wouldVeto && !anchorsThickEnough;

  if (!vetoed && contextSupports(conceptId, input, facts)) signals.push('context');

  return {
    conceptId,
    canonicalName: node?.canonicalName ?? conceptId,
    kind: node?.kind ?? 'concept',
    signals,
    vetoed,
    anchors,
    senseTooThin,
  };
}

function contextSupports(conceptId: string, input: ThreeWayInput, facts: MatchFacts): boolean {
  // ① 已映射的祖先与候选之间有 contains / prereq 路径。
  // ★ 跳过「祖先就是候选自己」：那是同一个节点，不是上下文。若不跳，
  //   「外来父节点映射到的正是这个候选」就会被算成第二个独立信号，
  //   于是只剩字面的情况也能一路判成命中 —— 那正是本模块要挡的错。
  for (const ancestor of input.mappedAncestors ?? []) {
    if (ancestor === '' || ancestor === conceptId) continue;
    if (facts.connected(conceptId, ancestor)) return true;
  }
  // ② 候选在这门课里已经出现过。
  const stageId = input.stageId ?? '';
  if (stageId !== '' && (facts.stages.get(conceptId)?.has(stageId) ?? false)) return true;
  // ③ kind 一致。★ 外来侧没给 kind 时不算支持 —— 「没说」不是「说了对」。
  if (input.externalKind !== undefined && input.externalKind !== '') {
    const node = facts.nodes.get(conceptId);
    if (node !== undefined && node.kind === input.externalKind) return true;
  }
  return false;
}

/**
 * 这一对名字的 Dice 是否落进退化区间（见 `MIN_DICE_CHARS` 的数学）。
 *
 * 只看「这一对」，不看某个名字单独的短长 —— 2 字外来名对 5 字别名是
 * `再循环` 之外最常见的救回形态，一刀切在「外来名短」上会把 F1 一起切掉。
 */
function diceIsDegenerate(a: string, b: string): boolean {
  // 任一侧没有二字窗口：k 恒为 0，分数恒等于 0 —— 比了也只是在说「长度不够」。
  if (a.length < 2 || b.length < 2) return true;
  // 两侧都只有一个窗口：k ≤ 1，分数只可能 0 或 1；「1」早被字面分支拿走。
  return a.length < MIN_DICE_CHARS && b.length < MIN_DICE_CHARS;
}

/**
 * 模糊分支：外来名与每个概念的**全部名字**（规范名 + 别名）比，取全局最大。
 *
 * 返回里的 `compared` 不是装饰：调用方要区分「比过，全是 0」与「一个都没比」
 * （后者见 `MIN_DICE_CHARS`）—— 这两种情况读报告的人要做的事不一样。
 */
function bestNameSimilarity(
  name: string,
  facts: MatchFacts,
): { readonly similarity: number; readonly compared: boolean } {
  if (name === '') return { similarity: 0, compared: false };
  let best = 0;
  let compared = false;
  for (const node of facts.nodes.values()) {
    // 兜底：手工造的 facts 可能没填 `namesByConcept`（只有 `loadMatchFacts` 会填）。
    // 兜到空会让每个名字都掉进「没有候选」—— 那是静默的错误，不如退回规范名。
    const names = facts.namesByConcept.get(node.id) ?? [matchKey(node.canonicalName)];
    for (const candidate of names) {
      if (diceIsDegenerate(name, candidate)) continue;
      compared = true;
      const score = bigramSimilarity(name, candidate);
      if (score > best) best = score;
      if (best >= 1) return { similarity: best, compared: true };
    }
  }
  return { similarity: best, compared };
}

/**
 * 把「候选与祖先之间有没有路径」这件事做成一个闭包。
 *
 * 双向查找：`contains` 是归属（单元包含小节），`prereq` 是先修（B 的先修是 A）。
 * 两个方向都算「有关」—— 外来图的父节点既可能是包含它的单元，也可能是它的
 * 直接先修。
 */
export function makeConnectedPredicate(graph: ConceptGraph): (a: string, b: string) => boolean {
  const neighbours = new Map<string, Set<string>>();
  const link = (left: string, right: string) => {
    if (left === right) return;
    const set = neighbours.get(left);
    if (set === undefined) neighbours.set(left, new Set([right]));
    else set.add(right);
  };
  for (const edge of graph.edges) {
    if (edge.relation !== 'contains' && edge.relation !== 'prereq') continue;
    link(edge.fromId, edge.toId);
    link(edge.toId, edge.fromId);
  }
  return (a, b) => {
    if (a === b) return true;
    const adjacency = neighbours.get(a);
    if (adjacency === undefined) return false;
    // 先看一步（绝大多数命中都在这里），再看两步 —— 再远就不是「上下文」了。
    if (adjacency.has(b)) return true;
    for (const middle of adjacency) {
      if (neighbours.get(middle)?.has(b) ?? false) return true;
    }
    return false;
  };
}

// ── 把库里的东西读成 `MatchFacts` ─────────────────────────────────────

const READ_ALIASES_SQL = `SELECT alias, concept_id
  FROM xq_concept_alias
 ORDER BY alias, concept_id`;

const READ_ANCHORS_SQL = `SELECT id, anchors
  FROM xq_concept
 WHERE cardinality(anchors) > 0
 ORDER BY id`;

const READ_OCCURRENCE_STAGES_SQL = `SELECT DISTINCT concept_id, stage_id
  FROM xq_concept_occurrence
 ORDER BY concept_id, stage_id`;

interface AliasRow extends Record<string, unknown> {
  alias: unknown;
  concept_id: unknown;
}

interface AnchorRow extends Record<string, unknown> {
  id: unknown;
  anchors: unknown;
}

interface OccurrenceStageRow extends Record<string, unknown> {
  concept_id: unknown;
  stage_id: unknown;
}

/**
 * 把判定需要的一切事实一次读进来。
 *
 * ★ 别名**不按 `ambiguous` 过滤** —— 含混的别名（`ambiguous = true`）本来就允许
 * 一名多指，读进来之后会自然落成「候选 ≥ 2 ⇒ 存疑」，这正是 J §3.1 说的
 * 「返回多候选本身就是歧义信号」。过滤掉反而会让它变成一个假的确定答案。
 */
export async function loadMatchFacts(queryable: Queryable): Promise<MatchFacts> {
  const [graph, aliasResult, anchorResult, stageResult] = await Promise.all([
    readConceptGraph(queryable),
    queryable.query<AliasRow>(READ_ALIASES_SQL),
    queryable.query<AnchorRow>(READ_ANCHORS_SQL),
    queryable.query<OccurrenceStageRow>(READ_OCCURRENCE_STAGES_SQL),
  ]);

  const aliases: { alias: string; conceptId: string }[] = [];
  for (const row of aliasResult.rows) {
    if (typeof row.alias !== 'string' || typeof row.concept_id !== 'string') continue;
    aliases.push({ alias: row.alias, conceptId: row.concept_id });
  }

  const anchors = new Map<string, readonly string[]>();
  for (const row of anchorResult.rows) {
    if (typeof row.id !== 'string' || !Array.isArray(row.anchors)) continue;
    anchors.set(
      row.id,
      row.anchors.filter((word): word is string => typeof word === 'string' && word !== ''),
    );
  }

  const stages = new Map<string, Set<string>>();
  for (const row of stageResult.rows) {
    if (typeof row.concept_id !== 'string' || typeof row.stage_id !== 'string') continue;
    const set = stages.get(row.concept_id);
    if (set === undefined) stages.set(row.concept_id, new Set([row.stage_id]));
    else set.add(row.stage_id);
  }

  return {
    lexicalIndex: buildLexicalIndex(graph.nodes, aliases),
    // 同一批 aliases 摊两遍：字面分支要「名字 → 概念」，模糊分支要「概念 → 名字」。
    namesByConcept: buildNamesByConcept(graph.nodes, aliases),
    nodes: graph.nodes,
    anchors,
    stages,
    connected: makeConnectedPredicate(graph),
  };
}

/** 一次判多个名字（同一批导入里几百个名字，共用一份事实）。 */
export function decideMany(inputs: readonly ThreeWayInput[], facts: MatchFacts): ThreeWayResult[] {
  return inputs.map((input) => decideThreeWay(input, facts));
}
