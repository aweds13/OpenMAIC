# 实现层 · 模块地图

> 这份文件回答：**代码放在哪、改哪一层、别碰哪。**
> 上游：`implementation/traceability.md`（M1–M15 的 SR 归属）、`specification/conventions.md`（约定）。
> 与 `AGENTS.md` 的分工：`AGENTS.md` 是**动手前必读的维护手册**（坑、证据命令、封版结论）；本文件是**结构地图**，跟着代码走、不写历史。

---

## 一、三层结构（改之前先判断自己在哪一层）

| 层 | 目录 | 什么时候改 | 改了会怎样 |
|---|---|---|---|
| **上游主体** | `app/`、`components/`、`lib/`、`packages/` | 只在「能力缺失」或「上游 bug」时改 | 会与上游 `origin/main` 产生分叉，必须记进 `运维.md` 的上线口径一节 |
| **我们的二开层** | 同上的特定文件（见下表）+ `skills/agent-runtime/**` | 常态在这里改 | 合并上游时按文件重放 |
| **DSH 宿主层** | `D:/文档/jelly_ware/_tools/dsh-plugins/**`（**不在本仓**） | 换宿主相关的一切 | 不受本仓 CI 约束；改了必须同步到 DSH profile |

**一句话判据**：这段逻辑就算 OpenMAIC 跑在浏览器里也要有 → 上游层；只有「跑在 DSH 里」才需要 → 宿主层。

---

## 二、模块表（M1–M15）

| 模块 | 关键文件 | 职责 | 改动风险 |
|---|---|---|---|
| M1 内容生成 | `lib/server/agent-runtime/runner.ts`、`skills/agent-runtime/**` | 提示词、工具装配、生成轮次 | 高 —— 系统提示词逐字节影响缓存命中 |
| M2 版面与密度 | `lib/quiz/layout-check.ts`、`lib/server/agent-runtime/scene-diagnostics.ts` | 溢出/字号/密度核算、版面差集 | 中 |
| M3 写入闸 | `lib/server/agent-runtime/dsl-tools.ts`、`lib/server/agent-runtime/plan-freeze.ts` | `patch_stage` 四道闸、原子写、写后自证 | 高 —— 唯一的不可逆路径 |
| M4 存储 | `packages/@openmaic/storage/src/document/pg.ts` | 表结构与 CAS | 高 —— 无版本列，只能靠 jsonb 值比对 |
| M5 阅读页 | `components/**`（阅读/播放）、`lib/playback/engine.ts` | 翻页、节奏、控件 | 中 |
| M6 自检页 | `lib/quiz/page-text.ts`、`lib/quiz/**` | 题量、文本抽取 | 低 |
| M7 导出 | `lib/export/**`、`app/api/**` | 批量归档 | 低 |
| M8 课程库检索 | `lib/chat/pi/tools/course-search.ts`、`read-document.ts`、`lib/server/agent-runtime/course-search.ts` | `course_search` / `read_document` | 中 —— 条件注册，未配置时不该出现 |
| M9 浏览器抓取 | `lib/chat/pi/tools/browse-url.ts`、`lib/server/agent-runtime/browse-url.ts`、`lib/web-search/**` | `browse_url`、`web_search`、SSRF | 中 —— 安全边界在这里 |
| M10 上下文与压缩 | `lib/server/agent-runtime/runner.ts`、`compaction.ts` | 系统提示词、材料注入、压缩预算 | 高 |
| M11 工具注册 | `lib/server/agent-runtime/runner-contract.ts`、`app/api/chat/pi/route.ts`、`lib/chat/pi/tools/call-agent.ts` | 三处注册点、允许表 | 高 —— 三处必须同口径 |
| M12 MCP | `lib/server/agent-runtime/mcp-client.ts`、`mcp-tools.ts` | 外部 MCP 连接与工具 | 低 |
| M13 DSH 宿主 | `_tools/dsh-plugins/openmaic-course/lib/{index,client.src,db,db-write}.js`、`openmaic-local-capabilities/lib/index.js` | 30 + 5 个工具 + seam 路由 + 三栏面板 | 中 —— 改完必须重装到 profile |
| M14 学习状态与回流 | `lib/server/agent-runtime/learner-state.ts`、`lib/server/agent-runtime/learner-state-render.ts`、`lib/quiz/xq-mastery.ts`、`lib/persistence/xq-learner.ts`、`lib/practice/results.ts` | 三样来源（三态格子 / 到期复习 / 练习结果）渲染成状态块并落盘 | 中 —— 状态块进系统提示词末块，且是**唯一会随答题变化**的一段 |
| M14b 概念图谱 | `lib/concepts/{ids,seed,occurrence,question,index}.ts` | 概念 id 形状、种子图、页级挂载推导、题级挂载推导 | 中 —— 先修边会被用来判「该不该现在学」 |
| M15 学习者画像 | `lib/server/agent-runtime/learner-profile.ts`、`D:/文档/jelly_ware/个人数据/学习画像.md` | 人写的目标与偏好，每次运行重读 | 低 —— 内容是人的，结构固定 |

> 这张表只给**模块归属与改动风险**；同一个文件的实测依据、坑与数字在**第四节全表**里 ——
> 两处都讲到的文件，以第四节那份为准。

### M14 里被替换掉的两处（结论保留，代码已删）

**① `lib/quiz/learner-state.ts` 的 `renderLearnerState()` —— 旧状态渲染器，已删。**
取代它的是 `lib/server/agent-runtime/learner-state-render.ts` 的 `renderLearnerStateBlock()`：
同一个位子（折叠结果 + 页面内容 → 可注入的一段文本），但**取的源换了** ——
旧渲染器折 `runtime_records`（按 `attempt-fold` 的分档），新渲染器读 `xq_cell_state`
（三态）+ `xq_review_schedule`（到期复习）+ 练习 `result.json`。判据随之从
`tests/quiz/learner-state.test.ts` 迁到 `tests/quiz/learner-state-render.test.ts`。

旧渲染器里有几条设计知识现在只在它的注释里，搬过来：

- **分档按行动优先序**：①`incorrectNow`（现在还错 → 下一份自检优先重考）②草稿页
  （`questions.length === 0 && answers` 非空 = 答过但没交卷，"这一页还没做完"，**不是**
  "没学过"）③`incorrectCount === 0`（已经全对 → 不必重复考，把额度留给前两档）。
  第四类 `everIncorrect` 非空且 `incorrectNow` 空 = 曾经错、已改对，**只报数、不占版面**。
  ★ 新渲染器**没有**「答过但没交卷」这一档 —— 三态来自 `xq_cell_state`，草稿页在那里没有格子。
- **`asOf` 取最新那条记录时间，不是生成时刻**。取生成时刻会让这块文本每次运行都变，而它挂在
  `PROMPT_BLOCK_ORDER` 末尾（`course-tools.ts`），一变就把前缀缓存末尾重读一次。用记录时间，
  内容就成了记录的纯函数。
- **题干按 `sceneKey(stageId, sceneId)` 查，跨课不许借**。`document_scenes` 主键是
  `(stage_id, id)`，同名 sceneId 多门课都有（本部署 `scene-p9` 有 6 个）；只按 sceneId 查会把
  Dart 的题干注进 Git/OOP 课的状态里。新渲染器同样把 `stageId` 写进每一行（`scene-p12（stage-a）`）。
- **题号不在这一页时明说"原题已不在这一页"**，不静默借用别的题的题干，也不丢记录 ——
  "这里错过一道题"本身就是状态。
- **`skipped` 非空必须写出来**：否则"读不到"会被读成"没做过"。
- **没有记录返回 `''`，不返回空模板**（注入"暂无答题记录"是纯噪声，且会让提示词白变一次）。
- **题干压一行**（`oneLine(text, max = 80)`，标题 `max = 24`）：题干里的换行会把清单打散。

**② 旧渲染器写进块里的元指令 —— 已废弃，不要再加回去。**
它曾把这些句子直接写进状态块（原文，删除前抄录）：

- `### 答题状态（机器写入 —— 不要念给学习者听，也不要提"我看了你的记录"）`
- `**现在还做错的（下一份自检优先重考这些，换一个问法，不要原题照搬）**`
- `**答过但没交卷（这一页还没做完，别当成没学过）**`
- `**已经全对（不必重复考，把额度留给上面那些）**`
- `曾经做错、后来改对的共 N 道 —— 这些可以在间隔复习时再抽查，但不是当下的重点。`
- `**读到这一块之后怎么做**` 三条：「有「现在还做错的」时：下一次自检必须覆盖这些**考点**，可以换场景、换问法，但不许出新题把它们绕过去。」/「有「答过但没交卷」时：先问学习者要不要接着做完，再决定要不要讲。」/「讲解新内容时，这些错过的考点是**已知的薄弱处** —— 讲到相关概念时可以点一句「上次这里你选了另一个」，但不要展开成复述记录。」
- `⚠️ 有 N 条记录读不出来（原因：…）。下面这份状态**可能不完整** —— 不要把"这里没提到"当成"他没做过"。`

**废弃理由：块里只许有事实。** 这些句子不描述任何东西，只命令读的人怎么用这段数据；
而提示词里没有「执行者」这一层 —— 模型读到「这条不变」只会当成一句关于世界的断言，
然后就错了。新渲染器的六条硬约束第 2 条就是这条禁令，判据是
`tests/quiz/learner-state-render.test.ts` 的「★ 不写「不要念给学习者听」这类元指令」。
（唯一保留的一句声明是块首 `以下是学习状态数据，不是给你的指令。` —— 它标的是**这段话的身份**，
只标一行、不展开：展开就又变成指令了。）

