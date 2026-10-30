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
import { staticPageText } from '@/lib/quiz/page-text';
import {
  checkLayout,
  formatLayoutDelta,
  formatLayoutFindings,
  layoutDelta,
  type LayoutDelta,
  type LayoutElement,
  type LayoutFinding,
} from '@/lib/quiz/layout-check';
import { checkPlanDependencies, formatPlanIssues, type PlanIssue } from '@/lib/quiz/plan-check';

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
  /** 机械可判的**字数带**（见下）；文本拼进工具回话。 */
  densityText: string;
  /**
   * ★★ **版面**（2026-10-10）：溢出 / 重叠 / 文字装不下 / 字号过小。
   *
   * agent **没有渲染预览**（`render_scene_preview` 要 `RENDER_SERVICE_URL`，本部署没配
   * ⇒ 工具不注册）。所以它看不到画面 —— 而这几件事**不需要画面也能算**：元素带坐标。
   * 见 `lib/quiz/layout-check.ts` 头部。
   */
  layoutFindings: LayoutFinding[];
  layoutText: string;
  /**
   * ★★ **改前/改后差集**（2026-10-10）：这一轮**引入**了什么、修掉了什么、
   * 哪些是**改前就有**的。只有 `patch_stage`（带 `previousScene`）才有内容。
   *
   * 为什么需要它：学习者原话「**新增两处盒子高度不足……都是既有问题，我的改动是等长的**」——
   * 写入后诊断只在**写完**之后算一遍，所以它说得出"这页有 2 处装不下"，
   * 说不出"**改前就有这 2 处**"。而这件事纯算术、不需要渲染、不需要人眼。
   */
  layoutDelta: LayoutDelta;
  layoutDeltaText: string;
  /** 这一页的可见正文字数（只看 slide）。 */
  bodyChars: number;
}

/** 太薄：实测默认产出平均 61 汉字/页，真实课件 352–390。 */
export const THIN_PAGE_CHARS = 120;
/** 过大：1000×562.5 画布在可读字号下约 350–400 字 ⇒ 超过 800 是**布局风险**。 */
export const OVERFLOW_RISK_CHARS = 800;

export interface SceneWriteDiagnosticsInput {
  /** 落盘之后**重新加载**的全部页面（这一页也在里面）。 */
  scenes: readonly Scene[];
  /** 刚写下去的那一页。 */
  scene: Scene;
  /**
   * ★★ **改动之前**那一页（同一个 id 的旧版本）。只有 `patch_stage` 拿得到。
   *
   * 给了它才算得出「这次改动引入了什么 / 既有的是什么」；不给就只有"改后"的快照。
   * `generate_scene` 写的是新页，天然没有前身。
   */
  previousScene?: Scene;
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
  //
  // ★ **这里刻意不传 `conceptsPerPage`**（那条"一页塞太多"的判据因此默认关着），
  //   因为**它和 course-audit 的 `NOVEL_P90` 不是同一个测量**：
  //     · plan-check 量的是**计划 brief** 里的新块（输入是 agent 写的计划文本）
  //     · course-audit 量的是**已落盘页面**里的新块（输入是真实页面内容）
  //   `NOVEL_P90 = 49` 是在 146 个真实**页面**上标定出来的，直接搬给"计划 brief"
  //   就是错的。要开它，得先拿真实**计划**数据各自标定一次。
  //   **别把这两个阈值合并成一个常量。**
  const planIssues = checkPlanDependencies(input.outline?.outlines ?? []);

