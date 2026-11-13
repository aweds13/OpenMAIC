# 实现层 · 覆盖矩阵

> 这份表回答一个问题：**每一条规格（SR）由谁负责、今天到底做没做到。**
> 上游：`specification/traceability.md` 的 **50 条逐域 SR**（另有 8 条跨域 SR-NF，见文末）。
> 判据：**没有自动化判据的不许写成「有」**。「人工核对」也是一个诚实的答案，但必须写明核对方式。

图例：`有` = 有自动化判据且今天通过；`松` = 有判据但只覆盖一部分；`人工` = 只能人工核对，已写方式；`无` = 没有判据。

## F1 内容上屏幕与密度

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F1.1 | M1 / M2 | 松 | `tests/agent-runtime/scene-diagnostics.test.ts` 检查元素是否溢出画布；「不滚动」靠渲染器固定画布尺寸天然成立，无独立断言 |
| SR-F1.2 | M1 | 松 | `skills/agent-runtime/stage-dsl`、`slide-dsl` 约束写入必须走 DSL；无「禁止手工拼 canvas」的静态检查 |
| SR-F1.3 | M1 / M2 | 有 | `lib/quiz/layout-check.ts` 的密度检查 + `tests/quiz/layout-check.test.ts` |
| SR-F1.4 | M1 | 松 | 提示词与 `textFitRefusal` 会在溢出时拒绝写入，但「必须加页」是模型决策，无断言 |
| SR-F1.5 | M2 | 有 | `lib/quiz/layout-check.ts` 字号下限检查 + 对应测试 |

## F2 阅读页行为

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F2.1 | M5 | 有 | `tests/**` 内阅读页翻页行为测试（自动前进被禁用） |
| SR-F2.2 | M5 | 有 | 同上；`MIN_READING_MS` 只作为下限提示已去掉强制等待 |
| SR-F2.3 | M5 | 人工 | 人工核对方式：打开阅读页，逐项点击每个可见控件，确认都有实际效果；无自动化 |
| SR-F2.4 | M5 | 人工 | 人工核对方式：分别用滚轮、点击左右区、方向键翻一页，确认三种都生效 |
| SR-F2.5 | M5 | 有 | 去抖常量 450ms 有单测覆盖 |
| SR-F2.6 | M5 | 人工 | 人工核对方式：关掉滚轮翻页后滚动页面，确认恢复浏览器默认滚动且不翻页 |

## F3 自检页

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F3.1 | M1 / M6 | 松 | 题量参数能传下去；未断言「下游不写死」 |
| SR-F3.2 | M1 | 松 | 题量不足会报错；有测试覆盖其中一种路径 |
| SR-F3.3 | M6 | 有 | `lib/quiz/page-text.ts` 的 `learnerVisibleText` + 其测试 |

## F4 批量导出

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F4.1 | M7 | 有 | `tests/export/batch-export.test.ts`、`batch-export-real-builders.test.ts`、`resource-pack-export.test.ts`、`inline-assets.test.ts`；多课合并为一个归档由 `batch-export.test.ts` 的 `isolates a broken course: the rest of the batch still lands` 覆盖 |
| SR-F4.2 | M7 | 人工 | `failedAssetUrls` 只作为 mock 返回值 `[]` 出现在测试里，没有断言它被填充。人工核对方式：断网后导出一门含外链图的课，确认失败的图被逐个列出来而不是静默少几张 |
| SR-F4.3 | M7 | 有 | `tests/export/batch-export.test.ts:213` `isolates a broken course: the rest of the batch still lands` 与 `:245` `treats an unloadable course as a per-course failure`；逐课报告区在 `BatchDownloadDialog` 的 `data-testid="batch-download-summary"` / `batch-download-result-${id}` |

## F5 本地课程库检索

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F5.1 | M8 | 人工 | 没有测试文件断言 `layer` 取值域、默认 `auto` 与原样进 URL。人工核对方式：连 8720 后各传一次 `auto`/`document`/`chunk`，在 8720 日志里确认 `layer` 原样到达。（旧版这里写 `tests/chat/pi/course-search.test.ts`，该文件不存在） |
| SR-F5.2 | M8 | 人工 | 结构化命中（`sourceUrl:` / `chunk N of M` / `full document id for read_document:`）无断言。人工核对方式：同一个查询看命中里的定位行是否齐全 |
| SR-F5.3 | M8 | 松 | 工具描述明确要求「不许编造、空命中明说」；`grep -rq "no_results" tests/` 零命中，`no_results` 分支无断言，`not_configured` / `error` 只靠同约定间接代表 |
| SR-F5.4 | M8 | 有 | `tests/chat/pi/read-document.test.ts` 覆盖 `mode: full` 不受预览上限约束 |
| SR-F5.5 | M8 | 松 | `limit` 上限与截断提示有测试；`nextOffset` 续读指针是死指针（已知缺陷，见下） |

