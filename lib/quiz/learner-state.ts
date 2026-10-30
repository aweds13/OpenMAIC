/**
 * 学习状态渲染器 —— 把折叠出来的答题状态接上**题目原文**，写成一段能注入提示词的文本。
 *
 * ── 为什么不能直接注入 fold 的输出 ────────────────────────────────
 *
 * `foldQuizAttempts` 给的是 `{ sceneId: 'scene-p9', incorrectNow: ['q8'] }`。
 * 对 agent 来说 **`q8` 是没有意义的** —— 它不知道 q8 问的是什么，也就没法
 * "换一个问法重考这道题"。所以这一层做的是唯一必要的连接：
 * 用 `document_scenes` 里那一页的内容，把题号还原成题干。
 *
 * 记录里的题号**可能已经不存在**：页面被 `generate_scene` 重生成过之后，
 * 老记录指的还是老题号。那时照样输出（带 `q8` 和"原题已不存在"），
 * 因为**"这里错过一道题"本身就是状态**，丢掉它才是错的。
 *
 * ── 输出纪律 ──────────────────────────────────────────────────────
 *
 *   · 只输出**能行动的**：要重做哪几道、哪页没交卷、哪页已经不必再考。
 *     「答对了几道」不是行动，所以不列。
 *   · 分档用的是 fold 刻意分开的那两组：`incorrectNow`（现在还错 → 马上重做）
 *     与 `everIncorrect`（历史错过含已改对 → 只报数，不占版面）。
 *     这正是当初把两者分开的理由，这里第一次用上。
 *   · 整块要**短**：它在每次运行的提示词里，而且换了状态就会让提示词末尾
 *     重读一次（见 runner.ts 的 promptBlocks 注释）。所以有 `maxQuestions`。
 *   · 自己带用法说明。像 `learnerProfilePromptBlock` 一样，不指望调用方补。
 *
 * ── 返回空串而不是"空模板" ────────────────────────────────────────
 *
 * 没有记录时返回 `''` —— 调用方据此**不注入**。注入一段"暂无答题记录"是纯噪声，
 * 而且会让提示词因为一句废话而变（前缀缓存白丢）。
 */
import { sceneKey, type QuizFoldSkip, type QuizSceneState } from '@/lib/quiz/attempt-fold';

/** 一页自检里 agent 需要知道的题目信息：够用来指认一道题。 */
export interface LearnerStateQuestionContent {
  id: string;
  question: string;
}

/**
 * 一页自检的呈现信息（来自 `document_scenes`，不是 runtime 记录）。
 *
 * `stageId` 与 `sceneId` 一起才唯一 —— `document_scenes` 的主键是
 * `(stage_id, id)`，同名 sceneId 会出现在多门课里（本部署：`scene-p9` 有 6 个）。
 */
export interface LearnerStateSceneContent {
  stageId: string;
  sceneId: string;
  order: number;
  title: string;
  questions: readonly LearnerStateQuestionContent[];
}

export interface RenderLearnerStateInput {
  /** `foldQuizAttempts` 的输出。 */
  scenes: readonly QuizSceneState[];
  /** 这些页面**当前**的内容 —— 用来把题号还原成题干。 */
  contents: readonly LearnerStateSceneContent[];
  /** 整块最多列几道要重做的题。默认 12。 */
  maxQuestions?: number;
  /** fold 的跳过清单：有记录被丢时要写出来，否则"没答过"和"读不到"会混掉。 */
  skipped?: readonly QuizFoldSkip[];
  /**
   * 状态**截至**哪一刻（ISO）—— 取最新的那条答题记录时间。
   *
   * 刻意不是"生成时刻"：那会让这块文本**每次运行都变**，而这个块挂在提示词
   * 末尾、又是唯一一块会随答题变化的内容。用最新记录时间，内容就成了记录的
   * 纯函数 —— 没答题时字节完全一样，缓存照命中（同 runner.ts 里 §1.2 那条）。
   */
  asOf?: string;
}

const DEFAULT_MAX_QUESTIONS = 12;

/** 一段文本压成一行 —— 题干里有换行会把清单打散。 */
function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function formatAnswers(answer: string | string[] | undefined): string {
  if (answer === undefined) return '';
  const text = Array.isArray(answer) ? answer.join('+') : answer;
  return text ? `（答 ${text}）` : '';
}

/** 题干查不到就说清楚，别让 `q8` 孤零零地出现在提示词里。 */
function describeQuestion(
  scene: QuizSceneState,
  questionId: string,
  content: LearnerStateSceneContent | undefined,
): string {
  const found = content?.questions.find((question) => question.id === questionId);
  const answer = formatAnswers(scene.answers[questionId]);
  const where = content
    ? `第 ${content.order} 页《${oneLine(content.title, 24)}》`
    : `页面 ${scene.sceneId}`;
  if (!found) {
    return `- ${where} 题号 ${questionId}（原题已不在这一页，可能是页面重生成过）${answer}`;
  }
  return `- 「${oneLine(found.question)}」 — ${where}，题号 ${questionId}${answer}`;
}

