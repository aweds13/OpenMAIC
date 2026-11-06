# PBL 架构勘察（OpenMAIC 官方实现 · upgrade/v1.3.0）

勘察对象：`D:/文档/jelly_ware/program/OpenMAIC`，分支 upgrade/v1.3.0。勘察期间 HEAD 从 918b4f0d 前进到 b0aa6c87；`git diff --name-only 918b4f0d..b0aa6c87` 只有两个文件（AGENTS.md、复盘/已结案结论.md），**pbl 相关文件 0 个**，所以行号在两者下一致。
方法：只读静态读码 + `find`/`wc -l`/`grep`/`git grep`。未起任何服务（PG 5433 未监听），未跑测试，未跑 tsc。
所有行号取自上述工作树。

---

## 1. 一句话结论

官方 PBL 是「**一个 LLM 导师（Instructor）串行带一个学习者走完若干 microtask**」的单线程教学循环：多角色只是**数据容器**（`roles[]`、`threads[]`、`agent-tabs`），真正的调度器不存在；proficiency（学习者档位）引擎算得很细（三阶段 + EWMA + hysteresis + 冷却）但**从不显示给学习者**；运行时不落在课程文档里，而是折进 RuntimeStore 的 `kind='pbl'` 通用 runtime 会话，**课程文档只留设计模板**——这与「学习状态.md 只折 quizAttempt」的现有宿主链路**完全不连通**。

---

## 2. 目录与分层

### 2.1 `packages/@openmaic/generation/src/pbl/` —— 10 文件 4180 行

纯逻辑内核：无 React、无 IO、无 Next 依赖。

| 路径 | 行数 | 职责 |
|---|---:|---|
| `operations/kernel/engagement.ts` | 185 | engagement 事件账本（环缓冲，上限 500），纯函数 |
| `operations/kernel/proficiency.ts` | 893 | 学习者档位引擎：静态检测器、EWMA、hysteresis、retier 门 |
| `operations/kernel/progress.ts` | 969 | 推进状态机：startMicrotask / advanceMicrotask / completeRoleplayAct / continueAfterHandover / normalizeProjectRuntime |
| `operations/kernel/runtime-events.ts` | 130 | 运行时事件账本与 `recordEvent`（环缓冲） |
| `operations/kernel/task-completion.ts` | 191 | 任务完成闸：`TASK_EVAL_PASS_SCORE=60`、pending 暂存与清除 |
| `planner-core.ts` | 487 | planner 系统提示词、空项目、scenario 设计块、completion 缺口判定 |
| `planner-single-call.ts` | 578 | 单次调用版 planner（一次 LLM 出整份 projectV2） |
| `prompts/loader.ts` | 44 | 读 `packages/@openmaic/generation/prompts-pbl/` 下的 3 个 md |
| `readers.ts` | 4 | 只有一个 `trimmedPBLText` |
| `types.ts` | 699 | projectV2 全量类型 |

分块 = **3 块**：kernel（5 文件）、planner（planner-core + planner-single-call + prompts/loader）、types（types.ts + readers.ts）。
**没有 `runtime/`，没有 `agents/`** —— 这两块全在 app 侧。

### 2.2 `lib/pbl/` —— 44 文件 10238 行

应用层：LLM agent 编排、HTTP 路由、客户端水合/折叠/持久化。

| 路径 | 行数 | 职责 |
|---|---:|---|
| `legacy/read.ts` | 333 | legacy 判定 `resolvePBLContent`（v2 / legacy / empty）、legacy 升级 |
| `v2/agents/instructor.ts` | 1864 | 导师回合：系统提示词拼装 + 2 个工具 + prose 清洗 |
| `v2/agents/planner.ts` | 793 | 生成期 planner（多步工具调用版），`MAX_PLANNER_STEPS=80` |
| `v2/agents/simulator.ts` | 646 | 角色扮演时的角色/Narrator 发言 |
| `v2/agents/evaluator.ts` | 443 | 三档评估（task / milestone / final），无工具、只追加 `project.evaluations` |
| `v2/agents/tier-guidance.ts` | 103 | 按档位返回提示词块（纯字符串，无 LLM） |
| `v2/agents/instructor-memory.ts` | 149 | 长对话压缩（纯函数，无 LLM），`COMPRESS_THRESHOLD=30` |
| `v2/agents/planner-core.ts` | 15 | **barrel**：re-export 自 `@openmaic/generation` |
| `v2/agents/planner-single-call.ts` | 3 | **barrel**：`generatePBLV2ProjectSingleCall` |
| `v2/api/sse.ts` | 289 | SSE 事件联合与 `createSSEResponse`（heartbeat 15s） |
| `v2/api/locale.ts` | 21 | 按 `x-user-locale` 改 `project.language` |
| `v2/operations/kernel/engagement.ts` | 2 | **barrel**（见 2.3） |
| `v2/operations/kernel/proficiency.ts` | 2 | **barrel** |
| `v2/operations/kernel/progress.ts` | 2 | **barrel** |
| `v2/operations/kernel/runtime-events.ts` | 2 | **barrel** |
| `v2/operations/kernel/task-completion.ts` | 2 | **barrel** |
| `v2/operations/runtime/advance-patch.ts` | 239 | advance 结果跨服务端/客户端边界的整块 patch |
| `v2/operations/runtime/completion-stats.ts` | 522 | 完成度统计（standard / scenario 两个判别分支） |
| `v2/operations/runtime/dynamic-signals.ts` | 236 | 动态信号入口：trackObservation / trackSubmissionScore / applyProficiencyDirective / tickTurnOnProject |
| `v2/operations/runtime/eval-prompts.ts` | 569 | 评估 user 半提示词（装证据）+ 场景 transcript 格式化 |
| `v2/operations/runtime/eval-tail-parser.ts` | 246 | 唯一把 LLM 原文转 typed 值的地方（纯函数） |
| `v2/operations/runtime/evaluation.ts` | 88 | `addEvaluation` / list 两个查询 |
| `v2/operations/runtime/file-validation.ts` | 101 | 提交文件扩展名白名单（含 `TEXT_FILE_EXTENSIONS`） |
| `v2/operations/runtime/quiz-snapshot.ts` | 116 | 前置 quiz 快照 `buildQuizSnapshot` + 折进档位 `applyQuizSignalsToProject` |
| `v2/operations/runtime/schemas.ts` | 139 | 两个活跃工具的 zod schema（`record_observation` / `adjust_difficulty`）+ 历史 schema |
| `v2/operations/runtime/submission.ts` | 162 | `addSubmission`：文本/文件/链接挂到 microtask |
| `v2/operations/runtime/workspace-launch.ts` | 48 | hero→workspace 的启动事务（含竞态守卫） |
| v2/prompts/instructor-base-rules.md | 252 | 导师系统提示词 base 段 |
| v2/prompts/evaluator-task.md | 62 | task 评估 system 半 |
| v2/prompts/evaluator-milestone.md | 69 | milestone 评估 system 半 |
| v2/prompts/evaluator-final.md | 91 | final 评估 system 半（JSON 契约） |
| v2/prompts/evaluator-final-scenario.md | 107 | 场景版 final 评估 system 半 |
| v2/prompts/simulator-system.md | 23 | 角色 system 半 |
| v2/prompts/simulator-narrator-system.md | 20 | Narrator system 半 |
| `v2/prompts/loader.ts` | 43 | 读 `process.cwd()/lib/pbl/v2/prompts` |
| `v2/runtime/drain.ts` | 447 | 把 project 两个环缓冲 drain 进 RuntimeStore（`subAnchor` 在 :189） |
| `v2/runtime/fold.ts` | 382 | 从 runtime 记录折叠回 learner state |
| `v2/runtime/hydration.ts` | 377 | 读侧水合 + 自愈快照 |
| `v2/runtime/learner-state.ts` | 248 | `extractLearnerState` / `applyLearnerState` / `stripToDesignTemplate` |
| `v2/runtime/record-payloads.ts` | 227 | 三类 runtime record payload 定义 |
| `v2/runtime/document-persistence.ts` | 49 | 存文档前：先同步再剥离运行时 |
| `v2/runtime/clone.ts` | 3 | 只有 `structuredClone` 包装 |
| `v2/types.ts` | 699 | 与 packages 版逐字相同（见 2.3） |
| `v2/readers.ts` | 4 | 与 packages 版逐字相同 |