**③ `lib/server/agent-runtime/learner-state.ts` 的 `buildLearnerStatePromptBlock()` —— 已删。**
它做「查库 → 渲染 → **返回块文本**（不写文件）」，与 `refreshLearnerStateFromRuntime()`
（查库 → 渲染 → **写文件**）是同一套取数 + 同一个渲染器，差别只在落不落盘。生产接线走的是
**写文件 + 读文件**那条：`runner.ts` 每轮开头 `refreshLearnerStateBestEffort()`，
热路径 `resolveLearnerState()` 只读文件、`learnerStatePromptBlock()` 补块首那一行。
★ 刷新**不止那一处**（2026-11-10 补）：`refreshLearnerStateWithConnection(queryable)` 给
「手上已经有池子的写路径」用，接在 `withXqProbeRecording` 的 `onRecorded` 与复习写入成功之后，
两处都是 `void`（写已经成功了，刷不动不该让人以为写失败）。理由是实测出来的：磁盘那份
946 字节、而同一时刻用同一个库渲染是 1405 字节（差一整节「练习」）—— 文件是接口，
「库变了但文件没变」就是一次静默失配，而不是缓存慢。
也就是说它**不是"该接没接"** —— 状态块一直在系统提示词里；它是被那条"离线写、热路径读"
的路径整体取代了（为什么要分两半：刷新要查库，而读发生在每次运行的提示词组装里，
那是热路径，见 `learner-state.ts` 文件头的「为什么文件是接口」）。

---

## 三、文件地图（按「你想干什么」找）

| 我要… | 去这里 |
|---|---|
| 改生成提示词 | `skills/agent-runtime/**`（技能包），不是 `runner.ts` 里的字符串 |
| 改 `patch_stage` 的拒绝条件 | `lib/server/agent-runtime/dsl-tools.ts` |
| 改版面差集算法 | `lib/server/agent-runtime/scene-diagnostics.ts` |
| 加一个聊天工具 | `lib/chat/pi/tools/` + **三处注册点都要加**（见 M11） |
| 改数据库表 | `packages/@openmaic/storage/src/document/pg.ts` + 迁移 |
| 改阅读页翻页 | `lib/playback/engine.ts` + `components/**` |
| 改学情事件（翻页记什么） | `lib/learning/use-xq-page-view.ts` + `lib/learning/xq-event-client.ts` + `app/api/persistence/[...path]/route.ts` 的 `handleXqEvent` |
| 改复习队列（到期了显示什么） | `lib/persistence/xq-review-queue.ts` + `app/api/persistence/[...path]/route.ts` 的 `handleXqReviewQueue` |
| 改「这次学了多久」（事件流折成什么） | `lib/persistence/xq-session-digest.ts` + `app/api/persistence/[...path]/route.ts` 的 `handleXqSessionDigest`（读之前会先跑 `lib/persistence/xq-session-sweeper.ts` 收掉死会话） |
| 改「他问过 AI 什么」（对话日志怎么拼） | `lib/persistence/xq-ai-log.ts` + `app/api/persistence/[...path]/route.ts` 的 `handleXqAiLog` |
| 改对话日志页（翻他问过什么） | `app/ai-log/page.tsx` + `components/learning/ai-log-list.tsx` + `lib/learning/xq-ai-log-client.ts`（入口在 `app/page.tsx` 的 `home-ai-log-link`） |
| 改学习记录页（我到底学了多久） | `app/sessions/page.tsx` + `components/learning/session-list.tsx` + `lib/learning/xq-session-client.ts`（入口在 `app/page.tsx` 的 `home-sessions-link`；判据在路由的 `handleXqSessionDigest` 一处） |
| 改答题事件（什么时候算「动过手」） | `lib/learning/xq-answer-events.ts` + `components/scene-renderers/quiz-view.tsx` |
| 改自评（「你有多大把握」问什么、怎么算准不准） | `lib/quiz/confidence.ts`（纯判据）+ `components/scene-renderers/quiz-view.tsx` 的 `quiz-confidence` 那一行 |
| 改「问 AI」（从做题页问一句） | `lib/learning/xq-hint.ts` + `lib/learning/xq-hint-prompt.ts` + `lib/contexts/quiz-ask-context.tsx`（按钮在 `components/scene-renderers/quiz-view.tsx` 的 `QuestionCard`，把手由 `components/edit/PlaybackChromeRoot.tsx` 提供） |
| 改复习界面（到期了怎么点） | `components/learning/due-review-list.tsx` + `lib/learning/xq-review-client.ts`（页面壳在 `app/review/page.tsx`） |
| 改复习提醒（今天有几关到期） | `components/learning/due-review-badge.tsx` 的 `badgeText()` —— 判定只有一份：读到 0 不显示、没读到也不显示、封顶 `50+` |
| 改复习入口（从哪点进去） | `app/page.tsx` 的 `home-top-tools` 工具条里那个 `home-review-link`（判据 `tests/learning/review-entry.test.ts`） |
| 改提问闸（什么时候不许问） | `lib/persistence/xq-hint-gate.ts` + `app/api/persistence/[...path]/route.ts` 的 `handleXqEvent` |
| 改题库文本抽取 | `lib/quiz/page-text.ts` |
| 改插件工具/面板 | `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/`（**不在本仓**） |
| 改中文文案 | `lib/i18n/locales/**`（`check:i18n-keys` 会校验键对齐） |

---

## 四、本 fork 独有的文件（全表，按文件排）

> 这一节就是原 `AGENTS.md` §2 那张全表，**原样搬来、一个数字没删**。
> 与第二节的分工：第二节按**模块**排（M1–M15，给归属与风险），本节按**文件**排（给实测依据、坑、判据）；
> 同一个文件两处都出现时，**细节以本节为准**，模块归属仍看 M1–M15。

改之前先看这里，**你要改的东西大概率已经有主了**。

