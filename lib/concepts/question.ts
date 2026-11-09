/**
 * 题级挂载：从「一道题的题干」推出「这道题在考哪些概念」。
 *
 * ── 为什么页级挂载不够 ──────────────────────────────────────────
 *
 * `deriveOccurrencesFromOutlines()` 算的是「这一页提到了哪些概念」，落
 * `xq_concept_occurrence`。一页八道题共用一份页级概念集，等于把每道题
 * 都算成「考了那八个概念」—— 实测 `stage--ShZtYAYOj/scene-p35` 挂了 10 个
 * 概念（9 条 `0.40 body`，含「远程仓库与 PR」「集合框架」这种正文顺带提的），
 * 拿它当题级概念，每道题的证据都会被放大 8 倍。
 *
 * 所以题级挂载必须**按题面收窄**，落 `xq_question_concept`，一行是
 * 「这一道题 × 这一个概念」。
 *
 * ── 只取题干，不取选项，不取解析 ────────────────────────────────
 *
 * 实测（真库 17 个 quiz 页 / 98 道题，同一把别名表）：
 *
 * | 口径 | 行数 | 覆盖页 |
 * |---|---|---|
 * | 只题干 `question` | 71 | 13 |
 * | 题干 + 选项 + 解析 | 124 | 15 |
 *
 * 多出来的 53 行（+75%）里大量是**反向噪声**：选项常常复述这一页涉及的
 * 其它概念名。`stage--ShZtYAYOj/scene-p35/q8` 题干问的是 routes / pushNamed，
 * 选项里出现 `prog.collection`（集合框架）与 `git.remote`（远程仓库与 PR）；
 * `scene-p24/q1` 题干问 Dart 空安全，选项里出现 `var` 与 `String`。
 * 选项是**干扰项**，它提到一个概念恰恰说明不该把它算成这题在考的东西。
 *
 * 解析（`analysis`）同理，只是方向不同：它是**答案讲解**，如果讲解里提到
 * 某个概念，那是「答完之后顺便说的」，不是这道题测的。
 *
 * ── 成员访问只取链头 ────────────────────────────────────────────
 *
 * `SEGMENT_SEPARATOR`（`occurrence.ts`）会把 `.` 当分隔符，于是
 * `Navigator.push` 被切成 `Navigator` 与 `push` 两段：前者是合法概念名，
 * 后者在别名表里对应「远程仓库与 PR」（git 的 push）—— 一道问 Flutter
 * 路由的题被挂上了 git 概念。
 *
 * 所以先按「词段 + 分隔符」切开，**丢掉紧跟在 ASCII 标识符后面的 `.` 之后的
 * 那一段**：`Navigator.push` 只留 `Navigator`，`this.name` 只留 `this`。
 * 实测这一步在全库只去掉 1 行（就是那条 `push`），页覆盖 13 页不变。
 *
 * 另一种写法是「把 `a.b` 整段粘住、整体丢掉」，实测会多去掉 4 行，其中
 * `this 关键字` 与 `路由与页面跳转` 是**漏**而不是对 —— 链头本身是有效概念。
 * 所以取前者（71 行，而不是 68 行）。
 *
 * ── 强弱两档：短 ASCII 词是「提到」不是「在考」 ─────────────────
 *
 * 71 行里 **36 行**是「≤5 字符的纯 ASCII 单词」命中：`final` / `var` /
 * `if` / `for` / `List` / `class` / `this` / `super` / `late` / `Type` /
 * `String` / `extends` / `rwx` / `PATH` / `jdk` / `git` / `commit` …
 * 它们是**编程语言的关键字与工具名**，一页讲变量的题里出现 `final` 很正常，
 * 但「这题在考 final 语义」是另一个更强的断言。
 *
 * 分档（`tierOf()`）：
 *
 * - **强**：CJK ≥ 2 字，或 ASCII ≥ 6 字符 ⇒ `confidence 0.80`。
 *   （`String` / `object` / `Widget` / `commit` 落强档 —— 它们是具体的类型名
 *   或命令名，出现在题干里通常就是在问它。）
 * - **弱**：CJK 单字，或 ASCII ≤ 5 字符 ⇒ `confidence 0.50`，与
 *   `chapter-band` 同档。`类` / `基` 这两个单字别名全库只有两条，正是弱档。
 *
 * 实测强弱分档后：强 35 行 / 弱 36 行，强档覆盖 **11 页**，弱档补到 **13 页**；
 * 只靠弱命中的两页是 `stage-BH39OH54cL/scene-p19`（`rwx` / `PATH` / `jdk` 全是短词）
 * 与 `stage-qgvTKiESij/scene-p3`（三道题都只命中 `var` / `final`）。
 *
 * ── 覆盖不到的地方是事实，不是缺陷 ──────────────────────────────
 *
 * 全库 17 个 quiz 页里有 **4 页题干零命中**：
 *
 * - `stage-7tNoR37iqT/scene-p12`（「HTTP/JSON 自检」）—— 题干写 GET / POST /
 *   404 / JSON，种子图里没有这些概念。
 * - `stage-gfGFwuwLJp/{scene-p6, scene-p11, scene-p15}`（数学课）—— 题干写
 *   极限 / ε-δ / 单调有界，而**这门课的 `document_outlines` 是空数组**，
 *   连章节名都没有，`chapter-band` 兜底也不可能生效。
 *
 * 所以上限是 13 页（真跑读数：17 页 / 71 行 / 13 页有挂载 / 强档 11 页）。任何「17 页都得有概念」的判据都是不可能达到的；把
 * 这 4 页写成「没命中」比编一个概念上去诚实。
 */
