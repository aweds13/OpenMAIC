/**
 * The stage read/patch toolset — the agent's document-level DSL surface.
 *
 * This layer combines the generic stage DSL (`read_stage`, `patch_stage`,
 * `grep_stage` from `./dsl-tools`) with page generation, playback, deck
 * structure, media promotion, and preview tools, plus the stage-level CRUD
 * they need (`create_stage`, folder organization, `rename_stage`, and
 * `read_stage_outline` from `./curriculum-tools`) for the background runner.
 *
 * What this layer owns:
 *
 *  - **Owner-scoped writes.** Every tool receives ONE store bound to the run's
 *    session owner. The owner never appears in a model-visible parameter;
 *    stages are readable by id, while foreign writes are refused.
 *  - **Sequential scheduling for document writers.** `patch_stage` loads the
 *    whole document, applies its change in memory and writes the scene back.
 *    The agent routinely emits several writers as PARALLEL tool calls in one
 *    turn, and then they all load the same snapshot and overwrite each other —
 *    the last writer wins, every sibling op is lost while still reporting
 *    success. The write set is derived from the shared
 *    `STAGE_WRITER_TOOL_NAMES` registry (the same list that arms client-side
 *    write ownership) and declared `executionMode: 'sequential'` to pi, so a
 *    batch containing a writer runs entirely sequentially and reads next to a
 *    write observe committed state.
 *  - **The DSL compatibility prompt block.** `DSL_TOOLS_PROMPT` teaches the
 *    model the current tool names (legacy transcripts named the retired
 *    per-type editors) and is layered into every runner prompt by
 *    `buildRunnerCoursePrompt` (runner-contract.ts).
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DocumentFolderStore, DocumentStore, MaicDocument } from '@openmaic/storage';
import type { Stage } from '@openmaic/dsl';

import type { Scene } from '@/lib/types/stage';
import { STAGE_WRITER_TOOL_NAMES } from '@/lib/agent-runtime/stage-writer-tools';
import { buildDslCourseTools, DSL_COURSE_TOOL_NAMES } from './dsl-tools';
import { CURRICULUM_ALLOWLIST } from './curriculum-tools';
import { buildGenerationTools, GENERATION_TOOL_NAMES } from './generation-tools';
import { buildCourseAudioAndDeckTools, COURSE_AUDIO_DECK_TOOL_NAMES } from './course-edit/tools';
import { buildMaterialMediaTool, MATERIAL_MEDIA_TOOL_NAME } from './material-media';
import { RENDER_SCENE_PREVIEW_TOOL_NAME } from './scene-preview';
import { buildImportPptxTool, IMPORT_PPTX_TOOL_NAME, type ImportPptxToolDeps } from './import-pptx';
import {
  buildGenerateImageTool,
  GENERATE_IMAGE_TOOL_NAME,
  type GenerateImageToolDeps,
} from './generate-image';
import {
  buildGenerateVideoTool,
  GENERATE_VIDEO_TOOL_NAME,
  hasConfiguredVideoGeneration,
  type GenerateVideoToolDeps,
} from './generate-video';
import type { SceneTtsInput, SceneTtsSummary } from './scene-tts';
import type { LoadedSkill } from './skills';

export type CourseDocument = MaicDocument<Scene, Stage>;
export type CourseStore = DocumentStore<Scene, Stage> & DocumentFolderStore;

/** Progress metadata emitted on the durable `checkpoint` channel after a write. */
export interface CheckpointInfo {
  tool: string;
  detail: string;
  /** The stage the checkpoint wrote to — unlocks the workbench's real-time
   * sync for courses that were opened, not minted, by this session. */
  stageId?: string;
  sceneId?: string;
  order?: number;
  title?: string;
  sceneType?: string;
  /** Active skill whose persisted constraints were checked after this write. */
  skill?: string;
  /** Non-blocking structural diagnostics for the persisted stage. */
  skillViolations?: string[];
}

export interface CourseToolDeps {
  /** The owner-bound document store of the run's session owner. */
  store: CourseStore;
  /**
   * Fail-closed owner probe for every model-declared stage target: a stage
   * that is not owned (foreign, missing, or tombstoned) is refused before the
   * tool ever touches the store. The refusal never echoes which state it was.
   */
  stageAccess: (
    stageId: string,
  ) => Promise<{ kind: 'owned' | 'missing' | 'foreign' | 'tombstoned' }>;
  /** Emitted after a successful document write (the durable `checkpoint` event). */
  onCheckpoint: (info: CheckpointInfo) => void;
  /** The session id, recorded on the document as the producer reference. */
  sessionId?: string;
  /** Cancel generation, preview, and synthesis when the run stops. */
  abortSignal?: AbortSignal;
  /** Test seam for the neutral TTS path. */
  synthesizeTts?: (input: SceneTtsInput) => Promise<SceneTtsSummary>;
  /** Resolve the skill that owns structural diagnostics for the current turn. */
  getActiveSkill?: () => LoadedSkill | null;
}

