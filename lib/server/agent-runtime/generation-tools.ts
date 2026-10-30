import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { isActionType } from '@openmaic/dsl';
import {
  buildCompleteScene,
  generateSceneActions,
  generateSceneContent,
  PBLGenerationError,
  type AICallFn,
  type ImageMapping,
  type PdfImage,
  type SceneContentFailureCode,
  type SceneGenerationContext,
} from '@openmaic/generation';

import { putSceneBringingCurrent } from './document-writes';

import type { SceneOutline } from '@/lib/types/generation';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import { agentRuntimeConfig } from './config';
import type { CourseToolDeps } from './course-tools';
import { runStageMutation } from './mutation-fence';
import { shiftCourseOrders } from './course-edit/tools';
import { createGenerationAiCallFactory, sceneContentStage } from './generation-ai-call';
import {
  describeNarrationVoice,
  formatTtsFailureTally,
  synthesizeSceneNarration,
} from './scene-tts';
import { toGenerationContent } from './generation-content';
import { checkScenesAgainstSkill } from './skills';
import { sceneWriteDiagnosticsWithReview } from './scene-diagnostics';
import { splitCoverageGaps } from '@/lib/quiz/coverage-gap';
import { appendToSystemPrompt, buildQuizGrounding } from '@/lib/quiz/quiz-grounding';
import { upsertOutlineEntry } from './course-outline-write';
import { planGate, planGateEnabled } from './plan-freeze';
import { readPlanFreeze } from './plan-freeze-store';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import { createLogger } from '@/lib/logger';

const MAX_GENERATE_SCENE_MEDIA = 8;
const SUPPORTED_SCENE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);
const log = createLogger('AgentGenerationTools');

const SceneParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  order: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal('slide'),
    Type.Literal('quiz'),
    Type.Literal('interactive'),
    Type.Literal('pbl'),
  ]),
  widgetType: Type.Optional(
    Type.Union(
      [
        Type.Literal('simulation'),
        Type.Literal('diagram'),
        Type.Literal('code'),
        Type.Literal('game'),
        Type.Literal('visualization3d'),
      ],
      {
        description:
          'Interactive pages only: which widget to build. simulation = parameter explorer, diagram = flowchart/mindmap/hierarchy/system graph, code = programming challenge, game = quiz/puzzle/strategy/card/action, visualization3d = 3D scene. Defaults to simulation when omitted. procedural-skill stays gated behind task-engine mode and is not accepted here.',
      },
    ),
  ),
  widgetOutline: Type.Optional(
    Type.Unknown({
      description:
        'Interactive pages only: widget configuration object matching widgetType (e.g. { concept, keyVariables } for simulation, { diagramType, nodes } for diagram, { language } for code, { gameType, challenge } for game, { visualizationType, objects } for visualization3d). Must be a plain object. Defaults to { concept: title } when widgetType is set; when only widgetOutline is set, widgetType defaults to simulation.',
    }),
  ),
  /**
   * ★ 这是**技能进入内容层的唯一通道**。
   *
   * agent 读过教学法 skill，但那次读取**只留在 agent 自己的上下文里** ——
   * generate_scene 内部的 LLM 调用是另一次独立请求，看不到 agent 读过什么
   * （见下方 generateSceneContent 的 options：只有 agents / languageDirective，
   * 没有任何技能信息）。
   *
   * 而 brief 正是那个调用的 `description`。所以教学法的**写作要求**必须由
   * agent 写进 brief，否则就断在这一层 —— 结构按技能排了，每页还是老样子。
   *
   * 描述写这么长是刻意的：模型对"brief 该写什么"没有先验，不点明它就只会
   * 写一句主题概括。
   */
  brief: Type.String({
    minLength: 1,
    description:
      "What this page must actually contain — this text is the page generator's ONLY instruction " +
      'beyond the title and type, so it carries the teaching method with it.\n' +
      'Include: (a) the concrete content to cover — definitions, mechanisms, worked examples, ' +
      'comparisons, the reasoning that links them; (b) the WRITING REQUIREMENTS of the active ' +
      'teaching method — target text density, tone, structure, what must appear on the page itself. ' +
      'A brief that only names the topic ("讲一下变量") produces a thin page.\n' +
      'Do not put tool instructions here — the page generator has no tools.',
  }),
  /**
   * ★ 自检页的题量/难度/题型。
   *
   * 在加这个之前，工作台的 `generate_scene` **根本没有表达题量的参数**，
   * 于是 `generateQuizContent` 每次都落到 SDK 那个写死的兜底：
   *
   *   const quizConfig = outline.quizConfig || {
   *     questionCount: 3, difficulty: 'medium', questionTypes: ['single'],
   *   };
   *
   * 结果就是：agent 在对话里说「给你出 5 道自检题」，落盘的页面**永远是 3 道**。
   * 实测同一批课程里，工作台生成的自检页全是 3 题，而更早手工补过的页面是
   * 6/8/10 题 —— 差的那些全是 agent 事后用 `patch_stage` 一题一题补进去的
   * （160 次 patch_stage 里有 16 次明写「自检扩到 N 题」）。
   */
  quizConfig: Type.Optional(
    Type.Object(
      {
        questionCount: Type.Integer({
          minimum: 1,
          maximum: 30,
          description: 'How many questions this self-check page must contain.',
        }),
        difficulty: Type.Optional(
          Type.Union([Type.Literal('easy'), Type.Literal('medium'), Type.Literal('hard')]),
        ),
        questionTypes: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Literal('single'),
              Type.Literal('multiple'),
              Type.Literal('short_answer'),
            ]),
          ),
        ),
      },
      {
        additionalProperties: false,
        description:
          'Quiz pages only. Required in practice: without it the page generator falls back to a ' +
          'hardcoded 3 questions, whatever you told the learner. Ask for the number the learner ' +
          'actually needs — a self-check page is usually 5-8.',
      },
    ),
  ),
  /**
   * 覆盖本页的「自学 / 听课」。省略 = 用服务端默认（OPENMAIC_SELF_STUDY）。
   *
   * 自学时**不生成讲稿**：既不产出 speech 动作，也不多花一次 LLM 调用，页面
   * 播放时整页静态显示。听课（false）才生成讲稿。
   *
   * 学习者当次说了想听/想自己看，就按他说的传；没说、画像里也记着默认自学，
   * 那就省略不传。
   */
  selfStudy: Type.Optional(
    Type.Boolean({
      description:
        'true = this page is read, not listened to: no narration is generated and no speech ' +
        'actions are written. false = generate narration. Omit to use the deployment default.',
    }),
  ),
  instruction: Type.Optional(Type.String()),
  materialFacts: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'The content points the page must present; the generator writes each of them onto the page. Only content meant for learners belongs here; style, layout and narration constraints do not. For pbl, the target skills.',
    }),
  ),
  media: Type.Optional(
    Type.Array(
      Type.Object({
        src: Type.String({ minLength: 1 }),
        description: Type.String({ minLength: 1 }),
        width: Type.Optional(Type.Number({ minimum: 1 })),
        height: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      { maxItems: 8 },
    ),
  ),
});
const ListParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
});
const ActionsParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  sceneId: Type.Optional(Type.String()),
  order: Type.Optional(Type.Integer({ minimum: 1 })),
  styleDirective: Type.Optional(Type.String()),
  synthesizeAudio: Type.Optional(Type.Boolean()),
});
const DuplicateParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  templateSceneId: Type.Optional(Type.String()),
  templateOrder: Type.Optional(Type.Integer({ minimum: 1 })),
  targetOrder: Type.Integer({ minimum: 1 }),
  title: Type.Optional(Type.String()),
});