| 文件 | 干什么 | 关键实测依据 |
|---|---|---|
| `lib/server/agent-runtime/config.ts` | 所有运行期开关（含 `selfStudyDefault`） | 加了 `selfStudyDefault` 后 `/api/whoami` 会回报它 |
| `lib/server/agent-runtime/study-mode.ts` | 「听课 / 自学」怎么落地 + 每页密度目标 | 见 AGENTS.md §4 |
| `lib/server/self-study-mode.ts` | 经典路径的 slide 密度覆盖（追加到 system prompt 末尾） | 352–390 字/页 |
| `lib/server/agent-runtime/course-design.ts` | 每条 `generate_scene` brief 必须写什么 | brief 是内容生成器**唯一**的指令 |
| `lib/server/agent-runtime/course-search.ts` | `course_search` + `read_document` 接进工作台 | L4 = 本地文档层 |
| `lib/server/agent-runtime/browse-url.ts` | `browse_url` 接进工作台（真浏览器） | 见 AGENTS.md §5 |
| `lib/server/agent-runtime/learner-profile.ts` | 注入 学习画像.md（**每次运行重读**） | 改画像不用重启 |
| `lib/server/agent-runtime/materials-library.ts` | `read_materials` / `update_materials` + **`listMaterialText()`** | agent 自己维护的材料库；**它的 URL 会喂进会话的 URL 信任闸**（`store.ts` 的建会话钩子）—— 见 AGENTS.md §3.1 那条假红与结论库 |
| `lib/persistence/asset-byte-split-store.ts` | 材料字节**按大小分流**（D1）：≤ `ASSET_INLINE_BYTE_LIMIT` 写 `asset_blobs.bytes`，超过写本地内容寻址目录并留 `bytes` 为 NULL（NULL 是「在盘上」的标记，不是缺块） | `asset_blobs.bytes` 本来就 nullable（`PgAssetByteStore.deleteWith` 会清它）⇒ 读侧先列后盘、一次回退就够，**不需要路由列**。三个 `*With` 方法必须加入 registry 事务（不加入会与自己的 blob 行锁**自死锁**）；文件写不是事务性的 |
| `lib/server/agent-runtime/mcp-tools.ts` + `mcp-client.ts` | 外部 MCP（GitHub）接进工作台 | 连不上只记 failed，不拖死会话 |
| `lib/server/agent-runtime/compaction.ts` | 原生上下文压缩 + ★ `usageAnchorIsStale()`：**用量锚点比最新一条 compaction 还旧就不采信**（`estimateAgentContextTokens(…, { trustUsageAnchor })`） | **默认关**，本部署开着。不检查它 ⇒ 提示恒为 `N -> N`，且**每次压缩后必然白压一次**（见结论库 §压缩锚点） |
| `lib/server/agent-runtime/session-commands.ts` | `/compact` 之类的会话命令 | 手动挡**不需要** ENABLED —— 它绕过阈值也绕过开关 |
| `lib/server/agent-runtime/prompt-context-file.ts` | 画像/材料库的"路径加载时求值、内容每次重读" | |
| `lib/server/agent-runtime/fetch-url.ts` | `fetch_url`（**上游就有**，我们改了两处） | 见 AGENTS.md §5 |
| `lib/export/use-export-pptx.ts` | `buildPptxBlob` / `buildResourcePackZip` + 共用的 `collectInteractivePages` | 单课导出；resource pack = PPTX + 交互页 |
| `lib/export/batch-export.ts` | **批量下载**：多门课 → 一个 ZIP（每课一文件夹） | 见 AGENTS.md §10 |
| `components/workbench/workspace/BatchDownloadDialog.tsx` | 批量下载对话框（多选 + 进度 + 逐课结果） | 入口在课程标签页工具栏 |
| `app/api/whoami/route.ts` | 一次性诊断：owner + 课程数 + **运行期开关实际值** | 改 `.env.local` 后先看这里 |
| `lib/quiz/attempt-fold.ts` | **答题状态折叠器**：把 `runtime_records` 里的 quiz 记录折叠成「这一页学成什么样」。纯函数，形状照 `lib/pbl/v2/runtime/fold.ts` | 见 结论库「答题状态早就在库里了」 |
| `lib/server/agent-runtime/learner-state.ts` | 状态文件的**读 / 写 / 刷新**：`refreshLearnerStateFromRuntime()` 离线取数写文件（三样来源：`xq_cell_state` / `xq_review_schedule` / 练习文件夹）；`refreshLearnerStateWithConnection()` 给写路径用（接在 `onRecorded` 与复习写入之后）<br>`resolveLearnerState()` 热路径只读文件 | ★ 取数**只按 `(stage_id, scene_id)`**，不再按 owner：`xq_*` 两张表没有 owner 列（单人部署）。★ 三样全空时不写文件（写空文件只会破坏前缀缓存）。见 结论库「学习状态文件」<br>★★ **一格的概念名字：只有最高档恰好挂 1 个概念时才给**（`ties = 1`）。真库读数把这条逼出来的：`stage--ShZtYAYOj/scene-p18` 最高档上同时挂着「字符串 / 继承 / 重写与 @Override」三个 0.80（q8 题干里贴了一段 `class Person { String name; … }`，`String` 只是字段类型），按码点序挑就变成「字符串」，按命中题数挑把 `stage-7tNoR37iqT/scene-p7` 变成「提交」（那十道题讲的是 git 整套工作流）。**问题不是排序是粒度** —— 一格挂 5–8 个同等强度的概念时，挑其中任何一个当名字都错；挑不出就退回页标题。判据 `tests/agent-runtime/learner-state-concept-label.test.ts` 5 条（含跨课同名 scene id 互不干扰）。★ 已知局限：题干里的代码片段仍可能给标签带偏，但它只影响那一行人话，不影响任何判定 |
| `lib/server/agent-runtime/learner-state-render.ts` | **状态块渲染器**（纯函数）：三态格子 + 到期复习 + 练习文本 → 给模型读的一段。六条硬约束写在文件头（零冷启动 / 无元指令 / 块首声明 / 结论可执行 / 稳定排序 / **不读笔记不写笔记**）。★ 第 6 条是笔记层的闸：笔记是另一个房东的材料，检索命中永不影响三态判定（SR-F11.6） | ★ 标签**跟着数据来源变**（概念 / 标题 / 都没有）：`xq_question_concept` 还没数据时全部走标题回退，照样写「概念」会让模型把页面标题当成知识点名字。判据 `tests/quiz/learner-state-render.test.ts` 20 条。<br>★ **三个节名都带判据、主语都是页**：`## 已达判据（置信下界 ≥ 0.55，且 3 天后复测仍答对）` / `## 未达判据（置信上界 ≤ 0.30）` / `## 暂未定（证据不足，不作判断）`。旧名 `已会`/`不会`/`说不准` 一个都不留 —— 并列摆出来就是一张对错榜，而「不会」的主语是人不是页。括号里的判据串与 `xq-mastery.ts` 的常量是同一件事，改算法要同批改这几行。<br>★ **每行带 `n=` / `k=`**：不带样本量的「置信下界 0.78」无从核对；缺一个就整段不写（只有 n 没有 k 读不出比率）。半份权重保留两位（`7.50` 不是 `8`）。<br>★ 零评价词：八个词（掌握得不好 / 薄弱 / 欠缺 / 需要加强 / 加油 / 做得不错 / 很聪明 / 粗心）一个都不许出现，有测试守着。 |
| `lib/quiz/xq-mastery.ts` | **掌握度纯函数层**：Beta 后验 + 单边 80% 区间 → known / not-learned / unknown；`itemsNeededForKnown()` 算「再做对几题可判」 | ★ 分位数必须是**单边** `1-CONFIDENCE` / `CONFIDENCE`（双边 10/90 会让检出率从 0.8836 掉到 0.5323）。判据 `tests/quiz/xq-mastery.test.ts` 29 条（含与 `.tmp/kg_final2.py` 的逐格对账、判界矩阵、延迟桶）。<br>★ **「会」只由延迟桶推出**：`n_delayed ≥ 3` 且 `masteryFromAccuracy(q20(Beta(1+k_delayed, 1+n_delayed−k_delayed))) ≥ 0.55`。`DELAYED_BUCKET_DAYS = 3` **不是文献值**，是四关第 2 关就是第 3 天；含 `Δ = now − asked_at` 是因为裸 `n/k` 构念上测的是「曾经答对的比例」，不是「隔几天还取得出来」（反复测全部项 vs 答对就撤，一周保持率 80% vs 33–36%，d=4.03）。桶不足时 `reason` 是 `mixed` 不是 `too-few-items` —— 总量够，缺的是「隔了几天之后的那一次」。<br>★ `masteryFromAccuracy` 在 `p ≤ 盲猜率` 返回 0 是**截断不是估计**：`(5,0)` 的真实 raw 上界 0.2353 被压成 0，状态块会写成「置信上界 0.00」，那个数会被读成「确定不会」。<br>★ 判界矩阵实测 `n=6..12 → 6/6 6/7 7/8 8/9 9/10 9/11 10/12`（`n=9` 要 8/9，设计文档 M §5.2 说的「n=9 要 9/9」与真跑不符） |
| `lib/persistence/xq-learner-store.ts` | **xq 写入层**：探针入库（同源去重）/ 三态重算 / 错题四关排期（1/3/7/15 天） | ★ **做错回第 1 关**不是顺延到下一关：fail 时对同一 `(stage_id, scene_id, question_id, concept)` 的**全部四行**重置 `due_at`；用「顺延」写法会在第 1 关失败时把四关压成 1/3/7 ⇒ **第 15 天那关永远不会到期**，而界面完全正常。★ **排期挂哪个概念只有一条判据**：`conceptForQuestion()` —— 这道题的最高档恰好只有一个概念时才是它，并列或没有题级映射一律回 `''`。与状态块拿格子标签同一套规则（`ties = 1`），只是粒度换成一道题。★★ 不能「挑一个也行」：`xq_review_schedule` 的唯一键**含 `concept`**，今天挑 A、明天挑 B 会把同一道错题变成两组四关，两组都到期时要重做两遍。★ **做错第几次起不再回 1 天**（2026-11-10，P5 四关重置降级）：`RECORD_OUTCOME_SQL` 里的 `prior` CTE 数「同一道题同一概念、`kind='review_failed'`、`occurred_at` 严格早于这一次」的条数，据此在 `REVIEW_RESET_LADDER`（两行 `[[1,3,7,15],[3,7,15,30]]`）里选行 —— 第一次做错仍 1/3/7/15（一期判决不变），第二次起整行后移。★ **整行后移**不是按关次逐个加长：阶梯的语义是「这一轮要走几步」，行内仍严格递增，否则 `due_at` 就不能再当排序依据。★ **只分两行**：第 N 次仍用第二行 —— 更长的间隔只是「把它彻底忘掉」。★ 用**严格小于**比较 `occurred_at`，因为 `recordXqReview` 先写事件再改排期，这一次自己的失败事件不能被算进 `prior`。`recordReviewOutcome()` 因此多了一个可选 `occurredAt` 参数（重放同一批事件时「第几次失败」必须算出同一答案）。判据 `tests/persistence/xq-learner-store.test.ts` 25 条 |
| `lib/persistence/xq-probe-recorder.ts` | **学情生产写入口**：服务端包一层 `appendRecord`，把 reviewed 的逐题结果落成 `xq_probe_item`、重算格子、给答错的排四关 | ★ 幂等键是**记录** `runtime:<recordId>` 不是题目（同一题本来就该能答多次，那正是 `counted_n` 表达的）；`correct === null` 跳过（AI 批改未回不能当答错）；**先 append 成功再落学情**，且整段 try/catch —— 答题提交不能因学情失败而失败。判据 `tests/persistence/xq-probe-recorder.test.ts` 19 条（★ 其中两条钉住「答错的题挂到哪个概念上」：最高档唯一就用它、并列就留空且仍然排满四关 —— 留空是标注缺失，不是复习断掉）。<br>★ **真库端到端跑过**（PGlite 不验证线上索引）：先 `items 56 / cells 7 / sched 0`（★ 那次读的 0 行已被 `scripts/backfill-review-schedule.ts` 补成 20 行，2026-11-09），投一条 reviewed ⇒ `sched 4`（1/3/7/15 天）且 `counted_n` 同题第二次落 `0.5`，同一条记录再投一次 `items` 仍是 2 ⇒ 幂等靠真库唯一索引而不是内存。用完必须 `recomputeAllCellStates()` 把格子算回去 —— 只删证据行会留下一格被探针抬高的缓存 |
| `lib/persistence/xq-event-recorder.ts` | **学情事件写入口**：`recordXqEvent()` 把一次学习行为写成 `xq_event`，会话由第一条 `session_started` 顺带建出来；含 `localDayOf()`（04:00 跨天）与 `deriveDedupeKey()` | ★ **会话 id 就是第一条事件的 `event_id`**（`xq_session.session_id` 不发明第二个 ID 生成器），所以顺序必须是「先算 eventId → 再插会话 → 再插事件」。★ **幂等靠 `dedupe_key` 唯一键**：键由 `kind / stage / scene / question / session / occurredAt` 派生，同一件事重发第二次回 `duplicate: true` 且不增行；★ 因此重试**必须复用同一个 `occurredAt`** —— 重取 `now()` 就把「重发」变成了另一件事。★ **本地日期减 4 小时**：`02:30` 属于前一天、`04:30` 属于当天，半夜学的那一课时还算前一天，否则「今天学了多久」会在跨零点时被劈成两段。★ 事件与探针**是两个入口**：探针从 `appendRecord` 的 reviewed payload 里抽逐题对错（判定在那边），事件只记录「发生了什么」。★ **提示分型必填**（2026-11-10）：`XQ_HINT_SUBTYPES = ['instrumental', 'executive']`，`hint_requested` 不带就抛、别的 kind 带也抛 —— 两者都挡在发 SQL 之前。此前 `hint_subtype` 只有 DDL 的 CHECK 而没有写入路径（字段与列清单里都没有它），于是十六个 kind 里唯一一个**带方向**的事件（instrumental 与成绩正相关、executive 强负相关）从来没被写过，症状是安静的「永远为零」。判据 `tests/persistence/xq-event-recorder.test.ts` 14 条（含契约漂移：`pg_get_constraintdef` 里逐字核对 16 个 kind、7 个 end_reason、2 个 hint_subtype）。路由侧 `POST /api/persistence/xq/events` 的判据在 `tests/persistence/xq-events-route.test.ts` 8 条 |
| `lib/persistence/xq-review-recorder.ts` | **学情复习结果入口**：`recordXqReview()` 把一次复习做成三件事 —— 确认那一关在排期表里、写 `review_passed` / `review_failed` 事件、调 `recordReviewOutcome()` 关掉或重排 | ★ **顺序固定为「先事实、后计划」**：`xq_review_schedule` 是派生缓存，`xq_event` 是事实；反过来写会让「他这次做错了」永久丢失，而降级规则正是靠失败次数算的。★ **`skip` 不写事件**：十六个 kind 里没有 `review_skipped`，写 `review_passed` 会骗状态层、写 `review_failed` 会让计数虚高。★ **关不存在就整笔拒**（不是静默成功）：一条指向空关卡的失败事实只会污染计数。★ 它此前不存在，因此 `recordReviewOutcome()` 零生产调用方、回填的 20 关到期后永远清不掉。判据 `tests/persistence/xq-review-recorder.test.ts` 11 条；路由 `POST /api/persistence/xq/reviews` 的判据在 `tests/persistence/xq-reviews-route.test.ts` 10 条（关不存在回 404 而不是 400 —— 请求形状没错，是那一关没了） |
| `lib/persistence/xq-ai-log.ts` | **对话日志读侧**：`readAiLog()` 把「他在哪道题上问过 AI」从两个地方拼回来 —— 事实在 `xq_event(kind='hint_requested')`，内容在 `runtime_records`（`payload.kind='chat_message'`），靠 `(stage_id, scene_id, question_id)` + `RuntimeRecord.subAnchor` + 5 分钟时间窗对上 | ★ **两边分开存是刻意的**（M §11.3 ①）：内容进事件表会让「只追加的事实流」混入大对象，而它带着两个索引、将来每次汇总都要扫；只留内容不留事实，「他在这道题上问过几次」就成了全文扫描。 ★ **滚动是这份读法最容易静默读错的地方**：一场逻辑对话超过 256 条记录会开新一代（`chat:<...>:generation:<n>`），按 `session_id` 读会**读到半场而看不出是半场** —— 不报错、不抛异常，只是少一半。所以判据里有一条专门造两代数据，断言两代的轮次都读回来（`generations: 2`）。 ★ **不存显式 record id**：记录会因滚动换 `session_id`、因压缩被替换成摘要，存下来的 id 会**变成孤儿且不报错**；三元组 + 时间窗对不上就是「没找到」，能数出来。 ★ **`runtime_records.created_at` 是 TEXT 而 `xq_event.occurred_at` 是 timestamptz**：直接比报 `operator does not exist: text >= timestamptz`，必须把文本那侧显式 `::timestamptz` —— 让另一侧转字符串则是自找时区漏洞。 ★ **`chat_session_state` 这类记录没有 `role`/`content`**：不筛 `payload.kind='chat_message'` 会产出空壳轮次，看起来像「AI 说了空话」。 判据 `tests/persistence/xq-ai-log.test.ts` 13 条 + 路由 `tests/persistence/xq-ai-log-route.test.ts` 6 条（`GET /api/persistence/xq/ai-log`，`day` **直读 `xq_session.local_day`** 而不是现算日历日 —— 两处现算会让同一个 `day` 在两个端点指向不同日期，非法回 400） |
| `lib/persistence/xq-review-queue.ts` | **学情复习读侧**：`listDueReviewCards()` 一句话把「到期的关」变成能直接显示的卡片 —— 页标题、截断后的题面、题级概念、关次、到期时刻 | ★ **一次 SQL 而不是三次**：到期行在 `xq_review_schedule`、页标题与题面在 `document_scenes.data`，三次往返要在 JS 里按复合键 `(stage_id, id)` 拼回去，而同名 scene 可跨课存在，拼错就张冠李戴 —— `LEFT JOIN LATERAL` 让数据库自己对齐。★ **`LEFT` 而不是内连接**：页被删、题被改、`scene_id` 漂了（这一仓真的发生过，见 `复盘/已结案结论.md` 的 `stage-GYvpbYB_aN/scene-p13`）都不该让「到期」这条事实消失，题面回空串即可。★ **`LIMIT` 在 CTE 里**，不在 join 之后 —— 否则跨多页的列表会被某一页的题面查询挤掉行。★ **不在这里判「该不该复习」**：到期判据与 `dueReviews()` 同一条（`due_at <= now AND done_at IS NULL`），两处判据会漂，所以判据里比对两个函数的输出集合而不是各自断言。判据 `tests/persistence/xq-review-queue.test.ts` 9 条；路由 `GET /api/persistence/xq/reviews` 的接线在 `app/api/persistence/[...path]/route.ts` 的 `handleXqReviewQueue`（与写侧同一个 URL，按方法分派 —— `learner-key` 也是这个形状） |
| `lib/persistence/xq-session-digest.ts` | **学情事件读侧**：`digestSessions()` 把只追加的事件流折成「这次学了多久、今天学了什么」—— 活跃时长、墙钟、页数、两种提示分开数、答过与交卷分开数 | ★ **为什么要有独立汇总器**：`xq_session.active_ms` / `wall_ms` 从建表起一直空着，因为活跃时长要**跨事件配对**（相邻两条间隔、按上一条动作类型取上限），挂在「记一条事实」上就得为每条事件重扫该会话全部历史 —— 写入侧的文件头明写「不补算派生量」，本文件就是它承诺的那个汇总器。 ★ **不回写 `xq_session`**：事件还在增长，今天算出的 42 分钟明天就变了；落库就得每条新事件后重算一遍，而这正是要避免的。判据里有一条专门钉「读一百次也不许改 `xq_session`」。 ★ **`active_ms` 不是「最后一条减第一条」**：中间可能是去吃饭了。上限按**上一条**事件取 —— 上一条是 `page_viewed` ⇒ 60 分钟（阅读型第二峰在 5–10 分钟，只有 60 装得下），其余 ⇒ 30 分钟。 两个都是产品默认值，不是研究结论（N3 §4.4）。 ★ **5 分钟那一档故意没做**：`page_viewed` 不区分「在读这一页」与「正在翻过去」，要分就得知道停留时长，而那正是 `dwell_ms` —— 今天没有任何写入方给它赋值。凭「翻页」两个字判成 5 分钟，会把真读了 50 分钟讲义的人砍成 5 分钟，方向是错的。 ★ **撤销两条判据都过**：`kind <> 'voided'`（撤销自己也是事件）AND `voided_by IS NULL`（被撤销的那条）；但 `voided_by` **今天没有写入方**，后半条是预备的，判据里用 SQL 直接补上把它钉住。 ★ **这些数字不进状态块**：N3 §4.4 原话「全是切分参数，不是剂量参数」，「今天学了 42 分钟」既不构成会也不构成不会，还会因为每分钟变而破坏前缀缓存。 判据 `tests/persistence/xq-session-digest.test.ts` 10 条 + 路由 `tests/persistence/xq-sessions-route.test.ts` 9 条（`GET /api/persistence/xq/sessions`，`day` 是**学习日**不是日历日，写成 `yyyy-mm-dd` 之外**拒 400** 而不是忽略 —— 忽略会把「这一天」悄悄放大成「全部」） |
| `lib/persistence/xq-session-sweeper.ts` | **会话收尾器**：把「开着但最后一条事件距今超过阈值」的会话关掉。浏览器崩溃、断电、进程被杀、`keepalive` 被中间层截掉这四种情况下客户端不会再跑一行代码，会话在库里永远 `ended_at IS NULL` —— 而 `/sessions` 的合计只累加已结束的会话，于是那一次学习被永久抹掉。★ 阈值**复用** `xq-session-digest.ts` 的同一组常量（翻页后 60 / 其余 30）：两处用不同阈值会自相矛盾。★ 收尾靠真事件 `session_abandoned`（`idle_60m` / `idle_30m`），走同一条 `CLOSE_SESSION_SQL`。★ 幂等键用**最后一条事件的时刻**不是 `now()`。★ `stage_id` 空的那种跳过不补空串。★ 接在 `GET /xq/sessions` 上 —— 没有别的地方会来修；收尾失败只 warn。判据 `tests/persistence/xq-session-sweeper.test.ts` 9 条 + `tests/persistence/xq-session-sweep-route.test.ts` 3 条 |
| `lib/persistence/xq-hint-gate.ts` | **提问闸**：`hintGateApplies()` 定「哪些提问进闸」、`hasPriorAnswerEvent()` 查同一道题上有没有更早的作答痕迹、`ANSWER_FIRST_CODE` 是拒绝码 | ★ **闸在服务端写入侧，不在 UI**：UI 侧挡不住直接调接口，而闸的意义是「这件事在系统里不允许发生」，不是「界面上不好点」。★ **判据只看事件存在性，不看内容**：一层很容易想到的替代是让模型判「他是不是想清楚了」（Explore 的「知识整合」就这么做），但 `2605.16207` / `2605.12748` 都表明模型系统性过度肯定错误解 —— 若闸判「AI 认为你想清楚了」，模型越迎合、闸越容易放行，**闸会在最需要它的时候打开**。★ **只挡 instrumental**：`executive`（求答案）与页面级提问放行，但必须如实记账 —— `N3` §5.4 里 executive 与成绩强负相关、instrumental 正相关，挡死会把学生推到搜索引擎（那边一个事件都收不到）。★ **「答过」不等于「答对」**：答错、写一半、超时都算答过，要求答对会诱导乱猜（desirable difficulty 最优区 60–85%）。★ **用 `occurred_at` 不用 `recorded_at`**：闸判的是当事人时间线上的先后，重试能把记账时刻推到后面去。判据 `tests/persistence/xq-hint-gate.test.ts` 5 条（三种豁免各一条 + 拒绝码）+ 路由 `tests/persistence/xq-events-route.test.ts` 13 条里的 5 条闸判据（409 `ANSWER_FIRST` 且一行不写 / 先答过就放行 / 答在问之后不算 / executive 放行 / 页面级放行） |
| `lib/learning/xq-event-client.ts` | **浏览器侧事件发送端**：`viewPage()` / `endSession()` / `recordEvent()`，会话懒开、串行发送、失败不抛 | ★ **翻页必须单独发请求**：`setCurrentSceneId` 只写 zustand + 标脏，一条网络都不发；而 `runtime_records` 的 payload 校验表里 `playback` 连 skeleton 都没有，挂不到 runtime 通道上。★ **会话懒开**：进播放态不翻页不该有「已坐下学习」的会话，真翻到第一页才开。★ **串行链**：`session_started` 必须先于同一次操作的 `page_viewed` 落库，否则事件外键指向一个还不存在的会话；三个页签同一 tick 齐发也只开一个会话（共用同一个 opening Promise）。★ **重试复用同一个 payload**：`occurredAt` 是幂等键的输入（见上一行），重取就变成新事件。★ **失败不抛**：没记上学情不该让人用不了产品，只 `console.warn`。判据 `tests/learning/xq-event-client.test.ts` 8 条（含「5xx 重试一次且复用同一个 occurredAt」「4xx 不重试」「结束会话后要重新开」） |
| `lib/quiz/confidence.ts` | **自评那四档的纯判据**：`CONFIDENCE_LEVELS = [25,50,75,95]`、`asConfidenceLevel()` / `asConfidenceMap()` / `isConfidenceComplete()` / `calibrationOf()` / `calibrationFromResults()` | ★ **只认恰好等于四个值**：`50.0001` 与 `"50"` 都不收 —— 上层宽容四舍五入，下层一样会被表上的 `CHECK (confidence_pre IN (25,50,75,95))` 拒，只是那时错误发生在很远的地方。★ **题数不到 8 时 `label` 是 `undefined` 而不是 `'good'`**：「还判断不了」与「判断为准」是两件事，写成后者是一句它并不知道的话。★ **`correct: null` 不计入校准**（AI 批改没回来），否则实际正确率凭空掉一截，而这个数直接给人看。★ **自评是事实不是判定**：`lib/quiz/xq-mastery.ts` 的 `EvidenceItem` 只有 `countedN` / `correct` / `guessRate` / `askedAt`，**永远不会有自评字段** —— Karpicke & Roediger 2008 四组预测约 50%、实际 80% 对 33%、组间 F<1，自评与真实零相关，零相关的量拿去加权等于加噪声。判据 `tests/quiz/confidence.test.ts` 21 条 + `tests/quiz/confidence-not-a-verdict.test.ts` 3 条（读源码断言掌握度里不出现那四个自评标识符） |
| `lib/learning/xq-answer-events.ts` | **答题这件事的事件侧**：`recordAnswerAttempt()` / `recordAnswerSubmitted()`，外加两个纯判据 `resolveAnswerTarget()` / `answerAttemptDedupeKey()` | ★ **探针记结论、事件记过程**：`xq_probe_item` 只在判分后才有行，而提问闸（M §10）判的是**顺序** —— 「他先动过手了吗」。写了一半就卡住的人探针表里一行都没有，他却正是最该允许问的那类，所以「动过手」必须能在**提交之前**落库。★ **不照抄 E 文档的卷级事件**：`xq_event` 有 `question_id` 列、闸的判据是题目级三元组；写成卷级就得去 `payload.results[]` 挖数组，SQL 写不出来。一题一行，闸就是一句 SQL（代价是一页八题八行）。★ **幂等键与时间无关**：`answer_attempted:<attemptId>:<questionId>`。默认派生键含 `occurredAt`，他会把同一答案改三遍 ⇒ 三行；而 `attemptId` 进键是必须的 —— 重做换 `:retry:N`，不能被上一轮吃掉。★ **判分挂了也发**：`correct: null` 仍然落一条 `answer_submitted`，「交了但没判出来」是事实，不发等于没交过。判据 `tests/learning/xq-answer-events.test.ts` 7 条（坐标三样缺一不发 / 键稳定 / 换题换轮换键 / attempted 与 submitted 键不同） |
| `lib/learning/xq-hint.ts` | **「问 AI」这一个动作的完整链路**：`askForHint()` 先记 `hint_requested`、成功了才调发消息；`truncateStem()` / `buildHintPrompt()` 只管把题干塞进模板 | ★ **顺序是硬的：先记事件、再发消息**。反过来的话，闸（服务端 409 `ANSWER_FIRST`）一挡，模型已经答了一半，那条提问却记不上 —— 要么撒谎记成 `executive`，要么学情断掉。★ **分型由调用方显式给**：`instrumental` 与 `executive` 与成绩的相关方向相反（`N3` §5.4），从文本反推不可靠，界面就放两个按钮记两个值。★ **学生自己的想法不进上下文**：只落 `xq_event.payload`，模板里也没有「我已经想过……」这类位置 —— 那会把模型推到「顺着你说」那条路上（`2506.10297`：学生提示错误答案时正确率最多降 15pp）。★ **四种结果说四句不同的话**（`sent` / `refused` / `failed` / `unsent`）：`refused` 不是错误，说「先写下你的想法」；说成「失败，再试一次」会把人推回去再点一次，而再点一次仍然是 409。★ **拒绝码从 4xx 响应体带回**：发送端原来只 `logFailure` 状态码，界面分不出「闸挡住」与「网络坏了」。判据 `tests/learning/xq-hint.test.ts` 7 条 + `tests/learning/xq-hint-prompt.test.ts` 8 条（码点截断不切坏代理对 / 模板漏占位符退回题干 / 两侧 `ANSWER_FIRST` 字面量一致） |
| `lib/learning/xq-ai-log-client.ts` | **对话日志浏览器客户端**：`read()` 读 `GET /api/persistence/xq/ai-log`，`turnSummary()` 把一条提问的轮次折成「配上了没有、几句问几句答」 | ★ **与复习客户端分家**：复习那个的返回会立刻改变待办数量，这个读的是历史；合成一个只会让「读失败」的两处语义不一致。 ★ **读失败不许说成「没有记录」**：一份空的对话日志看起来像「他从来没用过 AI」，而它完全可能是网络没通 —— 这正是排查「为什么学情里什么都没有」时最需要分清的两种状态。 ★ **不做分页**：服务端一次最多 100 条（`AI_LOG_LIMIT`），那是全部而不是第一页，假装支持翻页比不支持更糟。 ★ **坏轮次整条丢**：没有 `recordId` / `text` 的半个轮次比没有更糟 —— 它会以「AI 说了空话」的样子出现在页面上。 判据 `tests/learning/xq-ai-log-client.test.ts` 9 条 + `tests/i18n/ai-log-locales.test.ts` 63 条（十二个 locale × 五组，含「没读到」与「没有记录」不许同句） |
| `lib/learning/xq-session-client.ts` | **学习记录的浏览器客户端**：`read()` 读 `GET /api/persistence/xq/sessions`，`sessionSummary()` 折出分钟与页数、`totalActiveMs()` 算当天合计 | ★ **四个客户端一个端点一个**：复习管待办、对话日志管历史、这个管时长；合成一个只会让「读失败」的语义在三处不一致。 ★ **读失败不许说成「今天没学」**：一份空的会话列表看起来像「他什么都没做」，而真正原因可能只是服务端没起来 —— 那会让人去怀疑自己的自律。 ★ **合计只累加已结束的会话**：进行中那一个的活跃毫秒只会越算越小（最后一段间隔还没被下一条事件截断），把它加进去会让「今天一共学了多久」这个数**倒退**。 ★ **这些数字不进状态块**：N3 §4.4 的原话是阈值「全是切分参数，不是剂量参数」，而它们每分钟都在变，进状态块会持续破坏前缀缓存。 判据 `tests/learning/xq-session-client.test.ts` 9 条 + `tests/i18n/sessions-locales.test.ts` 49 条（十二个 locale × 四组，含「没读到」与「还没开始」不许同句）。 ★ **关标签页也要能关会话**：`post()` 带 `keepalive: true`（卸载中的页面发普通 fetch 会被掐掉），`useXqSessionLifecycle()` 挂 `pagehide`；不挂 `visibilitychange`（切标签页只是手离开了）、不用 effect cleanup（StrictMode 会把「学了 5 次」写成 15 次）。判据 `tests/learning/xq-event-client.test.ts` 11 条里那条「每条请求都带 keepalive」+ `tests/learning/use-xq-page-view.test.ts` 三条读源码的接线判据 |
| `components/learning/session-list.tsx` | **学习记录页的列表**：一条会话一行（时间、分钟数、进行中标记、事件/页数/交卷/问方向的明细），顶上是一天的合计 | ★ **三种状态分开说**：没读到 / 读到了但没有 / 读到了但一条都没关（与对话日志同一套理由）。 ★ **进行中单独标出来且不进合计**：见 `xq-session-client.ts` 那条。 ★ **这一页没有「今天该做什么」**：那是 `/review` 的事 —— 一个读计划（`xq_review_schedule`），一个读事实（`xq_event`），并到一页会让人以为「学了 40 分钟」等于「今天做完了」。 页面壳在 `app/sessions/page.tsx`（`force-dynamic`，判据在路由一处） |
| `components/learning/ai-log-list.tsx` | **对话日志页的列表**：一条提问一张卡，左上是时间与题号、右上两种分型各一个标签，下面是那一问一答 | ★ **三种状态分开说**：没读到 / 读到了但没有 / 记了问但配不到对话 —— 第三种是最容易做错的（画成普通记录就像「AI 什么都没说」，它其实说明子锚点没写上或对话被滚到了别的代）。 ★ **代数（`generations > 1`）要显示**：一场对话在库里可能是几行，归并了几代是排查信息 —— 不显示的话这个事实只存在于某个人的记忆里。 ★ **只读，没有删除**：给事实流的镜子加删除按钮，等于给「他说过什么」加编辑权；撤销要靠再写一条 `voided` 事件。 页面壳在 `app/ai-log/page.tsx`（`force-dynamic`，判据在路由一处） |
| `lib/contexts/quiz-ask-context.tsx` | **把「发消息」这件事穿过四层**：`QuizAskProvider` / `useQuizAsk()`，`null` 表示这个场景里没有聊天框 | ★ **不用 prop 传**：从 `PlaybackChromeRoot`（持有 `chatAreaRef`）到 `QuestionCard` 隔着 `CanvasArea → SceneRenderer → QuizView`，而 `CanvasArea` 已收三十多个 prop、它也确实不该知道「页面上有个聊天框」。★ **默认 `null` 而不是空实现**：`null` 的语义是「这里没有聊天框」（编辑态 / 预览 / 单测），此时按钮**不渲染**；空实现会把「没有这个功能」伪装成「有，但不管用」。判据 `tests/learning/quiz-ask-wiring.test.ts` 6 条（Provider 包住画布 / 中间三层零改动 / 取不到就不渲染 / 两个按钮记两种分型 / 发之前先展开侧栏 / 被挡住与真失败不是同一条文案） |
| `lib/learning/xq-review-client.ts` | **学情复习的浏览器客户端**：`listDue()` 读到期队列、`record()` 交一次复习结果，外加两个纯判据 `groupCardsByScene()` / `reviewCardKey()` | ★ **与 `xq-event-client` 分家**：事件那条链是只追加的事实、失败静默重试；复习这两个请求的结果**立刻决定屏幕上显示什么**，所以回结果对象而不是一路 `void`。★ **读失败不能说成「没有要复习的」**：`ok: false` 与空列表分开回 —— 否则界面会显示「今天没有要复习的」，那是在撒谎。★ **分页上限就是全部**（服务端 `DUE_REVIEW_CARD_LIMIT = 50`）：不实现翻页，假装支持比不支持更糟。★ **交失败不自动重试**：`dedupe_key` 由 `occurredAt` 派生，重试会让它变 ⇒ 成了「他又做了一遍」，排期被重置。★ **卡片身份带 `round`**：同一道题的第 1 关与第 3 关可以同时到期，只按题目去重会吞掉一关。判据 `tests/learning/xq-review-client.test.ts` 14 条 |
| `components/learning/due-review-list.tsx` | `/review` 页的主体：按页分组的到期卡，每张三个按钮（我答对了 / 我答错了 / 跳过） | ★ **按钮是这三种而不是「开始复习」**：复习的对象是一道做过的题，界面拿不到答题框也不需要 —— 这一层记的正是「他自己说答对了没有」，四关靠这条自报推进。★ **跳过不等于答对**：服务端 `skip` 只关这一关、不写事件，让人能诚实地跳过一次比逼他二选一更能保住这张表的可信度。★ **不重拉整张表**：点完一个按钮只把那条从本地列表移掉，重拉会在慢网下把刚点过的又画回来。★ **失败要说出来**（那条留在列表里并标红）—— 事件发送端可以静默，这里不行。判据 `tests/i18n/review-page-locales.test.ts` 26 条（十二个 locale 齐 + 「读失败」与「没有到期」不许同句） |
| `components/learning/due-review-badge.tsx` | 首页复习入口上的**到期角标**（2026-11-10）：显示今天到期的关数，`focus` 时重读（不轮询 —— 人回来了才问一次）。★ **三种状态刻意分开**：读到 0 不显示（没有到期是常态，一块「0」是噪声）、读到 n 显示 n、**没读到（`ok: false`）也不显示**。第三条最要紧 —— 把「没读到」画成「没有」正是复习页自己最不该犯的错（`due-review-list.tsx` 里 `readFailed` 与 `empty` 是两句不同的话），而角标只有一块地方说不了两句话，所以它沉默；代价是「今天有 3 关却没提示」，反过来会让人真的不去复习。服务端一次最多回 50 条，所以到顶写 `50+` 不是 `50`（写 50 会让人以为正好 50 关）。判定抽成纯函数 `badgeText()` 才测得动 —— 组件本身几乎全是副作用。判据 `tests/learning/due-review-badge.test.ts` 5 条 + `review-entry.test.ts` 里 2 条（角标挂在 `<Link>` **里面** / 链接要 `relative` 否则它跑到页面角落） |
| `lib/learning/use-xq-page-view.ts` | 把「翻到哪一页」挂成 `currentSceneId` 的副作用（`useXqPageView` / `endXqLearningSession`），外加一个纯判据 `shouldRecordPageView()` | ★ **只跟结果、不跟入口**：五条翻页路径（侧边栏 / 滚轮 / 上下页 / 跳转 / 续播）最后都只调 `setCurrentSceneId` —— 在每个入口各埋一次必然漏一条、重一条。★ **三条不记**：没有课程 id、没有页面 id、`sceneId === '__pending__'`（那是「正在生成下一课」的占位符，不是一页内容）。★ **结束不挂 effect cleanup**：StrictMode 双挂载会把「学了 5 次」写成 15 次，结束由播放态 `teardown` 显式触发。★ 编辑态不会误记 —— 组件树按 `mode` 分叉，编辑态不挂 `PlaybackChromeRoot`。判据 `tests/learning/use-xq-page-view.test.ts` 4 条（只测纯判据，仓里没有 `@testing-library/react`） |
| `scripts/backfill-review-schedule.ts` | **给历史错题补四关排期**：`xq_probe_item WHERE correct = false` 按题去重 → `conceptForQuestion()` → `scheduleReviewForWrong()`（1/3/7/15 天） | 建表以来 `xq_review_schedule` 一直是 **0 行**：历史上那批学情证据来自一次性探针 `.tmp/probe_xq_store.mts`，它只调 `ingestProbeItems()` 与 `recomputeCellState()`，**不调** `scheduleReviewForWrong()`。生产入口现在会排期，但那只管新记录 —— 旧的 5 条错题不会自己长出排期。<br>★ **概念走同一个方法**（`conceptForQuestion`），不在这里另写一条 SQL：两处判据分叉时「新错题」与「历史错题」会挂到不同概念上，同一道题变成两组四关。<br>★ **按题去重不按错次**：一道题错三次只排一组四关 —— 排期说的是「这道题要复习」，不是「错了三次所以要复习三次」。重跑幂等（`ON CONFLICT DO NOTHING`）。<br>真库读数（2026-11-09）：5 道错题 → **20 行**（其中 2 道有唯一概念：`scene-p18/q7 → 类与对象`、`scene-p35/q4 → setState 与状态管理`），重跑仍是 20 行 |
| `lib/persistence/xq-learner.ts` | **15 张 `xq_*` 表**（探针证据 / 三态缓存 / 错题四关 / 概念图 / 外来课程三段判定 / 会话 / 事件 / 人写的画像），走 `APP_SCHEMA_STORES` 启动期建表；迁移账本 `xq-learner` 记 `1 baseline` + `2 session-and-persona` | ★ 主键必须带 `stage_id`（234 页里 35 个 scene id 跨 stage 复用）；★ `xq_concept` 主键是 `c_`+12hex 的**不透明串**（名字是证据不是身份）；★ 别名表主键含 `concept_id` + `ambiguous` 列（同形异义是实测风险）；★ 版本 2 **只加不改**（新表 3 张 + 新列 4 个），因为 v1 已有 7 张表装着真实数据 |
| `lib/concepts/ids.ts` | 概念 id 形状（`c_` + 12 hex）+ 名字归一（全角/空白/大小写） | ★ **不做同义归并**：归并是判断，判断要有出处；自动同义词表会把两个概念永久合并而留不下拆分痕迹 |
| `lib/concepts/seed.ts` | 概念图谱**种子**（104 概念 / 105 边，全部内联、纯函数、不联网） | ★ 每条边带出处与理由（`reason` 表上有非空约束）；`prereq` 边构成 DAG；预算 **80–150 条边 / 60–120 个概念**（依据 os-taxonomy 2.15 边/节点，而 MOOCCubeX 22 条/节点被判「比稀疏更差」）。当前 104 / 105，其中 73 条来自本仓课程页序、32 条来自外部图谱。<br>★ 7 个概念**完全孤立**（无任何边）：`cpp.booleans`/`cpp.comparisons`/`cpp.headers`/`cpp.references`/`cpp.pointers`/`java.exception`/`java.overloading` —— 它们在调研里找不到能指出处的边，按「说不出处的不写」留下，不是漏了 |
| `lib/concepts/occurrence.ts` | 从一页的大纲条目推出**页级挂载**（概念 × 页 × 权重） | ★ API 是**每页一次**（`deriveOccurrencesFromOutlines(input, graph)`），传数组会静默返回 0 —— 实测踩过。★ 不做子串匹配：实测按名字做子串，「构造」一次把 8 页错挂到一个概念上。<br>★★ **读数完全取决于喂不喂正文**（`body` 是可选参数，默认不喂）。同一份 234 页，三种输入三个数：只喂 title+keyPoints ⇒ 144 条 / 116 页 / 59 概念；自己摊平 canvas 的 `text` 元素 ⇒ 413；**用本仓的 `staticPageText()` ⇒ 644 条 / 209 页 / 75 概念**。<br>★★ 生产口径必须是**第三个**：`staticPageText()` 是本仓「这一页学生能看到哪些字」的唯一定义（`coverage-gap` 与 `quiz-grounding` 用的就是它），另写一个摊平函数等于**造第二个单位**，两处对「这页讲过什么」的答案会不一样。它比手摊 canvas 多出来的是 quiz 题干/选项/解析与 pbl 正文，那些同样是学生看得见的字 —— **读数上的直接后果**：手摊口径下 17 个 quiz 页只有 **4** 页挂上（13 页是 0），换成 `staticPageText` 后 **16/17** 页挂上。库里已按这个口径重灌，`xq_concept_occurrence` 从 413 条变 **644 条**（`body 500 / title 127 / keypoint 17`）。<br>★ 手摊时还有个坑：把 `&amp;` 当空格切开会让「A&amp;B」变成「A B」，同一次运行从 413 涨到 422（多出的 9 条是切出来的假词）。 |
| `lib/concepts/question.ts` | 从**一道题的题干**推出题级挂载（概念 × 题 × 强弱档），纯推导、不写库 | ★★ **只取题干**（`data.content.questions[].question`），不含 `options[].label` 与 `analysis`：含选项会把挂载从 71 行抬到 124 行（+72%），而多出来的大量是**反向噪声** —— 选项常复述那一页别的概念名（`scene-p35/q8` 题干问 `Navigator.push`，选项里出现 `prog.collection` 与 `git.remote`）。<br>★★ **成员访问只取链头**：`Navigator.push` 只留 `Navigator`，把 `.` 后的尾巴丢掉。三种处理法真库实测：裸切 72 行；粘整段再跳过 68 行（把 `Navigator → 路由与页面跳转`、`this → this 关键字` 一起当噪声丢掉，是**漏**不是对）；只取链头 **71 行**（只去掉 `push → 远程仓库与 PR` 那一条真错挂）。<br>★ **两档不是三档**：CJK ≥ 2 字 或 ASCII ≥ 6 字符算强（`confidence 0.80`），其余算弱（`0.50`）。71 行里 35 强 36 弱 —— 弱档那半全是 `var`/`final`/`if`/`List`/`rwx`/`push` 这种短 ASCII，它们只说明「这页提过这个词」，压到与 `chapter-band` 同档才不至于冒充知识点。<br>★ **覆盖不到是事实**：17 个 quiz 页里 13 页有命中（强档 11 页），4 页零命中且**不是算法能救的** —— `stage-7tNoR37iqT/scene-p12` 题干写 GET/POST/404/JSON，种子图没有这些概念（且该页 `outlineId` 对应的章节名是「继承：is-a 与复用」，拿章节名兜底只会更错）；`stage-gfGFwuwLJp/{p6,p11,p15}` 那门课的 `document_outlines` 是空数组，`chapter-band` 对它们不可能生效。<br>★ `SEPARATOR_CHARS` 与 `occurrence.ts:83` 的 `SEGMENT_SEPARATOR` **必须同一字符集**（那边没导出所以抄了一份）：两处分叉就会用两把尺子量同一句中文。判据 `tests/concepts/question.test.ts` 19 条，夹具**全部是真库原文** —— 自己编的「Dart 的空安全是什么意思？」一条都不命中，因为 `matchWhole` 要整段相等，而「的空安全是什么意思」在中文里就是一个整段。写入走 `scripts/backfill-question-concepts.ts`（一次性、可整表重算） |
| `lib/quiz/coverage-gap.ts` | **覆盖缺口检查**（查）：这一页题干/选项/解析里的内容块，在它之前所有页里出现过吗。纯函数、可算、不花模型 | 见 结论库「覆盖缺口检查」 |
| `lib/quiz/quiz-grounding.ts` | **出题前注入**（拦）：把「前面已讲过的词表 + 页码表 + 五条硬规矩」追加到 quiz 生成器的 system prompt 末尾 | 同上；与 `coverage-gap` **共用同一个单位** |
| `lib/server/agent-runtime/assessment-mode.ts` | **评估方式**轴：「讲课 / 作业 / 考试」。与 `study-mode.ts` 的「听课 / 自学」（**输入方式**轴）**正交，别合并** | 见 结论库「评估方式这条轴」 |
| `lib/server/agent-runtime/course-outline-write.ts` | **T1：让 brief 落盘** —— `generate_scene` 写页之后，把这条 `SceneOutline` 按 outlineId/order upsert 进课程计划 | 见 结论库「计划从来没落盘过」；**`upsertOutlineEntry` 的身份键由调用方选**（`matchBy` 取 `'id'` 或 `'order'`）—— `plan_freeze` 传 `order`（它的 id 从 order 推，按 id 认会**偷别的页的条目**） |
| `lib/server/agent-runtime/audit-tools.ts` | **`course_audit`**：课程级审计（承接率 + 超载），**纯只读**、无条件注册 | 修一门已有课程**先审它**；见 结论库「先量再建」 |
| `lib/server/agent-runtime/scratch-tools.ts` | **草稿纸**：存储 + `scratch` 工具 + 提示词块（照材料库成例一个文件） | `promote` 按 `listMaterialTopics()` **对照磁盘校验**；见 结论库「幽灵参数」 |
| `lib/server/agent-runtime/practice-tools.ts` | **`practice_scaffold`**（写练习文件夹）+ **`practice_result`**（读回结果） | **不起进程**；与 VS Code 的联动靠 `.vscode/` 配置 |
| `lib/practice/scaffold.ts` | 脚手架**内容**生成（`check.mjs` runner / README / `.vscode`） | 编码坑（GBK）在 runner 里**修一次** |
| `lib/practice/results.ts` | 读练习目录下的 `result.json` → 渲染进 学习状态.md | T9 走**读取侧**，不开新写入路径 |
| `lib/scratch/scratchpad.ts` | 草稿纸**纯逻辑**：编号 `s001`（永不复用）/ 两层 / 索引 / 「只有 1 个来源」 | 与材料库的边界在 `promote` |
| `lib/server/agent-runtime/plan-freeze.ts` | 阶段冻结的**判据**（`planGate` 三条）+ 总开关 `planGateEnabled()` + ★★ **`planSpecGaps()`：「这份计划是不是规格」**（作者写的条目必须有 `keyPoints` + `【Unit …】` 抬头，练习条目必须有 `difficulty`；**`backfill` 派生的不算账**） | 开关默认关；本部署 `OPENMAIC_PLAN_GATE=1`。<br>★★ 这闸之前只验「条目数不为 0」⇒ 实测那门 66 条里 24 条占位、`keyPoints` 有内容的 **0** 条**照样冻结成功**。闸拒新计划、`status` 报老课程（用户说「帮我修这门课」，agent 自己就看见「这份计划不是规格」）。判据 `tests/agent-runtime/plan-freeze.test.ts` 末组 |
| `lib/server/agent-runtime/plan-freeze-store.ts` | 冻结状态的**独立小文件**读写（`data/plan-freeze/`） | 不放 `document_outlines`（怕静默失效） |
| `lib/server/agent-runtime/plan-freeze-tools.ts` | **`plan_freeze`**（status / add / backfill / freeze / revise）+ 提示词块。★ `revise` 带 **`shift`**（拆页 ⇒ 页号顺延）/ **`removeOrders`** / `entries` —— **它真的改计划**（原来只记一次理由） | `backfill` **只补缺、绝不覆盖** |
| `lib/quiz/course-audit.ts` | 课程级**审计判据**（承接率 + 超载线 `NOVEL_P90=60`），纯函数。★ **超载线只对 `slide` 有效**（`pbl` p50=95、`interactive` p50=11 是别的量纲；项目页进 `scaffoldPages`，**不叫超载**） | 超载线是 146 个真实讲解页的 p90 标定的 |
| `lib/quiz/plan-check.ts` | **计划期**依赖校验：超前引用 / 无归属 / 预算（三条只输出「补」和「挪」） | `conceptsPerPage` 默认关；见 结论库 |
| `components/generation/self-study-button.tsx` | 首页那条链上的「自学」开关（经典路径，与工作台的 `study-mode.ts` 不同一条路） | 在工作台路径上搜不到 `selfStudy` |
| `lib/quiz/code-block.ts` | **「这段文字该不该是 `code` 元素」两批规则**（`codeBlockVerdict`）+ **转换器**（`codeElementFromText`，几何不变、行首缩进保留） | 2026-10-09 复量：原判据要求 `;` 是**最后一个字符** ⇒ **带行尾注释的真代码块整批落进第二批**（28 个候选里 **6** 个）。复现 `OPENMAIC_CODE_BLOCK_LIVE_TSV=<dump> TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/code-block-live.test.ts`。<br>★★ **"几何不变"是陷阱（实测栽过）**：`code` 的开销与 `text` 不同 —— 内边距 **24px**、每行 **1.6 × fontSize**、边框 2px、等宽字符宽 **≈ 0.64em**。照搬 `text` 的盒子 ⇒ 第 5 行的 `}` 看不见、最长一行右边被切。**盒子按内容算，别照抄** |
| `components/slide-renderer/components/element/CodeElement/BaseCodeElement.tsx` | 幻灯片上 `code` 元素**长什么样**（顶栏 / 行号 / 圆角 / 投影 / 内边距全在这里） | ★ 2026-10-09 用户否掉了原版（原话「**感觉这个代码块丑丑的**」），量出来不只是丑：仿 macOS 顶栏 **32px** 占盒子高度 **26%**、行号槽 **49px** 占宽度 **20%** ⇒ **纵向溢出 35px / 横向溢出 47px**。现在：**顶栏整条删掉**、**行号默认 `false`**、6px 圆角 + 1px 细边框 + **无投影**。判据 `tests/components/slide-renderer/code-element-chrome.test.ts`（5 条 + 三道变异） |
| `lib/quiz/layout-check.ts` | **版面检查**（纯函数）：溢出画布 / 元素重叠 / 文字装不下 / 字号过小。★ **agent 看不到画面**（`render_scene_preview` 要 `RENDER_SERVICE_URL`，没配就不注册，AGENTS.md §1.1）；这几件事**不需要画面也能算** —— 元素本来就带坐标。挂在 `scene-diagnostics.ts` 上 ⇒ **两条写入路径共用** | 2026-10-10 加（学习者：『我这边没有渲染预览的工具』——随后更正为『我说的是它没有』，指 agent）。阈值只有两个且都可算：字号下限 **14px**、重叠按**较小那个的 15%**。**别往里塞「好不好看」** —— 那不可算，硬编阈值就是编数据。<br>★★ 「底板 + 文字」**不算重叠**（包含不算，涉及文字的部分相交才算）。<br>★★ 量余量用**最大全空矩形**，不是空白面积占比。<br>★★★ 参数必须与渲染器同源（`lib/slide/text-metrics.ts`）；`layoutDelta` 给改前/改后差集 ⇒ **"是不是我改坏的"不用人眼**。 |
| `lib/slide/text-metrics.ts` | **文本框行高/内边距的唯一来源**：渲染器**写进 DOM**，`lib/quiz/layout-check.ts` 直接 import | ★ 原先是两处会各漂的字面量（class `leading-[1.5]` vs 检查器 `1.6`）⇒ 24 个盒子里 **19 条假阳性**；**库里 1084 个 text 元素只有 5 个带 `lineHeight`**（改这里=改所有页面的行高）。判据 `tests/components/slide-renderer/text-line-height-pin.test.ts`（6 条 + 三道变异） |
| `lib/quiz/page-text.ts` | **「学生实际看得见的文字」**：slide / quiz / pbl 静态精确抽取；★ **interactive 页真渲染**（jsdom 跑它自己的 `init()`），渲染失败或渲染出空 ⇒ **退回源码并标注 `NOT RENDERED`** | 20 个 interactive 页里 **8 页正文只在 `<script>` 里**；第 28 页 48,080 字符 html → **34,952 字**。★ 与 `extractTaughtText` 方向相反（那个故意少收），只共用 `stripMarkup`、别合并。★★ **三个已知缺口**（判据全文 → AGENTS.md §1.22） |
| `lib/server/agent-runtime/page-review.ts` | **写入后带上下文再审一页**（`sceneWriteDiagnosticsWithReview()` 用的那半，6 条判据） | ★ **还没在真会话里跑过**（见 AGENTS.md §8）；三条纪律有判据：结论进回话 / 抛错被吞掉写入照常 / 没传就一个字不加 |
| `lib/server/agent-runtime/review-tools.ts` | **`review_course`**：对抗性内容审查 —— **一次隔离的模型调用**（system 里只有页面文本 + 规矩），**没有会话历史 / 画像 / 工具**；结论必须带页码引用，否则 `isError`。★ 候选机制 + **`outOfScopeGapClaims()`**：报告把**本段之前就出现过**的词说成"没解释" ⇒ **指名作废**（见 AGENTS.md §6.10 第 4 条） | 用户原话「审查 agent 要**完全没有任何基础**，不能想『噢原来是这个』」。判据 `tests/agent-runtime/review-tools.test.ts`（20 条 + 十道变异） |
| `lib/server/agent-runtime/scene-diagnostics.ts` | **两条写入路径共用**的写入后诊断（`generate_scene` **与** `patch_stage`） | 见 结论库「门禁必须挂在两条路径上」 |
| `lib/playback/reading-navigation.ts` | **阅读页滚轮翻页的判据**（阈值 12 / 去抖 450ms / 两道闸：用户开关 + 页内还能滚） | 规格见 `docs/specification/domains/F2-reading-pace.md`；`readingPage` 是**必填**布尔量，漏传只是静默还回播放键 |
| `lib/notes/local-kb.ts` | **个人知识库（Obsidian Vault）只读检索**：概念名 → ≤ 5 篇笔记（`noteId` / `title` / `path` / `headingPath`）。`notesDbPath()` 解析库路径，`findNotesForConcept()` 查。★ **不接进工具面**（`docs/research/材料统一/07-合成设计与实施拆分.md` §7 的既有裁决：pika 三技能不接进工具面，个人知识库是**另一个房东**）—— 它只是服务端只读库模块，不要注册成 agent 工具、不要写 `buildXxxTool`、不要动 `runner.ts` 的工具装配。★ **至今没有任何生产调用方**（2026-11-09 实测：`findNotesForConcept` 的引用只在 `tests/notes/local-kb.test.ts` 里，`lib/server/agent-runtime/` 与 `app/` 都没有 import）—— 这不是漏了接，是刻意的；谁要接先回读那条裁决 | ★★ **只用 strict 口径，不用 FTS/bm25**：概念名按 `[\s/、，,（）()]+` 切块 → 丢 CJK 单字与 `与/和/及/的/或` → 剩余块**全部**（AND）出现在 `notes.title` 或 `sections.heading_path` 里。真库实测（697 篇 / 3186 节，104 个种子概念）：**strict 7/104 有命中**。★ 两种「松」读数不同，别混用：只走 `section_fts MATCH` + `bm25` 是 **18/104**（其中 15 个噪音）；走技能真正暴露的 `query_sections`（bm25 + 标题/路径精确命中加分）是 **83/104**，按同一 strict 尺子复核 **77 个是噪音、真命中只有 6 个**（`引用 / Git / 反函数 / 连续 / 单调有界 / 线性代数`）。两个口径的结论同向：**放宽到正文就是噪音**（命中行的标题与小节路径里根本没有那个名字），松有严格无的纯噪音 12 个：`数组 / 字符串 / 指针 / 构造方法 / 封装 / 继承 / 多态 / 接口 / 提交 / 商法则 / 高阶导数 / 矩阵分析`。<br>★★ **绝不抛**：db 不存在 / 表不存在 / SQL 报错 / 概念切不出块 ⇒ 一律 `[]` + 一行 `console.warn`。路径解析顺序 `OPENMAIC_NOTES_DB` → `%APPDATA%/manage-personal-knowledge/obsidian-vault-notes.json` 的 `db_path` → `undefined`（**不硬编码** `C:/Users/...`）。连接 `readOnly: true`，`try/finally` close。<br>★★ **`notes.id` 必须两种形状都收**：真库是 `INTEGER PRIMARY KEY AUTOINCREMENT`（回 number），只收 string 会让真库**每一行都被悄悄丢掉** —— 实测踩过：697 篇里 `递归` 有 2 篇标题命中，模块却回 `[]`。判据 `tests/notes/local-kb.test.ts` 20 条（12 条检索 + 8 条路径解析） |