分块 = **7 块**：legacy / agents / api / operations-kernel / operations-runtime / prompts / runtime (+ types)。

### 2.3 packages 与 lib 的关系：barrel 与复制混用

| 位置 | 性质 | 证据 |
|---|---|---|
| `lib/pbl/v2/operations/kernel/*.ts`（5 个） | **barrel** | 每个 2 行：注释 + `export * from '@openmaic/generation/browser';` |
| `lib/pbl/v2/agents/planner-core.ts` | **barrel** | 15 行，全部 re-export 自 `@openmaic/generation` |
| `lib/pbl/v2/agents/planner-single-call.ts` | **barrel** | 3 行 |
| `lib/pbl/v2/types.ts` vs `packages/@openmaic/generation/src/pbl/types.ts` | **逐字复制** | 各 699 行，只差第 16 行 import：lib 版 `import type { SceneOutline } from '@/lib/types/generation';`，packages 版 `from '../outline-types.js';` |
| `lib/pbl/v2/readers.ts` vs packages 版 | **逐字复制** | 各 4 行，同一份 `trimmedPBLText` |
| `lib/pbl/v2/agents/*` 其余 6 个 + `operations/runtime/*` 11 个 + `runtime/*` 7 个 + `api/*` 2 个 | **lib 独有的真实现** | 文件本身不含 re-export |
| `packages/.../operations/kernel/*` 5 个 | **真实现** | lib 侧只是转出口 |

结论：**packages 侧是「可复用内核」（类型 + 纯逻辑），lib 侧是「应用层」**。但两者之间不是干净的一层 barrel：`types.ts` 与 `readers.ts` 是复制粘贴，改一边不会同步另一边。这是二开时最容易踩的地方。

### 2.4 DSL 层（`packages/@openmaic/dsl/src/`）

★ 先纠一个名字：**`PBLSceneConfig` 这个标识符在仓里不存在**（`git grep -n "PBLSceneConfig" -- '*.ts' '*.tsx'` 零命中）。真实名字是 **`PBLScenarioConfig`**（`packages/@openmaic/dsl/src/pbl.ts:95-102`）。

`PBLScenarioConfig` 字段清单（`dsl/src/pbl.ts:95-102`）：

```
setting: string
sceneVisual?: PBLSceneVisual      // caption/bg1/bg2/accent/motifs[]
goal?: string
rules?: string
learnerRole?: string
characters: PBLScenarioCharacter[]  // id/name/persona/situation?/boundaries?/avatar?/openingLine?
```

`SceneCore.multiAgent?` 的形状（`dsl/src/stage.ts:246` → `:134-141`）：

```ts
export interface MultiAgentConfig {
  enabled: boolean;
  agentIds: string[];       // 来自 agent registry
  directorPrompt?: string;  // 可选自定义导演指令
}
```

★ **这是死字段**：`git grep -n "multiAgent"` 在 `lib/` `components/` `app/` 下的命中只有导出/导入与 i18n 文案——`lib/export/classroom-zip-types.ts:126`（导出 DTO 定义）、`lib/export/use-export-classroom.ts:258-265`（导出时做 `agentIndices` 映射）、`lib/import/use-import-classroom.ts:501-532`（导入时反查回 agentIds）、`lib/edit/agent-roster.ts:33`（注释：保留原 id 以免 `scene.multiAgent.agentIds` 失效）、`components/settings/agent-settings.tsx:156`（只是文案）。**没有任何运行时/请求构造代码读它**。

`SceneType` 与 `Scene`（`dsl/src/stage.ts:22` / `:283-288`）：`SceneType = 'slide' | 'quiz' | 'interactive' | 'pbl'`；`Scene` 是 distributive conditional，把 `type` 绑到 `content`。`SceneContent` 在契约里只默认 `SlideContent | QuizContent`（`:226`），app 侧扩成 `AppSceneContent = DslSceneContent | InteractiveContent | PBLContent`（`lib/types/stage.ts:82`）。

---

## 3. 一次 PBL 场景的完整时序

### 阶段 0（不在场景内）：生成期写出一份 projectV2

1. 单页生成走到 pbl 分支：`lib/server/generation/steps/scene-content.ts:323` 在 `effectiveOutline.type === 'pbl'` 时把 `generatePBLV2Project(...)` 作为 `pblLoopFallback` 传下去。
2. planner 多步跑工具：`lib/pbl/v2/agents/planner.ts:95` `generatePBLV2Project`，7 个工具（`:266` set_project_info / `:333` add_role / `:390` add_milestone / `:460` add_microtask / `:536` mark_design_complete / `:581` set_scenario / `:674` set_scene_visual），`stopWhen: [plannerDesignAccepted(), stepCountIs(MAX_PLANNER_STEPS)]`（`:162`，`MAX_PLANNER_STEPS = 80` 在 `:76`）。
3. 档位不是 LLM 决定的：`emptyProject()`（`packages/@openmaic/generation/src/pbl/planner-core.ts:61`）在 `:76-83` 调 `computeInitialAssessment`，把 `assessment.tier` 写进 `project.proficiency`（`:84`）。注释 `:67-75` 原文：The Planner LLM does NOT decide this value: it consumes `assessment.tier` as a directive when dimensioning microtasks.
4. 落库前只做容器校验：`lib/document-store/validators.ts:86-109` 要求 `projectV2` 的 milestones/roles/threads 是数组，错误文案 `projectV2 must contain milestones, roles and threads arrays`。**不是逐字段 schema**。

### 阶段 1：打开页面

5. `components/stage/scene-renderer.tsx:41` → `<PBLRenderer content={scene.content} mode={mode} sceneId={scene.id} />`
6. `components/scene-renderers/pbl-renderer.tsx:38` 定义；`:44` `resolvePBLContent(content)`；`:47` legacy 走 `upgradeLegacyPBLConfigToProjectV2`；`:54` v2 挂 `PBLV2Container`（`:76`）。改内容时回调 `useStageStore.getState().updateScene(...)`。

### 阶段 2：hero 点开始

7. `components/scene-renderers/pbl/v2/hero.tsx:120-144` `handleStart`：
   - `:128` `const epoch = ++launchEpochRef.current;`（竞态守卫）
   - `:131` `const allScenes = useStageStore.getState().scenes;`
   - `:133` `const priorScenes = selfIdx >= 0 ? allScenes.slice(0, selfIdx) : [];`（只取本页**之前**的页）
   - `:135` `const priorQuizResults = await buildQuizSnapshot(priorScenes);`
   - `:138` `const ready = prepareCurrentWorkspaceLaunchProject(currentProjectRef, priorQuizResults);`
   - `:139-140` `onLaunchReady(ready)` 或 `onProjectChange(ready)`
8. `lib/pbl/v2/operations/runtime/workspace-launch.ts:29-40`：`transitionProjectUiPhase(project,'workspace')`，有 quiz 结果则写 `next.pendingOpenTaskPriorQuizResults`，否则 `delete`。
9. `lib/pbl/v2/operations/runtime/quiz-snapshot.ts:42-87` `buildQuizSnapshot`：只收 `scene.type === 'quiz'` 且 `state?.phase === 'reviewed'` 的页（`:53` 注释：reviewed means the learner has submitted AND seen the graded results）；无 `hasAnswer` 的简答题计入 `unscoredCount` 而不是错。

### 阶段 3：workspace 挂载 + 导师先开口

10. `components/scene-renderers/pbl/v2/chat.tsx:380-410` 空线程自动开场：`isRoleplay` → `:385` POST `/api/pbl/v2/simulator` `{phase:'greeting'}`；否则 `:396` POST `/api/pbl/v2/open-task` `{phase:'greeting', priorQuizResults}`（发之前先删掉 project 上的 pending 字段）。
11. `app/api/pbl/v2/open-task/route.ts:39` POST：`:47-52` 校验，`:56` `resolveModelFromRequest(req, body, 'pbl-v2-runtime:open-task')`，`:65` `applyRequestLocaleToProject`，`:72-81` greeting 且有 quiz 结果时 `applyQuizSignalsToProject(body.project, body.priorQuizResults)`，`:83-93` 起 SSE 跑 `runInstructorTurn`。
12. `lib/pbl/v2/agents/instructor.ts:1301` `runInstructorTurn`：`normalizeProjectRuntime` → `currentMicrotask`（无则 yield `NO_ACTIVE_MICROTASK` + done）→ instructing 时追加 user message + `recordEvent('learner_turn')` + `tickTurnOnProject` → `buildSystemPrompt`（`:803-876`）→ `buildHistoryMessagesForInstructor`（`:882`，slice(-24)）→ LLM 循环（`MAX_INSTRUCTOR_STEPS = 7`，`:61`）。

