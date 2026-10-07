/** Server-only agent runtime configuration. */
const numberFromEnv = (value: string | undefined, fallback: number) =>
  value ? Number(value) : fallback;

/**
 * Compaction threshold, in context tokens, used when the operator has not set
 * `OPENMAIC_AGENT_COMPACTION_CONTEXT_BUDGET`.
 *
 * Why a budget and not the model window: the driver passes its catalog context
 * window (`agent-driver-model.ts`), which is 1M for some models. A real session
 * never approaches that, so measuring against it would mean compaction never
 * fires — which is exactly what happened before this knob existed.
 *
 * 150k is roughly six times the floor cost of a run (the system prompt alone is
 * ~23k tokens), and it is well under the point where a single call's input
 * stops being usefully cacheable.
 */
export const DEFAULT_COMPACTION_CONTEXT_BUDGET_TOKENS = 150_000;

export const agentRuntimeConfig = {
  /** How often the runner scans for claimable sessions. */
  scanIntervalMs: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_SCAN_INTERVAL_MS, 1000),
  /** How often a running session's lease heartbeat is refreshed. */
  heartbeatIntervalMs: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_HEARTBEAT_MS, 2000),
  /**
   * A running session with an older heartbeat is orphaned and may be resumed
   * elsewhere. Keep this comfortably above the heartbeat interval so a slow
   * heartbeat is not mistaken for a dead worker.
   */
  leaseTtlMs: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_LEASE_TTL_MS, 10_000),
  /** Maximum sessions one application instance runs concurrently. */
  maxConcurrent: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT, 2),
  /** Maximum consecutive unattended starts or resumptions. */
  maxAttempts: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_MAX_ATTEMPTS, 5),
  /**
   * Native conversation compaction — the workbench's "the context got too big,
   * summarize the old part" step. Implemented in ./compaction.ts.
   *
   * OFF unless OPENMAIC_AGENT_COMPACTION_ENABLED is exactly "true". That is a
   * deliberate inversion of the reference runtime's opt-out default: compaction
   * changes what the model can see and spends a summarization call, so it is an
   * operator decision rather than a surprise.
   *
   * `contextBudgetTokens` is the threshold the decision is measured against, and
   * it is deliberately NOT the model's context window — see
   * {@link DEFAULT_COMPACTION_CONTEXT_BUDGET_TOKENS}.
   */
  compaction: {
    enabled: process.env.OPENMAIC_AGENT_COMPACTION_ENABLED === 'true',
    contextBudgetTokens: numberFromEnv(
      process.env.OPENMAIC_AGENT_COMPACTION_CONTEXT_BUDGET,
      DEFAULT_COMPACTION_CONTEXT_BUDGET_TOKENS,
    ),
    ...(process.env.OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS
      ? {
          reserveTokens: numberFromEnv(process.env.OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS, 0),
        }
      : {}),
    ...(process.env.OPENMAIC_AGENT_COMPACTION_KEEP_RECENT_TOKENS
      ? {
          keepRecentTokens: numberFromEnv(
            process.env.OPENMAIC_AGENT_COMPACTION_KEEP_RECENT_TOKENS,
            0,
          ),
        }
      : {}),
  },
  /**
   * 默认「自学」还是「听课」—— 只决定 `generate_scene` 要不要生成讲稿。
   *
   * ── 为什么必须在服务端有一个默认值 ─────────────────────────────────
   *
   * 自学模式原先**只存在于提示词里**（见 study-mode.ts：「不要跑
   * generate_actions」）。但讲稿根本不是 agent 生成的 —— 是 `generate_scene`
   * **内部**自己调 `generateSceneActions` 写进去的（generation-tools.ts）。
   * 于是实测的结果是：agent 很听话地不去调 generate_actions，却被迫在每一页
   * 生成完之后，再用 `patch_stage` 把工具自己塞进去的旁白删掉。
   *
   * 一次真实会话实测（2026-10-05，28 页那节课）：
   *   · 162 次 generate_scene —— 79 个 slide 页 **100%** 都产出了动作，
   *     平均 13.2 条（含 speech）；quiz 页 16 次，平均 1.9 条；
   *   · 160 次 patch_stage —— 其中 36 次明写「移除自动生成的旁白与高亮」。
   * 也就是每一页都白花一次讲稿 LLM 调用，再花一次调用把它删掉。
   *
   * 提示词约束不住的东西，必须在代码里给默认值。
   *
   * `true` = 默认自学。部署层面记学习者的稳定偏好；单页可用
   * `generate_scene.selfStudy` 覆盖（比如某一页确实想听）。
   */
  selfStudyDefault: ['1', 'true', 'yes', 'on'].includes(
    (process.env.OPENMAIC_SELF_STUDY ?? '').trim().toLowerCase(),
  ),
  /** Directory skills are loaded from. Overridable so a deployment can mount its own set. */
  skillsDir: process.env.OPENMAIC_AGENT_SKILLS_DIR ?? `${process.cwd()}/skills/agent-runtime`,
  /**
   * Optional learner profile (Markdown) injected into every run's system prompt.
   *
   * 为什么是文件而不是一段 env 值：画像要经常改（补掌握度、改目标），而且它
   * 是给人读写的 Markdown。塞进 env 会让"改画像"变成"改配置 + 重启"。
   *
   * 注意两个不同的生命周期：
   *   · **路径**在模块加载时求值（跟这个文件里其它配置一样）—— 换路径要重启；
   *   · **内容**每次运行都重读 —— 改画像本身不用重启。
   */
  learnerProfilePath: process.env.OPENMAIC_LEARNER_PROFILE_PATH?.trim() || undefined,
  /**
   * 学习状态（机器写入的答题状态），**与画像分开的一个文件**。
   *
   * 为什么要分：画像由人写，状态由机器每次整体重写 —— 共用一个文件，一次刷新
   * 就会抹掉学习者手写的话。分工与生命周期见 `learner-state.ts` 头部。
   *
   * 缺省：画像同目录下的 `学习状态.md`（本部署 = `D:/文档/jelly_ware/个人数据/`）。
   * 所以**不配也能用**；要换地方才配这个。
   */
  learnerStatePath: process.env.OPENMAIC_LEARNER_STATE_PATH?.trim() || undefined,
  /**
   * Optional materials **folder** (not a single file) the agent maintains.
   *
   * 结构：`INDEX.md`（索引层，每次注入）+ 若干个主题文件（如 `dart-flutter.md`）。
   *
   * 为什么是文件夹：材料会越攒越多。全塞一个文件，读到后面既找不到重点、
   * 又会把上下文撑爆。索引层永远短小，需要哪个主题才读哪个文件。
   *
   * 跟 learnerProfilePath 同一套生命周期：**路径**加载时求值、**内容**每次运行
   * 重读。见 prompt-context-file.ts。
   */
  materialsDir: process.env.OPENMAIC_MATERIALS_DIR?.trim() || undefined,
  /** Audio/video upload safety ceiling; defaults to the same 50 MiB cap as documents/images. */
  maxUploadBytes: numberFromEnv(process.env.OPENMAIC_AGENT_MAX_UPLOAD_BYTES, 50 * 1024 * 1024),
  /** Document/image cap, aligned with the classic `/api/extract-document` route. */
  maxDocumentBytes: numberFromEnv(process.env.MATERIALS_MAX_DOCUMENT_BYTES, 50 * 1024 * 1024),
  /** Maximum number of active material records retained by one owner. */
  maxMaterialsPerOwner: numberFromEnv(process.env.MATERIALS_MAX_COUNT_PER_OWNER, 100),
  /** Maximum aggregate bytes across one owner's active material records. */
  maxMaterialBytesPerOwner: numberFromEnv(
    process.env.MATERIALS_MAX_TOTAL_BYTES_PER_OWNER,
    2 * 1024 * 1024 * 1024,
  ),
} as const;