/**
 * Every tool in this toolset that is a read-modify-write of the persisted
 * course document: it loads the document (or one scene), applies its change in
 * memory, and writes a whole scene or the whole document back.
 *
 * Derived from the shared `STAGE_WRITER_TOOL_NAMES` (the same list that arms
 * client-side write ownership) so the scheduler and the workbench can never
 * disagree about who writes. `rename_stage` is scheduled in the curriculum
 * toolset, so it is excluded from this course-tool subset.
 */
export const DOCUMENT_WRITING_TOOLS: ReadonlySet<string> = new Set<string>(
  [...STAGE_WRITER_TOOL_NAMES].filter((name) => name !== 'rename_stage'),
);

/**
 * Declare the document writers as `executionMode: 'sequential'`.
 *
 * None of them takes a lock: each is `load whole document → apply one op in
 * memory → write the whole scene back`. The agent routinely emits several of
 * them for one page as PARALLEL tool calls in a single turn, and then they all
 * load the same snapshot and overwrite each other. The damage is silent — the
 * last writer wins, every sibling op is lost while still reporting success, and
 * an element added by one call is erased by a sibling whose snapshot predates
 * it.
 *
 * pi is the scheduler, so the requirement is declared to pi rather than
 * hand-rolled here: in `executeToolCalls` (pi-agent-core agent-loop.js) a batch
 * containing ANY call to a `sequential` tool runs entirely through
 * `executeToolCallsSequential`. That is deliberately stronger than serializing
 * only the writers against each other — it also orders the READS in the same
 * batch, so a `read_stage` next to an edit observes committed state instead of
 * the pre-write snapshot, which is the other half of what made the agent loop.
 *
 * The cost is that a batch mixing a write with otherwise-parallel reads loses
 * that parallelism. That is the intended trade: a lost write is not
 * self-correcting, a slower turn is.
 */
export function markDocumentWritersSequential(
  tools: AgentTool<never, never>[],
): AgentTool<never, never>[] {
  return tools.map((tool) => {
    const named = tool as unknown as { name: string };
    if (!DOCUMENT_WRITING_TOOLS.has(named.name)) return tool;
    return { ...tool, executionMode: 'sequential' } as unknown as AgentTool<never, never>;
  });
}

/**
 * Wrap every tool that names a stage in the fail-closed owner probe.
 *
 * This is the single legality boundary of the open-domain stage toolsets: each
 * tool resolves its target stage ONCE, before any store IO. A probe that is
 * not `owned` (foreign, missing, or tombstoned) refuses with the same
 * not-yours message the curriculum toolset uses, and the tool text never
 * echoes which state it was. Tools without a `stageId` parameter pass through
 * untouched. The runner applies it to the course/DSL toolset and to the roster
 * toolset — the reference wraps every stageId-bearing tool of its merged
 * course toolset the same way.
 */
export function withOwnerStageAuthorization(
  tools: AgentTool<never, never>[],
  deps: Pick<CourseToolDeps, 'stageAccess'>,
): AgentTool<never, never>[] {
  return tools.map((tool) => {
    const original = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(...args: Parameters<typeof tool.execute>) {
        const [callId, rawParams, signal, onUpdate] = args;
        const params = rawParams as unknown as { stageId?: unknown };
        const stageId = typeof params.stageId === 'string' ? params.stageId.trim() : '';
        if (stageId) {
          const access = await deps.stageAccess(stageId);
          if (signal?.aborted) throw new Error('aborted');
          if (access.kind !== 'owned') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'The stage was not found, or does not belong to this session user. Use list_folder_stages to see the stages you can work on.',
                },
              ],
              details: { refused: true, stageId },
              isError: true,
            };
          }
        }
        return original(callId, rawParams, signal, onUpdate);
      },
    } as unknown as AgentTool<never, never>;
  });
}

/**
 * The stage read/patch toolset registered on the runner: the three generic DSL
 * tools (with the page generation, deck, and media tools), every one of them
 * owner-gated by `withOwnerStageAuthorization`, and `patch_stage` marked
 * sequential through the shared writer registry. `import_pptx` and
 * `generate_image` are always part of the course toolset; `generate_video` is
 * capability-registered and exists exactly when a video provider is
 * configured, so the model never sees a tool that can only throw. Scene
 * preview is registered separately by the runner with its own probe, so it
 * never double-gates.
 */