### 阶段 4：一个 turn 里到底发生什么

13. **prompt 怎么拼**（`:853-873`，`.filter(Boolean).join('\n\n---\n\n')`，顺序即优先级）：
    1. instructor-base-rules.md（`:810` 加载，252 行）
    2. `## Your persona` + `instructor.systemPrompt`（`:849-851`）
    3. projectBlock
    4. milestoneBlock
    5. microtaskBlock
    6. submissionBlock
    7. priorSubmissionsBlock（`:251`）
    8. tierBlock = `tierGuidanceBlock(project.proficiency)`（`:826`）
    9. phaseBlock = `PHASE_BLOCKS[args.phase]`（`:838`）
    10. firstTaskWorkspaceOrientationBlock（`:839`，`:573`）
    11. scenarioAwarenessBlock（`:843-847`，`:683`）
    12. runtimeBrief（`:818`，`:498`）
    13. synthesisBlock（`:837`，仅 instructing 且 `stageSynthesisOwed`）
    14. buildAnchor(microtask)
    15. buildHardRulesBlock(project)
    注释 `:868-871` 说明 hard rules 放最后是为了拿 positional recency，压过 200 行 base。

14. **agent 怎么选**：没有选择。`runInstructorTurn` 只走 Instructor 一个角色；角色扮演阶段由 `simulator` 路由走 `runSimulatorTurn`。两者由**客户端**按 `isRoleplay` 二选一（`chat.tsx:497-509`），服务端不调度。
15. **信号怎么采**：Instructor 只有两个工具（`:1422-1490`）——
    - `record_observation`：先查同 microtask 同 signature 是否重复（`repeatedError`），再 `trackObservation(project, kind, { repeat })`
    - `adjust_difficulty`：`applyProficiencyDirective(project, proficiencyDirectiveFromTarget(target))`
    注释 `:1419-1420` 明说：record_observation 是分析性学习事件，**never gates advance**。
16. **写进哪里**：`project.runtimeEvents` 与 `project.engagementEvents` 两个 500 条环缓冲（`MAX_ENGAGEMENT_EVENTS = 500`，`packages/.../kernel/engagement.ts:28`）。**不写 localStorage、不直接写 DB**——由 drain（阶段 7）送进 RuntimeStore。

### 阶段 5：学习者发消息

17. `chat.tsx:485-510` `handleSend`：`:495` `appendUserMessage(project, activeAgentId, text, microtaskId)` 乐观追加 + `onProjectChange`（注释 `:489-493`：服务端故意不回显 user message，所以这个乐观追加是唯一真相源）→ `:497` 若是 roleplay 走 `:499` simulator，否则 `:506` instructor。
18. 场景阶段切换另有一条 effect：`chat.tsx:414-460`，当前 milestone 的 `scenarioStage === 'roleplay'` → `:450` simulator greeting；`'wrapup'` → `:451` open-task `{phase:'setup'}`。

### 阶段 6：提交作品 → 评估 → 推进

19. `components/scene-renderers/pbl/v2/submission.tsx:505` POST `/api/pbl/v2/evaluate`，body `{project, kind:'task', milestoneId, microtaskId}`。
20. `app/api/pbl/v2/evaluate/route.ts:56` POST：`:67-79` 校验 kind ∈ task|milestone|final，`:83` resolveModel，`:91` `hasVision = !!modelInfo?.capabilities?.vision`，`:93/:108/:122` 三个分支各起一条 SSE。
21. 评估器不出工具、不改 midway：`lib/pbl/v2/agents/evaluator.ts:27-32` 头注释原文 No tool calls. The evaluator does not modify the project mid-stream; it only appends to `project.evaluations` once, at the end, after the JSON tail parses.
22. LLM 原文转 typed 值只有一处：`lib/pbl/v2/operations/runtime/eval-tail-parser.ts`（纯函数、无 IO，复用 `parseJsonResponse`）。
23. 分数回灌档位：`use-instructor-stream.ts:200` `trackSubmissionScore(workingProject, newest.score)`。
24. 评估链顺序 task → milestone → final，每段独立 SSE 往返：`use-instructor-stream.ts:174-242`（task `:175-203`、milestone `:205-225`、final `:227-242`）。头注释 `:1-48` 原文要点：Milestone / final do NOT feed the engine — their stars are vibes, not measurements.
25. 谁决定要不要评估：**服务端打标，客户端照跑**。`lib/pbl/v2/operations/runtime/advance-patch.ts:67` `shouldEvaluateMilestone: args.milestoneCompleted && !project.scenario`；`:68` `shouldEvaluateFinal: args.projectCompleted`。
26. 纯状态推进（无 LLM）：`app/api/pbl/v2/task/update/route.ts:46` POST，5 个 action —— `start`(`:60-66`)、`continue_handover`(`:67-73`)、`complete_pending_task`(`:74-109`)、`enter_scenario`(`:118-139`)、`complete_act`(`:147-156`)；default 回 `Unknown action: ...`。头注释 `:1-18` 原文：No LLM involvement. Stateless.
27. 完成闸：`packages/.../kernel/task-completion.ts:18` `TASK_EVAL_PASS_SCORE = 60`，`:20-26` `taskEvaluationCanComplete` = `kind==='task' && typeof score==='number' && score >= 60`。过闸后 `setPendingTaskCompletion`(`:53`) 写 `pendingTaskCompletion` + `task_completion_staged` 事件，`appendTaskCompletionReadyMessage`(`:121`) 按语言发 6 语种提示（`taskCompletionReadyText` `:86-102`：zh-CN/en-US/zh-TW/ja-JP/ru-RU/ar-SA）。

### 阶段 7：持久化（这是本勘察最关键的一段）

28. 存文档前先同步：`lib/pbl/v2/runtime/document-persistence.ts:14` `preparePBLScenesForDocumentPersistence` —— 对每个 pbl v2 场景先 `synchronizePBLProjectRuntime`，再把 `projectV2` 换成 `stripToDesignTemplate(...)`。
29. 调用点 4 处：`lib/store/stage.ts:162`（单页）与 `:900`（整课保存）、`lib/utils/stage-storage.ts:360`、`lib/export/use-export-classroom.ts:149`、`lib/legacy-browser-import/course.ts:150`。
30. `stripToDesignTemplate`（`lib/pbl/v2/runtime/learner-state.ts:126-178`）清掉：`uiPhase='hero'`、`status='active'`、`submissions=[]`、`evaluations=[]`、`engagementEvents=[]`、`proficiencyAssessment=undefined`、`runtimeEvents/runtimeResetEpoch/pendingHandover/pendingTaskCompletion/pendingOpenTaskPriorQuizResults=undefined`、所有 `thread.messages=[]`、milestone 只留第一个 `'active'` 其余 `'locked'` 并清 `internalAssessment`、microtask 全 `'todo'` 且清 `internalAssessment/completionReason/engagement`。`proficiency` 由 `transitions[0].from` 恢复成作者写的档。
31. 读侧水合：`lib/store/stage.ts:1072` `await hydratePBLScenesFromRuntime(stageId, data.scenes.map(migrateScene))`（定义在 `hydration.ts:330`）。
32. `synchronizePBLProjectRuntime`（`hydration.ts:183-231`）：在 `withRuntimeStorageSharedLockUntilSettled` + `withPBLRuntimeTransaction(store, \`${stageId}:${sceneId}:${learnerKey}\`)` 里先 drain，再比 `folded.learnerState` 与 `extractLearnerState(project)`；只有 `runtimeIsCurrent && cutoverStarted` 才直接返回，否则 `appendPBLRuntimeSnapshotIfChanged({reason: cutoverStarted ? 'self_heal' : 'write_cutover'})`。

### 阶段 8：完成页