  // 字数带：**只在 slide 上**算（别的类型的正文不在 canvas 里，见 page-text.ts 的比较表）。
  const bodyChars =
    input.scene.type === 'slide'
      ? staticPageText({
          order: input.scene.order,
          type: input.scene.type,
          title: input.scene.title,
          content: input.scene.content,
        }).length
      : 0;
  // ★ 不做「超了就是错」：350–400 是**容量**，字数在六条优先级里排最后（study-mode.ts）。
  //   太薄 ⇒ 知识没落到屏幕上；过大 ⇒ 布局风险（溢出/缩成灰块）。中间那段机械层不插嘴。
  const densityNotes: string[] = [];
  if (input.scene.type === 'slide' && bodyChars > 0 && bodyChars < THIN_PAGE_CHARS) {
    densityNotes.push(
      `这一页只有 ${bodyChars} 字 —— 实测默认产出平均 61 汉字/页、真实课件 352–390。` +
        '知识要**落在屏幕上**：把该讲的补上（讲不透就**加页**，不要塞长句）。',
    );
  }
  if (bodyChars > OVERFLOW_RISK_CHARS) {
    densityNotes.push(
      `这一页 ${bodyChars} 字，超过画布容量（1000×562.5 可读字号下约 350–400 字）的 ` +
        `${Math.round(bodyChars / 400)} 倍 —— 这是**布局风险**（溢出或缩成灰块），` +
        '不是「你写多了」。处理办法是**拆成 2–3 页**，不是删内容。',
    );
  }

  // ★ 版面：**只有 slide 有 canvas**（别的类型的正文不在 canvas 里，同字数带那一条）。
  const elementsOf = (scene: Scene | undefined): LayoutElement[] =>
    scene?.type === 'slide'
      ? (((scene.content as { canvas?: { elements?: LayoutElement[] } } | undefined)?.canvas
          ?.elements ?? []) as LayoutElement[])
      : [];
  const layoutFindings = checkLayout(elementsOf(input.scene));

  /**
   * ★★ 差集：**"是不是我改坏的"**。
   *
   * 只在两侧都是 slide 且给了 `previousScene` 时算。页面类型变了（slide → quiz 等）
   * 时不算 —— 那不是"同一页的两版"，比差集没有意义。
   */
  const delta =
    input.previousScene && input.previousScene.type === 'slide' && input.scene.type === 'slide'
      ? layoutDelta(checkLayout(elementsOf(input.previousScene)), layoutFindings)
      : undefined;

  return {
    coverageGaps,
    coverageText: coverageGaps.length
      ? `\n\n${formatCoverageGaps(coverageGaps, { maxTerms: 12 })}`
      : '',
    planIssues,
    planText: planIssues.length ? `\n\n${formatPlanIssues(planIssues)}` : '',
    densityText: densityNotes.length
      ? String.fromCharCode(10, 10) +
        densityNotes.map((note) => `· ${note}`).join(String.fromCharCode(10))
      : '',
    bodyChars,
    layoutFindings,
    layoutText: layoutFindings.length
      ? String.fromCharCode(10, 10) + formatLayoutFindings(layoutFindings)
      : '',
    layoutDelta: delta ?? { added: [], removed: [], kept: [] },
    layoutDeltaText: delta ? formatLayoutDelta(delta) : '',
  };
}

/**
 * ★ 带**读者视角再读一遍**的诊断（2026-10-09）。
 *
 * 机械诊断（覆盖缺口 / 计划依赖 / 字数带）是**可算的**；"这一页读得通吗"**不可算**，
 * 只能让一次带上下文的模型调用去读（`page-review.ts`）。
 *
 * 三条纪律（和写入后诊断同源）：
 * 1. **绝不让写入失败** —— 审查抛错/超时/返回空，都只是"这次没验成"，页面照样是写好的；
 * 2. **没传 `reviewPage` 就是没这一步**（部署没配模型时行为与以前完全一致）；
 * 3. 文本**拼在同一处**（两个写入点都调这个函数），免得只有一条路径挂上了。
 */
export interface SceneWriteReviewDeps {
  reviewPage?: (input: {
    scenes: readonly Scene[];
    order: number;
  }) => Promise<{ findings: string } | null>;
}

export async function sceneWriteDiagnosticsWithReview(
  input: SceneWriteDiagnosticsInput,
  deps: SceneWriteReviewDeps = {},
): Promise<SceneWriteDiagnostics & { pageReviewText: string }> {
  const base = sceneWriteDiagnostics(input);
  if (!deps.reviewPage) return { ...base, pageReviewText: '' };
  try {
    const review = await deps.reviewPage({ scenes: input.scenes, order: input.scene.order });
    if (!review || review.findings.trim().length === 0) return { ...base, pageReviewText: '' };
    return {
      ...base,
      pageReviewText: `

这一页写完后再读一遍（带它前面已经讲过的页）——
${review.findings}`,
    };
  } catch {
    return { ...base, pageReviewText: '' };
  }
}