export function buildDslCourseToolset(
  deps: CourseToolDeps &
    Partial<ImportPptxToolDeps> &
    Partial<GenerateImageToolDeps> &
    Partial<GenerateVideoToolDeps>,
): AgentTool<never, never>[] {
  const tools = [
    ...buildGenerationTools(deps),
    buildImportPptxTool(deps),
    buildGenerateImageTool(deps),
    ...(hasConfiguredVideoGeneration(deps) ? [buildGenerateVideoTool(deps)] : []),
    ...buildCourseAudioAndDeckTools(deps),
    ...(deps.sessionId ? [buildMaterialMediaTool({ sessionId: deps.sessionId })] : []),
    ...buildDslCourseTools(deps),
  ] as unknown as AgentTool<never, never>[];
  return markDocumentWritersSequential(withOwnerStageAuthorization(tools, deps));
}

/** The exact registered tool names of this slice's toolset. */
export function buildCourseAllowlist(
  videoDeps: Partial<GenerateVideoToolDeps> = {},
): ReadonlySet<string> {
  return new Set([
    ...DSL_COURSE_TOOL_NAMES,
    ...GENERATION_TOOL_NAMES,
    IMPORT_PPTX_TOOL_NAME,
    GENERATE_IMAGE_TOOL_NAME,
    ...(hasConfiguredVideoGeneration(videoDeps) ? [GENERATE_VIDEO_TOOL_NAME] : []),
    ...COURSE_AUDIO_DECK_TOOL_NAMES,
    MATERIAL_MEDIA_TOOL_NAME,
    RENDER_SCENE_PREVIEW_TOOL_NAME,
    ...CURRICULUM_ALLOWLIST,
  ]);
}

export const DSL_TOOLS_PROMPT = [
  'Some installed skills and older transcripts were written for earlier tool names. Translate on sight: read_scene → read_stage (path=/scenes/<order|id>); edit_slide / edit_quiz / edit_widget / edit_actions / edit_pbl → patch_stage (same JSON-pointer ops, target the scene); read_course → read_stage; patch_course → patch_stage; grep_course → grep_stage; generate_outline → (plan in conversation, then create_stage + one generate_scene per page with an explicit brief); generate_roster → set_roster. Never call the legacy names.',
  'The generic DSL tools replace read_scene and the per-type edit tools.',
  'Every read_stage, patch_stage and grep_stage call requires an explicit stageId obtained from create_stage.',
  'Example: read_stage {"stageId":"stage-...","path":"/scenes/1","detail":"source"}. Use paths "", /outline, /scenes/<1-based order|sceneId>, and /scenes/<...>/actions.',
  'Before patching a structure you have not touched, read the stage-dsl skill and its matching reference chapter.',
  'Always read_stage detail:"source" for the target, patch_stage with the smallest /content/... or /actions/... JSON Pointer, then read_stage again to verify.',
  'For one targeted change inside a large HTML or long text field, use patch_stage op "str_replace" (path, oldText, newText; set replaceAll only when the anchor repeats) instead of rewriting the whole field with set.',
  'Use grep_stage for literal stage-wide text/source search.',
  'Start with detail:"tree" to see structure; read source only for the subtree you will edit; for long content, prefer grep_stage over paging with offset.',
  'Use generate_scene once per page: each successful call is a durable checkpoint. Use list_scenes to inspect persisted pages and generate_actions to rebuild playback actions for one page.',
  'Use duplicate_scene to copy a layout, edit_deck for retitle/insert/delete/reorder, and generate_tts after narration edits. Page-list writers keep the saved outline numbering aligned with the real pages.',
  'To fill an uploaded .pptx into an existing stage as appended pages with its original slides kept, read the `pptx-import` skill first (it carries the import-and-repair sequence) and use `import_pptx` after `create_stage` — never extract_material + generate_scene for a layout-preserving import. The stage keeps its own title; the PPT is content, not the classroom identity.',
  'When the page needs a new visual rather than an existing URL, call `generate_image` first, then apply its returned `src` with `patch_stage` set or add an image element; generate_image never edits the page.',
  'When a NEW page needs visuals, obtain every real src first by reusing material or calling generate_image, then pass each image src with its description and dimensions in `generate_scene.media` so the content model sees the media while composing the page; media generation tools never edit the page.',
  'generate_video is asynchronous: it returns a `gen_vid_...` placeholder immediately and the video completes in the background. Patch the placeholder onto a video element with patch_stage right away; the page updates itself when the video is ready.',
  'Use use_material_media before placing session image, video, or audio bytes into a page. Use render_scene_preview selectively to inspect a persisted page when the render capability is available.',
].join(' ');