33. `components/scene-renderers/pbl/v2/completion.tsx`（729 行）渲染 `computeCompletionStats(project)` 的结果。
34. `lib/pbl/v2/operations/runtime/completion-stats.ts:124` `computeCompletionStats`，`:129` 一行 fork `project.scenario ? computeScenarioStats : computeStandardStats`。

---

## 4. 多 agent 协作机制

### 4.1 8 个「agent」文件逐一（★ 只有 4 个真会调 LLM）

| 文件 | 行数 | 是否是 LLM agent | 职责 | 输入 | 输出 | 谁触发 |
|---|---:|---|---|---|---|---|
| `agents/instructor.ts` | 1864 | **是** | 导师回合：讲、问、记观察、调难度 | `PBLProjectV2` + phase + 最近 24 条历史 | SSE：token / project_patch / error | `POST /api/pbl/v2/open-task`、`POST /api/pbl/v2/instructor` |
| `agents/planner.ts` | 793 | **是** | 生成期把大纲变成 projectV2 | 大纲 + 语言 + 模型 | 7 个工具的累积结果 | `lib/server/generation/steps/scene-content.ts:323`（生成期，非运行时） |
| `agents/simulator.ts` | 646 | **是** | 角色扮演阶段按 cast 发言 + Narrator 旁白 | `project.scenario` + 当前 roleplay act | SSE：message / sim_phase | `POST /api/pbl/v2/simulator` |
| `agents/evaluator.ts` | 443 | **是**（无工具） | task / milestone / final 三档打分与反馈 | 提交物 + 会话 + engagement 遥测 | SSE：token + 一条 `evaluation` patch | `POST /api/pbl/v2/evaluate` |
| `agents/tier-guidance.ts` | 103 | 否（纯字符串） | 按档位返回教学提示词块（L0–L3 disclosure ladder） | `PBLProficiency` | 一段 markdown | 被 instructor 在 `:826` 调用 |
| `agents/instructor-memory.ts` | 149 | 否（纯函数） | 长对话压缩成 earlierSummary | messages | 压缩后的 messages | 被 instructor 调用 |
| `agents/planner-core.ts` | 15 | 否（barrel） | re-export packages 的 planner 公共面 | — | — | import |
| `agents/planner-single-call.ts` | 3 | 否（barrel） | re-export 单次调用版 planner | — | — | import |

结论：**「8 个 agent」是 8 个文件，不是 8 个会说话的角色**。真正并发/独立存在的角色只有 Instructor 与 Simulator，且二者**互斥**（按 `isRoleplay` 二选一），Planner 只在生成期跑，Evaluator 只在评估期跑。

### 4.2 有 orchestrator 吗？没有

- `grep -rn "orchestrat|roundtable|round-table|round_robin|multiAgent|speakingOrder|turnOrder" lib/pbl --include=*.ts --include=*.tsx --include=*.md` → **零命中**。
- 角色身份靠临时查找，没有注册表：Instructor 线程是 `project.threads.find(t => project.roles.find(r => r.id === t.agentId)?.type === 'instructor')`（`instructor.ts:1340-1343` / `:1383-1386`）；Simulator 是常量 `export const PBL_SIMULATOR_AGENT_ID = 'simulator'`（`packages/.../kernel/progress.ts:47`），且 `:41-46` 注释说明它是**合成成员 id、不是 roles[] 记录**，cast 存在 `project.scenario.characters`。
- `normalizeProjectRuntime(project)`（`progress.ts:75`）只做补座位：`:83` normalizeScenario → `:85-89` 补 instructor thread → `:95-98` 补 simulator thread（仅 scenario 项目）。
- 多 agent 的容器做了一半：`components/scene-renderers/pbl/v2/agent-tabs.tsx:45` `const agents = useMemo(() => project.roles.filter((r) => r.type !== 'user'), [project.roles]);`、`:59` `const showTabsBar = agents.length > 1;` —— 注释 `:10-14` 自认 single-agent projects (the norm today, with just the Instructor) skip the header bar entirely。**当前产品只有一个 Instructor，所以 tab 条永不显示**。`RoleIcon`（`:99-112`）只映射 instructor/evaluator/mentor/collaborator 四种。

### 4.3 role-play 分支（`instructor.ts:667` 附近，实为 `:666-801`）

`buildScenarioAwarenessBlock` 是「场景感知块」，注入 Instructor 系统提示词。

**触发条件三条全满足**（`:688-693`），否则返回空串（普通项目提示词逐字不变）：

```ts
const scenario = args.project.scenario;
if (!scenario) return '';
const characters = scenario.characters ?? [];
if (characters.length === 0) return '';
const roleplayMilestones = args.project.milestones.filter((m) => m.scenarioStage === 'roleplay');
if (roleplayMilestones.length === 0) return '';
```

**三阶段分工**（头注释 `:666-682` 原文要点）：
- `prep`：讲前提 + cast，然后交接（不评估、不反问、confirm-to-advance）
- `roleplay`：Simulator 拥有，Instructor 不跑，且**绝不冒充角色**
- `wrapup`：简短、有数据支撑的反馈 + 邀请提问；细节在完成页

**具体做什么**：
- `prep` 且 greeting/setup（`:724` `:726`）：要求一长篇格式化 briefing，8 段强制结构（`:739-752`），其中 rules 段由 `scenario.rules` 是否非空决定（`:732-735`）
- `prep` 且非开场（`:762-767`）：只答 setup 提问
- `wrapup`（`:769`）：先注入 `formatScenarioTranscript(args.project)` 的真实 transcript（`:775-777`），再要求零提问收尾（`:788-790` HARD RULES 原文：Do NOT ask the learner ANY question of any kind）
- `roleplay`（`:792-798`）：只说一句「场景由角色演，你别冒充 {names}」
- 截断：persona > 140 截断（`:699`）、situation > 160 截断（`:700`）

**服务端硬门（角色扮演不会空转）**：`completeRoleplayAct`（`progress.ts:652`）要求 `currentMilestone().scenarioStage === 'roleplay'`（`:659`），且该 act 至少有一条 `roleType === 'user'` 且 `microtaskId ∈ act.beatIds` 的 simulator 线程消息（`:673-678`），否则 `{ok:false, error:'act_not_engaged'}`。

### 4.4 有「圆桌 / 多角色轮流发言」吗？

**PBL 里没有。** 圆桌能力在**另一条完全独立的链**上（chat 层，不是 PBL）：

| 位置 | 行数 | 是什么 |
|---|---:|---|
| `components/roundtable/index.tsx` | 2332 | 圆桌 UI（`RoundtableProps.sessionType?: 'qa' \| 'discussion'`，`:57`） |
| `lib/chat/pi/director-loop.ts` | 303 | `export async function runPiDirectorLoop(opts)`（`:31`） |
| `lib/chat/pi/prompts.ts` | 618 | `buildDirectorPrompt(body, agents, maxAgentTurns)`（`:70`） |
| `lib/chat/pi/tools/call-agent.ts` | — | `CallAgentParams = { agentId: string; instruction: string }` |
| `lib/chat/pi/config.ts` | 46 | `DEFAULT_PI_MAX_AGENT_TURNS = 6` / `MAX_PI_MAX_AGENT_TURNS = 6` / `DEFAULT_PI_MAX_ACTIONS_PER_AGENT = 8` / `MAX_PI_MAX_ACTIONS_PER_AGENT = 8`（`:6-9`） |
| `app/api/chat/pi/route.ts` | — | `:314` `await runPiDirectorLoop({...})`（唯一生产调用方） |

**机制**：由**LLM 当导演**点名发言。`buildDirectorPrompt` 原文要点：You are the director of an in-class multi-agent classroom. → 导演用 `call_agent` 挑人，每轮只能用一个终止工具 `cue_user` 或 `close_session`；You may call at most ${maxAgentTurns} classroom agent turns；Prefer 1-2 classroom agents; do not call more agents just to fill the budget；`cue_user` and `close_session` are mutually exclusive。工具调用预算 `director-loop.ts:77` `const maxDirectorToolCalls = Math.max(opts.maxAgentTurns * 3, opts.maxAgentTurns + 3);`

**与 PBL 的关系：零。** `chat.tsx:1138` 出现 "roundtable" 只是因为注释里提到复用 `DEFAULT_TEACHER_AVATAR` 头像常量，PBL 的聊天是自绘的，不挂 roundtable 组件。

