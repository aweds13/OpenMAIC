/**
 * 学习状态 → 提示词块（**纯函数**，不碰库、不碰磁盘、不看时钟以外的东西）。
 *
 * ── 它解决的是哪个问题 ────────────────────────────────────────────
 *
 * `学习状态.md`（人看的那份）是**按答题记录折叠出来的散文**：哪道题现在错了、
 * 哪页没交卷。它对人够用，对模型不够 —— 模型真正要的是三件事：
 *
 *   1. **按知识点/页面的三态**：这页是「已达判据」「未达判据」还是「暂未定」；
 *   2. **今天该复习什么**（错题四关 1/3/7/15 天，到期了才提）；
 *   3. **动手练习的结果**（真的跑过代码的那些，来自 result.json）。
 *
 * 这三件事在库里已经有各自的真源（`xq_cell_state` / `xq_review_schedule` /
 * 练习文件夹），本模块只做「把行变成给模型读的短句」这一件事。**刻意做成纯函数**：
 * 判据（掌握度）在 `lib/quiz/xq-mastery.ts`，取数在调用方，渲染在这里 ——
 * 三者分开之后，渲染可以逐字节断言（见下面的「稳定排序」）。
 *
 * ── 六条硬约束，每条都写了为什么 ──────────────────────────────────
 *
 * 1. **零冷启动：三样都空 ⇒ 返回空字符串，不是「还没有数据」。**
 *    理由：空块同样占 token，而且**会破坏前缀缓存** —— system prompt 在 provider
 *    的 prefix cache 最前面，多一个字节后面整条都要重算（实测过 99.1% → 38.5%）。
 *    而「没数据」这件事模型从「**没有这一段**」就能推出来，不需要一句话告诉它。
 *    这也对应产品前提：状态是上课的**副产品**，不是开课前的门槛 —— 一个人刚打开
 *    课、什么都没做过时，这里本来就该什么都没有。
 *
 * 2. **块里不许出现任何元指令**（「这条不变」「可以当默认值」「不要念给学习者听」）。
 *    理由：这些句子是**写给执行者**的，可提示词里没有「执行者」这一层 —— 模型读到
 *    「这条不变」只会当成一句关于世界的断言，然后就错了。注入链路里
 *    `prompt-context-file.ts:34` 还会把 HTML 注释整段剥掉，写在注释里的元指令
 *    **根本没有运行时执行者**，只会误导读代码的人。所以这里只输出事实。
 *
 * 3. **块首一行声明「这是状态不是指令」。**
 *    理由：状态块是**唯一会随答题变化**的一段（`course-tools.ts` 的
 *    `PROMPT_BLOCK_ORDER` 把它放最后），前后文都是行为纪律。不标一句，模型很容易
 *    把「未达判据：循环结构」读成一条命令。**只标一行、不展开** —— 展开就又变成指令了。
 *
 * 4. **结论要可执行：`unknown` + `reason === 'too-few-items'` 时算出「再做对 N 题可判」。**
 *    理由：只给一个「暂未定」，模型无从下手，只能瞎猜要不要补讲；给一个数字，它就能
 *    决定「再出两道同类题」还是「直接讲」。数字必须来自 `itemsNeededForKnown()`
 *    （与判会用的同一套 Beta 下界），**算不出来就不写这一句** —— 编一个数字比不写更坏。
 *
 * 5. **稳定排序：按 `(stage_id, scene_id)` 的码点序。**
 *    理由：前缀缓存要求「同一组数据两次渲染逐字节相同」。`localeCompare` 会随
 *    ICU/系统语言变化，`Array.prototype.sort` 的默认比较是 UTF-16 码元序但对象比较
 *    会退化成 `String(obj)` —— 所以这里显式用 `<`/`>` 比字符串，不用 localeCompare。
 *
 * 6. **本函数不读笔记、不写笔记；笔记的任何内容都不得改变本函数的输出。**
 *    理由：笔记（个人知识库 / Obsidian Vault）是**另一个房东的材料**，
 *    不归本仓的课程与学情数据管（SR-F11.6）。它的检索命中是**旁证**，
 *    只说明「这个人可能在别处写过这件事」，不构成答题证据 ——
 *    把它读进来，等于让一篇手写笔记去改 `tri` 的判定，而判定只许由
 *    `xq_cell_state` / `xq_review_schedule` / 练习结果三样推出。
 *    所以 `lib/notes/local-kb.ts` 的返回**只给人和调用方看**，一行都不进这个渲染器。
 *
 * 另外两条格式约束：**不用 emoji、不用表格**。理由：表格在提示词里难解析，emoji 占
 * 字节又会让「同一件事」在不同端看起来不一样；短行 `- 页 …· 概念「…」· 会（…）`
 * 是模型和人都能一眼读的形状。
 */