## F6 网页抓取

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F6.1 | M9 | 松 | 走 8730 真浏览器；`waitMs` 透传无断言（`grep -rq "waitMs" tests/` 零命中），端到端只在人工核对过 |
| SR-F6.2 | M9 | 松 | `details.title` 与链接有断言（`tests/chat/pi/browse-url.test.ts`、`fetch-url.test.ts`）；`finalUrl` / `httpStatus` / `elapsedSec` 与那行 header 无直接断言 |
| SR-F6.3 | M9 | 人工 | 人工核对方式：抓一个含裸词（如「验证码」）但不反爬的页面，确认正文能取到 |
| SR-F6.4 | M9 | 松 | 工具只读不写有测试；「跑完磁盘无新增」无断言，人工核对方式：跑一次前后各 `git status --short` 比一次 |
| SR-F6.5 | M9 | 松 | 现有只断言 `maxChars: 5000` 被透传；schema 上下界 1000 / 120000 与默认 40000 无断言 |

## F7 上下文与材料

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F7.1 | M10 | 松 | 材料落库后下次会话可读到；无「跨会话一致性」断言 |
| SR-F7.2 | M10 | 有 | `tests/agent-runtime/**` 断言会话材料不进系统提示词 |
| SR-F7.3 | M10 | 有 | 同上；系统消息逐字节稳定的测试存在（缓存命中率实证 99.6–100%） |
| SR-F7.4 | M10 | 有 | 压缩阈值与触发有单测 |
| SR-F7.5 | M10 | 有 | 预算必须大于固定开销的校验存在 |

## F8 工具注册

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F8.1 | M12 | 有 | `tests/agent-runtime/mcp-*.test.ts`：连不上只记 failed、不注册工具 |
| SR-F8.2 | M11 | 有 | `tests/agent-runtime/runner-course-search-registration.test.ts` 等服务端条件注册 |
| SR-F8.3 | M11 | 有 | `tests/lib/chat/pi/native-child-consumer.test.ts` 断言 `availableToolNames` 不含未注册工具 |
| SR-F8.4 | M11 | 有 | 三处注册点（`runner.ts` / `route.ts` / `call-agent.ts`）同口径，有测试分别钉住 |

## F9 写入闸与版面差集

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F9.1 | M3 | 有 | `tests/agent-runtime/patch-stage-gates.test.ts` 四道闸各自有拒绝用例与文案断言 |
| SR-F9.2 | M3 | 松 | 整批原子依赖单次事务；「一批里第四条失败」无直接用例 |
| SR-F9.3 | M3 | 有 | 写后重新 `loadDocument` + `sceneWriteDiagnosticsWithReview` |
| SR-F9.4 | M3 / M4 | 人工 | 人工核对方式：`GET /api/whoami` 对照数据库直接查询 |
| SR-F9.5 | M3 / M4 | 松 | 摘要给出页码与元素序号；「表/行/字段」级别未给 |
| SR-F9.6 | M13 | 有 | `db-write.mjs` 的 CAS；伪造旧值实测返回 `stale / rows:0` |
| SR-F9.7 | M13 | 有 | 默认 `dryRun=true`；实测不落盘；差集键序 `before,after,added,removed,moved,resized,textChanged,restyled` |

## F10 在 DSH 里当宿主

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F10.1 | M13 | 有 | 课程/页列表与单页渲染已通：`smoke-render.mjs` 用 jsdom 真跑 effect，11/11 项通过 |
| SR-F10.2 | M13 | 有 | 已修并双向验证：面板改取 `page.content` / `page.type`（原读 `page.data`）。修好版 6 项全绿（含 canvas 专属正文与 `<svg` 实测 3 个），故意回退成 `page.data` 的 buggy 版 3 项红（卡「取文本…」/ 类型 undefined / 无 svg） |
| SR-F10.3 | M13 | 有 | 插件不启动外部浏览器进程；`spawnSync` 只用 `process.execPath` 跑 node |
| SR-F10.4 | M13 | 有 | 面板与旧 UI 读同一库同一批表；插件目录内无课程数据副本 |
| SR-F10.5 | M13 | 有 | 选中即 `POST /active`；实测 `GET /active` 能读到刚写的值 |
| SR-F10.6 | M13 | 有 | 空时返回「还没有用户在面板里选过页（或 DSH 刚重启过）」；实测重启后为 `null` |
| SR-F10.7 | M13 | 无 | **未验过**：DSH 侧写入后刷新旧 Web UI 是否可见，尚未实测 |

## F11 学完之后留下什么