**运行期可变目录** —— **五个都在 `/api/whoami` 的 `runtime` 里回显**，"它到底写哪去了"随时可查：

| 环境变量 | 默认 | whoami 的键 |
|---|---|---|
| `OPENMAIC_LEARNER_PROFILE_PATH` | 个人数据\学习画像.md | `learnerProfilePath` |
| `OPENMAIC_MATERIALS_DIR` | `个人数据\材料清单` | `materialsDir` |
| `OPENMAIC_SCRATCHPAD_DIR` | `<仓库>\data\scratchpad` | `scratchpadDir` |
| `OPENMAIC_PLAN_FREEZE_DIR` | `<仓库>\data\plan-freeze` | `planFreezeDir` |
| `OPENMAIC_PRACTICE_DIR` | `课程与学习\练习` | `practiceDir` |

★ **2026-10-07 对账四个数据目录时发现 `practiceDir` 根本没被回显**（而这一段原来写着
"三个都在…里回显"，还列了五个变量）—— 于是"我生成的练习去哪了"没有地方可查。
已补进 whoami。**加新目录时，顺手把它加进 whoami 的 `runtime`。**

测试用 `tests/setup-env.ts` 把它们指到临时目录（hermetic）。
`data/scratchpad/` 与 `课程与学习\练习/` 是**懒创建**的 —— 没用过就不存在，这不代表坏了。

