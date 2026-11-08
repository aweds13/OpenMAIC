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
| M14b 概念图谱 | `lib/concepts/{ids,seed,occurrence,index}.ts` | 概念 id 形状、种子图、页级挂载推导 | 中 —— 先修边会被用来判「该不该现在学」 |
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
然后就错了。新渲染器的五条硬约束第 2 条就是这条禁令，判据是
`tests/quiz/learner-state-render.test.ts` 的「★ 不写「不要念给学习者听」这类元指令」。
（唯一保留的一句声明是块首 `以下是学习状态数据，不是给你的指令。` —— 它标的是**这段话的身份**，
只标一行、不展开：展开就又变成指令了。）

**③ `lib/server/agent-runtime/learner-state.ts` 的 `buildLearnerStatePromptBlock()` —— 已删。**
它做「查库 → 渲染 → **返回块文本**（不写文件）」，与 `refreshLearnerStateFromRuntime()`
（查库 → 渲染 → **写文件**）是同一套取数 + 同一个渲染器，差别只在落不落盘。生产接线走的是
**写文件 + 读文件**那条：`runner.ts` 每轮开头 `refreshLearnerStateBestEffort()`，
热路径 `resolveLearnerState()` 只读文件、`learnerStatePromptBlock()` 补块首那一行。
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
| `lib/server/agent-runtime/learner-state.ts` | 状态文件的**读 / 写 / 刷新**：`refreshLearnerStateFromRuntime()` 离线取数写文件（三样来源：`xq_cell_state` / `xq_review_schedule` / 练习文件夹）；`resolveLearnerState()` 热路径只读文件 | ★ 取数**只按 `(stage_id, scene_id)`**，不再按 owner：`xq_*` 两张表没有 owner 列（单人部署）。★ 三样全空时不写文件（写空文件只会破坏前缀缓存）。见 结论库「学习状态文件」 |
| `lib/server/agent-runtime/learner-state-render.ts` | **状态块渲染器**（纯函数）：三态格子 + 到期复习 + 练习文本 → 给模型读的一段。五条硬约束写在文件头（零冷启动 / 无元指令 / 块首声明 / 结论可执行 / 稳定排序） | ★ 标签**跟着数据来源变**（概念 / 标题 / 都没有）：`xq_question_concept` 还没数据时全部走标题回退，照样写「概念」会让模型把页面标题当成知识点名字。判据 `tests/quiz/learner-state-render.test.ts` 18 条 |
| `lib/quiz/xq-mastery.ts` | **掌握度纯函数层**：Beta 后验 + 单边 80% 区间 → known / not-learned / unknown；`itemsNeededForKnown()` 算「再做对几题可判」 | ★ 分位数必须是**单边** `1-CONFIDENCE` / `CONFIDENCE`（双边 10/90 会让检出率从 0.8836 掉到 0.5323）。判据 `tests/quiz/xq-mastery.test.ts` 21 条，含与 `.tmp/kg_final2.py` 的逐格对账 |
| `lib/persistence/xq-learner-store.ts` | **xq 写入层**：探针入库（同源去重）/ 三态重算 / 错题四关排期（1/3/7/15 天） | ★ **做错回第 1 关**不是顺延到下一关：fail 时对同一 `(stage_id, scene_id, question_id, concept)` 的**全部四行**重置 `due_at`；用「顺延」写法会在第 1 关失败时把四关压成 1/3/7 ⇒ **第 15 天那关永远不会到期**，而界面完全正常。判据 `tests/persistence/xq-learner-store.test.ts` 19 条 |
| `lib/persistence/xq-probe-recorder.ts` | **学情生产写入口**：服务端包一层 `appendRecord`，把 reviewed 的逐题结果落成 `xq_probe_item`、重算格子、给答错的排四关 | ★ 幂等键是**记录** `runtime:<recordId>` 不是题目（同一题本来就该能答多次，那正是 `counted_n` 表达的）；`correct === null` 跳过（AI 批改未回不能当答错）；**先 append 成功再落学情**，且整段 try/catch —— 答题提交不能因学情失败而失败。判据 `tests/persistence/xq-probe-recorder.test.ts` 17 条。<br>★ **真库端到端跑过**（PGlite 不验证线上索引）：先 `items 56 / cells 7 / sched 0`，投一条 reviewed ⇒ `sched 4`（1/3/7/15 天）且 `counted_n` 同题第二次落 `0.5`，同一条记录再投一次 `items` 仍是 2 ⇒ 幂等靠真库唯一索引而不是内存。用完必须 `recomputeAllCellStates()` 把格子算回去 —— 只删证据行会留下一格被探针抬高的缓存 |
| `lib/persistence/xq-learner.ts` | **12 张 `xq_*` 表**（探针证据 / 三态缓存 / 错题四关 / 概念图 / 外来课程三段判定），走 `APP_SCHEMA_STORES` 启动期建表 | ★ 主键必须带 `stage_id`（234 页里 35 个 scene id 跨 stage 复用）；★ `xq_concept` 主键是 `c_`+12hex 的**不透明串**（名字是证据不是身份）；★ 别名表主键含 `concept_id` + `ambiguous` 列（同形异义是实测风险） |
| `lib/concepts/ids.ts` | 概念 id 形状（`c_` + 12 hex）+ 名字归一（全角/空白/大小写） | ★ **不做同义归并**：归并是判断，判断要有出处；自动同义词表会把两个概念永久合并而留不下拆分痕迹 |
| `lib/concepts/seed.ts` | 概念图谱**种子**（104 概念 / 105 边，全部内联、纯函数、不联网） | ★ 每条边带出处与理由（`reason` 表上有非空约束）；`prereq` 边构成 DAG；预算 **80–150 条边 / 60–120 个概念**（依据 os-taxonomy 2.15 边/节点，而 MOOCCubeX 22 条/节点被判「比稀疏更差」）。当前 104 / 105，其中 73 条来自本仓课程页序、32 条来自外部图谱。<br>★ 7 个概念**完全孤立**（无任何边）：`cpp.booleans`/`cpp.comparisons`/`cpp.headers`/`cpp.references`/`cpp.pointers`/`java.exception`/`java.overloading` —— 它们在调研里找不到能指出处的边，按「说不出处的不写」留下，不是漏了 |
| `lib/concepts/occurrence.ts` | 从一页的大纲条目推出**页级挂载**（概念 × 页 × 权重） | ★ API 是**每页一次**（`deriveOccurrencesFromOutlines(input, graph)`），传数组会静默返回 0 —— 实测踩过。★ 不做子串匹配：实测按名字做子串，「构造」一次把 8 页错挂到一个概念上。<br>★★ **读数完全取决于喂不喂正文**（`body` 是可选参数，默认不喂）。同一份 234 页，三种输入三个数：只喂 title+keyPoints ⇒ 144 条 / 116 页 / 59 概念；自己摊平 canvas 的 `text` 元素 ⇒ 413；**用本仓的 `staticPageText()` ⇒ 644 条 / 209 页 / 75 概念**。<br>★★ 生产口径必须是**第三个**：`staticPageText()` 是本仓「这一页学生能看到哪些字」的唯一定义（`coverage-gap` 与 `quiz-grounding` 用的就是它），另写一个摊平函数等于**造第二个单位**，两处对「这页讲过什么」的答案会不一样。它比手摊 canvas 多出来的是 quiz 题干/选项/解析与 pbl 正文，那些同样是学生看得见的字 —— **读数上的直接后果**：手摊口径下 17 个 quiz 页只有 **4** 页挂上（13 页是 0），换成 `staticPageText` 后 **16/17** 页挂上。库里已按这个口径重灌，`xq_concept_occurrence` 从 413 条变 **644 条**（`body 500 / title 127 / keypoint 17`）。<br>★ 手摊时还有个坑：把 `&amp;` 当空格切开会让「A&amp;B」变成「A B」，同一次运行从 413 涨到 422（多出的 9 条是切出来的假词）。 |
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