| SR | 模块 | 判据 | 落点 |
|---|---|---|---|
| SR-F11.1 | M4 / M14 | 松 | `tests/quiz/attempt-fold.test.ts` 12 例钉住三阶段折叠、曾错仍记、按 seq 不按时间戳、题面丢失有解释；`tests/quiz/attempt-fold-live.test.ts` 连真库。**「判分落库」这一半没有判据** —— 今天的逐题对错是读取时按题面重算的 |
| SR-F11.2 | M14 | 松 | `tests/quiz/learner-state-render.test.ts` 的 `known 带置信下界，not-learned 带上界，unknown 带 reason 的人话`（第三态存在；节名 `## 已达判据（…）` / `## 未达判据（…）` / `## 暂未定（…）`）与 `★ stageId 与 sceneId 都在行里 —— 35 个 scene id 跨课复用`（跨课不借）、`★ 每行带 n= / k=`、`★ 零评价词`；「会只由延迟证据推出」由 `tests/quiz/xq-mastery.test.ts` 的 `延迟桶：会 = 隔了几天还答得对` 六例钉住（今天答对的 8/8 判 unknown、延迟桶 < 3 条时全量 10/10 仍 unknown）。**三级分开只有页级** —— 题级**映射**已落库（`lib/concepts/question.ts` → `xq_question_concept`，`tests/concepts/question.test.ts` 19 例；真库 71 行 / 13 页），但题级与知识点级都没有自己的三态读数。题级映射的两处消费都是**标注**：状态块的一格标签、错题四关挂的概念（判据 `tests/persistence/xq-probe-recorder.test.ts` 两条：唯一则用 / 并列则留空且仍排满四关）；历史错题补排期 `scripts/backfill-review-schedule.ts`。**知识点级读数 2026-11-10 落地**：`readConceptMastery()`（19 例：唯一才用 / 并列两个都不算 / 三门课合到一处才跨过三题门槛 / 同题两次是两条证据 / 多选盲猜率 0.0638 / 题目身份是三元组 / 不给 stageIds 就是所有课 / 算三次不改表 / 按名字排序）；复习卡带 `mastery`（2 例）。**第二处消费是状态块**（2026-11-10）：`refreshLearnerStateFromRuntime()` 把读数折进 `renderLearnerStateBlock({ concepts })` 并排在页级三节前面，只列 `known`/`not-learned`（`unknown` 一条不列 —— 页级已说过为什么不够判）、一行不写 stage/scene（概念跨页）、只写 `n` 不写 `questions`（两个都叫「题数」会混）；`tests/quiz/learner-state-render.test.ts` 八例钉住「暂未定的不列」「一行不写 stage/scene」「只写 n 不写 questions」「全是 unknown 仍是空串」。真机 `cells=6 / concepts=15`、15 个全 `unknown` ⇒ 块里零行、文件 1573 B 与加这一层之前一致。**题级仍空** |
| SR-F11.3 | `lib/persistence/xq-concept-graph.ts` | 松 | **读侧 2026-11-10 落地，判定侧仍无**：`ConceptEdge` 现在带 `source` 与 `reason`（第一版只取四列，把来源丢了 —— 那条规格在读得到图的人手里根本没法核对），`prerequisiteEvidence()` 回「依据」而不是「结论」：一条边一行、带来源与档位、重复保留（同一个先修被两张外部图各支持一次是两条证据），判据 6 例（带来源 / 两图两证据 / 来源未知是 `null` 不是空串 / **按码点排序不用 `localeCompare`** / `contains` 不算依据且目标过合并链 / 起点解析不出仍是缺口）；路由 1 例（`?id=` 一并回 `prerequisiteEvidence`，与去重后的 `prerequisites` 是两份数据）；真机 `分支结构` 回 `strict/acm-graph` + `recommended/course-outline` 两条依据。**「无证据不得参与排序」这一半是「恰好没做」**：`GET /xq/concepts` 不产出任何顺序，禁词判据 4 例守着（禁 `recommendOrder`/`studyOrder`/`nextConcept`）；但「有证据之后谁许排序」仍没有实现，也没有任何代码把 `strength` 当门槛用过 |
| SR-F11.4 | `lib/persistence/xq-learner.ts` | 有（结构） | **结构 2026-11-10 落地**：`xq_graph_version` （含 `one_open` 偏索引）+ `xq_concept` 五列四约束 + `xq_probe_item.retest_of`，库上已验证；判据 5 例（同一时刻一个开放版本 / 概念只能标进存在的版本 / id 形状与名字非空 / 退役晚于进入 / 重测链回指）。**读侧 2026-11-10 落地**：`lib/persistence/xq-concept-graph.ts` + `GET /xq/concepts`（94 条 `prereq` 边第一次被读），判据 45 + 12 + 4 例（纯函数段手搭链/菱形/环/合并链/退役先修/缺节点，读库段 PGlite 含出现记录与页标题，路由段真路由 + PGlite，接线段源码断言「没有写 SQL、没有产出顺序」）。**出现记录同一笔记了**：`xq_concept_occurrence` 644 行（keypoint 17 / title 127 / body 500）此前零生产读方，现随 `?id=` 一并回出现页/标题/权重/层级；29/104 个概念如实回空数组。**使用侧 2026-11-10 补齐两段**：① 版本推进流程（`lib/persistence/xq-graph-version.ts` + `scripts/advance-graph-version.ts`，判据 17 例：CAS 拦并发 / 冻结与开版同一次 / 中间版本不许跳过 / 只写 `created_in IS NULL` / 往冻结版塞概念要拒；真机推进到 v2 后已还原）② **导入批次**（`lib/persistence/xq-import-batch.ts`，34 例：五键幂等、`NULLS NOT DISTINCT` 让 NULL 也参与唯一性、换抽取器/跨版图/换课各分新批、页序变则哈希变而键序不变、三态状态机、`applied` 与 `applied_at` 双向约束）；以及**种子图进库**（`lib/persistence/xq-seed-sync.ts` + `scripts/seed-concept-graph.ts`，判据 14 例：以名字认领并保留原 id / 退役概念只认领 / 外部 id 冲突不覆盖 / 边变更计数 / 真种子图 104·357·63·105 / 真种子图幂等；真库 `--execute` 四张表行数不变，与 2026-11-09 那次历史导入逐一吻合）③ **出现记录的写入方**（`lib/persistence/xq-concept-occurrence-sync.ts` + `scripts/backfill-concept-occurrences.ts`，判据 21 例：关联靠 `data->>'outlineId'` / 一条大纲对多页 / 正文口径必须是 `staticPageText()` / keyPoint 压过正文 / 跨课同名 scene 各算各的 / 不传 execute 不写 / 重跑幂等 / 页改标题就删旧写新 / `manual` 行不许删 / 概念缺行时报出来不新造；真库 644 → **645 行**、页 209 → 209、重跑 `新增 0 / 未变 645`）—— 在这之前「种子图 → 库」与「页 → 概念」**根本不在仓里**，那两份数据都不可再生。★ 这一跳走过一次弯路：第一版自己写摊平函数，算出 674 行 / `body 529`、与当时库对上 95.2%，**那个高吻合是假象**（把 interactive 外壳 HTML 当正文、漏掉 48 个 `widgetConfig` 页的真实正文）；换成 `staticPageText()` 后 `body` 与页数才同时落回 500 / 209。**仍缺** `prereq` 排序（明确不许上线）与导入批次（三张表 0 行、104 概念全在第 1 版）⇒ 状态列记「有判据」，SR-F11.4 仍留「未落地」标记 |
| SR-F11.5 | M14 | 有 | `tests/agent-runtime/practice-results.test.ts` 六例：坏文件跳过不中断、目录不存在不抛、标明来源、文件上限、只有练习结果也写状态、两者都无则不写空文件；实现 `lib/practice/results.ts:117` 注释原文「永不抛」 |
| SR-F11.6 | 无 | 无 | **未落地**：OpenMAIC 与 Obsidian 零集成 |
| SR-F11.7 | M14 / M15 | 松 | 机器文件自带使用规则有断言（`always carries its own usage rules and the do-not-recite warning`）；**「不要手改」标注 2026-11-10 落地**（渲染器在块首后写一行 HTML 注释，人看得到、注入时被 `prompt-context-file.ts` 剥掉；判据 `tests/quiz/learner-state-render.test.ts` 约束 7 四例 + `tests/agent-runtime/learner-state-provenance.test.ts` 四例，真机磁盘 1405→1573 B 而注入块仍是 1405 B）；**矛盾检测 2026-11-10 落地**（`lib/server/agent-runtime/profile-contradictions.ts`：不走「域 → 概念」（真库 `Dart` / `Java` / `程序设计基础` 在概念表与别名表上精确匹配 0 命中），改走「域 → 页标题 → 格」；渲染器在块首之后、所有节之前加一节 `## 画像与状态不一致`，措辞是「画像说 X，状态说 Y」不是「X 是错的」；判据 `tests/agent-runtime/profile-contradictions.test.ts` 20 例 + `tests/quiz/learner-state-render.test.ts` 8 例；真机画像 801 字节 + 6 格 ⇒ 1 条矛盾：`Dart / Flutter` 标 UNKNOWN，而「自检：Dart 进阶八道题」达判据，块 840 → 957 字节）。**仍缺一样**：「什么时候生成」没写（写死时刻会让每次刷新变字节，精确时刻在库里） |
| SR-F11.8 | 无 | 无 | **未落地**：无概念表、无来源映射表；设计见 `D:/文档/jelly_ware/_tools/kg/xq/J-外来课程接入设计.md` |
| SR-F11.9 | M15 | 松（部分） | **匹配器 / 提案裁决 / 任务与对齐单元都有了，`τ` 也已标定，缺批量裁决**：三段判定树 `lib/persistence/xq-three-way-match.ts` 44 例（2026-11-13 从 33 增 11：`namesByConcept` 让别名参与模糊匹配、`diceIsDegenerate` 只在「这一对」都短时弃比、单字名判 `short-name-no-fuzzy`）+ 报告脚本 `scripts/match-external-names.ts`（不写库）；义项锚 20 例（切词 6 / 算锚 7 / 落库 7），真机 36/104 概念、147 词；提案与裁决 30 例（原 17 条 + 2026-11-13 的 11 条：判重查别名表与并发撞唯一索引、`hit` 后到自动归并、拒绝只冻人的决定、无页证据要保留）+ 裁决台 `scripts/review-intake-proposals.ts`；任务与对齐单元 17 例（id 形状 / `confidence` 纯规则 / 排序 / 格子折单元 / 写前拦住 / 开一次任务含回滚 / 收口 / 列任务），真机 `--execute` 后任务与单元前缀一致、验完已清空。提案 30 例（含 `task_id` 挂得上任务、第二次导入保留第一次的来历）；`scripts/match-external-names.ts --enqueue --task <id> --source <graph> --execute` 是真机走通的那条路（7 条提案 / hit 5 自动归并 / 重导 0 新建 7 已见）。仍缺**批量裁决**、**按页看证据的界面**、`bigram τ` 标定、**「每一次是为了什么收的」**、任何真实外来名单的验证 |
| SR-F11.10 | M14 | 有 | 写入器 14 例（会话 id = 首事件 id / 同一次开始投两次只建一个会话 / 同页同时刻重发只算一次而隔一分钟是新的一次 / 手点三页 = 3 条 / 结束会话写全 `ended_at`+`end_reason`+`event_n`+`scene_n` / 04:00 前后分属两天 / 同日第二会话 `seq_no=2` / 幂等键稳定 / 坏时间戳不写半条 / **契约漂移**逐字核对 16 个 kind、7 个 end_reason 与 2 个 hint_subtype / **提示分型写得进去** / 缺类型发 SQL 前就抛 / 别的 kind 挂类型抛）；路由 14 例（真路由 + 真写入器：3 条 page_viewed / 重发两次 `count(*)` 不变且回 `duplicate: true` / 未知 kind 400 / 非 POST 405 / 关闭会话后派生量对 / **提示分型完整路径**（instrumental 与 executive 分开落）/ 未知提示类型 400 / 缺类型 400）；浏览器发送端 10 例（只开一条会话 / 三页签同 tick 也只开一个 / 5xx 重试复用同一 `occurredAt` / 4xx 不重试 / 失败不抛 / 结束后重新开）；触发判据 4 例（占位页 `__pending__` 不记、无课程 id 不记、无页面 id 不记）；答题事件 7 例（`lib/learning/xq-answer-events.ts`：坐标三样缺一不发 / 键稳定 / 换题换轮换键 / 两条 kind 键不同）；提问闸 5 例（`lib/persistence/xq-hint-gate.ts`：只挡 instrumental / executive 豁免 / 页面级豁免 / 别的 kind 豁免 / 拒绝码）+ 路由里 7 条闸判据（409 且不写 / 先答过放行 / 答在问之后不算 / executive 放行 / 页面级放行 / **带题号却漏 `hintSubtype` 仍回 400**）。**问的那一头 2026-11-10 接上**：`lib/learning/xq-hint.ts` 7 例（先记事件再发消息的顺序可观测 / 分型与题干一起带上 / 闸挡住时消息不发 / 挡住与记不上是两种结果 / 抛错不冒泡 / 记上了没发出去回 `unsent` / 两侧 `ANSWER_FIRST` 字面量一致）+ `tests/learning/xq-hint-prompt.test.ts` 8 例（码点截断不切坏代理对 / 模板漏占位符退回题干 / 占位符出现两次填两次）+ `tests/learning/quiz-ask-wiring.test.ts` 6 例（Provider 包住画布 / 中间三层零改动 / 取不到就不渲染 / 两按钮两分型 / **发之前先展开侧栏** / 挡住与真失败不同文案）+ `tests/i18n/quiz-ask-locales.test.ts` 49 例（十二个 locale × 文案齐 / 带 `{{stem}}` / 两种问法不同句 / 挡住与真失败不同句）。真机端到端跑过：手点三页 → 3 条 `page_viewed`，重发不增行，关闭会话后 `event_n 5 / scene_n 3`。**提问闸真机验过 2026-11-10**（dev server 3000 + PG 5433）：没答过就问 `instrumental` → 409 `ANSWER_FIRST` 且库里零新增；先发一条 `answer_attempted` 再问 → 201；`executive` 无前置 → 201。合成数据验完已清掉。**读侧 2026-11-10 落地**：`digestSessions()` 10 例（干净学习按相邻间隔求和 / 去吃饭两小时截断 / **翻页后上限 60 分钟按上一条取** / 两种提示分开数 / 撤销两条判据都过 / 答过与交卷分开数 / 按学习日筛 / 零事件会话仍回一行 / 最近在最前 / 常量固定）+ 路由 9 例（6 分钟 2 页 4 条事件 / 截断只作用于 `activeMs` 不作用于 `wallMs` / `day` 是学习日不是日历日 / 不给 day 就跨全部日期 / limit 乱写回默认 / **读一百次也不许改 `xq_session`** / 非法 day 400 / 非 GET 405 / 两种提示分开数）。**仍缺**：`self_report` 零采集；5 分钟那一档故意没做（`page_viewed` 分不出「在读」与「在翻」）；**对话日志 2026-11-10 落地**：读侧 13 例（一条提问配到它的对话轮次 / **`day` 读的是落库的 `local_day` 不是现算日历日**（UTC `18:30` 那条读到 `2026-11-08`、读不到 `2026-11-09`） / **跨代也要读全**（造两代数据断言都读回来）/ 状态记录不算一轮对话 / 记了问但找不到对话回空数组不是丢掉这条 / 超出时间窗不并进来且差一秒仍算 / 提问之前的对话不算 / 别的课同一个题号不许串 / 长正文按码点截断不出孤立代理项 / 两种分型分开交出去 / 没说题号的提问不进日志 / 最近在前且 limit 生效 / 常量固定）+ 路由 6 例（回一条提问带对话轮次 / 零条时回空数组不是 404 / day 不成形 400 / 空 day 当作没给 / limit 乱写回默认 / 非 GET 405）。**界面 2026-11-10 落地**：客户端 9 例（读回一条提问与轮次 / **读失败与「没有记录」分开** / 200 不是 JSON 仍算没读到 / 网络抛错不冒泡 / 缺身份整条丢而缺标注回空串 / 坏轮次整条丢 / day 与 limit 拼进查询串 / 空 day 与 NaN limit 不拼 / turnSummary 区分「没配上」与「配上了但空」）+ locale 63 例（十二个 locale × 五组，含「没读到」与「没有记录」不许同句、meta 两个占位符、两种分型不同句、键集合一致）。**「学了多久」有界面 2026-11-10 落地**：客户端 9 例（读回一个会话 / **读失败与「今天没学」分开** / 缺身份整条丢 / 没关的会话 `wallMs` 是 null 不是 0 / 返回体不是 JSON 仍算没读到 / limit 乱写不发出去 / 折分钟与页数并标出进行中 / **合计只算已结束的** / 负数不算）+ locale 49 例（十二个 locale × 四组）。**仍缺**：5 分钟窗是产品默认值；入口只有主页工具条的 `home-ai-log-link` 与 `home-sessions-link`，都无角标；会话列表没有按课程分开看。**关标签页能关会话**：`keepalive` 判据 1 条（`xq-event-client.test.ts` 11 条里）+ 接线判据 3 条（`use-xq-page-view.test.ts`，读源码：挂 `pagehide` 不挂 `visibilitychange`、卸载摘监听、依赖数组带 `stageId`）。**服务端兜底**：收尾器 9 例（`xq-session-sweeper.test.ts`：61 分钟收用 60 档 / 59 分钟不收 / 刚打开 31 分钟用 30 档 / 同刻重跑只落一条 / 已正常结束不再被收 / `stage_id` 空跳过 / 收尾事件带 stage / 两条会话各按自己档判 / `limit 0` 什么都不查）+ 路由 3 例（读一次后不再是进行中 / 第二次不再收 / 收尾抛异常仍回 200）。**仍缺**：没有定时任务。 |
| SR-F11.11 | M14 | 有 | 写入器 11 例（答对只关这一关 / 答错四关全重排 / 跳过不写事件只标关 / 关不存在抛且不写假事实 / 同刻重投只留一条 / **真的又错一次就该是两条** / payload 带 round 与 outcome / 记完不再到期 / **同一时刻关四关要四条事件**（幂等键曾不含 `round`，第 2/3/4 关被当重投丢掉而排期照样关 / 同一关重投只一条 / `+08:00` 与 `Z` 两种写法算同一瞬间）；路由 10 例（答对 201 / 答错重排 / 跳过 201 且 eventId 为 null / 重投 200 + duplicate / 关不存在 404 而非 400 / outcome 拼错 400 / round 必须正整数 / 缺 sessionId 拒 / 非 POST 405 / 记完少一条）。**真机端到端跑过 2026-11-10**（PG 5433 + dev server 3000，合成一道题一关）：`pass` → 201 且 `xq_review_schedule` 那一行 `done_at` 非空、`outcome='pass'`、`review_passed` 事件 1 条；同一请求重投 → 200 `duplicate: true` 且事件仍 1 条；`skip` → 201 且 `eventId: null`、只标关不写事件；不存在的关 → 404 `REVIEW_ROUND_NOT_FOUND`。**降级规则 2026-11-10 已落地**：`prior` CTE 数 `review_failed` + `REVIEW_RESET_LADDER` 两行阶梯（第一次 1/3/7/15、第二次起 3/7/15/30，整行后移），判据 `tests/persistence/xq-learner-store.test.ts` 25 例；真机验过「第一次 fail 后仍 1/3/7/15，第二次 fail 后变 3/7/15/30」。**读侧 2026-11-10 落地**：`GET /api/persistence/xq/reviews` 9 例（到期关带页标题与题面 / 判据与 `dueReviews()` 同一条 / 页被删到期不消失 / 题号对不上只丢题面 / `limit` 数到期行 / `limit` 乱写不报错 / 关掉后不再出现 / 只许 GET 与 POST / 长题面截断 160 字）。**界面 2026-11-10 落地**：`/review` 页（`app/review/page.tsx` + `components/learning/due-review-list.tsx`）挂载即读队列、按页分组、三个按钮交结果、成功即移出列表；客户端 `lib/learning/xq-review-client.ts` 14 例（读失败与空列表分开 / 缺字段整条丢 / 交失败不重试 / 卡片身份带 round / 跨课同页不并组），十二个 locale 文案 26 例。**入口 2026-11-10 落地**：首页 `.home-top-tools` 里加 `home-review-link`（`Link href="/review"`，`aria-label` 取 `review.title`），5 例守「链接还在 / 文案来自 locale / 角标挂在链接里 / 链接要 relative / 复习页仍 force-dynamic」。**到期信号 2026-11-10 落地**：`components/learning/due-review-badge.tsx` 在入口里显示今天到期关数，`focus` 时重读、封顶 `50+`；5 例守纯判定 `badgeText()`（`null` 沉默 / 0 沉默 / 正数照写 / 到顶写 `50+` / 负数当没有）—— 最要紧的是**没读到也不显示**，把「没读到」画成「没有」会让人真的不去复习。**仍缺**：只有首页这一处，也没有主动推送 |
| SR-F11.12 | M14 | 有 | 纯判据 21 例（只认 25/50/75/95 / 近似值与字符串不收 / 坏条丢不抛 / 空题号不是题 / 数组与 `null` 当没有 / `withConfidence` 不改入参 / `answeredQuestionIds` 跳过空白 / 没作答不选自评也不挡 / 缺口点得出来 / 一道没判出什么都不说 / **不到 8 题不出标签** / `correct:null` 不计入 / over / under / good / 边界 bias 25 算 over / 只吃两边都有的题）+ 不判定判据 3 例（**读源码**：掌握度里不出现 `confidence_pre` / `confidencePre` / `ConfidenceMap` / `ConfidenceLevel`；`EvidenceItem` 块干净；自评只经探针落 `confidence_pre`）+ 探针 22 例（自评落进 `confidence_pre` / 没自评留 `NULL` / **自评不影响判定**，自评故意给反的）+ 视图状态 9 例（四条完整对象断言都带 `confidence`）+ 十二个 locale 各 12 键。**仍缺**：只在播放态做题页能填；`confidence_post` 零采集；校准只在本页显示一次 |
| SR-F11.13 | M14 / M9 | 有 | `refreshLearnerStateWithConnection()` 5 例（库连不上不抛 / 没配路径时在碰库之前返回 / `onRecorded` 用 `pool` 不新建 / 复习成功分支也刷 / 两处都 `void`）+ `onRecorded` 组 4 例（插了新事实叫一次 / 重复投递不叫 / `correct===null` 全跳过不叫 / 钩子炸了不影响 `inserted`）。**仍缺**：练习 `result.json` 是磁盘来源无感知；无节流。 |