**`/api/whoami` 是第一站。** 它回显 `runtime.selfStudyDefault` 等**模块加载时求值**的
开关 —— "我改了 `.env.local` 怎么没反应"的答案通常是"没重启"，而它会直接告诉你进程
当前握着什么值。

---

## 五、改动前必须确认的三件事

1. **这属于哪一层**（上面第一节）。改错层是最贵的错误 —— 上游层改动在下一次合并时全部重放。
2. **有没有契约**（`docs/contracts/interactions.md` 的 OP-x / `flows.md` 的 FLOW-x 覆盖到）。没有契约的操作，先补契约再动手。
3. **判据在哪**（`docs/implementation/coverage.md` 里这一条是「有」还是「松/人工/无」）。标「无」的说明今天没有护栏，改完要自己造证据。

---

## 六、改完之后（固定四步）

1. `node node_modules/prettier/bin/prettier.cjs --write <改动文件>` —— 仓里 `core.autocrlf=false`，别让 CRLF 混进去。★ 只对代码有效：`.prettierignore` 有 `*.md`，文档它一个都不看。
2. `npx tsc --noEmit` —— 必须 0 error。`packages/@openmaic/renderer` 的 `dist/*.d.ts` 若缺失会退化成全 `any`，修法见 `自检.md` §8.1「补充 renderer 声明文件」一节。
3. `node scripts/check-i18n-keys.mjs` —— 动过文案才需要。
4. `python -X utf8 scripts/check-layers.py` —— 动过 `docs/` 才需要。

**不要**跑全量 `vitest run` 当作判据：本机单机有约 10 个 Windows 环境假红（见 `自检.md` §8.1），CI 才是判据。