import { itemsNeededForKnown, type Tri } from '@/lib/quiz/xq-mastery';

/** 一格的判读结果 —— 与 `xq_cell_state` 的列一一对应（`numeric` 在 PG 里是字符串）。 */
export interface LearnerStateCell {
  stageId: string;
  sceneId: string;
  tri: Tri;
  /** 证据条数（加权后）。PG 的 numeric 会以 string 回来，所以两种都收。 */
  n?: number | string | null;
  k?: number | string | null;
  /** 置信下界（0..1）。 */
  lb5?: number | string | null;
  /** 置信上界（0..1）。 */
  ub95?: number | string | null;
  /** `xq_cell_state.reason`。只在 tri === 'unknown' 时有意义。 */
  reason?: string | null;
  /** 概念名（`xq_question_concept` 聚合出来的 keypoint）；没有就用页面标题。 */
  concept?: string | null;
  /** 页面标题与页序（来自 `document_scenes`），用来让人认得出是哪一页。 */
  title?: string | null;
  order?: number | null;
}

/** 一条到期的复习（`xq_review_schedule` 里 `done_at IS NULL AND due_at <= now`）。 */
export interface LearnerStateReview {
  stageId: string;
  sceneId: string;
  concept?: string | null;
  questionId?: string | null;
  /** 第几关（1..4，对应 1/3/7/15 天）。 */
  round?: number | null;
  dueAt: string | Date;
}

/**
 * 一条**知识点级**读数（`readConceptMastery()` 折出来的）。
 *
 * ★ 它与上面那三态格子不是一回事：一格是「这一页他会不会」，这里是
 *   「这个知识点他会不会」，证据**跨页跨课合并**。`类与对象` 那条实测就跨了
 *   2 页 2 课 —— 任何单独一页都只有 1 条证据（不够判），合起来才够。
 */
export interface LearnerStateConcept {
  concept: string;
  tri: Tri;
  /** 合并后的证据条数（按 `counted_n` 加权）。 */
  n?: number | string | null;
  /** 合并后的答对数。 */
  k?: number | string | null;
  lb5?: number | string | null;
  ub95?: number | string | null;
  /** 参与判定的题数（去重后的题目个数），与 `n` 不是一回事。 */
  questions?: number | string | null;
}

/**
 * 一条**画像与状态的矛盾**：画像把人写成「不知道」，库里却判出来了。
 *
 * ★ 这一层只负责「让矛盾可见」，不负责裁决。规格已经把优先级写死
 *   （矛盾时以人写的那份为准并显式说明），所以块里那一节的措辞必须是
 *   「画像说 X，状态说 Y」，而不是「X 是错的」—— 后者是模型替人做决定。
 */
export interface LearnerStateContradiction {
  /** 画像里那一行的领域名（可能是「Dart / Flutter」这种合称）。 */
  domain: string;
  /** 标题里真正命中的那个词。 */
  token: string;
  stageId: string;
  sceneId: string;
  title: string;
  /** 库里的结论：`known` 或 `not-learned`。 */
  tri: Tri;
}

