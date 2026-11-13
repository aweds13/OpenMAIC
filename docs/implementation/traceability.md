# traceability.md — 规格 → 实现追踪（implementation 层）

> 这张表把 `specification/domains/**` 的每条 SR 挂到**具体模块**（文件 + 行）。
> 它是 `N → SR`（`../specification/traceability.md`）之后的第二跳，两跳合起来才闭合。
> 一条 SR 可以挂多个模块；一个模块可以承载多条 SR。**没有模块的 SR 说明没实现**，检查器会红。

## 模块索引

| 模块 | 文件 | 职责 |
|---|---|---|
| M1 内容生成 | `lib/server/agent-runtime/runner.ts`、`skills/agent-runtime/**` | 提示词、工具装配、生成轮次 |
| M2 版面与密度 | `lib/quiz/layout-check.ts`、`lib/server/agent-runtime/scene-diagnostics.ts` | 版面检查、密度核算、差集 |
| M3 写入闸 | `lib/server/agent-runtime/dsl-tools.ts`、`lib/server/agent-runtime/plan-freeze.ts` | `patch_stage` 四道闸、原子写、写后自证 |
| M4 存储 | `packages/@openmaic/storage/src/document/pg.ts` | `document_stages` / `document_scenes` 表与 CAS |
| M5 阅读页 | `components/**`（阅读/播放）、`lib/playback/engine.ts` | 翻页、节奏、假控件 |
| M6 自检页 | `lib/quiz/page-text.ts`、`lib/quiz/**` | 题量、文本抽取 |
| M7 导出 | `lib/export/**`、`app/api/**` | 批量归档 |
| M8 课程库检索 | `lib/chat/pi/tools/course-search.ts`、`lib/chat/pi/tools/read-document.ts`、`lib/server/agent-runtime/course-search.ts` | `course_search` / `read_document` |
| M9 浏览器抓取 | `lib/chat/pi/tools/browse-url.ts`、`lib/server/agent-runtime/browse-url.ts`、`lib/web-search/**` | `browse_url`、`web_search`、SSRF |
| M10 上下文与压缩 | `lib/server/agent-runtime/runner.ts`、`lib/server/agent-runtime/compaction.ts` | 系统提示词、材料注入、压缩预算 |
| M11 工具注册 | `lib/server/agent-runtime/runner-contract.ts`、`app/api/chat/pi/route.ts`、`lib/chat/pi/tools/call-agent.ts` | 三处注册点、允许表 |
| M12 MCP | `lib/server/agent-runtime/mcp-client.ts`、`lib/server/agent-runtime/mcp-tools.ts` | 外部 MCP 连接与工具 |
| M13 DSH 宿主 | `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/index.js`（宿主半）、`lib/client.src.js`（浏览器半）、`lib/db.mjs`（只读取数）、`lib/db-write.mjs`（CAS 写入） | 七工具 + seam 路由 + 三栏面板 |
| M14 学习状态与回流 | `lib/server/agent-runtime/learner-state-render.ts`、`lib/quiz/xq-mastery.ts`、`lib/persistence/xq-learner-store.ts`、`lib/persistence/xq-probe-recorder.ts`、`lib/server/agent-runtime/learner-state.ts`、`lib/practice/results.ts` | 三态格子 + 到期复习 + 练习结果 → 状态块；写文件 / 热路径读文件 |
| M15 学习者画像 | `lib/server/agent-runtime/learner-profile.ts`、`D:/文档/jelly_ware/个人数据/学习画像.md` | 人写的目标与偏好，每次运行重读 |

## SR → 模块

**F1 内容密度与页面形态**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F1.1 | M1、M2 | `skills/agent-runtime/slide-craft/`、`lib/quiz/layout-check.ts`（溢出检查） |
| SR-F1.2 | M1 | `skills/agent-runtime/slide-dsl/`、`lib/server/agent-runtime/dsl-tools.ts`（DSL 工具集） |
| SR-F1.3 | M1、M2 | 密度目标写在技能提示词；核算在 `lib/quiz/layout-check.ts` |
| SR-F1.4 | M2、M3 | `dsl-tools.ts` 的 `textFitRefusal`（`estimateTextHeightPx` 超限拒写） |
| SR-F1.5 | M2、M3 | `maxFontSizePx` / `fontSize` 下限；`textFitRefusal` 明确拒绝压字号 |