/** Base runner identity/environment lines, shared by every runner prompt. */
export const COURSE_SYSTEM_PROMPT = [
  'You are a capable assistant working in a durable background session.',
  'Complete the user request carefully and explain the result clearly.',
  'The conversation may pause, restart on another worker, or receive follow-up messages.',
  'Treat earlier conversation messages as durable context.',
  'Do not claim access to tools or data that are not present in this session.',
  'Use ask_user only when a decision genuinely belongs to the user.',
  'Make every question self-contained and concise.',
  'Offer stable, unique option ids when choices are useful.',
  'After ask_user succeeds, stop and wait for the next user message.',
  'Do not answer your own question or invent the user decision.',
  'If no clarification is needed, answer directly without calling a tool.',
  'Follow later user messages as updates to the same conversation.',
  'Be honest about uncertainty and unavailable capabilities.',
  "Reply in the user's language unless the user requests another language.",
].join('\n');

interface CoursePromptBlocks {
  /** Pi's native `<available_skills>` discovery block. */
  availableSkills?: string;
  /**
   * Present exactly when skills are installed. Turns the passive skill list
   * above into an active choice: recommend a few, list the rest, ask once.
   * See `skillChoicePromptBlock()` in skills.ts for why.
   */
  skillChoice?: string;
  /**
   * 「讲课 / 作业 / 考试」这条**评估方式**轴（与 听课/自学 正交）。
   * 无参、恒定；模式本身是对话里的事，不进提示词做状态。
   * 见 `assessment-mode.ts` 头部：它是**姿态不是闸**。
   */
  assessmentMode?: string;
  /** Multi-stage workflow guidance (explicit stage ids and folders). */
  curriculum?: string;
  /** Present exactly when the web_search tool is registered. */
  search?: string;
  /**
   * Present exactly when the `course_search` tool is registered — i.e. this
   * deployment has OPENMAIC_COURSE_SEARCH_URL pointing at a local library.
   */
  courseLibrary?: string;
  /**
   * Present exactly when `browse_url` is registered — i.e. this deployment has
   * OPENMAIC_BROWSE_URL pointing at the Playwright sidecar. Says how the
   * browser and `fetch_url` divide the work (look vs keep); see browse-url.ts.
   */
  browse?: string;
  /**
   * The learner's own profile (OPENMAIC_LEARNER_PROFILE_PATH). Present only
   * when that file is configured AND readable — an unreadable profile is
   * omitted rather than injected as an error or an empty section.
   */
  learnerProfile?: string;
  /**
   * Always present on the runner path: how to read the learner's answer to
   * "listen or read it yourself", and what that choice changes downstream.
   */
  studyMode?: string;
  /**
   * Always present on the runner path. Carries the design-quality rules that
   * the SDK's one-shot prompts get wrong (density, decomposition, cross-page
   * echo, terms, filler) — translated into what the agent must put in each
   * `generate_scene` brief. See course-design.ts.
   */
  courseDesign?: string;
  /**
   * Present exactly when at least one external MCP server registered a tool.
   * Says these are external services — failure must be reported, not papered
   * over with the model's own recollection.
   */
  mcp?: string;
  /**
   * The materials library index (OPENMAIC_MATERIALS_DIR/INDEX.md) plus the
   * topics found on disk. Present only when that folder is configured AND
   * readable — an unreadable library is omitted rather than injected empty.
   *
   * Unlike the other blocks this one accompanies **writing** tools: the agent
   * maintains the library, so the block is an instruction to gather → ask →
   * record, not just a list to read.
   */
  materialsLibrary?: string;
  /** Policy boundary for content fetched from session-observed URLs. */
  untrustedContent?: string;
  /** fetch_url usage guidance (the tool is always registered). */
  fetch?: string;
  /** Compatibility guidance for installed legacy skills and resumed transcripts. */
  dslTools?: string;
  /**
   * Session-materials listing. Present only when the session actually has
   * materials (reference semantics: the block must not appear for a session
   * with nothing to read).
   */
  materials?: string;
  /** Roster guidance (list_voices / set_roster; always registered). */
  roster?: string;
  /** Voice-cloning guidance (clip_audio / register_voice; always registered). */
  voice?: string;
  /**
   * 阶段冻结的门槛开着时才出现（`OPENMAIC_PLAN_GATE=1`）。
   * 见 plan-freeze-tools.ts：门槛关着就不许提它（§1.1）。
   */
  planFreeze?: string;
  /** 修一门**已有**课程之前先审计（`course_audit`；无条件注册）。 */
  courseAudit?: string;
  /** 草稿纸（`scratch`；无条件注册）—— agent 的工作记忆。 */
  scratch?: string;
  /** 练习脚手架／结果读回（`practice_scaffold` / `practice_result`；无条件注册）。 */
  practice?: string;
  /**
   * ★ **学习者状态**（`learners/学习状态.md`）：学过哪些页、错在哪几题。
   *
   * 它是**唯一会随答题变化**的一块 —— 所以渲染顺序上放**最后**：
   * 前面全是不变量，只有末尾会重读（§1.2 前缀缓存）。
   */
  learnerState?: string;
}