## 累计

- 有判据：**33** 条
- 松（部分覆盖）：**19** 条
- 只能人工：**8** 条
- 无判据：**3** 条（SR-F10.7、SR-F11.6、SR-F11.8）
- 合计 **63** 条逐域 SR（另有 8 条跨域 SR-NF，判据在 `conventions.md` 各节，随 `scripts/check-layers.py` 与测试套一起跑）

（本表 2026-11-08 增补 F11 后重数：F1–F10 仍是 50 条、判据分布 27/14/8/1 不变；F11 九条为 1 有 / 3 松 / 5 无。合计 59 条逐域 SR。（2026-11-09 后补 SR-F11.10「事件流与会话包络」，F11 变十条 2 有 / 3 松 / 5 无，合计 60 条、有判据 29 条；同日后补 SR-F11.11「计划必须与事实对得上」，F11 变十一条 3 有 / 3 松 / 5 无，合计 61 条、有判据 33 条。）2026-11-13 修匹配链六处失效（F1/F2 模糊匹配、F5 判重、F6 后到归并、F7 拒绝语义、F10a 证据形状），SR-F11.9 的判据从 33/19 增到 44/30，**计数不变**（仍 63 条 / 有判据 33 / 松 19 / 无判据 3）。2026-11-10 再补 SR-F11.12「自评只进事实表」，F11 变十二条 4 有 / 3 松 / 5 无，合计 62 条、有判据 31 条。同日后补的 SR-F11.8 / F11.9 来自「外来课程怎么接」这个问题的定案 —— 答案写在意图层 N31 / N32，两条都是未落地。2026-11-10 又补了 SR-F11.4 的**结构**那一半（图谱版本表 + 概念表 expand + 重测链），它有判据了所以从「无判据」挪进「有判据」：F11 不变仍十三条 5 有 / 3 松 / 5 无，合计 63 条、有判据 33 条。★ 但 SR-F11.4 的**使用**那一半（按 prereq 排序 / 版本推进 / 导入批次）仍然零，所以它在规格层继续标「未落地」，**这是刻意的**：结构有了不等于这条规格成立。2026-11-10 晚再补它的**读侧**（`xq-concept-graph.ts` + `GET /xq/concepts`，51 例判据）—— 94 条 prereq 边第一次被读，但**排序仍然不许上线**：读得出来「谁在它前面」不等于决定了「他下一步学什么」，后者是产品决策。计数不变（SR-F11.4 早已记「有判据」）。同一晚把 SR-F11.3 从「无判据」挪进「松」：先修边现在**带得出来源**（`source`/`reason` 上了 `ConceptEdge`，`prerequisiteEvidence()` 把依据与结论分开回），但「无证据不得参与排序」这一半仍然是空的 —— 没有任何代码按 `strength` 决定许不许排序，所以是「松」不是「有」。无判据 5 → 4、松 17 → 18。2026-11-10 同日再补了 SR-F11.4 的**种子图进库**这一跳（`xq-seed-sync.ts` + `seed-concept-graph.ts`，14 例）：它不改状态列 —— 「这份数据可再生」不改变「排序不许上线 / 导入批次为零」这两个缺口，但它让「那 104 个概念从哪来」第一次写在仓里的代码上。计数不变。2026-11-10 夜里又把 SR-F11.9 从「无判据」挪进「松」：义项锚落地了（`xq-concept-anchors.ts` + `seed-concept-anchors.ts`，20 例；真机 36/104 概念、147 词），但三段匹配器与提案裁决仍然零 —— 所以是「松」不是「有」。无判据 4 → 3、松 18 → 19，合计仍 63 条。同日稍后三段匹配器也落地（`xq-three-way-match.ts`，30 例；`BIGRAM_TAU` 当时刻意留 `null`、报告脚本不写库；随后补了两道守卫 ——「锚太薄不许否决」24 → 27 例，「外来侧说的正是我们登记的别名时不许否决」27 → 30 例，后者修前真库 25 个概念会被自己的别名否掉、共 85 对；`τ` 标定后补三条判据 30 → 33 例），但**提案裁决与批量裁决仍缺**，所以它继续留在「松」：计数不变（63 条 / 有判据 33 条 / 松 19 条 / 无判据 3 条）。)

