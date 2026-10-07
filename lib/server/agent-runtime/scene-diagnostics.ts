/**
 * 一页**写完之后**跑的那几个诊断 —— 抽成一处，好让「生成」和「修改」共用同一条代码。
 *
 * ── 为什么必须共用（这是被一个具体问题逼出来的）────────────────────
 *
 * 用户问：「假如我让 AI 在原来 Day 1 上修复，它能按着已有规则来吗」。
 * 答案是**大部分不能** —— 因为 `coverage-gap` / `plan-check` 当初只挂在
 * `generate_scene` 上，而**修复走的是另一条路**（`patch_stage` 直接改 JSON）。
 * 于是"修一页"这个最常见的动作，所有检查静默通过。
 *
 * 修法不是复制一份检查到 `patch_stage`（那两份判据早晚会漂），而是把这一段抽出来，
 * 两个写入点都调它。**同一把尺子，两条路。**
 *
 * ── 为什么是"写完之后"而不是"写之前" ─────────────────────────────
 *
 * 判据要拿**真的写下去的页面内容**去比（`document_scenes` 的 content 是 HTML，
 * 剥离逻辑在 `coverage-gap` 里），而且要比的是**这一页之前**所有页 —— 这只有
 * 落盘之后重新加载才能拿到一致的视图。
 *
 * ── 诊断，不是门禁 ────────────────────────────────────────────────
 *
 * 两条检查都**不回滚、不删题**，只把结果交给 agent。修法只允许「补」和「挪」
 * （见 `plan-check.ts` 头部）—— 门禁一旦允许删就会变成棘轮。
 */
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { Scene } from '@/lib/types/stage';
import {
  findUncoveredTerms,
  formatCoverageGaps,
  taughtTextBefore,
  type AssessedQuestion,
  type CoverageGap,
} from '@/lib/quiz/coverage-gap';
import {
  checkPlanDependencies,
  formatPlanIssues,
  type PlanIssue,
} from '@/lib/quiz/plan-check';

/**
 * 从一页已落盘的自检里取出待查文本。
 *
 * 只挑有题号的题（生成层偶尔会漏字段，缺了就不查它，而不是整页放弃）。
 */
export function quizQuestionsOf(scene: Scene): AssessedQuestion[] {
  const content = scene.content as { questions?: unknown };
  if (!Array.isArray(content.questions)) return [];
  const questions: AssessedQuestion[] = [];
  for (const entry of content.questions) {
    if (typeof entry !== 'object' || entry === null) continue;
    const question = entry as {
      id?: unknown;
      question?: unknown;
      options?: unknown;
      analysis?: unknown;
    };
    if (typeof question.id !== 'string' || typeof question.question !== 'string') continue;
    const options = Array.isArray(question.options)
      ? question.options
          .map((option) =>
            typeof option === 'string'
              ? option
              : typeof (option as { label?: unknown })?.label === 'string'
                ? (option as { label: string }).label
                : undefined,
          )
          .filter((label): label is string => typeof label === 'string')
      : [];
    questions.push({
      id: question.id,
      question: question.question,
      options,
      ...(typeof question.analysis === 'string' ? { analysis: question.analysis } : {}),
    });
  }
  return questions;
}

export interface SceneWriteDiagnostics {
  coverageGaps: CoverageGap[];
  coverageText: string;
  planIssues: PlanIssue[];
  planText: string;
}

export interface SceneWriteDiagnosticsInput {
  /** 落盘之后**重新加载**的全部页面（这一页也在里面）。 */
  scenes: readonly Scene[];
  /** 刚写下去的那一页。 */
  scene: Scene;
  /** 当前计划信封（可缺 —— 没有就跳过计划检查）。 */
  outline: AppDocumentOutline | undefined;
}

/**
 * 汇总诊断文本与结构化计数。
 *
 * 两个写入点都调它：`generate_scene`（生成）与 `patch_stage`（修改）。
 * 文本拼进工具返回给 agent 看；计数进 `details` 供 §3.3 的 SQL 读。
 */
export function sceneWriteDiagnostics(input: SceneWriteDiagnosticsInput): SceneWriteDiagnostics {
  // 覆盖缺口：只对自检页做（别的页没有"要考什么"）。
  const coverageGaps =
    input.scene.type === 'quiz'
      ? findUncoveredTerms({
          questions: quizQuestionsOf(input.scene),
          taughtText: taughtTextBefore(
            input.scenes.map((item) => ({ order: item.order, content: item.content })),
            input.scene.order,
          ),
        })
      : [];

  // 计划期依赖：计划是空的时候它**一句话都不说**（这是它的固有性质 ——
  // 它审的是"正在排的计划"，不是"已有的课"）。见 plan-check.ts 头部。
  const planIssues = checkPlanDependencies(input.outline?.outlines ?? []);

  return {
    coverageGaps,
    coverageText: coverageGaps.length ? `\n\n${formatCoverageGaps(coverageGaps, { maxTerms: 12 })}` : '',
    planIssues,
    planText: planIssues.length ? `\n\n${formatPlanIssues(planIssues)}` : '',
  };
}