**F2 阅读节奏与翻页**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F2.1 | M5 | `lib/playback/engine.ts`（无自动前进） |
| SR-F2.2 | M5 | `MIN_READING_MS`（阅读页不强制停留） |
| SR-F2.3 | M5 | 阅读页外壳（隐藏播放器控件） |
| SR-F2.4 | M5 | 滚轮/点击/方向键三条输入 |
| SR-F2.5 | M5 | 翻页去抖常量 |
| SR-F2.6 | M5 | 滚轮翻页开关 |

**F3 自检页**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F3.1 | M6、M1 | 题量参数透传链 |
| SR-F3.2 | M6 | 题量不足报错 |
| SR-F3.3 | M6 | `lib/quiz/page-text.ts` 的 `learnerVisibleText(page)` |

**F4 批量导出**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F4.1 | M7 | 批量归档入口 |
| SR-F4.2 | M7 | 资源打包 |
| SR-F4.3 | M7 | 逐课结果汇总 |

**F5 本地课程库检索**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F5.1 | M8 | `course-search.ts` 的 `LAYERS`（L0–L4 + auto） |
| SR-F5.2 | M8 | 结构化命中（层级、docId、chunkIndex） |
| SR-F5.3 | M8 | 「不得编造」文案 + 空命中明说 |
| SR-F5.4 | M8 | `read-document.ts` 的 `DOC_MODES`（`peek` / `full`） |
| SR-F5.5 | M8 | `nextOffset` 续读指针 |

**F6 真浏览器抓取**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F6.1 | M9 | `browse_url` 的 `waitMs`（等 JS 渲染） |
| SR-F6.2 | M9 | 返回体带最终 URL / 状态 / 耗时 |
| SR-F6.3 | M9 | 反爬判定作用域（只对正文抽取） |
| SR-F6.4 | M9 | 预览与持久化分离 |
| SR-F6.5 | M9 | `maxChars` 上限 + 截断明说 |

**F7 会话上下文与材料**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F7.1 | M10 | 材料/画像按会话读取，不缓存进程级 |
| SR-F7.2 | M10 | `runner.ts` 材料工具化（`listSessionScopeMaterials`） |
| SR-F7.3 | M10 | 系统消息构造（逐字节稳定） |
| SR-F7.4 | M10 | `compaction.ts`（原生压缩） |
| SR-F7.5 | M10 | 压缩预算常量与环境变量 |

**F8 工具注册与提示词口径**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F8.1 | M12 | `mcp-client.ts` 失败只记录、`mcp-tools.ts` 不注册 |
| SR-F8.2 | M11 | `resolveCourseSearchCapability()` / `resolveBrowseCapability()` 返回 null 不注册 |
| SR-F8.3 | M11 | `runner.ts` 的 `allowedToolNames: new Set(tools.map(t => t.name))` |
| SR-F8.4 | M11 | `runner.ts` / `route.ts` / `call-agent.ts` 三处同一口径 |

**F9 写入闸与版面差集**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F9.1 | M3 | `dsl-tools.ts` 四道闸（plan / overload / holes / review） |
| SR-F9.2 | M3 | 逐条 `applyPatchOp` → 一次 `putSceneBringingCurrent` |
| SR-F9.3 | M3 | `validateSlideCanvas` + `sceneWriteDiagnosticsWithReview` |
| SR-F9.4 | M4 | `document_scenes` 表；`GET /api/whoami` 复读 |
| SR-F9.5 | M3、M2 | `scene-diagnostics` 六段摘要 |
| SR-F9.6 | M4、M13 | `pg.ts` 的 CAS；`db-write.mjs` 的 `where data = $old` |
| SR-F9.7 | M13 | `openmaic_patch_stage` 的 `dryRun` 默认 true + 差集 |

**F10 DSH 宿主与当前页**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F10.1 | M13 | `openmaic_courses` / `openmaic_scenes` / `openmaic_page` |
| SR-F10.2 | M13 | `client.src.js` 的 `SlideCanvas({slide: content.canvas})` |
| SR-F10.3 | M13 | 面板在 DSH 内渲染，无外部浏览器依赖 |
| SR-F10.4 | M13 | `db.mjs` 只读同一个 PostgreSQL |
| SR-F10.5 | M13 | `POST /dsh-openmaic/active` + `openmaic_active` |
| SR-F10.6 | M13 | `ACTIVE = null` 初值；返回 `{active: null}` |
| SR-F10.7 | M13 | `db-write.mjs` 写回同一张表 |