## 两个必须记住的「当前断点」

1. **SR-F5.5 续读指针是死指针** —— `nextOffset` 返回了但下游不用；修法二选一：要么实现续读，要么删掉这个字段别骗人。
2. **SR-F10.7 跨宿主可见性未验** —— 这是「不维护两套」的最后一道证据，没验过就不能说换宿主成立。

（原先的第三个断点 SR-F10.2 面板渲染已修并双向验证，故从这里移出。）

## SR-NF 的判据在哪

| SR | 判据 |
|---|---|
| SR-NF1 判定可复现 | `scripts/check-layers.py` + 各测试文件的读数；约定见 `specification/conventions.md` §一 |
| SR-NF2 不许静默降级 | `tests/**` 内各工具失败形态测试；约定见 §二 |
| SR-NF3 提示词缓存稳定 | `tests/agent-runtime/**` 系统消息稳定性测试；约定见 §三 |
| SR-NF4 工具参数严格 schema | 各工具 `parameters` 单测；约定见 §四 |
| SR-NF5 不可信内容只当数据 | 提示词模板与工具描述；约定见 §三 |
| SR-NF6 失败可归因四类 | 各工具失败形态测试；约定见 §四 |
| SR-NF7 文档与代码同源 | `scripts/check-layers.py` 的引用完整性检查；约定见 §六 |
| SR-NF8 跨平台可跑 | CI 在 ubuntu 上跑全量；约定见 §七 |