### 4.5 调度图

```
生成期（一次性，离线）
  大纲 ──► lib/server/generation/steps/scene-content.ts:323
              └─► planner.ts:95 generatePBLV2Project  [LLM, ≤80 步, 7 工具]
                     └─► projectV2 ──► document_scenes.data.content.projectV2
                                        （validators.ts:86-109 只校验容器是数组）

运行期（HTTP 请求驱动，无中央调度器）
  浏览器 chat.tsx:497
    ├─ isRoleplay ──► POST /api/pbl/v2/simulator ──► simulator.ts:381 runSimulatorTurn [LLM]
    └─ 否则      ──► POST /api/pbl/v2/instructor ─► instructor.ts:1301 runInstructorTurn [LLM]
                         ├─ tier-guidance.ts:98 （纯字符串）
                         └─ instructor-memory.ts:36 （纯函数）
  浏览器 submission.tsx:505
    └──────────────► POST /api/pbl/v2/evaluate ───► evaluator.ts:330/382/414 [LLM，无工具]
  浏览器 workspace.tsx:148 / chat.tsx:218
    └──────────────► POST /api/pbl/v2/task/update ─► progress.ts（纯状态机，无 LLM）
  浏览器 chat.tsx:396
    └──────────────► POST /api/pbl/v2/open-task ──► instructor.ts:1301（phase=greeting|setup）
```

调度权全部在**客户端的时间点 + 服务端的 patch 标记**（`advance-patch.ts:67-68`），中间没有任何 agent 之间的协商。

---

## 5. 证据与评估体系

### 5.1 三类证据

| 阶段 | 数据来源 | 字段 | 落点 | 触发时机 |
|---|---|---|---|---|
| **planner（静态）** | 大纲 / 前序场景 / 用户 bio / 用户自述档位 / 前置 quiz | `ProficiencySignal{kind, direction, weight, note, ts}`，kind ∈ outline_keyword / prior_scene_difficulty / user_bio / user_level_explicit / quiz_accuracy | `project.proficiencyAssessment.signals`（append-only，上限 50，`MAX_SIGNAL_HISTORY = 50`） | `emptyProject()`（`planner-core.ts:61`）→ `computeInitialAssessment`（`proficiency.ts:673-703`） |
| **pre-play（开场前 quiz 快照）** | 本页之前所有 `type==='quiz'` 且 `phase==='reviewed'` 的页 | `PriorQuizResult{sceneId, sceneTitle, totalQuestions, correctCount, incorrectCount, unscoredCount, accuracy}` | 同上，追加一条 `quiz_accuracy` signal + `proficiency_updated` runtime event | `hero.tsx:135` 建快照 → `workspace-launch.ts:35` 暂存 → `open-task/route.ts:72-81` 在 greeting 时折入 |
| **dynamic（运行时每 turn）** | Instructor 的 `record_observation` 工具、提交分数、关闭检查、强制推进 | kind ∈ submission_score / task_speed / help_request / concept_confusion / self_correction / force_advance / closing_check_quality | 同上 + `PBLEngagementEvent`（11 种 kind，`types.ts:191-211`） | `dynamic-signals.ts:100/112/122/132/163/191/230` |

动态信号的进入点（`dynamic-signals.ts` 导出）：`trackObservation(:100)`、`trackClosingCheck(:112)`、`trackForceAdvance(:122)`、`trackMicrotaskCompletion(:132)`、`trackSubmissionScore(:163)`、`applyProficiencyDirective(:191)`、`tickTurnOnProject(:230)`。头注释 `:1-27` 四步说明：建信号 → `updateProjectAssessment`（EWMA + retier 门）→ tier 变了追加 `proficiency_changed` engagement 事件 → 返回 SSE patches；末尾原文 **No UI side-effect by design.**

`record_observation` 四 kind → signal 的映射（`proficiency.ts:484-522`）：`error` → concept_confusion（repeat ? -0.7 : -0.4，repeat 才满权重否则 ×0.7）、`concept_unlocked` → self_correction（+0.5）、`struggle` → concept_confusion（-0.5，×0.8）、`question` → help_request（-0.3，×0.7）。`signalFromClosingCheck`（`:524-`）：weak -0.6 / strong +0.6 / ok 0（ok 仍计权重与信号数）。

### 5.2 `PBLProficiencyAssessment` 完整字段（`lib/pbl/v2/types.ts:400-429`）

| 字段 | 类型 | 注释原文要点 |
|---|---|---|
| `tier` | `PBLProficiency` | Current bucket — derives Instructor guidance block. |
| `score` | `number` | `[-1,+1]`；`< -0.33` beginner / `-0.33 ≤ s ≤ +0.33` intermediate / `> +0.33` advanced；离开要过反向 ±0.20（`:403-409`） |
| `confidence` | `number` | `[0,1]`；cannot cross a boundary while confidence < 0.4（`:411-413`） |
| `source` | `ProficiencyAssessmentSource` | `'planner' \| 'pre-play' \| 'dynamic' \| 'self-report'`（`:379`） |
| `signals` | `ProficiencySignal[]` | Append-only，bounded to the most recent 50（`:415-416`） |
| `lastUpdatedAt` | `string` | ISO |
| `transitions` | `ProficiencyTransition[]` | 首次切换前为空 |
| `dynamicSignalsSinceRetier` | `number` | 最小信号门，防止一条异常观测就翻档（`:421-424`） |
| `turnsSinceRetier` | `number` | 冷却，防止每隔一条消息就振荡（`:425-428`） |

### 5.3 四份评估 prompt 各自做什么

| 文件 | 行数 | 做什么 |
|---|---:|---|
| lib/pbl/v2/prompts/evaluator-task.md | 62 | 评 microtask 的提交物。硬规则第 1 条是语言必须与 `{{language}}` 一致；有历史 task 评估时只当 revision history，只评最新提交 |
| lib/pbl/v2/prompts/evaluator-milestone.md | 69 | 写「里程碑反思卡」，不是考试分数。要引用该阶段真实发生的事，证据来自 engagement 信号 |
| lib/pbl/v2/prompts/evaluator-final.md | 91 | 整门 PBL 的完成报告。输出严格 JSON：`{"feedback","stars","what_you_built":[...],"what_you_learned":[...],"whats_next"}`（`:15-16`）；feedback 只 2-3 句、不得重复 bullets；若「Integrative checks (stage synthesis)」段有学习者回答，优先拿它当 standout moment；禁 markdown fence |
| lib/pbl/v2/prompts/evaluator-final-scenario.md | 107 | 场景版的 final，多一层 act goal 覆盖判定 |

user 半由 `eval-prompts.ts` 拼：`buildTaskEvalPrompt(:62)` / `buildMilestoneEvalPrompt(:135)` / `buildFinalEvalPrompt(:518)`，装配 `formatProjectEngagementRollup(:224)`、`formatProjectSynthesisChecks(:334)`、`formatScenarioTranscript(:417)`、`buildScenarioFinalUser(:445)`。

### 5.4 `quiz-snapshot.ts` / `completion-stats.ts` / `dynamic-signals.ts`

- **`quiz-snapshot.ts`（116 行）**：`buildQuizSnapshot(scenesBeforePbl)`（`:42-87`）从 RuntimeStore 读前置 quiz 的答题记录，只收 `phase==='reviewed'`；`applyQuizSignalsToProject(project, results)`（`:94-116`）折进档位，tier 变了同步 `project.proficiency` 并发 `proficiency_updated` 事件。
- **`completion-stats.ts`（522 行）**：见 5.5。
- **`dynamic-signals.ts`（236 行）**：见 5.1。

### 5.5 「完成」判定怎么算

`computeCompletionStats(project): CompletionStats`（`completion-stats.ts:124`）在 `:129` 一行分叉，返回判别联合 `kind: 'standard' | 'scenario'`（`:24`）。

**StandardCompletionStats**（`:28-51`）：`conceptsUnlocked` / `independenceRate` / `totalErrors` / `totalTurns` / `totalDurationSeconds` / `totalSubmissions` / `toughestMilestone` / `stageDetails` / `highlights`。