**F11 学习状态与回流**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F11.1 | M4 / M14 | `lib/quiz/attempt-fold.ts` 的 `foldQuizAttempts` 从 `runtime_records` 折叠逐题判定；`tests/quiz/attempt-fold.test.ts`（12 例，含 `orders records by seq, never by timestamp`、`keeps a corrected mistake in everIncorrect but clears incorrectNow`）；`tests/quiz/attempt-fold-live.test.ts` 连真库。**逐题判定目前由读取方即时重算，不落库** —— 这条规格要求落库，尚未做到 |
| SR-F11.2 | M14 | `lib/server/agent-runtime/learner-state-render.ts` 的 `renderLearnerStateBlock` 按页级汇总（`tests/quiz/learner-state-render.test.ts` 20 例，含 `★ stageId 与 sceneId 都在行里 —— 35 个 scene id 跨课复用` 钉住跨课不许借题面；节名主语是页且带判据，旧名 `已会`/`不会`/`说不准` 一个不留）；三态判定在 `lib/quiz/xq-mastery.ts`（29 例，含单边分位数的标定对账、判界矩阵、延迟桶六例）。**题级映射已有、三级判定仍未分开**：`lib/concepts/question.ts` 从题干推出题级挂载写进 `xq_question_concept`（`tests/concepts/question.test.ts` 19 例，真库 71 行 / 13 页 / 强档 11 页）；但三态读数仍只有页级（`xq_cell_state` 是 `(stage_id, scene_id)` 的缓存），概念标签只是页级判定那一行的人话，不是知识点级结论（`tests/agent-runtime/learner-state-concept-label.test.ts` 5 例钉住「最高档恰好 1 个概念才给标签」）。**题级映射现在有两处消费，都是标注不是判定**：状态块的一格人话标签、错题四关挂的概念（`XqLearnerStore.conceptForQuestion()`，同一套「唯一才用」规则；`tests/persistence/xq-probe-recorder.test.ts` 两条钉住唯一则用、并列则留空仍排满四关）。历史错题补排期走 `scripts/backfill-review-schedule.ts`（真库 5 道 → 20 行）。**知识点级读数 2026-11-10 落地**：`lib/persistence/xq-concept-mastery.ts` 的 `readConceptMastery()` 把同一概念跨课跨页的观测合到一处，用同一个 `classifyEvidence()` 折三态（`tests/persistence/xq-concept-mastery.test.ts` 19 例；算而不存、盲猜率按题型分、题目身份是 `(课,页,题)` 三元组）；第一处消费是复习卡（`GET /api/persistence/xq/reviews` 每张卡带 `mastery`，`tests/persistence/xq-review-queue.test.ts` 两条：跨课证据合到一处 / 没有可判证据时是 `null` 不是「暂未定」）。真库 56 条证据里 17 条映射到 15 个概念，全部低于 `MIN_ITEMS_FOR_VERDICT` ⇒ 今天每个概念都是 `unknown`/`too-few-items`。**第二处消费是状态块**（2026-11-10）：`refreshLearnerStateFromRuntime()` 把读数折进 `renderLearnerStateBlock({ concepts })` 并排在页级前面，只列 `known`/`not-learned`；判据 `tests/quiz/learner-state-render.test.ts` 八例（含「暂未定的不列」「一行不写 stage/scene」「只写 n 不写 questions」「全是 unknown 仍是空串」）。真机 `cells=6 / concepts=15`、全 `unknown` ⇒ 零行、文件 1573 B 不变。**题级仍是空的** |
| SR-F11.3 | `lib/persistence/xq-concept-graph.ts` | **读侧 2026-11-10 落地，排序侧仍无**：`ConceptEdge` 带 `source` + `reason`，`prerequisiteEvidence()` 回依据而不是结论（一条边一行、带来源与档位、重复保留）；判据 6 例在 `tests/persistence/xq-concept-graph.test.ts`，路由 1 例在 `tests/persistence/xq-concepts-route.test.ts`。**没有任何代码按 `strength` 决定「许不许排序」**，`GET /xq/concepts` 明确不产出顺序（4 例禁词判据）—— 这条规格的「带来源」成立、「无证据不得参与排序」是空的 |
| SR-F11.4 | `lib/persistence/xq-learner.ts`（v3/v4 迁移） | **结构 2026-11-10 齐了，使用没有**：`xq_graph_version` + `xq_concept` 五列四约束（迁移 `3 graph-version` / `4 concept-expand`）已落，库里 104 概念 / 357 别名 / 105 边 / 644 出现记录；**读侧 2026-11-10 落地**（`lib/persistence/xq-concept-graph.ts` + `GET /xq/concepts`，这是 94 条 `prereq` 边第一次被读）：直接先修 / 闭包 / 最长深度 / 环 / 退役先修 / `ready`，**不产出顺序**；全 104 概念深度对独立 Kahn 比对 0 处不一致。**版本推进 2026-11-10 落地**（`lib/persistence/xq-graph-version.ts` + `scripts/advance-graph-version.ts`：CAS 式冻结/开版、`created_in` 只写一次、冻结版不再长；真机推进到 v2 后已还原）；**种子图进库 2026-11-10 落地**（`lib/persistence/xq-seed-sync.ts` + `scripts/seed-concept-graph.ts`：以 `canonical_name` 认领并保留原 id、退役/合并只认领不写别名、外部 id 冲突不覆盖、边变更计数；真库 `--execute` 读数「认领 104 / 新增 0 / 跳过 357 与 63 / 边未变 105」与历史导入逐一吻合）。**导入批次 2026-11-10 落地**（V5 迁移建 `xq_import_batch` + `xq_concept_occurrence` / `xq_intake_proposal` / `xq_concept_edge` 补列；`lib/persistence/xq-import-batch.ts` 五键 `UNIQUE NULLS NOT DISTINCT` + 三态状态机 + 内容指纹，判据 34 例）。，**出现记录 2026-11-10 接上了**（`--execute --batch` 按课各开一批 → 同步器按 `stage → batchId` 写归属 → 全成功才落定；真库 9 批全 `applied`、645 行全带 `batch_id` 与 `page_hash`、重跑「命中」九批且未变 645）。但**还没有导入器把整门课当一次导入来做**（`xq_intake_*` 三表 0 行，种子图同步器仍不写 `batch_id`） —— 三张导入表都 0 行、104 个概念仍全在第 1 版、排序仍不许上线 ⇒ 仍标「未落地」。**出现记录的读写两半 2026-11-10 都补齐了**：读侧 `?id=` 一并回出现页与页标题（`类与对象` 58 条按权重降序、标题全解析）；写入侧 `lib/persistence/xq-concept-occurrence-sync.ts` + `scripts/backfill-concept-occurrences.ts` 让 `deriveOccurrencesFromOutlines()` 第一次有生产调用方（此前零 —— 那 644 行是已不在盘上的 `.tmp` 脚本灌的）。三条判据：关联靠 `data->>'outlineId'`（三种关联法里唯一页自己声明的那种，且一条大纲可对多页 ⇒ 多值索引）、正文口径复用 `staticPageText()`（自己摊会造第二个单位：674 行 / body 529 的「高吻合」实为把 interactive 外壳 HTML 当正文并漏掉 48 个 widgetConfig 页）、`manual` 行不许删。真库 644 → **645 行**、页 209 → 209、重跑幂等。判据 `tests/persistence/xq-concept-occurrence-sync.test.ts` 21 例。判据 `tests/persistence/xq-learner-schema.test.ts` 27 例（含迁移 v6 之后新增的「`source` 收七档、外来三档单独一档，拼错那一档要被库拒」） + `tests/persistence/xq-concept-graph.test.ts` 45 例 + `tests/persistence/xq-concepts-route.test.ts` 12 例 + `tests/persistence/xq-concepts-wiring.test.ts` 4 例 |
| SR-F11.5 | M14 | `lib/practice/results.ts` 的 `readPracticeResults`（`lib/practice/results.ts:117`，**永不抛**：坏 JSON/读不动/不是目录一律跳过，退化成「没有练习记录」）+ 同名目录上限 200；`tests/agent-runtime/practice-results.test.ts` 含 `★ skips broken files instead of failing the whole refresh`、`★ writes the state file when there are NO quiz records but there ARE practice results` |
| SR-F11.6 | 无（**未落地**） | 无模块。OpenMAIC 与 Obsidian 至今零集成 |
| SR-F11.7 | M14 / M15 | 两份文件实测分家：`D:/文档/jelly_ware/个人数据/学习状态.md` **全部由 `refreshLearnerStateBestEffort` 生成**（`lib/server/agent-runtime/learner-state.ts:353`），`D:/文档/jelly_ware/个人数据/学习画像.md` **1851 B 由人写**。**「不要手改」标注 2026-11-10 落地**（`learner-state-render.ts` 的 `PROVENANCE`：一行 HTML 注释，人看得到、注入时剥掉；判据 4 + 4 例；真机 1405→1573 B 而注入块 1405 B）。**矛盾检测 2026-11-10 落地**（`lib/server/agent-runtime/profile-contradictions.ts` 走「域 → 页标题 → 格」而不是「域 → 概念」—— 真库 `Dart` / `Java` / `程序设计基础` 在 `xq_concept` 与 `xq_concept_alias` 上精确匹配 0 命中，按字符串匹配写会永远不红；渲染器把这一节排在其他所有节**之前**；判据 20 + 8 例；真机 6 格 1 条矛盾）。**仍缺**：「什么时候生成」没写 |
| SR-F11.8 | 无（**未落地**） | 无模块。图谱与「概念身份」都不存在：全库无概念表、无来源映射表，`document_scenes` 里只有 `outlineId` 一个可挂点（234 页 100% 有值，138 页能对上计划条目）。设计见 `D:/文档/jelly_ware/_tools/kg/xq/J-外来课程接入设计.md` |
| SR-F11.9 | **部分（匹配器 / 提案裁决 / 任务与对齐单元都有了，缺批量裁决）**：`lib/persistence/xq-three-way-match.ts`（三段判定树，纯函数 + 库事实装载）+ `scripts/match-external-names.ts`（报告脚本，不写库）+ `lib/persistence/xq-concept-anchors.ts`（义项锚）+ `scripts/seed-concept-anchors.ts` + `lib/persistence/xq-intake-proposal.ts`（提案与裁决五步）+ `scripts/review-intake-proposals.ts`（裁决台）+ `lib/persistence/xq-intake-task.ts`（任务与对齐单元，`confidence` 是纯规则算的）+ `scripts/intake-begin.ts` | 提案与任务的写入方 2026-11-10 补齐（`xq_intake_task` / `xq_alignment_unit` 从 0 行到有入口；`scripts/match-external-names.ts --enqueue --task --source` 把匹配结果写成提案行，`task_id` 第一次有人填，判据 30 条，2026-11-13 修 F5/F6/F7/F10a 后从 19 增 11）；仍缺**批量裁决**、**按页看证据的界面**、`bigram τ` 标定、以及**「每一个词每一次是为了什么收的」**（唯一键里没有 `task_id`，保留的是第一次那条）。三段匹配器 2026-11-10 落地：判定树写死为「字面 + 至少一个别的信号才命中」，`BIGRAM_TAU = 0.45`（2026-11-10 用 20 个外来名 + 20 个留出集 + 9 个同义变体扫出来，可用区间 0.42–0.52；未标定前有一点重叠只能存疑，理由 `bigram-uncalibrated`）；★ 五处「把没说话当成不符合」的判定错各有判据（第五处：外来侧的词命中候选自己的规范名或别名时算 sense 支持 —— `anchors` 按定义不许是概念名或别名，于是「它说的是我们的别名」永远不可能与 anchors 相交，真库 36 个有锚概念里 25 个会被自己的别名否决、共 85 对）（第四处：候选锚词少于 `SENSE_VETO_MIN_ANCHORS = 3` 时取消否决权、理由写 `sense-too-thin` —— 真库 9 个概念只有 1–2 个锚，`构造方法: ["编译"]` 会把正确的 `构造器`/`父类`/`super` 全否掉）。判据 44 条（2026-11-13 修 F1/F2：别名参与模糊匹配、退化区间才弃比、单字名判 `short-name-no-fuzzy`，从 33 增 11）。义项锚 2026-11-10 落地：`lift ≥ 2` 的富集口径、`Intl.Segmenter` + 首尾虚字过滤、已有锚默认不覆盖；真机 36 个概念 / 147 个词（`类与对象` 58 页、`字符串` 56 页抽不出锚 —— 该走存疑）。判据 20 条。★ 锚只能当否决用，不能当确认用（`J` §3.3「独立信号 ≥2」） |
| SR-F11.10 | M14 | `lib/persistence/xq-event-recorder.ts` 的 `recordXqEvent()` 写 `xq_event`、`localDayOf()` 定 04:00 跨天、`deriveDedupeKey()` 派生幂等键、`XQ_HINT_SUBTYPES` 管提示分型（`tests/persistence/xq-event-recorder.test.ts` 14 例，含契约漂移那条逐字核对 16 个 kind / 7 个 end_reason / 2 个 hint_subtype）；`POST /api/persistence/xq/events` 由 `app/api/persistence/[...path]/route.ts` 的 `handleXqEvent` 接（`tests/persistence/xq-events-route.test.ts` 14 例，真路由 + 真写入器，只把池子换成 PGlite）；浏览器侧 `lib/learning/xq-event-client.ts` 负责会话懒开、串行发送、重试复用同一 `occurredAt`（`tests/learning/xq-event-client.test.ts` 8 例）；触发点在 `lib/learning/use-xq-page-view.ts`，挂在播放态 `currentSceneId` 的副作用上（`tests/learning/use-xq-page-view.test.ts` 4 例只测纯判据）。答题两条 kind 的写入方在 `lib/learning/xq-answer-events.ts`（`recordAnswerAttempt()` / `recordAnswerSubmitted()`，幂等键 `answer_attempted:<attemptId>:<questionId>` 与时间无关；`tests/learning/xq-answer-events.test.ts` 7 例只测纯判据 `resolveAnswerTarget()` 与两个键）。提问闸在 `lib/persistence/xq-hint-gate.ts`（`hintGateApplies()` 定豁免、`hasPriorAnswerEvent()` 查先后、`ANSWER_FIRST_CODE`；`tests/persistence/xq-hint-gate.test.ts` 5 例），接在 `handleXqEvent` 的写入侧、拒绝回 409。**生产提问入口 2026-11-10 接上了**：`lib/learning/xq-hint.ts` 的 `askForHint()` **先记 `hint_requested`、成功了才发消息**（反过来闸一挡，模型已答一半而提问记不上）；界面是做题页题卡右上角的「问 AI」，两种分型各一个按钮，`lib/contexts/quiz-ask-context.tsx` 把发消息的能力穿过 `CanvasArea → SceneRenderer → QuizView` 四层（中间三层零改动），`tests/learning/xq-hint.test.ts` 7 例 + `xq-hint-prompt.test.ts` 8 例 + `quiz-ask-wiring.test.ts` 6 例 + `tests/i18n/quiz-ask-locales.test.ts` 49 例。★ 实测纠了一处顺序错：`hint_requested` 带题号却漏 `hintSubtype` 时，闸先跑、回的是 409「先答题」—— 学生照做再点仍然 409；已改成形状先于闸（回 400），并补了一条路由判据。**仍缺**：这条入口只在播放态的做题页，工作台 / `/review` / PBL 都没有；`executive` 那一路没有频次或额度限制。**读侧 2026-11-10 落地**：`lib/persistence/xq-session-digest.ts` 的 `digestSessions()` 是 `xq_event` 的第一个读方 —— 一次 `lag()` 窗口函数把相邻间隔按**上一条**事件类型分档截断（翻页后 60 分钟、其余 30 分钟），折出活跃时长 / 墙钟 / 页数 / 两种提示分开数 / 答过与交卷分开数；路由 `GET /api/persistence/xq/sessions` 接在 `handleXqSessionDigest`（`day` 是学习日，非法就 400 而不是静默放大成「全部」），`tests/persistence/xq-session-digest.test.ts` 10 例 + `xq-sessions-route.test.ts` 9 例。**仍缺**：`self_report` 零采集；5 分钟那一档空闲阈值故意没做（`page_viewed` 分不出「在读」与「在翻」，而那要靠 `dwell_ms` —— 今天没有写入方）；`dwell_ms` 不进任何判定。**对话日志 2026-11-10 落地**：`lib/persistence/xq-ai-log.ts` 的 `readAiLog()` 把 `xq_event(kind='hint_requested')` 与 `runtime_records`（`payload.kind='chat_message'`）按 `(stage_id, scene_id, question_id)` + `subAnchor` + 5 分钟时间窗拼起来，路由 `GET /api/persistence/xq/ai-log` 接在 `handleXqAiLog`（`tests/persistence/xq-ai-log.test.ts` 13 例 + `xq-ai-log-route.test.ts` 6 例）；`RuntimeRecord.subAnchor` 此前**从未被 chat 写过**（真库 31 条 chat 记录带锚点 0 条），`1046e55e` 逐层打通且换题开新会话。**界面 2026-11-10 落地**：`/ai-log` 页 + `components/learning/ai-log-list.tsx` + `lib/learning/xq-ai-log-client.ts`（客户端 9 例 + locale 63 例）；三种状态分开说、代数显示、只读无删除。**`day` 的口径 2026-11-10 统一**：此前 `readAiLog` 用 `(occurred_at AT TIME ZONE 'Asia/Shanghai')::date` 现算日历日，而 `GET /xq/sessions` 读的是 `xq_session.local_day`（04:00 边界）—— 同一个 `day` 参数两个端点两个答案，凌晨两点那一条在会话摘要里属昨天、在对话日志里属今天。改成 `JOIN xq_session … AND s.local_day = $1::date`，判据钉住（UTC `18:30` 那条必须读到 `2026-11-08`、读不到 `2026-11-09`）。**「学了多久」有界面 2026-11-10 落地**：`/sessions` 页 + `components/learning/session-list.tsx` + `lib/learning/xq-session-client.ts`（客户端 9 例 + locale 49 例）；合计只累加已结束的会话、读失败不说成「今天没学」。**仍缺**：5 分钟窗是产品默认值；入口只有主页工具条的 `home-ai-log-link`（无角标 —— 日志是往回看的，没有「今天该看几条」）与 `home-sessions-link`（同样无角标 —— 时长不是待办）；会话列表没有「按课程分开看」。**关标签页能关会话 2026-11-10 落地**：`post()` 带 `keepalive: true` + `useXqSessionLifecycle()` 挂 `pagehide`（此前只有播放态 `teardown()`，而直接关标签页没有卸载回调 ⇒ 会话永远开着 ⇒ 合计永远是 0）。**服务端兜底 2026-11-10 落地**：`sweepStaleSessions()` 把「开着但最后一条事件距今超过阈值」的会话收掉（阈值复用 digest 的同一组常量，收尾靠真事件 `session_abandoned`，幂等键用最后一条事件的时刻），接在 `GET /xq/sessions` 上；判据 9 + 3 例。**仍缺**：没有定时任务，只有人打开这一页时才收。 |