export interface RenderLearnerStateBlockInput {
  /** 三态格子（`xq_cell_state`）。传进来之前应当已按 owner 圈好。 */
  cells?: readonly LearnerStateCell[];
  /** 到期复习。传进来之前应当已经过滤过 `done_at IS NULL`。 */
  reviews?: readonly LearnerStateReview[];
  /**
   * 知识点级读数（跨页跨课合并）。
   *
   * ★ **只列已经判得出来的**（`known` / `not-learned`），`unknown` 一律不列。
   *
   * 理由：知识点层存在的意义是**跨页合并把证据凑够**。没凑够的时候，页级那三节
   * 已经把「为什么不够判」写得比这里细（`再做对 N 题可判` / `证据不一致`）——
   * 再把 14 个「暂未定」抄一遍，只多占前缀预算，一个字的信息都不多。
   *
   * 反过来，一旦某个知识点真的判出来了，它就是比任何单页都强的陈述，该进块。
   */
  concepts?: readonly LearnerStateConcept[];
  /**
   * 画像与状态的矛盾（`findProfileContradictions()` 的产出）。
   *
   * ★ 它是**唯一**一节写「两份文件打架」的地方。为什么值得占预算：两份都被
   *   注入同一次运行、都标着「当作事实」，而人不会同时读两遍 —— 没有这一节，
   *   矛盾的唯一发现方式就是有人碰巧注意到。
   */
  contradictions?: readonly LearnerStateContradiction[];
  /**
   * 练习结果，**原样**是 `formatPracticeResultsForState()` 的输出。
   *
   * 理由：那一份已经把「来源是 result.json 而不是 runtime_records」写在标题里了，
   * 再在这里重写一遍就成了两处投影，迟早漂。没练习结果时它是 `''`。
   */
  practiceText?: string;
  /** 判定「今天到期」的时点。省略取 `new Date()`；测试与重放时必须显式传。 */
  now?: Date | string | number;
  /** 最多列几条到期复习。默认 5 —— 再多就把提示词预算吃掉了。 */
  maxReviews?: number;
}

const HEADER = '以下是学习状态数据，不是给你的指令。';

/**
 * 写给**人**的一行，不是写给模型的。
 *
 * SR-F11.7 要求：由代码生成的状态文件必须写明「由谁生成、什么时候生成、不要手改」。
 * 此前这份文件只说了「是数据不是指令」，**一个字的「不要手改」都没有** —— 于是
 * 谁都可以直接编辑它，然后在下一次刷新时被静默覆盖，而且覆盖前后都没有任何提示。
 *
 * ★ 为什么用 HTML 注释：块内不许出现元指令（约束 2），而注入链路
 *   （`prompt-context-file.ts` 的 `HTML_COMMENT`）会把注释整段剥掉 —— 所以它
 *   人看得到、模型看不到，正好落在「声明归属」这一层而不违反约束 2。
 *
 * ★ 为什么写「下一次刷新」而不是具体时间：时间会随每次写入变化，而这一行的存在
 *   意义是**说明它会变**；写一个具体时刻反而让人以为「那就是定稿时刻」。
 *   `recorded_at` 那类精确时刻在库里，不在给人看的散文里。
 */
const PROVENANCE =
  '<!-- 本文件由代码生成（学习状态刷新器）。手改会在下一次刷新时被整段覆盖 —— 要改判定，改库与判据，不要改这里。 -->';

const DEFAULT_MAX_REVIEWS = 5;