import { normalizeConceptName } from './ids';
import { buildAliasIndex } from './occurrence';
import type { ConceptAliasIndex } from './occurrence';
import type { SeedGraph } from './seed';

/**
 * 强档的门槛：CJK 至少两个字，ASCII 至少六个字符。
 *
 * 数字的来源见文件头：72 行命中里 36 行是 ≤5 字符的纯 ASCII 单词，它们
 * 是语言关键字与工具名，出现在题干里不等于在考它。六是个保守的界 ——
 * `String` / `object` / `Widget` / `commit` 刚好够，`final` / `this` /
 * `class` / `List` 不够。
 */
export const STRONG_MIN_CJK_CHARS = 2;
export const STRONG_MIN_ASCII_CHARS = 6;

/** 强档的置信度。与页级 keyPoint 的「归一化后相等」同档（0.8）。 */
export const QUESTION_CONCEPT_CONFIDENCE_STRONG = 0.8;

/** 弱档的置信度。与 `chapter-band` 同档（0.5）—— 都只说明「大概沾边」。 */
export const QUESTION_CONCEPT_CONFIDENCE_WEAK = 0.5;

/**
 * 摊平题干用的分隔符。**与 `occurrence.ts` 的 `SEGMENT_SEPARATOR` 同一个字符集**
 * （那边没导出，所以这里重复一次；两处若分叉，题级与页级就会用两把尺子量
 * 同一句中文）。
 */
const SEPARATOR_CHARS =
  /[\s\u3000：:，,。.；;、／/|｜·・\-—―–_()（）[\]【】「」『』“”"'‘’《》〈〉!！?？~～+＋=&＆#＃]/;

/** 一道题的题干命中一个概念的草稿（还没换成数据库 id）。 */
export interface QuestionConceptDraft {
  /** 种子里的概念 key；落库时换成 `xq_concept.id`。 */
  conceptKey: string;
  /** 概念规范名。`xq_question_concept.concept` 存的就是它（不是 id）。 */
  conceptName: string;
  /** 题 id（`data.content.questions[].id`，形如 `q1`）。 */
  questionId: string;
  /** 命中落在哪一档。 */
  tier: 'strong' | 'weak';
  /** 0.80（强）/ 0.50（弱），见文件头。 */
  confidence: number;
  /** `exact` = 原文逐字就是概念名；`normalized` = 只差大小写 / 全角 / 空白。 */
  link: 'exact' | 'normalized';
  /** 命中的是哪一个写法，用于事后核对（落库不用）。 */
  matchedForm: string;
}

/** 推导一页题目所需的最小输入。 */
export interface QuizPageInput {
  stageId: string;
  sceneId: string;
  /** `data.content.questions`；只有 `id` 与 `question` 会被读。 */
  questions: readonly { id?: string; question?: string }[];
}

/**
 * 按分隔符切成「词段」与「分隔符」交替的序列。
 *
 * 与 `String.prototype.split()` 的区别只有一个：**保留分隔符本身**，因为
 * 判断「这一段是不是成员访问的尾巴」要看它前面隔的是不是 `.`。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  for (const ch of text) {
    if (SEPARATOR_CHARS.test(ch)) {
      if (current) tokens.push(current);
      tokens.push(ch);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * 把题干摊平成词段，并丢掉成员访问的尾巴。
 *
 * `Navigator.push` → `Navigator`；`this.name` → `this`；`a.b.c` → `a`。
 * 判据是「前一个词段以 ASCII 标识符字符结尾、分隔符是 `.`、本段以标识符字符
 * 开头」—— 三者同时成立才算成员访问，中文句号（`。`）不会误判。
 */
export function questionStemWords(text: string): string[] {
  const tokens = tokenize(text);
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (SEPARATOR_CHARS.test(token)) continue;
    const separator = index > 0 ? tokens[index - 1] : '';
    const previous = index > 1 ? tokens[index - 2] : '';
    if (separator === '.' && /[A-Za-z0-9_]$/.test(previous) && /^[A-Za-z0-9_]/.test(token)) {
      continue;
    }
    words.push(token);
  }
  return words;
}

