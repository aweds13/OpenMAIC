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
| SR-F11.2 | M14 | 松 | `tests/quiz/learner-state-render.test.ts` 的 `known 带置信下界，not-learned 带上界，unknown 带 reason 的人话`（第三态存在；节名 `## 已达判据（…）` / `## 未达判据（…）` / `## 暂未定（…）`）与 `★ stageId 与 sceneId 都在行里 —— 35 个 scene id 跨课复用`（跨课不借）、`★ 每行带 n= / k=`、`★ 零评价词`；「会只由延迟证据推出」由 `tests/quiz/xq-mastery.test.ts` 的 `延迟桶：会 = 隔了几天还答得对` 六例钉住（今天答对的 8/8 判 unknown、延迟桶 < 3 条时全量 10/10 仍 unknown）。**三级分开只有页级** —— 题级**映射**已落库（`lib/concepts/question.ts` → `xq_question_concept`，`tests/concepts/question.test.ts` 19 例；真库 71 行 / 13 页），但题级与知识点级都没有自己的三态读数。题级映射的两处消费都是**标注**：状态块的一格标签、错题四关挂的概念（判据 `tests/persistence/xq-probe-recorder.test.ts` 两条：唯一则用 / 并列则留空且仍排满四关）；历史错题补排期 `scripts/backfill-review-schedule.ts` |
| SR-F11.3 | 无 | 无 | 先修关系在代码里完全不存在（无概念表、无先修表），无判据 |
| SR-F11.4 | 无 | 无 | **未落地**：图谱形态未定，规格只写约束 |
| SR-F11.5 | M14 | 有 | `tests/agent-runtime/practice-results.test.ts` 六例：坏文件跳过不中断、目录不存在不抛、标明来源、文件上限、只有练习结果也写状态、两者都无则不写空文件；实现 `lib/practice/results.ts:117` 注释原文「永不抛」 |
| SR-F11.6 | 无 | 无 | **未落地**：OpenMAIC 与 Obsidian 零集成 |
| SR-F11.7 | M14 / M15 | 松 | 机器文件自带使用规则有断言（`always carries its own usage rules and the do-not-recite warning`）；**「不要手改」标注不存在**，人写/机写两份文件今天互相矛盾 |
| SR-F11.8 | 无 | 无 | **未落地**：无概念表、无来源映射表；设计见 `D:/文档/jelly_ware/_tools/kg/xq/J-外来课程接入设计.md` |
| SR-F11.9 | 无 | 无 | **未落地**：无提案表；导入路径没有任何自动收编概念的入口 |

## 累计

- 有判据：**28** 条
- 松（部分覆盖）：**17** 条
- 只能人工：**8** 条
- 无判据：**6** 条（SR-F10.7、SR-F11.3、SR-F11.4、SR-F11.6、SR-F11.8、SR-F11.9）
- 合计 **59** 条逐域 SR（另有 8 条跨域 SR-NF，判据在 `conventions.md` 各节，随 `scripts/check-layers.py` 与测试套一起跑）

（本表 2026-11-08 增补 F11 后重数：F1–F10 仍是 50 条、判据分布 27/14/8/1 不变；F11 九条为 1 有 / 3 松 / 5 无。合计 59 条逐域 SR。同日后补的 SR-F11.8 / F11.9 来自「外来课程怎么接」这个问题的定案 —— 答案写在意图层 N31 / N32，两条都是未落地。）

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