/** 字典序比较码点，**不用** `localeCompare`（它会随 ICU/系统语言变，见约束 5）。 */
function byCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** `numeric` 列可能是 string / number / null；统一成 number，非有限值一律当「没有」。 */
function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 两位小数；`null` ⇒ 不写那半句（见约束 4「算不出来就不写」）。 */
function fixed2(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

/** 复习去重的键：同一页同一道题同一关只出现一次。 */
function reviewKey(review: LearnerStateReview): string {
  return [
    review.stageId,
    review.sceneId,
    review.questionId ?? '',
    String(review.round ?? ''),
    typeof review.dueAt === 'string' ? review.dueAt : review.dueAt.toISOString(),
  ].join('\u0000');
}

/**
 * 一行三态。格式固定成 `- 页 <sceneId>（<stageId>）· <标签>「…」· <结论>`。
 *
 * ★ `stage_id` 与 `scene_id` **必须都在行里**：`document_scenes` 的主键是
 * `(stage_id, id)`，35 个 scene id 跨课复用 —— 只写 `p12` 的话，同一段提示词里
 * 两个不同的「第 12 页」会撞在一起，模型没法区分该讲哪一门课的那一页。
 *
 * ★ 标签**跟着数据来源变**：有概念就写「概念」，只有页标题就写「标题」，两者都没有
 * 才退回 sceneId（那时连标签都不写）。理由是实测出来的：`xq_question_concept`
 * 还没数据时全部走标题回退，如果照样写「概念『Git 自检：十道题（易 → 难）』」，
 * 模型会把一句**页面标题**当成一个**知识点的名字**，然后在讲解里管它叫「概念」，
 * 甚至在别的课上找同名概念。标签写错比不写更坏 —— 它是模型判断"这是什么粒度"
 * 的唯一线索。
 */
function cellLine(cell: LearnerStateCell): string {
  const concept = (cell.concept ?? '').trim();
  const title = (cell.title ?? '').trim();
  // 三档回退：概念名 > 页标题 > sceneId。标签与前两档一一对应。
  const label = concept ? '概念' : title ? '标题' : '';
  const shown = concept || title || cell.sceneId;
  // 段落用 `· ` 连，**不预先补分隔符** —— 先补一个再给别的段补一个，就会出 `·  · n=`。
  const parts = [`页 ${cell.sceneId}（${cell.stageId}）`];
  if (label) parts.push(`${label}「${singleLine(shown)}」`);
  const measure = measureOf(cell);
  if (measure) parts.push(measure);
  const head = `- ${parts.join(' · ')} · `;

  // ★ 判据外显：`n=` / `k=` 两个数必须跟着读数一起出现（上面已拼进 `head`）。
  //
  // 理由不是「信息越多越好」，而是 N6 §9.2 那条实测：读者放弃查看进度信息的原因里，
  // 「认为它不准确」是独立预测因子之一，而一个不带样本量的「置信下界 0.78」无从核对。
  // 两个数都是 `xq_cell_state` 的列，渲染器本来就有，不需要额外查询。

  if (cell.tri === 'known') {
    const lb = fixed2(toNumber(cell.lb5));
    return `${head}${lb === null ? '已达判据' : `置信下界 ${lb}`}`;
  }
  if (cell.tri === 'not-learned') {
    const ub = fixed2(toNumber(cell.ub95));
    return `${head}${ub === null ? '未达判据' : `置信上界 ${ub}`}`;
  }

  // tri === 'unknown'：多给一句「还差什么」，模型才知道下一步做什么（约束 4）。
  if (cell.reason === 'too-few-items') {
    const n = toNumber(cell.n);
    const k = toNumber(cell.k);
    if (n !== null && k !== null && n >= 0 && k >= 0) {
      const needed = itemsNeededForKnown({ n, k });
      // needed <= 0 说明现有证据按同一套判据已经够了，和数据自相矛盾 —— 不写数，
      // 免得写出「再做对 0 题可判」这种让人怀疑整块可信度的话。
      if (needed !== null && needed > 0) return `${head}再做对 ${needed} 题可判`;
    }
    return `${head}证据还不够判`;
  }
  if (cell.reason === 'no-quiz') return `${head}这页还没有答题证据`;
  if (cell.reason === 'not-selected') return `${head}这页还没被抽到`;
  if (cell.reason === 'mixed') {
    return `${head}证据不一致（同一页既有答对也有答错）`;
  }
  return `${head}暂未定`;
}

/**
 * `n=8 k=7` 这一段。两个数缺一个就整段不写 —— 只有 `n` 没有 `k` 是读不出比率的，
 * 写半个数比不写更让人误以为「答对了 n 道」。
 */
function measureOf(cell: LearnerStateCell): string {
  const n = toNumber(cell.n);
  const k = toNumber(cell.k);
  if (n === null || k === null) return '';
  return `n=${trimNumber(n)} k=${trimNumber(k)}`;
}

/** `8.0` → `8`，`7.5` → `7.50`。计数权重可能是半份（同日同题重测），所以不能一律取整。 */
function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * 一行知识点级读数：`- 概念「类与对象」· 2 题 · n=2 k=2 · 置信下界 0.60`。
 *
 * ★ 为什么不写 stage/scene：概念是**跨页**的，写一个页 id 就等于把它钉回某一页，
 *   而它恰恰是「两页合起来才够判」的产物。要定位它出现在哪几页，那是
 *   `GET /api/persistence/xq/concepts?id=` 的活，不是状态块的一行能干的事。
 *
 * ★ 为什么不写 `questions`：`n` 是加权后的证据条数（同日同题重测算半份），
 *   `questions` 是去重后的题目个数。两个数都给、都叫「题数」，读的人一定会混。
 *   这里只写 `n`（判据实际用的那个），题目个数留在接口里给界面用。
 */
function conceptLine(concept: LearnerStateConcept): string {
  const name = singleLine(concept.concept);
  const parts = [`- 概念「${name}」`];
  const n = toNumber(concept.n);
  const k = toNumber(concept.k);
  const measure = n !== null && k !== null ? `n=${trimNumber(n)} k=${trimNumber(k)}` : '';
  if (measure) parts.push(measure);
  if (concept.tri === 'known') {
    const lb = fixed2(toNumber(concept.lb5));
    parts.push(lb === null ? '已达判据' : `置信下界 ${lb}`);
  } else {
    const ub = fixed2(toNumber(concept.ub95));
    parts.push(ub === null ? '未达判据' : `置信上界 ${ub}`);
  }
  return parts.join(' · ');
}

/**
 * 一行矛盾：`- 画像「Dart / Flutter」标着 UNKNOWN，但「自检：Dart 进阶八道题」已达判据`。
 *
 * ★ 措辞是「画像说 X，状态说 Y」，**不是**「X 是错的」：规格给了优先级
 *   （矛盾时以人写为准），但裁决这件事不该由状态块替模型做完 —— 它只该让
 *   矛盾不可忽略。写成判决书，模型就会把画像里那句人写的判断当作过期数据覆盖掉，
 *   而那正是「人写为准」要防的。
 *
 * ★ 为什么带页标题也带 stage/scene：标题让人认得出是哪一页；id 让人查得到。
 *   只有标题时两门课可能都有「自检：Dart 八道题」，只有 id 时人读不懂。
 */
function contradictionLine(item: LearnerStateContradiction): string {
  const domain = singleLine(item.domain);
  const title = singleLine(item.title);
  const verdict = item.tri === 'known' ? '已达判据' : '未达判据';
  return `- 画像「${domain}」标着 UNKNOWN，但「${title}」（${item.stageId}/${item.sceneId}）${verdict}`;
}

/** 一行到期复习：`- 页 <sceneId>（<stageId>）· 概念「…」· 第 N 关 · 到期 <日期>`。 */
function reviewLine(review: LearnerStateReview): string {
  const concept = (review.concept ?? '').trim();
  const due = dueDate(review.dueAt);
  const parts = [`- 页 ${review.sceneId}（${review.stageId}）`];
  if (concept) parts.push(`概念「${singleLine(concept)}」`);
  const round = toNumber(review.round);
  if (round !== null) parts.push(`第 ${round} 关`);
  if (due) parts.push(`到期 ${due}`);
  return parts.join('· ');
}

/** 到期日只取 `YYYY-MM-DD`：时分秒每天都会变，写进去等于让缓存每天失效一次。 */
function dueDate(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  return date.toISOString().slice(0, 10);
}

/** 把换行压成空格：一行一条，块里不能出现被折断的条目（表格与折行都难解析）。 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 切掉 `formatPracticeResultsForState()` 末尾那条**行动指令**。
 *
 * 那一份有失败时会追加一段：
 *
 *   **没过的那几条就是该回去讲的东西** —— 回到对应的讲解页补讲或拆页，…
 *
 * 它是**写给模型的命令**。放在人看的那份 `学习状态.md` 里没问题，可一旦进提示词块
 * 就违反本模块的约束 2（块里只许有事实）—— 而这里正是它进块的唯一入口。
 *
 * 为什么在这儿切、而不去改 `lib/practice/results.ts`：那个文件不在这轮的改动范围里，
 * 且它的输出**同时**被人看的那份文件复用 —— 在那一层删掉，人看的那份也就没有这句了
 * （人看的那份留着它是合适的：它是对人的建议，不是对模型的命令）。
 *
 * 判据刻意写得**窄**：只删「整段以 `**没过的那几条就是该回去讲的东西**` 开头」的尾段。
 * 换成「删最后一段」更省事，但那份格式一改（比如以后在末尾加一句图例）就会误删事实。
 */
function stripTrailingInstruction(practiceText: string): string {
  const paragraphs = practiceText.split('\n\n');
  while (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1]!.trim();
    if (!last.startsWith('**没过的那几条就是该回去讲的东西**')) break;
    paragraphs.pop();
  }
  return paragraphs.join('\n\n').trim();
}