/** 一个词段落在强档还是弱档，见文件头。 */
export function questionWordTier(word: string): 'strong' | 'weak' {
  // 只要含一个非 ASCII 字符就按「中文」算：实测别名表里没有中英混写的短词，
  // 而 `JDK` 这种全大写的工具名走 ASCII 那条分支才是对的。
  if (/[^\x00-\x7f]/.test(word)) {
    return [...word].length >= STRONG_MIN_CJK_CHARS ? 'strong' : 'weak';
  }
  return word.length >= STRONG_MIN_ASCII_CHARS ? 'strong' : 'weak';
}

/**
 * 从一页的题目推导题级概念挂载。
 *
 * 同一道题命中同一个概念只保留**最强**的一条（强档优先，同档取码点序更小的
 * 写法，保证两次跑结果一致）。返回顺序按 `questionId` 再按 `conceptKey`
 * 升序，落库脚本据此可以稳定复算。
 *
 * @param input 一页的 stage / scene / 题目。
 * @param graph 种子图（或任意同形状的图），用于取别名表与概念规范名。
 * @param options.index 复用已建好的别名表（批量跑时省一次重建）。
 */
export function deriveQuestionConcepts(
  input: QuizPageInput,
  graph: SeedGraph,
  options: { index?: ConceptAliasIndex } = {},
): QuestionConceptDraft[] {
  const index = options.index ?? buildAliasIndex(graph);
  const names = new Map(graph.concepts.map((concept) => [concept.key, concept.name]));
  const best = new Map<string, QuestionConceptDraft>();

  for (const question of input.questions) {
    const questionId = (question.id ?? '').trim();
    if (!questionId) continue;
    for (const word of questionStemWords(String(question.question ?? ''))) {
      const normalized = normalizeConceptName(word);
      if (!normalized) continue;
      const conceptKey = index.get(normalized);
      if (!conceptKey) continue;
      const conceptName = names.get(conceptKey);
      if (!conceptName) continue;

      const tier = questionWordTier(word);
      const draft: QuestionConceptDraft = {
        conceptKey,
        conceptName,
        questionId,
        tier,
        confidence:
          tier === 'strong' ? QUESTION_CONCEPT_CONFIDENCE_STRONG : QUESTION_CONCEPT_CONFIDENCE_WEAK,
        link: word.trim() === normalized ? 'exact' : 'normalized',
        matchedForm: word,
      };

      const key = `${questionId}\u0000${conceptKey}`;
      const previous = best.get(key);
      if (previous && previous.confidence > draft.confidence) continue;
      if (
        previous &&
        previous.confidence === draft.confidence &&
        previous.matchedForm <= draft.matchedForm
      ) {
        continue;
      }
      best.set(key, draft);
    }
  }

  return [...best.values()].sort(
    (a, b) => a.questionId.localeCompare(b.questionId) || a.conceptKey.localeCompare(b.conceptKey),
  );
}