**横切（NF）**

| SR | 模块 | 落点 |
|---|---|---|
| SR-NF1 | 全局 | `AGENTS.md` §3 证据命令；`复盘/` 全部读数 |
| SR-NF2 | M6、M8、M9、M10 | 各工具的 `not_configured` / 明确报错分支 |
| SR-NF3 | M10 | 系统消息稳定 + 材料工具化 |
| SR-NF4 | M11、M8、M9 | 各工具 `parameters` schema 与范围 |
| SR-NF5 | M9、M10 | 提示词里的「不可信内容」声明 |
| SR-NF6 | M8、M9、M13 | 结构化失败四类 |
| SR-NF7 | 全局 | 本目录与 `复盘/` 的维护约定 |
| SR-NF8 | 全局 | 测试里的路径比较方式、`scripts/` 的跨平台写法 |
| SR-F11.11 | M14 | `lib/persistence/xq-review-recorder.ts` 的 `recordXqReview()`：先确认那一关在排期表里（`ROUND_EXISTS_SQL`，不在就抛 `XqReviewRoundMissingError`），再写 `review_passed` / `review_failed` 事件（`skip` 不写 —— 十六个 kind 里没有它），最后调 `XqLearnerStore.recordReviewOutcome()`（`tests/persistence/xq-review-recorder.test.ts` 11 例，含「真的又错一次就该是两条」与「记完之后不再到期」）；`POST /api/persistence/xq/reviews` 由 `app/api/persistence/[...path]/route.ts` 的 `handleXqReview` 接（`tests/persistence/xq-reviews-route.test.ts` 10 例，关不存在回 404 而不是 400）。**动机是可复算的**：此前 `recordReviewOutcome()` 零生产调用方，而回填已排进 20 关，到期后永远清不掉。**降级规则已于 2026-11-10 落地**（P5 四关重置）：`xq-learner-store.ts` 的 `RECORD_OUTCOME_SQL` 多了一个 `prior` CTE 数「同一道题同一概念、`kind='review_failed'`、`occurred_at` 严格早于这一次」的条数，据此在 `REVIEW_RESET_LADDER`（两行 `[[1,3,7,15],[3,7,15,30]]`）里选行 —— 第一次做错仍 1/3/7/15，第二次起整行后移；`recordReviewOutcome()` 因此多了可选 `occurredAt`（重放要用同一时刻，否则同一份历史重跑两次会得到两套排期）。判据 `tests/persistence/xq-learner-store.test.ts` 25 例（新增「第二次起整行后移」「第 N 次仍用第二行」「同一时刻自己的失败事件不算以前」）。**读侧 2026-11-10 落地**：`GET /api/persistence/xq/reviews` 由 route 的 `handleXqReviewQueue` 接，`lib/persistence/xq-review-queue.ts` 的 `listDueReviewCards()` 一次 `LEFT JOIN LATERAL` 把到期行、页标题、题面拼齐（9 例：`tests/persistence/xq-review-queue.test.ts`，含「到期判据与 `dueReviews()` 是同一条」「页被删到期不消失」「limit 数的是到期行不是题面行」）。**读侧 2026-11-10 再续**：浏览器侧接上了 —— `/review` 路由（`app/review/page.tsx`）挂 `components/learning/due-review-list.tsx`，客户端是 `lib/learning/xq-review-client.ts`（`listDue()` / `record()` / `groupCardsByScene()` / `reviewCardKey()`，`tests/learning/xq-review-client.test.ts` 14 例；十二个 locale 的文案由 `tests/i18n/review-page-locales.test.ts` 26 例守住）。**入口 2026-11-10 落地**：首页顶部工具条加 `home-review-link`（`<Link href="/review">`，`aria-label` 取 `review.title`），判据 `tests/learning/review-entry.test.ts` 5 例。**到期信号 2026-11-10 落地**：`components/learning/due-review-badge.tsx` 挂在那个入口里，显示今天到期的关数（`focus` 时重读不轮询，封顶写 `50+`）；★ 三种状态刻意分开 —— 读到 0 不显示、读到 n 显示 n、**没读到也不显示**（把「没读到」画成「没有」正是复习页最不该犯的错），判据 `tests/learning/due-review-badge.test.ts` 5 例。**仍缺**：只有首页这一处（播放态与工作台看不到），也没有主动推送（通知 / 邮件 / 桌面提醒都没有）—— 人不去首页就永远不知道。**真机端到端 2026-11-10 补验**：合成一道题一关，`pass` → 那一关 `done_at` 写定且 `review_passed` 只 1 条，重投 200 `duplicate: true` 不增行，`skip` 只标关不写事件（`eventId: null`），不存在的关 404。合成数据验证后已清掉 |
| SR-F11.12 | M14 | `lib/quiz/confidence.ts` 是自评那四档的纯判据（`CONFIDENCE_LEVELS` / `asConfidenceLevel()` / `asConfidenceMap()` / `isConfidenceComplete()` / `calibrationOf()` / `calibrationFromResults()`，`tests/quiz/confidence.test.ts` 21 例）；承载走 `QuizAttemptPayload.confidence`（`lib/quiz/runtime.ts`，空映射**不写** —— 写 `{}` 会让 `samePayload` 把两次不同草稿判成相同，草稿静默丢掉），恢复走 `lib/quiz/view-state.ts`（`tests/quiz/view-state.test.ts` 9 例四条断言都带 `confidence`）；落库走 `lib/persistence/xq-probe-recorder.ts` 的 `confidencePre`（`tests/persistence/xq-probe-recorder.test.ts` 22 例，新增三条：自评落进 `confidence_pre` / 没自评留 `NULL` / **自评不影响判定**）；界面是做题页题卡的 `quiz-confidence` 四档行 + 复习态不给 `onConfidence`，校准条在 `ScoreBanner` 之后（`data-testid="quiz-calibration"`），十二个 locale 各 12 键。★ **自评是事实不是判定**：`lib/quiz/xq-mastery.ts` 的 `EvidenceItem` 只有 `countedN` / `correct` / `guessRate` / `askedAt`，`tests/quiz/confidence-not-a-verdict.test.ts` 3 条**读源码**守着它（禁的是 `confidence_pre` / `confidencePre` / `ConfidenceMap` / `ConfidenceLevel` 四个具体名字，不能笼统禁 `confidence` —— 该文件有个同名统计常量 `CONFIDENCE = 0.8` 是 Beta 可信区间的置信水平）。**依据**：Karpicke & Roediger 2008 四组预测约 50%、实际 80% 对 33%、组间 F<1，自评与真实零相关。**仍缺**：自评只在播放态做题页能填（`/review` 的复习卡还不问）；`confidence_post` 零采集；「准不准」只在本页显示一次，没有进状态块也没有跨会话趋势 |
| SR-F11.13 | M14 / M9 | `refreshLearnerStateWithConnection(queryable)` 用调用方已有的池子刷状态块，接在 `withXqProbeRecording` 的 `onRecorded`（只在 `inserted > 0` 时叫）与复习写入成功之后，两处都 `void`；`tests/persistence/xq-probe-recorder.test.ts` 的 `onRecorded` 组 4 例 + `tests/agent-runtime/learner-state-refresh.test.ts` 5 例。真机验过：磁盘 946 → 1405 字节，三节齐。**仍缺**：练习文件夹里的 `result.json` 是磁盘来源，没有东西能感知它变了（要等下一次 agent 运行）；没有节流。 |