/**
 * 渲染成给模型读的一段。**三样全空时返回 `''`**（见硬约束 1）。
 */
export function renderLearnerStateBlock(input: RenderLearnerStateBlockInput = {}): string {
  const cells = input.cells ?? [];
  const reviews = input.reviews ?? [];
  // 先切掉那句行动指令再判空：只剩指令的话（理论上不会）就不该算「有内容」。
  const practiceText = stripTrailingInstruction((input.practiceText ?? '').trim());

  // ★ 零冷启动：先判空再拼任何字。空块占 token 且破坏前缀缓存，而「没数据」从
  //   「没有这一段」就能推出来 —— 所以这里连一行占位都不留。
  // 知识点级只收已经判得出来的两条（见输入注释）；判不出来的在这里就丢掉，
  // 免得下游还要各自记得「unknown 不列」。
  const concepts = (input.concepts ?? []).filter(
    (concept) => concept.tri === 'known' || concept.tri === 'not-learned',
  );
  const contradictions = input.contradictions ?? [];

  if (
    cells.length === 0 &&
    concepts.length === 0 &&
    contradictions.length === 0 &&
    reviews.length === 0 &&
    practiceText.length === 0
  ) {
    return '';
  }

  const nowMs =
    input.now === undefined
      ? Date.now()
      : input.now instanceof Date
        ? input.now.getTime()
        : typeof input.now === 'number'
          ? input.now
          : new Date(input.now).getTime();
  const maxReviews = Math.max(1, Math.trunc(input.maxReviews ?? DEFAULT_MAX_REVIEWS));

  // ── 稳定排序（约束 5）：先按 (stageId, sceneId)，同格再按结论 → 保证逐字节相同。
  const sortedCells = [...cells].sort(
    (a, b) =>
      byCodePoint(a.stageId, b.stageId) ||
      byCodePoint(a.sceneId, b.sceneId) ||
      byCodePoint(String(a.concept ?? ''), String(b.concept ?? '')),
  );

  // 知识点级同样按概念名码点序 —— 前缀缓存要求两次渲染逐字节相同（约束 5）。
  const sortedConcepts = [...concepts].sort((a, b) => byCodePoint(a.concept, b.concept));
  const knownConcepts: string[] = [];
  const notLearnedConcepts: string[] = [];
  for (const concept of sortedConcepts) {
    if (concept.tri === 'known') knownConcepts.push(conceptLine(concept));
    else notLearnedConcepts.push(conceptLine(concept));
  }

  const known: string[] = [];
  const notLearned: string[] = [];
  const unknown: string[] = [];
  for (const cell of sortedCells) {
    if (cell.tri === 'known') known.push(cellLine(cell));
    else if (cell.tri === 'not-learned') notLearned.push(cellLine(cell));
    else unknown.push(cellLine(cell));
  }

  // 到期的复习：先按时间，再按 (stage, scene, 题, 关) —— 只看时间的话同一批
  // 到期的顺序取决于 PG 的返回顺序，两次渲染可能不同。
  const dueReviews = [...reviews]
    .filter((review) => {
      const time =
        review.dueAt instanceof Date ? review.dueAt.getTime() : new Date(review.dueAt).getTime();
      return Number.isFinite(time) && time <= nowMs;
    })
    .sort(
      (a, b) =>
        new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime() ||
        byCodePoint(a.stageId, b.stageId) ||
        byCodePoint(a.sceneId, b.sceneId) ||
        byCodePoint(a.questionId ?? '', b.questionId ?? '') ||
        (toNumber(a.round) ?? 0) - (toNumber(b.round) ?? 0),
    );

  // 同一页同一题同一关重复入库时只留一条（唯一约束本该挡住，但读的一侧不该假设它一定挡住）。
  const seen = new Set<string>();
  const uniqueReviews: LearnerStateReview[] = [];
  for (const review of dueReviews) {
    const key = reviewKey(review);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueReviews.push(review);
  }
  const shownReviews = uniqueReviews.slice(0, maxReviews);

  const lines: string[] = [HEADER, PROVENANCE, ''];

  // ★ 矛盾排在**所有节之前**，包括知识点与页级。
  //
  //   理由不是「重要」这种含糊话：别的节都是「关于这个学习者的陈述」，只有这一节是
  //   「这次运行拿到的两份输入互相打架」。模型读到一节关于页的陈述，与读到一句
  //   「你的两份输入不一致」，该触发的是两种不同的反应；排在后面它就只是又一条数据。
  //
  //   ★ 也不写成「以人写为准，请忽略状态」：那句判断在规格里，这里只把两份并列
  //     摆出来。让状态块替模型裁决，等于把「人写的可以被机器悄悄推翻」制度化。
  if (contradictions.length > 0) {
    const sorted = [...contradictions].sort(
      (a, b) =>
        byCodePoint(a.domain, b.domain) ||
        byCodePoint(a.stageId, b.stageId) ||
        byCodePoint(a.sceneId, b.sceneId),
    );
    lines.push(
      '## 画像与状态不一致（两份输入打架 —— 以画像为准，但这几处要问）',
      ...sorted.map(contradictionLine),
      '',
    );
  }

  // ★ 三个节名都是**对页的陈述**，不是对人的判断，而且括号里带着判据。
  //
  // N6 §9.2 的机制：读者放弃查看进度信息，不是因为「坏消息」，是因为它像一张对错榜
  // ——「已会 12 条 / 说不准 5 条」是同一把尺子量出来的两个读数，但并列摆出来就成了
  // 排名。三个改名的共同点是**把判据写进标题**：读者看到的是一个门槛，不是一句评价。
  //
  // 判据串必须与算法一致：`0.55` 是 `KNOWN_MIN`、`0.30` 是 `NOT_LEARNED_MAX`、
  // 「3 天后复测仍答对」是延迟桶（`DELAYED_BUCKET_DAYS`）。改算法就得改这几行，
  // 它们是 `tests/quiz/learner-state-render.test.ts` 里钉住的同一件事。
  // ★ 知识点级排在页级**前面**：它跨页跨课合并过证据，是比任何单页都强的陈述。
  //
  //   节名沿用「判据写进标题」那条（N6 §9.2），但主语换了：页级那三节的主语是
  //   **页**，这两节的主语是**知识点**。同一个阈值在两处都写一遍是刻意的 ——
  //   读者不该为了核对一个数字去翻另一节。
  if (knownConcepts.length > 0) {
    lines.push(
      '## 知识点：已达判据（跨页合并，置信下界 ≥ 0.55，且 3 天后复测仍答对）',
      ...knownConcepts,
      '',
    );
  }
  if (notLearnedConcepts.length > 0) {
    lines.push('## 知识点：未达判据（跨页合并，置信上界 ≤ 0.30）', ...notLearnedConcepts, '');
  }

  if (known.length > 0) {
    lines.push('## 已达判据（置信下界 ≥ 0.55，且 3 天后复测仍答对）', ...known, '');
  }
  if (notLearned.length > 0) {
    lines.push('## 未达判据（置信上界 ≤ 0.30）', ...notLearned, '');
  }
  if (unknown.length > 0) {
    lines.push('## 暂未定（证据不足，不作判断）', ...unknown, '');
  }

  if (shownReviews.length > 0) {
    lines.push('## 今天到期的复习', ...shownReviews.map(reviewLine));
    const hidden = uniqueReviews.length - shownReviews.length;
    if (hidden > 0) lines.push(`- 另外还有 ${hidden} 条到期复习没列出来。`);
    lines.push('');
  }

  // 练习结果原样嵌入（它自带 `## 练习（真的跑过代码的那些）` 标题与来源说明）。
  if (practiceText.length > 0) {
    lines.push(practiceText, '');
  }

  return lines.join('\n').trimEnd();
}
