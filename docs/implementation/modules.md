# 实现层 · 模块地图

> 这份文件回答：**代码放在哪、改哪一层、别碰哪。**
> 上游：`implementation/traceability.md`（M1–M13 的 SR 归属）、`specification/conventions.md`（约定）。
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

## 二、模块表（M1–M13）

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
| M13 DSH 宿主 | `_tools/dsh-plugins/openmaic-course/lib/{index,client.src,db,db-write}.js`、`openmaic-local-capabilities/lib/index.js` | 12 个工具 + seam 路由 + 三栏面板 | 中 —— 改完必须重装到 profile |

> 这张表只给**模块归属与改动风险**；同一个文件的实测依据、坑与数字在**第四节全表**里 ——
> 两处都讲到的文件，以第四节那份为准。

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
> 与第二节的分工：第二节按**模块**排（M1–M13，给归属与风险），本节按**文件**排（给实测依据、坑、判据）；
> 同一个文件两处都出现时，**细节以本节为准**，模块归属仍看 M1–M13。

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
| `lib/quiz/learner-state.ts` | **状态渲染器**：折叠结果 + 页面内容 → 一段能注入提示词的文本（把题号还原成题干） | 同上 |
| `lib/server/agent-runtime/learner-state.ts` | 状态文件的**读 / 写 / 刷新**：`refreshLearnerStateFromRuntime()` 离线查库写文件；`resolveLearnerState()` 热路径只读文件 | 见 结论库「学习状态文件」 |
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