**ScenarioCompletionStats**（`:55-85`）：`sceneCaption?` / `characterNames` / `acts{completed,total}` / `totalTurns` / `totalDurationSeconds` / `goalCoverage?` / `goalScaffold?`（后两者互斥）。

**阈值全是 inline 字面量，没有具名常量**：

| 判据 | 源码 | 行号 |
|---|---|---|
| 「最难里程碑」需该 milestone 错误数 | `if (errors >= 3 && errors > (best?.errors ?? 0))` | `:425` |
| 独立性 highlight 需证据数 ≥2 且解锁率 ≥60% | `if (totalEvidence >= 2 && unlocks / totalEvidence >= 0.6)` | `:499` |
| 韧性 highlight 需至少 1 个错误 | `if (totalErrors >= 1)` | `:508` |
| 都没有则 fallback | `highlights.push({ kind: 'completion' })` | `:517-518` |

`independenceRate` 定义（`:163`）：`unlocks + checks > 0 ? unlocks / (unlocks + checks) : 0`，即 `concept_unlocked` 证据数 /（`concept_unlocked` + `closing_check` + `stage_synthesis_check`）。`countEvidenceEvents`（`:385-403`）只从 engagement 缓存算（注释 `:388-393`：从 ledger 再算会双计，压低 independenceRate）。

场景侧的 goal 对齐是硬门：`scenarioActGoalsScaffold(:176)` 只取 `scenarioStage==='roleplay'` 的 milestone，goal 取 `successWhen || completionCriteria`（`:182`）；`normalizeActGoals(:211)` 要求 LLM 给的 goals 数量**等于** scaffold 该 act 的数量（`:239`），否则整块 `undefined`。

### 5.6 关键常量表（名字 = 值，逐条带文件:行号）

| 常量 | 值 | 位置 |
|---|---|---|
| `EWMA_ALPHA` | `0.2` | `packages/@openmaic/generation/src/pbl/operations/kernel/proficiency.ts:60` |
| `CONFIDENCE_GAIN` | `0.5` | 同上 `:64` |
| `MAX_SIGNAL_HISTORY` | `50` | 同上 `:68` |
| `TIER_BOUNDS` | `{enterAdvanced: 0.5, leaveAdvanced: 0.2, enterBeginner: -0.33, leaveBeginner: -0.2}` | 同上 `:73-86` |
| `MIN_CONFIDENCE_FOR_RETIER` | `0.4` | 同上 `:87` |
| `MIN_DYNAMIC_SIGNALS` | `3` | 同上 `:91` |
| `RETIER_COOLDOWN_TURNS` | `5` | 同上 `:95` |
| `DEFAULT_TIER` | `'intermediate'` | 同上 `:105` |
| `SHRINK_K` | `0.7` | 同上 `:642` |
| `WEIGHT_CAPS.outline_keyword` | `0.5` | 同上 `:127-140` |
| `WEIGHT_CAPS.prior_scene_difficulty` | `0.4` | 同上 |
| `WEIGHT_CAPS.user_bio` | `0.5` | 同上 |
| `WEIGHT_CAPS.user_level_explicit` | `1` | 同上 |
| `WEIGHT_CAPS.quiz_accuracy` | `0.5` | 同上 `:132` |
| `WEIGHT_CAPS.submission_score` | `0.5` | 同上 |
| `WEIGHT_CAPS.task_speed` | `0.3` | 同上 |
| `WEIGHT_CAPS.help_request` | `0.35` | 同上 |
| `WEIGHT_CAPS.concept_confusion` | `0.45` | 同上 |
| `WEIGHT_CAPS.self_correction` | `0.4` | 同上 |
| `WEIGHT_CAPS.force_advance` | `0.3` | 同上 |
| `WEIGHT_CAPS.closing_check_quality` | `0.4` | 同上 |
| `TASK_EVAL_PASS_SCORE` | `60` | `packages/.../kernel/task-completion.ts:18` |
| `MAX_ENGAGEMENT_EVENTS` | `500` | `packages/.../kernel/engagement.ts:28` |
| `PBL_SIMULATOR_AGENT_ID` | `'simulator'` | `packages/.../kernel/progress.ts:47` |
| `SCENARIO_SCHEMA_VERSION` | `1` | `packages/@openmaic/generation/src/pbl/planner-core.ts:20` |
| `MAX_SYNTHESIS_STAGES` | `2` | 同上 `:404` |
| `MAX_INSTRUCTOR_STEPS` | `7` | `lib/pbl/v2/agents/instructor.ts:61` |
| `MAX_HISTORY_MESSAGES`（instructor） | `24` | 同上 `:62` |
| `MAX_PLANNER_STEPS` | `80` | `lib/pbl/v2/agents/planner.ts:76` |
| `MAX_HISTORY_MESSAGES`（simulator） | `300` | `lib/pbl/v2/agents/simulator.ts:58` |
| `COMPRESS_THRESHOLD` | `30` | `lib/pbl/v2/agents/instructor-memory.ts:23` |
| `KEEP_RECENT` | `16` | 同上 `:26` |
| `MAX_EARLIER_SUMMARY_CHARS` | `4500` | 同上 `:29` |
| `PBL_RUNTIME_PAYLOAD_VERSION` | `1` | `lib/pbl/v2/runtime/record-payloads.ts:19` |
| `PBL_DRAIN_TIMEOUT_MS` | `10_000` | `lib/pbl/v2/runtime/drain.ts:29` |
| `PBL_DRAIN_CHAIN_HARD_CAP_MS` | `PBL_DRAIN_TIMEOUT_MS * 2` | 同上 `:30` |
| `WATERMARK_SCOPE` | `'device'` | 同上 `:32` |
| SSE `heartbeatMs` 默认 | `15_000` | `lib/pbl/v2/api/sse.ts:215` |
| `DEFAULT_PI_MAX_AGENT_TURNS` | `6` | `lib/chat/pi/config.ts:6` |
| `MAX_PI_MAX_AGENT_TURNS` | `6` | 同上 `:7` |
| `DEFAULT_PI_MAX_ACTIONS_PER_AGENT` | `8` | 同上 `:8` |
| `MAX_PI_MAX_ACTIONS_PER_AGENT` | `8` | 同上 `:9` |

### 5.7 档位引擎的实际数学（补齐「三阶段」细节）

- 静态批次不是 EWMA，是**加权平均 × shrinkage**：`aggregateSignals`（`proficiency.ts:610-668`）里 `const shrink = weightTotal / (weightTotal + SHRINK_K);`（`:650`），`confidence = shrink`（`:655`）。标定表注释 `:633-641`：quiz 100% → 1.0 × (0.5/1.2) ≈ 0.42 → 仍 intermediate（因为 `enterAdvanced = 0.5`）。
- 动态单条是 **EWMA**：`applySignal`（`:711-726`）`const contribution = signal.direction * signal.weight;`、`newScore = clamp(0.2 * contribution + 0.8 * current.score, -1, 1)`、`newConfidence = clamp(current.confidence + signal.weight * 0.5, 0, 1)`，signals 追加后 `slice(-50)`。
- retier 门（`:743-760`）：同 tier → `'same tier'`；`confidence < 0.4` → `'low confidence'`；**只有 `source === 'dynamic'`** 才查 min-signal 门（`< 3` 回 `'min-signal gate'`）与冷却（`< 5` 回 `'cooldown'`）；否则 `{switch:true, newTier:desired, reason:'crossed bucket boundary'}`。
- `scoreToTier`（`:160-174`）是 hysteresis 的实现：当前 beginner 只要 `score > -0.2` 就回 intermediate；当前 advanced 只要 `score < 0.2` 就回 intermediate；当前 intermediate 要 `> 0.5` 才进 advanced、`< -0.33` 才进 beginner。
- `applyQuizAccuracy`（`:453-477`）：只用 `correctCount + incorrectCount` 当分母（`unscored` 不计），`direction = clamp((accuracy - 0.5) * 2, -1, 1)`，weight 取 `WEIGHT_CAPS.quiz_accuracy`。
- `reseatAssessmentTier` 会把 score 硬设成 `advanced ? 1 : beginner ? 0 : -1`（`:440`），并清零两个计数器。
- `applyPlannerProficiency`（`planner-core.ts:296-317`）：若 `assessment?.signals[0]?.kind === 'user_level_explicit'` 则**锁定**，不吃 LLM 覆盖（`:302-304`）。