/**
 * The agent's system prompt, assembled from the capabilities this session
 * actually has. The DSL compatibility block is always present; every other
 * block is included only when the corresponding capability is registered.
 */
/**
 * 提示词块的**渲染顺序**。
 *
 * ★ 这个数组与 `CoursePromptBlocks` 之间有一条**编译期**完备性检查（见下）：
 *   往接口里加字段、却忘了加到这里 ⇒ **编译不过**。
 *
 * ── 为什么必须有这条检查（一次真事故，2026-10-07）────────────────
 *
 * 原渲染函数是**逐个 `if (blocks.X)`** 写的。于是"往 `promptBlocks` 里塞一个键"
 * 与"真的渲染它"是**两件事**，而前者**不报错**（`promptBlocks` 是推断类型的变量，
 * 传给函数时不做多余属性检查）。实测有 **6 个块被静默丢弃**：
 *
 *   `assessmentMode`（接口声明了，渲染函数没检查）
 *   `planFreeze` / `courseAudit` / `scratch` / `practice`（连接口都没声明）
 *   **`learnerState`**（同上）—— 学习状态的内容**从未到达模型**
 *
 * 那意味着那几轮写的全部行为指引都是**死代码**：块被构造、被传进来、然后被扔掉。
 * 改成"顺序表驱动 + 编译期完备"之后，这种漏法在类型层面就不可能了 ——
 * 与 §12 的 `readingPage` 必填是同一条思路：**让编译器兜，别靠纪律。**
 */
const PROMPT_BLOCK_ORDER = [
  'availableSkills',
  'skillChoice',
  // 紧跟在技能之后：它说的是"你选好的教学法要怎么落到页面上"
  'studyMode',
  // 与 studyMode **正交**的另一条轴（输入方式 vs 评估方式）
  'assessmentMode',
  // 计划先于"每页具体怎么写"：没有计划条目就生成不了页
  'planFreeze',
  'courseDesign',
  // 修**已有**课程：紧接着"怎么写页"，因为它讲的是"改哪一页"
  'courseAudit',
  'practice',
  'curriculum',
  'search',
  'courseLibrary',
  // 「怎么看网页」必须紧跟能力清单、且在 fetch 之前
  'browse',
  'mcp',
  'materialsLibrary',
  // 工作记忆：在"为谁做"之前
  'scratch',
  'learnerProfile',
  'dslTools',
  'fetch',
  'untrustedContent',
  'materials',
  'roster',
  'voice',
  // ★ 唯一会随答题变化的一块，放**最后** ⇒ 只让末尾重读（§1.2）
  'learnerState',
] as const satisfies readonly (keyof CoursePromptBlocks)[];

/**
 * 编译期完备性：接口里有、顺序表里没有的字段 ⇒ 这里报错（`never` 约束不满足）。
 * **零运行时开销**（纯类型）。
 */
type MissingPromptBlock = Exclude<keyof CoursePromptBlocks, (typeof PROMPT_BLOCK_ORDER)[number]>;
type AssertNever<_T extends never> = true;
type _PromptBlockOrderIsComplete = AssertNever<MissingPromptBlock>;

/**
 * The agent's system prompt, assembled from the capabilities this session
 * actually has. The DSL compatibility block is always present; every other
 * block is included only when the corresponding capability is registered.
 *
 * ★ 渲染由 {@link PROMPT_BLOCK_ORDER} 驱动 —— 不要退回"逐个 if"的写法：
 *   那正是让 6 个块被静默丢弃的原因。
 */
export function courseSystemPrompt(blocks: CoursePromptBlocks): string {
  const parts = [COURSE_SYSTEM_PROMPT];
  for (const key of PROMPT_BLOCK_ORDER) {
    const value = blocks[key];
    if (value) parts.push('', value);
  }
  return parts.join('\n');
}