type ActionGenerator = typeof generateSceneActions;

export interface GenerationToolDeps extends CourseToolDeps {
  aiCall?: AICallFn;
  generateActions?: ActionGenerator;
}

function sceneIdFor(scenes: readonly Scene[], order: number) {
  const preferred = `scene-p${order}`;
  const taken = new Set(scenes.map((scene) => scene.id));
  if (!taken.has(preferred)) return preferred;
  let suffix = 2;
  while (taken.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

function duplicateId(sessionId: string | undefined, callId: string) {
  const hash = createHash('sha256')
    .update(`${sessionId ?? ''}\0${callId}`)
    .digest('hex')
    .slice(0, 16);
  return `scene-dup-${hash}`;
}

/**
 * 自检页没有指定题量时用的数字。
 *
 * 刻意**不是** SDK 那个 3。3 是"没想过"的产物：真实的自检页实测最后都被补到
 * 6–10 题。5 是一个不需要返工的起点，而参数在场时它永远会被覆盖。
 */
const DEFAULT_QUIZ_QUESTION_COUNT = 5;

/** 把工具参数变成 outline 认得的 quizConfig（`short_answer` → `text`，见 SceneOutline）。 */
function resolveQuizConfig(input?: {
  questionCount?: number;
  difficulty?: 'easy' | 'medium' | 'hard';
  questionTypes?: ('single' | 'multiple' | 'short_answer')[];
}): NonNullable<SceneOutline['quizConfig']> {
  const types = (input?.questionTypes ?? ['single']).map((type) =>
    type === 'short_answer' ? ('text' as const) : type,
  );
  return {
    questionCount: input?.questionCount ?? DEFAULT_QUIZ_QUESTION_COUNT,
    difficulty: input?.difficulty ?? 'medium',
    questionTypes: types.length ? types : ['single'],
  };
}

function result(text: string, details: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text' as const, text }], details, ...(isError ? { isError } : {}) };
}

function outlineFromScene(scene: Scene, snapshot: unknown): SceneOutline {
  const planned = (snapshot as AppDocumentOutline | undefined)?.outlines?.find(
    (entry) => entry.id === scene.outlineId || entry.order === scene.order,
  );
  return {
    ...planned,
    id: scene.outlineId ?? scene.id,
    order: scene.order,
    title: scene.title,
    type: scene.type as SceneOutline['type'],
    description: planned?.description ?? scene.title,
    keyPoints: planned?.keyPoints ?? [],
  };
}

function concreteMediaSrc(src: string): boolean {
  if (src.startsWith('/') && !src.startsWith('//')) return src.length > 1 && !/\s/.test(src);
  if (!/^https?:\/\//i.test(src)) return false;
  try {
    const url = new URL(src);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * A media src this tool will pass through onto a page element.
 *
 * An allocated asset id counts, alongside an HTTP(S) URL and a same-origin
 * path. `generate_image` returns an id now that it stores its bytes in the
 * asset pool (#1522), and the documented flow hands that src straight to
 * `generate_scene.media`; the generation package writes a mapping value onto
 * the element verbatim (`resolveImageIds`) and the renderer leases the id from
 * the pool, so it needs no other treatment here. `isMediaPlaceholder` still
 * answers true for it — an id does need resolving before it renders — which is
 * why the id is admitted ahead of that question rather than by changing what
 * it means. What stays refused is what was always refused: a generation
 * placeholder, a data URL, and anything naming nothing.
 */
function acceptableMediaSrc(src: string): boolean {
  if (mayNameAPoolAsset(src)) return !/\s/.test(src);
  return !isMediaPlaceholder(src) && concreteMediaSrc(src);
}

export interface UnresolvedMediaPlaceholder {
  elementId: string;
  type: 'image' | 'video';
  placeholder: string;
}

/**
 * Whether a document reference would still render as a skeleton.
 *
 * An allocated asset id would not: its bytes are in the pool and the renderer
 * leases them. Only a reference nothing can resolve — a generation placeholder
 * waiting on a job — is a skeleton.
 */
function unresolvedRef(ref: string): boolean {
  return isMediaPlaceholder(ref) && !mayNameAPoolAsset(ref);
}

/** Find slide media elements that would still render as skeletons. */
export function collectUnresolvedMediaPlaceholders(scene: Scene): UnresolvedMediaPlaceholder[] {
  if (scene.type !== 'slide') return [];
  const placeholders: UnresolvedMediaPlaceholder[] = [];
  for (const element of scene.content.canvas.elements) {
    const candidate = element as unknown as {
      id?: string;
      type?: string;
      src?: string;
      mediaRef?: string;
    };
    if (!candidate.id) continue;
    if (candidate.type === 'image' && candidate.src && unresolvedRef(candidate.src)) {
      placeholders.push({
        elementId: candidate.id,
        type: 'image',
        placeholder: candidate.src,
      });
    }
    if (
      candidate.type === 'video' &&
      (!candidate.src ||
        unresolvedRef(candidate.src) ||
        (candidate.mediaRef ? unresolvedRef(candidate.mediaRef) : false))
    ) {
      placeholders.push({
        elementId: candidate.id,
        type: 'video',
        placeholder:
          (candidate.src && unresolvedRef(candidate.src) ? candidate.src : undefined) ??
          (candidate.mediaRef && unresolvedRef(candidate.mediaRef)
            ? candidate.mediaRef
            : undefined) ??
          candidate.mediaRef ??
          '',
      });
    }
  }
  return placeholders;
}

function actionContext(scenes: readonly Scene[], current: Scene): SceneGenerationContext {
  const ordered = [...scenes].sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((scene) => scene.id === current.id);
  const previous = index > 0 ? ordered[index - 1] : undefined;
  return {
    pageIndex: Math.max(0, index) + 1,
    totalPages: ordered.length,
    allTitles: ordered.map((scene) => scene.title),
    previousSpeeches: (previous?.actions ?? [])
      .filter((action) => action.type === 'speech')
      .map((action) => action.text)
      .filter(Boolean)
      .slice(-3),
  };
}

/** Drop action names unknown to the current DSL before they reach persistence. */
export function filterKnownActions(actions: readonly Action[]): Action[] {
  return actions.filter((action) => isActionType(action.type));
}

export function buildGenerationTools(deps: GenerationToolDeps): AgentTool<never, never>[] {
  const routed = createGenerationAiCallFactory({
    abortSignal: deps.abortSignal,
    ownerId: deps.ownerId,
  });
  const aiCallFor = (stage: Parameters<typeof routed>[0]) => deps.aiCall ?? routed(stage);
  const actionGenerator = deps.generateActions ?? generateSceneActions;

  const generateScene: AgentTool<typeof SceneParams> = {
    name: 'generate_scene',
    label: 'Generate page',
    description:
      'Generate and durably persist one page from an explicit title, type, and brief. Reusing an order replaces that page. Quiz pages take quizConfig (questionCount is what the page will actually contain — pass it, or the generator silently falls back to its own default). Interactive pages accept widgetType (simulation/diagram/code/game/visualization3d) plus a matching widgetOutline object; both are rejected for other page types. Narration is decided here, not by generate_actions: pass selfStudy (or rely on the deployment default) and no speech is written.',
    parameters: SceneParams,
    async execute(_callId, params, signal) {
      if (!Number.isInteger(params.order) || params.order < 1) {
        return result(
          'generate_scene needs a 1-based integer page order.',
          {
            error: 'invalid-order',
          },
          true,
        );
      }
      const doc = await deps.store.loadDocument(params.stageId);
      /**
       * ★ 阶段冻结的门槛。
       *
       * 判据（见 plan-freeze.ts 的 planGate）：计划不是空的、已冻结、且**这一页在计划里
       * 有条目**。不满足就**拒绝生成**，并把该怎么做原样告诉 agent —— **拒绝本身就是通知**，
       * 所以系统提示词里一个字都不用加（也就不用担心前缀缓存）。
       *
       * 这是手册 §4 那条教训的应用：提示词约束不住的东西，在代码里给默认值。
       */
      if (planGateEnabled()) {
        const planEntries = ((doc?.outline as AppDocumentOutline | undefined)?.outlines ??
          []) as SceneOutline[];
        // 三条判据全开：**计划非空 + 已冻结 + 这一页在计划里**。
        // 夹具早就备好了（`document()` 写的冻结文件 + 每页一条 plan 条目），
        // 强制行为由 tests/agent-runtime/generation-tools.test.ts 的
        // 「★ 阶段冻结的门槛」一组钉住（以及 tests/agent-runtime/patch-stage-gates.test.ts 的 patch_stage 侧）。
        const gate = planGate({
          state: await readPlanFreeze(params.stageId),
          entries: planEntries,
          order: params.order,
        });
        if (!gate.ok) {
          return result(
            gate.message,
            { blocked: 'plan-not-frozen', order: params.order, planEntries: planEntries.length },
            true,
          );
        }
      }
      if (!doc) return result('No course document yet. Call create_stage first.', {}, true);
      const existing = doc.scenes.find((scene) => scene.order === params.order);
      const title = params.title.trim();
      const brief = params.brief.trim();
      if (!title || !brief) {
        return result(
          'generate_scene needs a non-empty title and brief.',
          {
            error: 'missing-title-or-brief',
          },
          true,
        );
      }
      if (existing && !SUPPORTED_SCENE_TYPES.has(existing.type)) {
        return result(
          `Page ${params.order} has unsupported type "${existing.type}" and was left unchanged.`,
          { blocked: 'unsupported-type', sceneId: existing.id, type: existing.type },
          true,
        );
      }
      if (existing?.type === 'pbl' && params.type !== 'pbl') {
        return result(
          'The existing page is a PBL project. Delete it first or regenerate it as pbl; changing its type here would destroy the project.',
          { blocked: 'pbl-type-change', sceneId: existing.id, type: existing.type },
          true,
        );
      }
      if (params.instruction && params.type === 'pbl') {
        return result(
          'generate_scene cannot apply an instruction to a PBL page because the planner would drop it. Use patch_stage for a fine edit or regenerate without instruction.',
          { blocked: 'pbl-instruction-not-supported', sceneId: existing?.id },
          true,
        );
      }
      if (
        params.type !== 'interactive' &&
        (params.widgetType !== undefined || params.widgetOutline !== undefined)
      ) {
        return result(
          'generate_scene only accepts widgetType/widgetOutline for interactive pages.',
          { error: 'widget-requires-interactive', type: params.type },
          true,
        );
      }
      if (
        params.widgetOutline !== undefined &&
        (typeof params.widgetOutline !== 'object' ||
          params.widgetOutline === null ||
          Array.isArray(params.widgetOutline))
      ) {
        return result(
          'generate_scene needs widgetOutline to be an object matching widgetType.',
          { error: 'invalid-widget-outline' },
          true,
        );
      }
      if (params.type !== 'quiz' && params.quizConfig !== undefined) {
        return result(
          'generate_scene only accepts quizConfig for quiz pages.',
          { error: 'quiz-config-requires-quiz', type: params.type },
          true,
        );
      }
      const requestedMedia = params.media ?? [];
      if (requestedMedia.length > MAX_GENERATE_SCENE_MEDIA) {
        return result(
          `generate_scene accepts at most ${MAX_GENERATE_SCENE_MEDIA} media items.`,
          { error: 'too-many-media', maxItems: MAX_GENERATE_SCENE_MEDIA },
          true,
        );
      }
      const outline: SceneOutline = {
        id: existing?.outlineId ?? `p${params.order}`,
        order: params.order,
        title,
        type: params.type,
        description: brief,
        keyPoints: params.materialFacts ?? [],
        ...(params.type === 'interactive' &&
        (params.widgetType !== undefined || params.widgetOutline !== undefined)
          ? {
              widgetType: params.widgetType ?? 'simulation',
              // Mirror the generator fallback so a bare widgetType still generates.
              widgetOutline: (params.widgetOutline as
                | SceneOutline['widgetOutline']
                | undefined) ?? {
                concept: title,
              },
            }
          : {}),
        ...(params.type === 'pbl'
          ? {
              pblConfig: {
                projectTopic: params.title.trim(),
                projectDescription: params.brief.trim(),
                targetSkills: params.materialFacts ?? [],
              },
            }
          : {}),
        ...(params.type === 'quiz' ? { quizConfig: resolveQuizConfig(params.quizConfig) } : {}),
      };
      const baseline =
        params.instruction && existing?.type === 'slide'
          ? {
              elements: existing.content.canvas.elements,
              background: existing.content.canvas.background,
            }
          : undefined;
      const assignedImages: PdfImage[] = [];
      const imageMapping: ImageMapping = {};
      for (const [index, media] of (params.media ?? []).entries()) {
        const src = media.src.trim();
        const description = media.description.trim();
        if (!description) {
          return result(
            'Every media item needs a non-empty description.',
            {
              error: 'invalid-media-description',
              index,
            },
            true,
          );
        }
        if (!acceptableMediaSrc(src)) {
          return result(
            'Every media item needs a stored-asset id from generate_image, an HTTP(S) URL, or a same-origin path — not a generation placeholder or a data URL.',
            {
              error: isMediaPlaceholder(src) ? 'media-placeholder-src' : 'invalid-media-src',
              index,
            },
            true,
          );
        }
        const id = `img_${index + 1}`;
        assignedImages.push({
          id,
          src,
          description,
          pageNumber: index + 1,
          sourceDocumentName: 'page media input',
          ...(media.width ? { width: media.width } : {}),
          ...(media.height ? { height: media.height } : {}),
        });
        imageMapping[id] = src;
      }
      const agents = doc.stage.generatedAgentConfigs;
      /**
       * 出题前的注入：把「前面已经讲过什么」告诉自检页生成器。
       *
       * 它是**另一次 LLM 调用**，看不到 agent 读过什么、也看不到别的页（见上面
       * brief 那段注释）。所以通道只有两条：`brief`（agent 写，承载"这一页要什么"，
       * 含要重考的考点）和这一段（**代码算**，承载"全课程的词表"—— agent 记不住，
       * 也不该由它记）。见 `lib/quiz/quiz-grounding.ts` 头部。
       *
       * 与写入后的 `coverageGaps` 是同一个单位（`contentChunks` 切的块），所以
       * "允许用的词"和"报出来的缺口"说的是同一件事，判据不会互相漂。
       */
      const quizGrounding =
        params.type === 'quiz'
          ? buildQuizGrounding({
              scenes: doc.scenes.map((item) => ({
                order: item.order,
                title: item.title,
                content: item.content,
              })),
              beforeOrder: params.order,
            })
          : '';
      const contentAiCall = quizGrounding
        ? appendToSystemPrompt(aiCallFor(sceneContentStage(params.type)), quizGrounding)
        : aiCallFor(sceneContentStage(params.type));
      let content: Awaited<ReturnType<typeof generateSceneContent>>;
      let contentFailure: SceneContentFailureCode | undefined;
      try {
        content = await generateSceneContent(outline, contentAiCall, {
          agents,
          languageDirective: doc.stage.languageDirective ?? '',
          allowProceduralSkill: true,
          ...(assignedImages.length ? { assignedImages, imageMapping } : {}),
          ...(params.instruction ? { editDirective: params.instruction } : {}),
          ...(baseline ? { baselineContent: baseline } : {}),
          onFailure: (failure) => {
            contentFailure = failure.code;
          },
        });
      } catch (error) {
        if (error instanceof PBLGenerationError) {
          return result(
            `PBL generation failed and nothing was written. ${error.message}`,
            {
              error: 'pbl-planner-failed',
              order: params.order,
              title,
              sceneId: existing?.id,
              ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
              cause: error.message,
            },
            true,
          );
        }
        throw error;
      }
      if (signal?.aborted) throw new Error('aborted');
      if (!content) {
        const error = contentFailure ?? 'scene-content-generation-failed';
        log.warn({
          error,
          stageId: params.stageId,
          order: params.order,
          title,
          type: params.type,
          ...(existing ? { sceneId: existing.id } : {}),
        });
        const text =
          error === 'prompt-unavailable'
            ? 'Page content prompt could not be prepared; nothing was written.'
            : error === 'invalid-model-output'
              ? 'The model response could not be parsed into page content; nothing was written.'
              : 'Page content generation failed; nothing was written.';
        return result(
          text,
          {
            error,
            order: params.order,
            title,
            type: params.type,
            ...(existing ? { sceneId: existing.id } : {}),
          },
          true,
        );
      }
      /**
       * 自学页不生成讲稿。
       *
       * `study-mode.ts` 只告诉了 agent「不要跑 generate_actions」—— 但讲稿是
       * **这里**生成的，agent 说什么都拦不住它。所以要在这里真的拦。
       */
      const selfStudy = params.selfStudy ?? agentRuntimeConfig.selfStudyDefault;
      const actions = selfStudy
        ? []
        : filterKnownActions(
            await actionGenerator(outline, content, aiCallFor('scene-actions'), {
              agents,
              languageDirective: doc.stage.languageDirective ?? '',
            }),
          );
      /**
       * 自检页的题量核对。
       *
       * `parseJsonResponse` 的「修截断」分支会把写了一半的 JSON 数组**砍到最后一个
       * 完整对象**再闭合，然后**当作成功返回**（json-repair.ts Fix 3，只打一条
       * warn）。于是"要 8 道、写崩在第 5 道"会静默变成 5 道。生成层看不见这件事，
       * 所以在这里量一次。
       */
      const quizRequested =
        params.type === 'quiz' ? resolveQuizConfig(params.quizConfig).questionCount : undefined;
      const quizProduced =
        params.type === 'quiz' && 'questions' in content ? content.questions.length : undefined;
      const quizShortfall =
        quizRequested !== undefined && quizProduced !== undefined && quizProduced < quizRequested;
      if (quizShortfall) {
        log.warn({
          error: 'quiz-question-shortfall',
          stageId: params.stageId,
          order: params.order,
          title,
          requested: quizRequested,
          produced: quizProduced,
        });
      }
      const built = buildCompleteScene(outline, content, actions, params.stageId, {
        sceneId: existing?.id ?? sceneIdFor(doc.scenes, params.order),
      });
      if (!built) return result('Page assembly failed; nothing was written.', {}, true);
      const scene = built as Scene;
      await runStageMutation(signal, () =>
        putSceneBringingCurrent(deps.store, params.stageId, scene),
      );
      const skill = deps.getActiveSkill?.() ?? null;
      const afterWrite = await deps.store.loadDocument(params.stageId);
      /**
       * T1：把这一页的 brief **落盘**到课程计划里。
       *
       * 在此之前 brief 生成完就扔 —— 数据库里没有任何一行说"第 5 页本来要讲 X"，
       * 于是 `read_stage_outline` 只显示标题、`edit_deck` 的重排在 agent 路径上
       * 是**死代码**。见 `course-outline-write.ts` 头部。
       *
       * 只有全量 `saveDocument` 能写 outline（存储层没有增量 API），所以**内容没变
       * 就不写** —— `changed: false` 时跳过整篇保存。放在 scene 落盘**之后**，
       * 这样 `afterWrite` 里已经含这一页，整篇保存不会把它漏掉。
       * （写 scene 与写 outline 是两次写，中间崩掉的结果就是今天的行为：brief 没落盘、
       * 页面还在。方向是纯改善，没有新的坏状态。）
       */
      const outlineUpdate = afterWrite
        ? upsertOutlineEntry(afterWrite.outline as AppDocumentOutline | undefined, outline)
        : { outline: undefined, changed: false };
      if (afterWrite && outlineUpdate.changed && outlineUpdate.outline) {
        await runStageMutation(signal, () =>
          deps.store.saveDocument({ ...afterWrite, outline: outlineUpdate.outline }),
        );
      }
      const skillViolations =
        skill && afterWrite ? checkScenesAgainstSkill(afterWrite.scenes, skill.constraints) : [];
      const persisted = afterWrite?.scenes.find((item) => item.id === scene.id) ?? scene;
      /**
       * 写入后的两条诊断：自检页的**覆盖缺口** + **计划期依赖**。
       *
       * ★ 与 `patch_stage` **共用同一段代码**（`scene-diagnostics.ts`）—— 用户问
       * 「让 AI 在原来 Day 1 上修复，它能按着已有规则来吗」，那时的答案是"不能"，
       * 因为检查只挂在这条路上。抽出来之后，**生成和修改两条路判据一致**。
       *
       * 两条都是**诊断不是拒绝**：不回滚、不删题，修法只允许"补"和"挪"。
       */
      const diagnostics =
        afterWrite !== null
          ? await sceneWriteDiagnosticsWithReview(
              {
                scenes: afterWrite.scenes,
                scene: persisted,
                outline: (outlineUpdate.outline ?? afterWrite.outline) as
                  | AppDocumentOutline
                  | undefined,
              },
              { reviewPage: deps.reviewPage },
            )
          : {
              coverageGaps: [],
              coverageText: '',
              planIssues: [],
              planText: '',
              densityText: '',
              bodyChars: 0,
              layoutFindings: [],
              layoutText: '',
              layoutDelta: { added: [], removed: [], kept: [] },
              layoutDeltaText: '',
              pageReviewText: '',
            };
      const mediaPlaceholders = collectUnresolvedMediaPlaceholders(persisted);
      deps.onCheckpoint({
        tool: 'generate_scene',
        stageId: params.stageId,
        sceneId: scene.id,
        order: scene.order,
        title: scene.title,
        sceneType: scene.type,
        skill: skill?.id,
        ...(skillViolations.length ? { skillViolations } : {}),
        detail: `page ${scene.order} persisted`,
      });
      return result(
        `Page ${scene.order} "${scene.title}" persisted.${
          selfStudy ? ' Self-study: no narration was generated (the page reads on its own).' : ''
        }${
          quizShortfall
            ? ` QUESTION COUNT SHORTFALL: you asked for ${quizRequested} questions and the page` +
              ` generator returned ${quizProduced} — its response was cut off and the parser` +
              ` silently kept the complete prefix. The page as it stands is incomplete. Add the` +
              ` missing ${quizRequested - quizProduced} with patch_stage (cheap, and it keeps the` +
              ` questions that are already there), or regenerate the page with fewer or shorter` +
              ` questions in the brief so the response fits.`
            : ''
        }${
          skillViolations.length
            ? ` SKILL CONSTRAINT CHECK against "${skill?.id}": ${skillViolations.join('; ')}.`
            : ''
        }${diagnostics.coverageText}${diagnostics.planText}${diagnostics.densityText}${diagnostics.layoutText}${diagnostics.pageReviewText}${
          mediaPlaceholders.length
            ? ` ${mediaPlaceholders.length} media placeholder(s) still render as skeletons.`
            : ''
        }`,
        {
          sceneId: scene.id,
          order: scene.order,
          type: scene.type,
          actionCount: actions.length,
          selfStudy,
          ...(quizRequested !== undefined ? { quizRequestedQuestions: quizRequested } : {}),
          ...(quizProduced !== undefined ? { quizProducedQuestions: quizProduced } : {}),
          ...(quizShortfall ? { quizShortfall: true } : {}),
          skill: skill?.id,
          ...(skillViolations.length ? { skillViolations } : {}),
          outlinePersisted: outlineUpdate.changed,
          // ★ **计数无条件写、样本列表按需写**。
          //   原来两个都是条件的 ⇒ 缺口为 0 时字段**根本不出现**，
          //   于是 SQL 读出来是 NULL，**分不清"跑过且干净"和"这条路没跑过"** ——
          //   而"缺了 0 个"正是修复成功时的读数，最需要被看见的就是它。
          //   （样本列表仍然按需：空数组没有信息量。）
          planIssueCount: diagnostics.planIssues.length,
          coverageGapCount: diagnostics.coverageGaps.length,
          // ★ **含代码/英文的那一类全量发射**（2026-10-07 修）。
          //   原来这里和 `coverageGaps` 一样是 `.slice(0, 12)` ⇒ 旁注列 12 条、
          //   details 也只有 12 条 ⇒ **第 13 条以后没有任何出口**。
          //   实测后果：agent 只看到 12 条，剩下 82 条只能**外推**，而它自己
          //   也如实说了"那是外推"。**工具不给出口，就别指望模型结论可靠。**
          //   中文片段只计数（低价值那一类：讲解页与自检页各自独立生成，措辞必然不同）。
          coverageGapsCode: splitCoverageGaps(diagnostics.coverageGaps).code.map((gap) => gap.term),
          coverageGapProseCount: splitCoverageGaps(diagnostics.coverageGaps).prose.length,
          ...(diagnostics.planIssues.length
            ? { planIssues: diagnostics.planIssues.map((issue) => issue.kind) }
            : {}),
          ...(diagnostics.coverageGaps.length
            ? { coverageGaps: diagnostics.coverageGaps.slice(0, 12).map((gap) => gap.term) }
            : {}),
          ...(mediaPlaceholders.length ? { mediaPlaceholders } : {}),
        },
        quizShortfall,
      );
    },
  };

  const listScenes: AgentTool<typeof ListParams> = {
    name: 'list_scenes',
    label: 'List pages',
    description: 'List the pages currently persisted in a stage.',
    parameters: ListParams,
    async execute(_callId, params) {
      const doc = await deps.store.loadDocument(params.stageId);
      const pages = [...(doc?.scenes ?? [])]
        .sort((a, b) => a.order - b.order)
        .map(({ id, order, title, type }) => ({ id, order, title, type }));
      return result(`Persisted pages: ${pages.length}.`, { pageCount: pages.length, pages });
    },
  };

  const generateActionsTool: AgentTool<typeof ActionsParams> = {
    name: 'generate_actions',
    label: 'Generate page actions',
    description:
      'Regenerate playback actions for one persisted page, optionally backfilling narration audio.',
    parameters: ActionsParams,
    async execute(_callId, params, signal) {
      const doc = await deps.store.loadDocument(params.stageId);
      const scene = params.sceneId
        ? doc?.scenes.find((item) => item.id === params.sceneId)
        : doc?.scenes.find((item) => item.order === params.order);
      if (!doc || !scene) return result('Page not found. Call list_scenes.', {}, true);
      const outline = outlineFromScene(scene, doc.outline);
      const actions = filterKnownActions(
        await actionGenerator(
          outline,
          toGenerationContent(scene.content),
          aiCallFor('scene-actions'),
          {
            ctx: actionContext(doc.scenes, scene),
            agents: doc.stage.generatedAgentConfigs,
            languageDirective: doc.stage.languageDirective ?? '',
            userProfile: params.styleDirective,
          },
        ),
      );
      if (!actions.length)
        return result('No known actions were generated; the page was unchanged.', {}, true);
      const next = { ...scene, actions } as Scene;
      await runStageMutation(signal, () =>
        putSceneBringingCurrent(deps.store, params.stageId, next),
      );
      deps.onCheckpoint({
        tool: 'generate_actions',
        stageId: params.stageId,
        sceneId: scene.id,
        order: scene.order,
        detail: `${actions.length} actions persisted`,
      });
      let audio;
      if (params.synthesizeAudio !== false) {
        audio = await (deps.synthesizeTts ?? synthesizeSceneNarration)({
          scene: next,
          force: false,
          roster: doc.stage.generatedAgentConfigs,
          signal,
          ownerId: deps.ownerId,
        });
        if (audio.changed) {
          await runStageMutation(signal, () =>
            putSceneBringingCurrent(deps.store, params.stageId, next),
          );
          deps.onCheckpoint({
            tool: 'generate_actions',
            stageId: params.stageId,
            sceneId: scene.id,
            order: scene.order,
            detail: 'narration audio persisted',
          });
        }
      }
      const voiceNote =
        audio?.voice && audio.generated > 0 ? ` ${describeNarrationVoice(audio.voice)}` : '';
      const narration =
        audio?.available === true
          ? ` Narration audio: ${audio.generated} generated, ${audio.skipped} skipped, ${formatTtsFailureTally(audio.failed)}.${voiceNote}`
          : '';
      return result(`Persisted ${actions.length} known actions for "${scene.title}".${narration}`, {
        sceneId: scene.id,
        actions,
        ...(audio ? { audio } : {}),
      });
    },
  };

  const duplicateScene: AgentTool<typeof DuplicateParams> = {
    name: 'duplicate_scene',
    label: 'Duplicate page',
    description:
      'Copy an existing page to a new position without actions. Replaying the same tool call is idempotent.',
    parameters: DuplicateParams,
    async execute(callId, params, signal) {
      const doc = await deps.store.loadDocument(params.stageId);
      if (!doc) return result('No course document yet. Call create_stage first.', {}, true);
      const scenes = [...doc.scenes].sort((a, b) => a.order - b.order);
      const id = duplicateId(deps.sessionId, callId);
      const replay = scenes.find((scene) => scene.id === id);
      if (replay)
        return result('This page was already duplicated. Nothing changed.', {
          sceneId: id,
          order: replay.order,
          replay: true,
        });
      const template = params.templateSceneId
        ? scenes.find((scene) => scene.id === params.templateSceneId)
        : scenes.find((scene) => scene.order === params.templateOrder);
      if (!template) return result('Template page not found.', {}, true);
      const at = Math.min(params.targetOrder, scenes.length + 1);
      const shifted = shiftCourseOrders(
        scenes,
        doc.outline as AppDocumentOutline | undefined,
        at,
        1,
      );
      const now = Date.now();
      const created = {
        ...structuredClone(template),
        id,
        outlineId: id,
        stageId: params.stageId,
        order: at,
        title: params.title?.trim() || template.title,
        actions: [],
        createdAt: now,
        updatedAt: now,
      } as Scene;
      await runStageMutation(signal, () =>
        deps.store.saveDocument({
          ...doc,
          scenes: [...shifted.scenes, created].sort((a, b) => a.order - b.order),
          outline: shifted.outline,
        }),
      );
      deps.onCheckpoint({
        tool: 'duplicate_scene',
        stageId: params.stageId,
        sceneId: id,
        order: at,
        detail: `duplicated ${template.id}`,
      });
      return result(`Duplicated "${template.title}" at order ${at}.`, { sceneId: id, order: at });
    },
  };

  return [generateScene, listScenes, generateActionsTool, duplicateScene] as unknown as AgentTool<
    never,
    never
  >[];
}

export const GENERATION_TOOL_NAMES = [
  'generate_scene',
  'list_scenes',
  'generate_actions',
  'duplicate_scene',
] as const;