---

## 6. 与 DSH 宿主的接口面

### 6.1 E14：PBL 产出会不会进「学习状态.md」？—— 不会

`lib/server/agent-runtime/learner-state.ts`（299 行）全文 `grep -n "pbl\|PBL"` **零输出**。它的 SQL 只查 quiz：

```sql
SELECT s.id, s.stage_id, s.status, s.created_at, s.learner_key
  FROM runtime_sessions AS s
  JOIN stage_meta AS m ON m.stage_id = s.stage_id
 WHERE s.kind = 'quizAttempt'
   AND m.owner_id = $1
   AND m.deleted_at IS NULL
   AND ($2::text IS NULL OR s.learner_key = $2)
 ORDER BY s.created_at
```

（`learner-state.ts:145-156`；`:183` 再 `SELECT data FROM runtime_records WHERE session_id = ANY($1::text[]) ORDER BY session_id, seq`。）

PBL 的会话 kind 是 `'pbl'`，**不在这条 SQL 的过滤条件里**，所以 PBL 的档位、证据、完成度一个字都不会进学习状态.md。

PBL 的「评估出口」是它自己的完成页：`computeCompletionStats(project)` → `completion.tsx`（729 行）渲染；`PBLEvaluation` 里 `kind==='final'` 的结构化字段 `whatYouBuilt / whatYouLearned / whatsNext / actGoals`。**这些全在浏览器内存 + RuntimeStore 里，没有落成任何人类可读文件。**

### 6.2 E15：PBL 暴露成 agent 工具了吗？—— 没有

`lib/server/agent-runtime/` 下 **没有任何 pbl 专属工具文件**。`grep -rn "pbl" lib/server/agent-runtime/*.ts` 的命中全是「场景类型」层面的：

| 位置 | 内容 |
|---|---|
| `course-outline-union.ts:80` | `const OUTLINE_TYPES = new Set<SceneOutline['type']>(['slide','quiz','interactive','pbl']);` |
| `course-outline-write.ts:50` | `entry.pblConfig ?? null` |
| `dsl-tools.ts:260-268` | `read_stage` 对 pbl 页只回 `{roles, milestones, microtasks}` 三个计数 |
| `dsl-tools.ts:402-424` | `textScene()` 对 `content.type==='pbl' && content.projectV2` 只摊 title/description/learningObjective/gains/roles[].name/milestones[].{title,description,briefing,debrief}/microtasks[].{title,description,learnerBrief}/hints[] 成 `/content/projectV2/...` JSON-pointer |
| `dsl-tools.ts:564-569` | patch 校验只允许 pbl content 的 key ∈ `['type','projectConfig','projectV2']` |
| `generation-tools.ts:454-457` | 已存在 pbl 页时改类型被拒：`{blocked:'pbl-type-change'}` + `The existing page is a PBL project. Delete it first or regenerate it as pbl; changing its type here would destroy the project.` |

可用工具只有 `read_stage` / `patch_stage` / `grep_stage`（`dsl-tools.ts:1173/:1195/:1544`）。**没有 `pbl_*`，也没有 open-task / turn / evaluate 的 agent 侧包装。**

### 6.3 运行时记录落在哪张表 / 哪个 key

| 事实 | 读数 | 位置 |
|---|---|---|
| 会话表 | `runtime_sessions(id, stage_id, learner_key, kind, status, created_at, updated_at, data)` | `packages/@openmaic/storage/src/runtime/pg.ts:379-391`（INSERT 列） |
| 记录表 | `runtime_records(id, session_id, seq, scene_id, created_at, data)`，`UNIQUE(session_id, seq)` | `pg.ts:147-155` |
| PBL 的 kind | `'pbl'`（**不在** `CoreRuntimeKind` 里） | `packages/@openmaic/dsl/src/runtime.ts:158-166` 只有 `'chat' \| 'quizAttempt' \| 'playback'`；`:211-212` 注释说明 kind 是 open string，可为 app 自定义 |
| 会话 id 生成 | `` `pbl-${stageId}-${learnerKey}` `` | `lib/pbl/v2/runtime/drain.ts:65-67` |
| 水位 key（KV/localStorage） | `` `runtime.pblDrain.${stageId}.${sceneId}.${learnerKey}` `` | 同上 `:61-63` |
| payload 版本 | `PBL_RUNTIME_PAYLOAD_VERSION = 1` | `lib/pbl/v2/runtime/record-payloads.ts:19` |
| `subAnchor` 落在哪 | 只在 `data` JSONB 里（`pg.ts:564-566` 对 `['sceneId','actionIndex','subAnchor']` 做 undefined 剔除，INSERT 只有 6 列） | `pg.ts:564-566` |
| 校验器 | `APP_RUNTIME_PAYLOAD_VALIDATORS = { chat, quizAttempt, whiteboard }` —— **没有 pbl 键** | `lib/runtime/payload-validators.ts`；`pg.ts:301-303` + `server/index.ts:224-231`（`Object.hasOwn` 才用） |

`drain.ts` 头注释 `:1-20` 原文要点：把 `runtimeEvents` 与 `engagementEvents` 两个有界发件箱 drain 进活动中的 PBL runtime 会话；每条 ledger 有独立的设备级水位；**故意 at-least-once**，下游 fold 必须按 event id 去重；发件箱是 500 条环缓冲，所以存文档前持久化边界要验 fold，必要时补一份全量快照。

### 6.4 我方插件现状（E16 的起点）

路径 `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/`（是源目录；已安装副本在 `C:/Users/asus/.dsh/profiles/desktop/node_modules/dsh-openmaic-course`，是实体目录不是软链）。

| 文件 | 实测行数 |
|---|---:|
| `lib/index.js` | 2855 |
| `lib/client.src.js` | 1153 |
| `lib/db.mjs` | 296 |
| `lib/diag.mts` | 1614 |
| `lib/db-write.mjs` | 282 |
| `lib/services.mjs` | 234 |

（任务书给的是「宿主半 2492 行、浏览器半 777 行」；实测 2855 / 1153。差异原因**不知道**，可能是任务书写的旧版。）

只读缝：`const SEAM = "/dsh-openmaic";`（`lib/index.js:90`），浏览器半 `const ROUTE = '/dsh-openmaic';`（`client.src.js:15`）。
缝路由全集：`/services`(:1116) / `/courses`(:1134) / `/materials`(:1153) / `/scenes`(:1258) / `/thumbs`(:1263) / `/page`(:1268) / `/text`(:1274) / `/active`(:1282 GET, :1359 POST) / `/activity`(:1287) / `/export-batch`(:1295 POST) / `/patch`(:1332 POST)。需要 DB 的白名单 `:1122` = `["/courses","/scenes","/thumbs","/page","/text","/patch"]`。

**现有能力对 PBL 的三处硬缺口**：

1. **拿不到 PBL 运行时**。`lib/db.mjs` 的 SQL keys 只有 courses(:30) / scenes(:40) / thumbs(:50) / search(:59) / page(:71) / 'scenes-full'(:77) / outline(:86) / stages(:96) / folders(:114) / 'stage-outline'(:122) / 'stage-scenes'(:134) / quiz-records(:147) / quiz-sessions(:161)，命令分派 `:173-285`。**没有 `runtime_sessions` / `runtime_records` 的通用读取命令**，只有 quiz 专用的两个。
2. **`/text` 对 pbl 页读不出东西**。`sceneText(page)`（`lib/index.js:1006-1076`）：先试 `content.questions`（quiz，`:1012`），再试 `content.html`（interactive/pbl，`:1032`——pbl 没有 html），再试 `content.canvas.elements`（slide，`:1045`——pbl 没有 canvas），最后按固定 keys 数组 walk（`:1054-1072`，keys 含 title/speech/text/question/stem/prompt/label/options/choices/explanation/answer/steps/items/tasks/description——**没有 projectV2 / roles / milestones**）。所以 pbl 页只会被 walk 出极少量零散串。
3. **`/patch` 对 pbl 页只能改标题**。`patchStage`（`lib/index.js:873-988`）：`elementText` 分支在非 slide 页回 `这页没有 canvas.elements，改不了文字（非 slide 页暂只读）`（`:900`）；`ops` 六个动作全部作用在 `content.canvas.elements` 上（`:909-953`）。没有任何写 `projectV2` 的路径。