/**
 * 渲染学习状态；没有可说的就返回 `''`。
 *
 * 分档（按行动优先序）：
 *   1. **现在还错的**（`incorrectNow`）—— 下一份自检优先重考这些；
 *   2. **答过但没交卷的页** —— 提醒"这一页还没做完"，不是"没学过"；
 *   3. **已经全对的页** —— 明确说"不必重复考"，省掉一次无意义的出题。
 */
export function renderLearnerState(input: RenderLearnerStateInput): string {
  const maxQuestions = input.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const contentsById = new Map(
    input.contents.map((content) => [sceneKey(content.stageId, content.sceneId), content]),
  );

  const withVerdict = input.scenes.filter((scene) => scene.questions.length > 0);
  const drafts = input.scenes.filter(
    (scene) => scene.questions.length === 0 && Object.keys(scene.answers).length > 0,
  );
  const clean = withVerdict.filter((scene) => scene.incorrectCount === 0);
  const toRetry = withVerdict.filter((scene) => scene.incorrectNow.length > 0);
  const corrected = withVerdict.filter(
    (scene) => scene.incorrectNow.length === 0 && scene.everIncorrect.length > 0,
  );

  const skipped = input.skipped ?? [];
  if (withVerdict.length === 0 && drafts.length === 0 && skipped.length === 0) return '';

  const lines: string[] = [];
  lines.push('### 答题状态（机器写入 —— 不要念给学习者听，也不要提"我看了你的记录"）');
  lines.push('');
  if (input.asOf) {
    lines.push(`折叠自本机答题记录，状态截至 ${input.asOf}。`);
    lines.push('');
  }

  if (skipped.length) {
    lines.push(
      `⚠️ 有 ${skipped.length} 条记录读不出来（原因：${[...new Set(skipped.map((s) => s.reason))].join('、')}）。` +
        '下面这份状态**可能不完整** —— 不要把"这里没提到"当成"他没做过"。',
      '',
    );
  }

  const retryItems: string[] = [];
  for (const scene of toRetry) {
    const content = contentsById.get(sceneKey(scene.stageId, scene.sceneId));
    for (const questionId of scene.incorrectNow) {
      retryItems.push(describeQuestion(scene, questionId, content));
    }
  }

  if (retryItems.length) {
    lines.push('**现在还做错的（下一份自检优先重考这些，换一个问法，不要原题照搬）**');
    lines.push(...retryItems.slice(0, maxQuestions));
    if (retryItems.length > maxQuestions) {
      lines.push(`- …还有 ${retryItems.length - maxQuestions} 道`);
    }
    lines.push('');
  }

  if (drafts.length) {
    lines.push('**答过但没交卷（这一页还没做完，别当成没学过）**');
    for (const scene of drafts) {
      const content = contentsById.get(sceneKey(scene.stageId, scene.sceneId));
      const where = content
        ? `第 ${content.order} 页《${oneLine(content.title, 24)}》`
        : scene.sceneId;
      lines.push(`- ${where}：已作答 ${Object.keys(scene.answers).length} 题，未交卷`);
    }
    lines.push('');
  }

  if (clean.length) {
    lines.push('**已经全对（不必重复考，把额度留给上面那些）**');
    for (const scene of clean) {
      const content = contentsById.get(sceneKey(scene.stageId, scene.sceneId));
      const where = content
        ? `第 ${content.order} 页《${oneLine(content.title, 24)}》`
        : scene.sceneId;
      lines.push(`- ${where}：${scene.correctCount}/${scene.questions.length}`);
    }
    lines.push('');
  }

  if (corrected.length) {
    const count = corrected.reduce((total, scene) => total + scene.everIncorrect.length, 0);
    lines.push(
      `曾经做错、后来改对的共 ${count} 道 —— 这些可以在间隔复习时再抽查，但不是当下的重点。`,
      '',
    );
  }

  lines.push('**读到这一块之后怎么做**');
  lines.push(
    '- 有「现在还做错的」时：下一次自检必须覆盖这些**考点**，可以换场景、换问法，' +
      '但不许出新题把它们绕过去。',
  );
  lines.push('- 有「答过但没交卷」时：先问学习者要不要接着做完，再决定要不要讲。');
  lines.push(
    '- 讲解新内容时，这些错过的考点是**已知的薄弱处** —— 讲到相关概念时可以点一句' +
      '「上次这里你选了另一个」，但不要展开成复述记录。',
  );

  return lines.join('\n').trim();
}