另外：`openmaic_page_text`（`:1492`）走的就是 `sceneText`；`openmaic_page`（`:1456`）走 `readDb(["page",...])`，能拿到完整 `content`（含 `projectV2`）**但只是返回原始 JSON**，没有解析/摘要；29 个工具（实测 `grep -c 'name: "openmaic_'` = 29）里**没有 pbl 专属工具**。

### 6.5 最少改动清单（分两档）

**A 档：只读观察（不需要 OpenMAIC 起服务，只加 `db.mjs` + `index.js`）**

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `lib/db.mjs` | 加 2 条 SQL 与 2 条命令：`pbl-sessions`（`select id, stage_id, learner_key, status, created_at, updated_at from runtime_sessions where stage_id = $1 and kind = 'pbl' order by created_at`）、`pbl-records`（`select seq, scene_id, data from runtime_records where session_id = $1 order by seq`）。同时把 `:176-178` 的「不认识的命令」列表补上这两个名字 |
| 2 | `lib/index.js` | ① `:1122` 的 `needDb` 名单加 `"/pbl"`；② 新增缝路由 `/pbl`（GET，query `stageId` + 可选 `learnerKey`），走 `readDb([...])`；③ `sceneText`（`:1006`）在 `:1042` 之前插一段 `content.projectV2` 分支：摊 `title/description/learningObjective` + 每个 milestone 的 `title/briefing` + 每个 microtask 的 `title/learnerBrief` + `scenario.characters[].name/persona`；④ 新增工具 `openmaic_pbl_state`（读 sessions + records，按 `subAnchor` 聚合出「每个 microtask 发生了什么」） |
| 3 | `lib/client.src.js` | `:970` 与 `:1003` 两个渲染分支之外，加第三个 `data.type === 'pbl'` 分支——**只读摘要卡**（标题 / 几个 milestone / 几个 microtask / 是否 scenario / 当前 status），不做交互 |

这一档**不需要改 OpenMAIC 仓任何文件**，因为它只读 DB 两张表 + `document_scenes.data`。

**B 档：真跑（发起 turn / 评估）**

必须调 `POST /api/pbl/v2/{open-task,instructor,simulator,evaluate,task/update}`，也就是**要求 OpenMAIC 的 Next 服务在跑**（当前 PG 5433 未监听，整条链起不来）。最少改动：

| # | 文件 | 改什么 |
|---|---|---|
| 4 | 插件新增 `lib/pbl-http.mjs` | 5 个 endpoint 的 fetch 包装（SSE 解析；`/api/persistence` 那条通用 RuntimeStore 通路也在这层） |
| 5 | `lib/index.js` | 缝加 `/pbl-turn`（POST，转发到 5 个 endpoint 之一）；`ensurePostgres` 之外再加一层「Next 服务在不在」的健康检查 |
| 6 | `lib/client.src.js` | 加真正的 PBL 交互面（chat + submission + completion）。这一档**不是「最少」了**：现有 `client.src.js` 只做了 slide/quiz 两条渲染路径，PBL 的 24 个组件 7344 行没有任何一行被搬过来 |

**结论**：只读观察是**真·最少**（3 个文件、不动 OpenMAIC）；真跑要把 PBL 的客户端面（24 文件 7344 行）搬进来，那是另一个量级的工程。

---

## 7. 诚实清单

以下是我**没读到 / 读不懂 / 无法验证**的，逐条给原因。

1. **`PBL_V2_DEV_PROFICIENCY_BADGE` 找不到读取点。** `grep -rn "PBL_V2_DEV_PROFICIENCY_BADGE"` 全仓（含 `.worktrees/`）只命中三处**注释**（`lib/pbl/v2/api/sse.ts:122`、`packages/@openmaic/generation/src/pbl/operations/kernel/proficiency.ts:37`）与 `dist` 的 `.d.ts`，**没有任何 `.ts`/`.tsx` 读这个 env**。所以「只有该 env 为 true 才出调试徽章」这句在本工作树上**不成立**——徽章渲染代码不存在。是已移除、还在别的分支、还是从没落地，**不知道**。
2. **类型层文档与实现不一致。** `lib/pbl/v2/types.ts:356-358` 注释写 the only high-weight pre-PBL signal is `quiz_accuracy` (cap 0.6)，而实现是 `quiz_accuracy: 0.5`（`proficiency.ts:132`），且 `proficiency.ts:120-127` 的注释自认 quiz drops to 0.5。本报告按 **0.5** 写。哪边是「应然」**不知道**。
3. **任务书里的 `PBLSceneConfig` 在仓里不存在。** `git grep -n "PBLSceneConfig" -- '*.ts' '*.tsx'` 零命中；实际类型叫 `PBLScenarioConfig`（`dsl/src/pbl.ts:95`）。我按实际类型回答，但这个命名差异是任务书写错还是上游改名，**不知道**。
4. **未跑任何东西。** 没跑测试（`tests/pbl` 58 文件 16343 行，一行没执行）、没跑 tsc、没跑 lint、没起服务、没连 PG。所有「行为」结论都是**静态读码推断**，不是运行时观测。SSE 实际流、DB 实际行内容、浏览器实际渲染效果**均未验证**。
5. **legacy PBL 升级路径没读全。** 我只读了 `resolvePBLContent`（`legacy/read.ts:206-223`）的分支判据和 `upgradeLegacyPBLConfigToProjectV2` 的调用点（`pbl-renderer.tsx:47`），**没读 upgrade 函数体**（它在 `legacy/read.ts` 里但具体行段没逐个读）。legacy→v2 的字段映射细节**不知道**。
6. **PBL 在 DB 里到底有没有行，我没验。** `lib/db.mjs` 的 `quiz-records` 判据注释里写「实测 228 行里 54 行有 payload 却没有 phase（pbl 事件、聊天事件）」——这是**别人写下的转述**，我没连库自己数。所以「库里已有 pbl 事件行」这句只能引用、不能背书。
7. **`.worktrees/` 有多份副本，我没比对。** 仓里有 `.worktrees/merge-upstream/` 等目录，里面也有 `lib/pbl/` 与 `packages/.../pbl/`。本报告只针对 `upgrade/v1.3.0` 主工作树，其他工作树的差异**不知道**。
8. **圆桌 / director 机制只读了提示词与常量。** `lib/chat/pi/director-loop.ts`（303 行）我只确认了 `runPiDirectorLoop` 的签名与调用点（`app/api/chat/pi/route.ts:314`）、`maxDirectorToolCalls` 的计算（`:77`），**没有逐行读调度循环**。所以「agent 之间是串行还是并行」「并发上限怎么生效」**不完全清楚**——只能确定提示词层面的预算（最多 6 个 agent turn、每个 agent 最多 8 个 action）。
9. **`eval/pbl-v2-planner/` 的实验没读。** 仓里有 `eval/pbl-v2-planner/{build-compare.ts, compare-html.ts, judge-prompt*.md, runner.ts, scenarios/test-cases.json, serve.ts}`，是做 planner 输出对比的。它们的 judge 口径、跑出来的结论**不知道**。
10. **插件行数与任务书对不上。** 任务书说「宿主半 `lib/index.js` 2492 行、浏览器半 `lib/client.src.js` 777 行」，实测 **2855 / 1153**。是任务书写的旧版、还是两个不同的插件副本，**不知道**。
11. **`stripToDesignTemplate` 的 `proficiency` 恢复逻辑我只读了描述。** `learner-state.ts:126-178` 里「由 `transitions[0].from` 恢复成作者写的档」这句是我从代码顺序读出来的，但**没有构造样例验证**（比如 transitions 为空数组时的行为）。
12. **`completion.tsx` / `submission.tsx` / `workspace.tsx` 只读了关键行段，没通读。** 729 / 1395 / 623 行里我读的是入口与调用点，UI 状态机的边角（比如 reset 流程、导出流程）**没有全覆盖**。
13. **没有验证 `PBLProficiency` 的空串 `''` 在实际项目里会不会出现。** 类型上允许（`dsl/src/pbl.ts:14`），`tierGuidanceBlock` 也专门为它兜底（`tier-guidance.ts:98-103`），但生成期是否真会写出 `''` 我**没找到写点**。
