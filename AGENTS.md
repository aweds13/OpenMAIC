# AGENTS.md —— OpenMAIC 二开维护手册

> 这份文件会被 DSH 自动注入（`@deepseek-ai/dsh-agent-instructions`：从**最近的 `.git`
> 所在目录**到会话工作目录，逐层加载 `AGENTS.md`）。目的是让**一个新开的对话窗口**
> 不用重新摸索就能干活。
>
> 写法约定：**只写操作知识**（顺序、前置检查、常见错、该看哪个产物）。判据在代码里。
> 一条结论只有在**实测过**之后才写进来，并附上能复现它的命令。

## 文档分五层 + 三份活文件 —— 读对那一层

**为什么这么分见 [`docs/文档架构.md`](docs/文档架构.md)。** 查资料走五层，干活读三份活文件：

| 层 | 入口 | 装什么 |
|---|---|---|
| 意图 | [`docs/intention/needs.md`](docs/intention/needs.md) | N1–N23 需求全表（要什么，不管怎么做） |
| 规格 | [`docs/specification/traceability.md`](docs/specification/traceability.md) | 十域 F1–F10、50 条 SR；`domains/` 下逐域规则 |
| 契约 | [`docs/contracts/interactions.md`](docs/contracts/interactions.md) | OP-1…OP-6 操作契约；`flows.md` 的 FLOW-1…FLOW-4 |
| 实现 | [`docs/implementation/modules.md`](docs/implementation/modules.md) | M1–M13 模块索引；`coverage.md` 的判据矩阵 |
| 品味 | [`docs/taste/README.md`](docs/taste/README.md) | 产品 / 架构 / 工程品味与红线、冲突排序 |

| 活文件 | 给谁看 | 装什么 |
|---|---|---|
| **本文件**（`AGENTS.md`） | **agent** | **规则 + 现状**：改哪一层、文件地图、证据命令、坑；§0 一句话现状、§8 未决项。★ **会被注入，预算 56000 字节** |
| [`复盘/已结案结论.md`](复盘/已结案结论.md) | **agent** | **已量过、已结案**的结论（每条附复现命令）。**动手前先读** |

**新窗口不需要开场白**：本文件会被自动注入，读完 §0（现状）与 §8（未决项）就知道该干什么。
原「新窗口交接卡」已于 2026-10-30 拆掉 —— 状态进了 §0 与 §8，一次性历史进 git。

原 `二开说明.md` / `怎么用.md` / `架构图.md` 已并入五层（产品说明 → 意图 + 品味；
使用手册 → 实现层「自检」的 §5「怎么说」；结构图 → 实现层「架构图」）。
原 `复盘/上游合并清单.md` 与 `复盘/多窗口并行-worktree.md` 里**日后还要照着敲**的部分
已并入 [`docs/implementation/运维.md`](docs/implementation/运维.md)，其余随文件删除（历史在 git 里）。

★ **别把功能说明写进本文件**：这里只写"怎么不出错"。功能"做了什么、为什么"在 `docs/intention/`。
两处都写必然漂。

---

## 0. 一句话现状

这是 THU-MAIC **OpenMAIC** 的二开分支（`upgrade/v1.3.0`）。
改动落在 `lib/` `app/` **`components/`** `tests/`，外加 `next.config.ts` 与
`package.json` / `pnpm-lock.yaml`（`jsdom` 进了 `dependencies`，见 §2 的 `page-text.ts`）。
**以 `git diff --name-only origin/main..HEAD` 为准**（**含 `components/`** —— 漏看就会以为
"改动只在服务端"）。上游基线是 `origin/main` = `3618238d`；`57fbcc4` 只是**祖先**，
`docs-map` 判据仍拿它当历史锚点，不代表当前基线。

★ **`packages/@openmaic/**` 并非"一行没动"**：实测
`git diff --stat 57fbcc4..HEAD -- packages/@openmaic` = **165 files / +14826 / −792**。
旧文档里"为空可复验"是**假绿灯**（相对 `3618238d` 才是 0）。默认仍不改它，但别以为它干净。

使用者是**一个自学者**（天津大学计算机大一，备二面）。他对产物的要求是实测出来的，
不是偏好：

| 他说的 | 实测出来的数字 |
|---|---|
| 「幻灯片好粗糙，内容单薄，不如我自学」 | 默认 61 汉字/页 vs 天大真实课件 **352–390**/页 |
| 「我是自学，不喜欢听课」 | 见 §4「自学 vs 听课」 |
| 「题量对不上」 | 自检页曾经**永远是 3 题**（写死的兜底），其余靠 agent 手补 |
| 「读网页会被拦、会截断，这不是假的吗」 | 预览 2000 字符 vs 正文平均 **17,443** —— 只读到 **11%** |

---

## 0.1 当前状态（2026-10-30 晚）

- **HEAD 已推到 `mine/main`，CI 全绿**（13/13 success）。★ 推送失败看 `curl https://api.github.com`（通）
  对 `curl https://github.com`（000）；日志里 `Everything up-to-date` **不等于成功**（RPC 断连后的误导尾行），
  只能信 API / `git ls-remote`。原命令重试，**不要**改 remote / 换协议 / 强推。
- **五层 `docs/` 全绿**：`check-layers.py` → `122 条引用（断链 0 处）` + `PASS ✅`（做过反向验证）。
- **仓根三份老文档与两份一次性复盘已删**（含「新窗口交接卡」），内容拆进五层与本文件
  §0.1/§8（旧版 `git show 490259c1:<文件名>`）。结论库 140200 → 88228 字节。
- ★ **prettier 不看 Markdown**（`.prettierignore` 有 `*.md`）⇒ 四步门禁第一步对文档是空跑。
- **插件两个真缺陷已收口并双向验证**（`page.data` 形状错配；差集只剥几何 ⇒ 多出 `markupChanged` 桶），
  部署副本 md5 与源全等。
- **B1 写入真库端到端验过**：`stage-0O5fLNmbe4/scene-p1` 指纹 `740876…|4007` → `de49c74…|3980`
  → 还原回 `740876…|4007` **逐字节相同**（★ 第一次还原差 1 字节：原文 `<strong>` 只包「使用说明」
  —— **只比指纹不看原文会误判成还原成功**）。**B2** 非 slide 页只读文本在真数据上成立。
  其余 B1/B2 细节 → 结论库 §3.9。

**未决只有两条**，都在 §8：真人点一页；重启后复验 `markupChanged`。

### 不在本仓的那些文件（改之前先确认改的是哪一份）

| 想找 | 路径 |
|---|---|
| **DSH 插件源**（两包 12 工具） | `D:/文档/jelly_ware/_tools/dsh-plugins/`（独立 git 仓） |
| 插件**部署副本**（真正被加载的） | `C:/Users/asus/.dsh/profiles/desktop/node_modules/dsh-openmaic-*/` |
| 起全部本地服务 / 日志 | `D:/文档/jelly_ware/_tools/openmaic/`（`start_all.ps1`、`logs/`；口径见运维 §二） |
| 量尺寸 / 耗时 / 重量、离线探 interactive 页 | 同上 `diagnostics/`（`measure-slide-fit.mjs`、`measure-page-timing.mjs`、`measure-page-weight.mjs`、`probe-interactive-offline.mjs`） |
| 数据库数据目录 | `D:/PostgreSQL-OpenMAIC/data`（5433） |

---

## 1. ★ 改之前先确认改哪一层

**默认不动 `packages/@openmaic/**`。** 官方规则是"默认不要改，当只读用"；改了之后
上游升级必冲突。产品层有足够的缝：

| 想改什么 | 改哪里 | 为什么这里有缝 |
|---|---|---|
| 注入/覆盖模型看到的**系统提示词** | `lib/server/agent-runtime/*`（如 `self-study-mode.ts` 的做法：在 `aiCall` 外面包一层，往 system prompt **末尾追加**最高优先级覆盖段） | 生成包的提示词模板不用动 |
| 加/改**工具**、工具描述、参数 | `lib/server/agent-runtime/generation-tools.ts` 等 | 工具是产品层组装的 |
| 改**能力注册**（配了才有） | `<能力>.ts` 里的 `resolveXxxCapability()` + `runner.ts` 两处 | 见 §1.1 |

### 1.1 能力注册原则（**违反它会静默地骗模型**）

> **没配这个能力 ⇒ 不注册工具，并且提示词里一个字都不许提它。**

反例：`browse_url` 的描述一度写着"课程目录用 `course_search`、本地文档用
`read_document`" —— 而没配课程库的部署里这两个工具根本不存在。模型会去调一个它
没有的能力，**比不给指引更糟**。所以工作台版在 `browse-url.ts` 里**整体替换**了
描述，只提确实无条件存在的 `fetch_url`。

注册一个新工具要改**三处**；**允许表不用手改**（第 14 轮起它从工具表派生，见下）：

1. `lib/server/agent-runtime/<能力>.ts` —— `resolveXxxCapability()` + 工具 + 提示词块
2. `lib/server/agent-runtime/runner.ts` —— `const x = resolveXxxCapability()` → `xxxTools`
3. `runner.ts` 的 `assembleRunnerTools(...)` —— 加一组

**提示词块**（要注入的话，两处，都有**编译期**检查兜着）：
`course-tools.ts` 的 `CoursePromptBlocks` 加字段 + `PROMPT_BLOCK_ORDER` 加位置 ——
漏了字段或漏了顺序**都编译不过**（第 13/15 轮：曾经有 6 个块因为"塞了键但没渲染"被静默丢弃）。

**`allowedToolNames` 不要再手写一份**：它是 `new Set(tools.map((t) => t.name))`，
工具表里有什么就放行什么。原来那份手写的名字镜像（~30 行）第 14 轮已删 ——
两份清单靠人保持同步，对不上就是"看得见、调不动"，**而且不报错**。

**写「有条件的能力」时的两条写法规则**（判据按这两条认，见下）：
· 让人去调某个工具时**优先用反引号**（`` `course_search(query=…)` ``）；
· 万一带不了反引号（比如祈使句里），**必须带限定语** —— `…when that tool is registered` / `…when the render capability is available`。
  判据把「**无条件**地让人去调一个没注册的工具」当错，把**带限定语**的提及当对。
  真提示词里 `render_scene_preview` 就是这么写的，别改成无条件的。

`runner-course-search-registration.test.ts` 是这套东西的 pin，照它写新能力的测试。
★ **加新能力块时，把它加进那个文件里的"能力矩阵"轴** —— 判据只覆盖一个配置，
就会漏掉只在那一个配置里不出现的 bug（第 11 轮实测栽过）。

**★ 门禁必须挂在两条写入路径上**（`generate_scene` **和** `patch_stage`）—— 这条**栽过两次**：
① 诊断（覆盖缺口 / 计划校验）只挂生成 ⇒「修一页」所有检查静默通过
   （已修：抽成 `scene-diagnostics.ts`，两个写入点都调它）；
② **阶段冻结的门槛只挂生成** ⇒ 用户说「修复一下 Day1」，agent 查了一下计划状态就
   **直接 `patch_stage` 改页**，不问、也不给他看计划（2026-10-07 实测逼出来的）。

②的修法与两条判据：`patch_stage` 现在也过 `planGate`（判据
`tests/agent-runtime/patch-stage-gates.test.ts`，7 条 + 三道变异）；
`planGate(input, { tool })` 的 `tool` 选项就是为此加的 —— **拒绝信息必须报对工具名**，
否则模型会以为该去调另一个工具（变异测试专门钉了这一条）。

**加一个新闸时，顺手问一句「另一条写入路径呢」** —— 那是同一条判据的第二个入口。

### 1.2 提示词缓存：一句话成本

系统消息在 provider 的 prefix cache 里是**一个整体**。**改动任何一个字节 ⇒ 整个系统
消息重新计费。**

- 所以材料提示块（`lib/server/agent-runtime/material-prompt.ts` 的 `materialsPromptBlock`）
  是**恒定**的：它只指路 `list_materials`，不在系统提示词里枚举材料清单 —— 每登记一次
  材料就换一次提示词的话，会持续 3% 的缓存未命中。
- **不要**加"有材料才出现、没材料就消失"这种**会话中途会翻转**的块 —— 翻转一次就是
  一次全上下文重读。要么恒定，要么由**部署配置**决定（进程生命周期内不变）。
- 诊断：`OPENMAIC_DEBUG_PROMPT_FINGERPRINT=1`，看 `[prompt-fingerprint]` 行的逐块
  哈希，对比 `data/usage/*.jsonl` 里的 `cacheReadTokens`。

---

## 2. 本 fork 独有的文件 = 地图

改之前先看这里，**你要改的东西大概率已经有主了**。

| 文件 | 干什么 | 关键实测依据 |
|---|---|---|
| `lib/server/agent-runtime/config.ts` | 所有运行期开关（含 `selfStudyDefault`） | 加了 `selfStudyDefault` 后 `/api/whoami` 会回报它 |
| `lib/server/agent-runtime/study-mode.ts` | 「听课 / 自学」怎么落地 + 每页密度目标 | 见 §4 |
| `lib/server/self-study-mode.ts` | 经典路径的 slide 密度覆盖（追加到 system prompt 末尾） | 352–390 字/页 |
| `lib/server/agent-runtime/course-design.ts` | 每条 `generate_scene` brief 必须写什么 | brief 是内容生成器**唯一**的指令 |
| `lib/server/agent-runtime/course-search.ts` | `course_search` + `read_document` 接进工作台 | L4 = 本地文档层 |
| `lib/server/agent-runtime/browse-url.ts` | `browse_url` 接进工作台（真浏览器） | 见 §5 |
| `lib/server/agent-runtime/learner-profile.ts` | 注入 `学习画像.md`（**每次运行重读**） | 改画像不用重启 |
| `lib/server/agent-runtime/materials-library.ts` | `read_materials` / `update_materials` + **`listMaterialText()`** | agent 自己维护的材料库；**它的 URL 会喂进会话的 URL 信任闸**（`store.ts` 的建会话钩子）—— 见 §3.1 那条假红与结论库 |
| `lib/server/agent-runtime/mcp-tools.ts` + `mcp-client.ts` | 外部 MCP（GitHub）接进工作台 | 连不上只记 failed，不拖死会话 |
| `lib/server/agent-runtime/compaction.ts` | 原生上下文压缩 + ★ `usageAnchorIsStale()`：**用量锚点比最新一条 compaction 还旧就不采信**（`estimateAgentContextTokens(…, { trustUsageAnchor })`） | **默认关**，本部署开着。不检查它 ⇒ 提示恒为 `N -> N`，且**每次压缩后必然白压一次**（见结论库 §压缩锚点） |
| `lib/server/agent-runtime/session-commands.ts` | `/compact` 之类的会话命令 | 手动挡**不需要** ENABLED —— 它绕过阈值也绕过开关 |
| `lib/server/agent-runtime/prompt-context-file.ts` | 画像/材料库的"路径加载时求值、内容每次重读" | |
| `lib/server/agent-runtime/fetch-url.ts` | `fetch_url`（**上游就有**，我们改了两处） | 见 §5 |
| `lib/export/use-export-pptx.ts` | `buildPptxBlob` / `buildResourcePackZip` + 共用的 `collectInteractivePages` | 单课导出；resource pack = PPTX + 交互页 |
| `lib/export/batch-export.ts` | **批量下载**：多门课 → 一个 ZIP（每课一文件夹） | 见 §10 |
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
| `lib/practice/results.ts` | 读练习目录下的 `result.json` → 渲染进 `学习状态.md` | T9 走**读取侧**，不开新写入路径 |
| `lib/scratch/scratchpad.ts` | 草稿纸**纯逻辑**：编号 `s001`（永不复用）/ 两层 / 索引 / 「只有 1 个来源」 | 与材料库的边界在 `promote` |
| `lib/server/agent-runtime/plan-freeze.ts` | 阶段冻结的**判据**（`planGate` 三条）+ 总开关 `planGateEnabled()` + ★★ **`planSpecGaps()`：「这份计划是不是规格」**（作者写的条目必须有 `keyPoints` + `【Unit …】` 抬头，练习条目必须有 `difficulty`；**`backfill` 派生的不算账**） | 开关默认关；本部署 `OPENMAIC_PLAN_GATE=1`。<br>★★ 2026-10-09 加的闸与诊断 —— **在它之前冻结只验「条目数不为 0」**，所以实测那一门（66 条里 24 条占位、`keyPoints` 有内容的 **0** 条）**照样冻结成功**。闸拒新计划、`status` 报老课程（这样用户只说「帮我修这门课」，agent 自己就会看见「这份计划不是规格」）。判据 `tests/agent-runtime/plan-freeze.test.ts` 末组（7 条 + 三道变异） |
| `lib/server/agent-runtime/plan-freeze-store.ts` | 冻结状态的**独立小文件**读写（`data/plan-freeze/`） | 不放 `document_outlines`（怕静默失效） |
| `lib/server/agent-runtime/plan-freeze-tools.ts` | **`plan_freeze`**（status / add / backfill / freeze / revise）+ 提示词块。★ `revise` 带 **`shift`**（拆页 ⇒ 页号顺延）/ **`removeOrders`** / `entries` —— **它真的改计划**（原来只记一次理由） | `backfill` **只补缺、绝不覆盖** |
| `lib/quiz/course-audit.ts` | 课程级**审计判据**（承接率 + 超载线 `NOVEL_P90=60`），纯函数。★ **超载线只对 `slide` 有效**（`pbl` p50=95、`interactive` p50=11 是别的量纲；项目页进 `scaffoldPages`，**不叫超载**） | 超载线是 146 个真实讲解页的 p90 标定的 |
| `lib/quiz/plan-check.ts` | **计划期**依赖校验：超前引用 / 无归属 / 预算（三条只输出「补」和「挪」） | `conceptsPerPage` 默认关；见 结论库 |
| `components/generation/self-study-button.tsx` | 首页那条链上的「自学」开关（经典路径，与工作台的 `study-mode.ts` 不同一条路） | 在工作台路径上搜不到 `selfStudy` |
| `lib/quiz/code-block.ts` | **「这段文字该不该是 `code` 元素」两批规则**（`codeBlockVerdict`）+ **转换器**（`codeElementFromText`，几何不变、行首缩进保留） | 2026-10-09 复量：判据原来要求 `;` 是**最后一个字符** ⇒ **带行尾注释的真代码块整批落进第二批**（28 个候选里 **6** 个）。复现 `OPENMAIC_CODE_BLOCK_LIVE_TSV=<dump> TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/code-block-live.test.ts`。<br>★★ **转换时"几何不变"是个陷阱（实测栽过）**：`code` 元素的开销与 `text` 不同 —— 内边距 **24px**（`py-3 px-3`）、每行 **1.6 × fontSize**（14px ⇒ 22.4px）、边框 2px、等宽字符宽 **≈ 0.64em**（14px ⇒ ≈ 8.96px/字符）。照搬 `text` 的盒子 ⇒ 第 5 行的 `}` 看不见、最长一行右边被切。**盒子要按内容算，别照抄** |
| `components/slide-renderer/components/element/CodeElement/BaseCodeElement.tsx` | 幻灯片上 `code` 元素**长什么样**（顶栏 / 行号 / 圆角 / 投影 / 内边距全在这里） | ★ 2026-10-09 用户否掉了原版（原话「**感觉这个代码块丑丑的**」），量出来不只是丑：仿 macOS 顶栏 **32px** 占盒子高度 **26%**、行号槽 **49px** 占宽度 **20%** ⇒ **纵向溢出 35px / 横向溢出 47px**。现在：**顶栏整条删掉**、**行号默认 `false`**、6px 圆角 + 1px 细边框 + **无投影**。判据 `tests/components/slide-renderer/code-element-chrome.test.ts`（5 条 + 三道变异） |
| `lib/quiz/layout-check.ts` | **版面检查**（纯函数）：溢出画布 / 元素重叠 / 文字装不下 / 字号过小。★ **agent 没有渲染预览** —— `render_scene_preview` 要 `RENDER_SERVICE_URL`，没配就**不注册这个工具**（§1.1），所以它看不到画面；而这几件事**不需要画面也能算**（元素本来就带坐标）。挂在 `scene-diagnostics.ts` 上 ⇒ **两条写入路径共用** | 2026-10-10 加（学习者：『我这边没有渲染预览的工具』——随后更正为『我说的是它没有』，指 agent）。阈值只有两个且都可算：字号下限 **14px**、重叠按**较小那个的 15%**。**别往里塞「好不好看」** —— 那不可算，硬编阈值就是编数据。<br>★★ 「底板 + 文字」**不算重叠**（包含不算，涉及文字的部分相交才算）。<br>★★ 量余量用**最大全空矩形**，不是空白面积占比。<br>★★★ 参数必须与渲染器同源（见 `lib/slide/text-metrics.ts`）。<br>★★★ `layoutDelta` 给改前/改后差集 ⇒ **"是不是我改坏的"不用人眼**。 |
| `lib/slide/text-metrics.ts` | **文本框行高/内边距的唯一来源**：渲染器**写进 DOM**，`lib/quiz/layout-check.ts` 直接 import | ★ 原先是两处会各漂的字面量（class `leading-[1.5]` vs 检查器 `1.6`）⇒ 24 个盒子里 **19 条假阳性**；**库里 1084 个 text 元素只有 5 个带 `lineHeight`**（改这里=改所有页面的行高）。判据 `tests/components/slide-renderer/text-line-height-pin.test.ts`（6 条 + 三道变异） |
| `lib/quiz/page-text.ts` | **「学生实际看得见的文字」**：slide / quiz / pbl 静态精确抽取；★ **interactive 页真渲染**（jsdom 跑它自己的 `init()`），渲染失败或渲染出空 ⇒ **退回源码并标注 `NOT RENDERED`** | 20 个 interactive 页里 **8 页的正文只在 `<script>` 里**（第 17/28/36/38/42/44/52/57 页）；实测第 28 页 48,080 字符 html → **34,952 字**正文。★ 与 `extractTaughtText` **方向相反**（那个故意少收、偏误报），只能共用 `stripMarkup`，别合并。★★ **三个已知缺口（2026-10-09 逐条核出来的，全都会变成审查的假阳性）**：① 收的是 jsdom 的 `body.textContent` ⇒ **内联 `<script>`/widget-config 的文字也进来**（第 34 页的 `type`/`code`/`language`/`description` 因此被判成"真缺口"）；② **配置写在 `<head>` 的那 1 页反而收不到提示**（20 个 interactive 页：head 配置 **1** / body 配置 **17** / 无配置 2 —— 第 32 页的提示因此被判成"全页没说"）；③ **压平了 `left`/`top`** ⇒ 审查会把**两栏**读成"挤在一行"（实测 6 条版面误报全出在这里） |
| `lib/server/agent-runtime/page-review.ts` | **写入后带上下文再审一页**（`sceneWriteDiagnosticsWithReview()` 用的那半，6 条判据） | ★ **还没在真会话里跑过**（见 §8）；三条纪律有判据：结论进回话 / 抛错被吞掉写入照常 / 没传就一个字不加 |
| `lib/server/agent-runtime/review-tools.ts` | **`review_course`**：对抗性内容审查 —— **一次隔离的模型调用**（system 里只有页面文本 + 规矩），**没有会话历史 / 画像 / 工具**；结论必须带页码引用，否则 `isError`。★ 候选机制 + **`outOfScopeGapClaims()`**：报告把**本段之前就出现过**的词说成"没解释" ⇒ **指名作废**（见 §6.10 第 4 条） | 用户原话「审查 agent 要**完全没有任何基础**，不能想『噢原来是这个』」。判据 `tests/agent-runtime/review-tools.test.ts`（20 条 + 十道变异） |
| `lib/server/agent-runtime/scene-diagnostics.ts` | **两条写入路径共用**的写入后诊断（`generate_scene` **与** `patch_stage`） | 见 结论库「门禁必须挂在两条路径上」 |
| `lib/playback/reading-navigation.ts` | **阅读页滚轮翻页的判据**（阈值 12 / 去抖 450ms / 两道闸：用户开关 + 页内还能滚） | 规格见 `docs/specification/domains/F2-reading-pace.md`；`readingPage` 是**必填**布尔量，漏传只是静默还回播放键 |

**运行期可变目录** —— **五个都在 `/api/whoami` 的 `runtime` 里回显**，"它到底写哪去了"随时可查：

| 环境变量 | 默认 | whoami 的键 |
|---|---|---|
| `OPENMAIC_LEARNER_PROFILE_PATH` | `个人数据\学习画像.md` | `learnerProfilePath` |
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

## 3. 证据：怎么知道改对了

### 3.1 先跑测试，别先跑产品

**改完固定四步，顺序不要换**（前三步是 CI 的门，第四步是文档层）：

```bash
cd D:/文档/jelly_ware/program/OpenMAIC
node node_modules/prettier/bin/prettier.cjs --write <改过的文件>   # 别用 npx；★ 只管代码，*.md 见下
npx tsc --noEmit                                                   # 必须 0 error
node scripts/check-i18n-keys.mjs                                   # 别用 pnpm：store 权限报 os error 5
python -X utf8 scripts/check-layers.py                             # 末行要 LAYER CHECKS: PASS ✅
```

★ **prettier 不管 Markdown**：`.prettierignore` 有 `*.md` ⇒ 第一步对 `.md` 是**空跑**
（写坏了也不报）。文档判据只有 `check-layers.py` 与人眼，别把「prettier 绿了」当文档没问题。

★ **`npx tsc --noEmit` 的必要前置**：`packages/@openmaic/renderer/dist/` 里只有 `.js`
没有 `.d.ts`（`types` 指向 `./dist/index.d.ts`），导出会全部退化成 `any`，**凭空冒出 33 个 error**。
修法是补一次声明文件，不是去改代码：

```bash
cd packages/@openmaic/renderer && npx tsc --emitDeclarationOnly --declarationDir dist
```

**单元测试按需跑，别拿全量当判据**：

```bash
npx vitest run tests/agent-runtime/          # 主战场，末尾看 Tests N passed
npx vitest run <某个文件>                     # 判定"是不是我弄坏的"永远用这个
```

★ **本机全量跑必然假红，CI 不会**：`vitest run` 单机并发在这台 Windows 上会撞 5000ms
默认超时，199 个文件时能报 `Test Files 13–14 failed`，**隔离重跑后 12/13 全绿**。
CI 用 `--shard=N/4` 四分片独立 runner，不会有这批假红。
⇒ **看到红先单跑那个文件**；单跑过就是负载，不是回归。

**基线同样红、属本机环境、不修**（已逐个 A/B 过：`git stash` 掉改动照样红）：
`tests/agent-runtime/document-image-parser.test.ts`（`process.cwd()` 拼 `/` 比 `\`）、
`tests/utils/course-thumbnail-cache.test.ts`、`chart-schema-lockstep`、
`scene-preview-self-contained`、`material-extraction`、`owner-extraction-options`、
`session-materials`、`voice-clone-tools`。

**一条会骗人的环境开关**：仓根 `server-providers.yml`（被 `.gitignore:55` 忽略）会把部署
切到 legacy，使 `status='disabled'` 的槽可被请求覆盖 —— `tests/server/model-config/llm.test.ts`
因此红。`mv` 走该文件即绿。它不在版本控制里，别照它推结论。

**测试是 hermetic 的**：`tests/setup-env.ts` **默认不加载 `.env.local`**，所以测试不依赖
本机配置；要跑真端点才用 `TEST_LOAD_LOCAL_ENV=1`。
★ **本机三件环境噪声**（fake-IP DNS 让 SSRF 判据永拒 / Windows 无 `getuid` /
`join()` 给反斜杠让路径判据空转）→ 结论库「本机环境」。

### 3.2 然后重启 —— 这一步不能省

**两件不同的事，别混：**

| 改了什么 | 怎么生效 |
|---|---|
| `lib/` `app/` `components/` 里的产品代码 | 整台 `next dev` 重启（`lib/server/agent-runtime/**` **不会热重载**） |
| `_tools/dsh-plugins/**` 里的 **DSH 插件** | ① 源改了要**重建** `node build.mjs` ② 再**同步部署副本** ③ 再**重启 DSH 应用** |

```bash
# 1) 找 3000 的 PID（taskkill / Get-CimInstance 在这台机器上会挂死，别用）
netstat -ano | grep -E ":3000\\s" | grep LISTENING
# 2) 杀
powershell -NoProfile -Command "Stop-Process -Id <PID> -Force"
# 3) 起（脚本自己会清 Turbopack 残留链接，见 §6）
powershell -NoProfile -ExecutionPolicy Bypass -File "D:/文档/jelly_ware/_tools/openmaic/start_all.ps1"
# 4) 验
curl -s http://127.0.0.1:3000/api/whoami
```

★ **修完不重启 = 白修**。`3000` 是 OpenMAIC 自己的生产构建；DSH 会话在 `61123`，
插件两半各自的生效路径见 §12。

```bash
# 1) 找 3000 的 PID（taskkill / Get-CimInstance 在这台机器上会挂死，别用）
netstat -ano | grep -E ":3000\s" | grep LISTENING
# 2) 杀
powershell -NoProfile -Command "Stop-Process -Id <PID> -Force"
# 3) 起（脚本自己会清 Turbopack 残留链接，见 §6）
powershell -NoProfile -ExecutionPolicy Bypass -File "D:/文档/jelly_ware/_tools/openmaic/start_all.ps1"
# 4) 验
curl -s http://127.0.0.1:3000/api/whoami
```

★ **`3000` 不是生产常驻**：本机全量起服务是 `start_all.ps1`，PG 在 `5433`。
`curl http://127.0.0.1:3000/workspace` **不再是**「起没起来」的判据 —— 那个端口
今天很可能根本没监听（实测 NOT listening）。**第一站永远是 `local_services`。**

### 3.3 ★ 真话在数据库里，不在日志里

"agent 到底做了什么"只有一处能查：`agent_session_events`（每场会话一条一条事件流，
含每次工具调用的**入参与结果**）。这比读日志准得多。

```bash
PGPASSWORD=postgres PGCLIENTENCODING=UTF8 \
  "D:/PostgreSQL-OpenMAIC/pgsql/bin/psql.exe" -h 127.0.0.1 -p 5433 -U postgres -d postgres
```

```sql
-- 工具调用分布：一眼看出 agent 在拿什么补什么
SELECT data->>'toolName' AS tool, count(*) FROM agent_session_events
WHERE type='tool_execution_end' GROUP BY 1 ORDER BY 2 DESC;

-- generate_scene 实际产出多少动作（含 speech）
SELECT data->'result'->'details'->>'type' AS t, count(*),
       round(avg((data->'result'->'details'->>'actionCount')::numeric),1)
FROM agent_session_events
WHERE type='tool_execution_end' AND data->>'toolName'='generate_scene'
  AND data->'result'->'details' ? 'actionCount' GROUP BY 1;

-- 自检页真实题量
SELECT stage_id||' ord='||scene_order||' q='||
       coalesce(jsonb_array_length(data->'content'->'questions')::text,'?')
FROM document_scenes WHERE data->>'type'='quiz' ORDER BY 1;   -- ★ 只有一列，ORDER BY 2 会报错
```

**★★ `data/usage/*.jsonl` 的 token 口径（2026-10-10 实测，我先踩了）**：

**上下文大小 = `inputTokens` 单独一个数。不要加 `cacheReadTokens`。**
`cacheReadTokens` / `cacheCreationTokens` 是 `inputTokens` 的**明细拆分**，不是相加项。
相加会把上下文**放大一倍**：同一时刻 `inputTokens` = **139,175**，相加 = **277,031**，
而官方压缩读数（`agent_session_events` 里 `type='trace'` 的 `N -> M tokens`）是 **139,827** ✓。
★ 我拿错的口径推出了**两个错结论**（"90 万没用上"/"压完还剩 2.7 倍"），
是事件流里的官方数字把我拦下来的。**量之前先找一个已知值对表。**

```sql
-- 压缩的真实前后读数 —— 不用推断，这就是官方数字
SELECT to_timestamp(ts/1000) AT TIME ZONE 'Asia/Shanghai', data->>'message'
  FROM agent_session_events WHERE type='trace' AND data->>'message' LIKE '%compacted%'
 ORDER BY ts DESC LIMIT 12;
```

**实测结论**（2026-10-10，1234 次 agent-runtime 调用）：中位 **120,899**、p90 221,520、
最大 **444,038**；压缩**触发 ~140K → 压到 ~25K**（正常且激进）。
触发线是 `.env.local` 的 `OPENMAIC_AGENT_COMPACTION_CONTEXT_BUDGET=150000`，
而模型窗口是 **1,048,576** ⇒ **离上限还有 55 万，不紧张**。

**中文 SQL 字面量的坑**：`psql.exe` 在 Git Bash 下会把字面量按 GBK 发出去 ⇒
`invalid byte sequence for encoding "UTF8"`。两种绕法：

```sql
t LIKE U&'%\65C1\767D%'      -- '旁白' 的码点转义，最省事
```
或者把 SQL 写进 **UTF-8 文件**再 `psql -f`。

---

## 4. 自学 vs 听课（**已经吵过一轮，别重开**）

### 结论

内容原先**被有意设计成放在讲稿里**（SDK 模板原话："Slides are visual aids, NOT
lecture scripts"、"all elaboration … must appear here in speech text"）。对"边听边学"
合理；对"我自己看材料"是灾难。

### 曾经的错（值得记住的教训）

自学模式**只写在提示词里**（"不要跑 `generate_actions`"）。但讲稿根本不是 agent
生成的 —— 是 `generate_scene` **内部**自己调 `generateSceneActions` 写的。
于是实测：

| 2026-10-05 那节课（28 页） | |
|---|---|
| `generate_scene` | **162** 次 |
| 其中 slide 页产出动作 | **79 / 79，100%**，平均 **13.2** 条 |
| `patch_stage` | **160** 次 |
| 其中明写「移除自动生成的旁白与高亮」 | **36** 次 |

**提示词约束不住的东西，必须在代码里给默认值。** 现在是：
`OPENMAIC_SELF_STUDY=true`（`.env.local`）→ `generate_scene` 压根不调讲稿生成器；
单页可用 `generate_scene.selfStudy` 覆盖。

### 自学页的写作要求

内容必须**在屏幕上**：目标 **350–400 汉字/页**（≈ 1000×562.5 画布在可读字号下的
上限）。**要多就加页，不要加每页字数** —— 加字数会溢出或缩成灰块。
不要旁白腔（"我们接下来"、"请注意"、"同学们"）。

---

## 5. 读网页：三道门，各自的作用（改之前先分清）

| 工具 | 机制 | 已知失效模式 |
|---|---|---|
| `web_search` | 外部检索 API | 没配就没有这个工具 |
| `fetch_url` | 一次 HTTP，抽正文，**存成 session material** | 见下 |
| `browse_url` | **真浏览器**（Playwright + Edge） | 需要 8730 在跑 |
| `read_material` | 分段精读那份 material（8000 字符/页） | |

### 5.1 `fetch_url` 的两个实测缺陷（**已修**）

1. **预览只有 2000 字符**，而实测 56 次成功抓取平均 **17,443** 字符 ⇒ 模型只看得到
   **11%**。更糟的是 `nextOffset` 以前是**死指针**：`fetch_url` 的参数只有一个
   `url`，没有任何工具接收 offset。现在结果里带 `nextStep`，明说"这是前 N 个字符、
   共 M 个、继续读用 `read_material(materialId, offset=…)`"。
2. **反爬关键词对整页 HTML 做子串匹配** —— `<script>` 里任何一处 `captcha` 就整页
   拒绝（现代 bundle 里很常见）。实测 75 次抓取里 3 次被拦，**2 次是被裸词
   `captcha` 误伤**。现在只对**抽取后的正文**判定：真正的验证码拦截页可见文字里
   必然有这些词，照样拦得住。

**改这两处时注意**：`fetch_url` 是**上游文件**，我们的改动要尽量小且带注释，
否则以后 rebase 会疼。

### 5.2 顺序（写进提示词的分工）

```
web_search  找有哪些页面（返回的 URL 进 session 信任门）
   ↓
browse_url  打开看（JS 渲染页 / 403 / 要正文）
   ↓
fetch_url   值得留的页面**存下来**（变成 material）
   ↓
read_material  分段精读，跟着 nextOffset 翻到没有为止
```

**只说"优先用浏览器"是错的** —— 模型会用浏览器读一遍就走，内容没落成 material，
后面的精读、页面生成、上下文压缩之后的重读全都引用不到。**「看」和「存」必须分开讲。**

---

## 6. 坑（每条都真实浪费过一小时）

### 6.1 Turbopack junction：一键启动"卡住"的真因

`next dev`（Turbopack）会在 `.next/dev/node_modules/` 下给每个外部包建 junction。
**硬杀**（`Stop-Process -Force`）会留下残留，下次启动第一秒就 panic：

```
TurbopackInternalError: failed to create junction point …
Caused by: 文件存在。(os error 80)   ← 硬杀留下的残留
          拒绝访问。(os error 5)     ← 间歇性，同一台机器连试两次第一次崩
```

端口因此永远不开，而老版 `start_all.ps1` 只会**盲等 180 秒**再报 FAILED。
现在脚本会清残留 + 盯 `_openmaic_dev.err.log` + 最多重试 3 次：
实测冷启动 **188s（FAILED）→ 65s（成功）**。

> **绝对不要**对 `.next/dev/node_modules` 跑 `rmdir /s`、`Remove-Item -Recurse` 或
> `shutil.rmtree` —— 它们会**顺着 junction 走进 `node_modules/.pnpm` 删真包**。
> 正确做法是自己走目录树，遇到 `ReparsePoint` **不下钻**，用**非递归**的
> `[System.IO.Directory]::Delete($path, $false)` 只摘链接。
> 见 `_tools/openmaic/start_all.ps1` 的 `Clear-TurbopackJunctions`。

### 6.1b ★ `127.0.0.1:3000` 打开时"所有按钮都没反应" —— Next 16 的 dev origin 拦截

Next.js 16 的 dev server **默认只允许 `localhost`**，把其它来源对自己 `/_next/*`
的请求当**跨域**拦掉。而本机（以及桌面快捷方式）用的是 `127.0.0.1:3000`：

```
HTML 能加载、页面看起来正常，但 JS 分块全被 403 拦掉
⇒ 所有按钮都没反应（事件处理器根本没挂上）
⇒ 控制台里是 "Blocked cross-origin request to Next.js dev resource /_next/..."
```

**不是**你的组件坏了、也不是 hydration 失败 —— 是**资源根本没到浏览器**。
修法在 `next.config.ts` 的 `allowedDevOrigins: ['127.0.0.1', 'localhost']`
（**只影响开发期**，生产构建不看这个键）。改完要重启 dev server。

### 6.2 这台机器上会挂死的命令

| 别用 | 用 |
|---|---|
| `taskkill`、`Get-CimInstance` | `netstat -ano` 找 PID + `Stop-Process -Id` |
| `powershell … \| tr -d '\r'` | 重定向到文件再读。**有 detached 子进程继承管道时它永不返回** —— 2026-10-08 **又踩一次**：`start_all.ps1 \| tail -25`（那脚本自己会 detached 起服务）⇒ 作业 7 分钟不返回，只能杀掉作业，而**dev server 一起被带走**（再跑一次才回来）。**启动脚本的输出一律 `> 文件 2>&1`**，别接管道、也别接 `tail`/`grep` |
| `$pid`（PowerShell 里只读） | `$procId` |
| PowerShell 5.1 读非 BOM 的 `.ps1`（当 ANSI） | **脚本只写 ASCII**，路径从 `$PSScriptRoot` 推 |

### 6.3 其他

- **改环境变量要重启**：`.env.local` 在进程启动时读。先看 `/api/whoami` 的 `runtime`。
- **单会话单 worker**：worker 循环的闸是 `ctx.running.size < config.maxConcurrent`（`runner.ts` 的 `runWorker`）。`maxConcurrent` 读 `OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT`（**代码默认 2，本部署 `.env.local` 刻意设 1**），第一站看 `/api/whoami` 的 `runtime.maxConcurrent`。
  （2026-10-07：这条原来写的是 `RUNNING_MAP` —— 那个符号**在代码里根本不存在**，照着它去搜会一无所获。）
- **UI 有两层折叠**：左边栏默认「对话」，课程在折叠的文件夹里 —— 用户说"课程不见了"
  先怀疑这个，再怀疑数据。
- **`DELETE /api/stages/<id>` 是软删**（`stage_meta.deleted_at`），不是真删。
- **`psql` 中文 SQL 字面量** ⇒ 见 §3.3。

### 6.4 ★ 两条已结案的环境事实

· **代码注释里的数字可能是上游作者账号的快照**（`WorkspaceRail.tsx` 的 "139 courses"）；
· **`@openmaic/dsl` 没有 `require` 条件** —— 想"读真数据"就写成 vitest 用例，别写独立脚本。

### 6.6 ★ `document_scenes.id` **只在 stage 内唯一** —— 任何按 sceneId 做键的地方都要带上 stage_id

2026-10-07 实测，而且这是**我自己的代码踩的**，所以单列：

```sql
-- 主键就是复合的
SELECT pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid='document_scenes'::regclass AND contype='p';
--  document_scenes_pkey | PRIMARY KEY (stage_id, id)
```

而 `scene-p7` / `scene-p9` / `scene-p12` 这种 id **本部署各有 6 个 stage 在用**。
后果不是"顺序不对"，是**张冠李戴**：

- 折叠器一开始按 `sceneId` 单独做键 ⇒ 两门课的同名页会被**合并成一页**；
- 内容查询 `WHERE id = ANY(...)` 少了 `stage_id` ⇒ 取到**另一门课的题干**。
  实测那次：`stage-7tNoR37iqT`（Git/OOP/HTTP 课）的 `scene-p9` 是《OOP 用大白话讲一遍》，
  但查询匹配到了 `stage--ShZtYAYOj` 的《自检：Dart 语法八道题》——
  **差一点就把「你错了 Dart 的 async/await」注进一个在学 Git 的人的提示词里。**
- 单元测试**抓不住**（假 id 都唯一），短读的 live 测试也抓不住（那次记录恰好全在一门课里）。
  是"折叠结果 + 页面内容"做 join 的那一刻才炸出来的。

**规矩**：

1. 页面身份一律是 `(stageId, sceneId)`；`lib/quiz/attempt-fold.ts` 的 `sceneKey()` 是这个键
   的唯一实现，别在别处再拼一个。
2. 折叠器的 `sceneStateOf(fold, stageId, sceneId)` **两个参数都要** —— 让"取错课的那一页"
   在编译期就不可能（同 F2 的 `readingPage` 必填那条思路）。
3. 查 `document_scenes` 永远带 `stage_id`；`runtime_sessions` 的 `stage_id` 就是它的来源。
4. 回归 pin：`tests/quiz/attempt-fold.test.ts`「keeps same-named pages in different courses apart」、
   `tests/quiz/learner-state.test.ts`「does not borrow another course's question text…」。
   **改这两个模块时先看这两条。**

### 6.7 ★ `document_scenes` 里 slide 的 `content` **就是 HTML** —— 拿它当纯文本用会把 CSS 关键词喂给模型

2026-10-07 实测。原文长这样（直接从库里取的）：

```html
<p style="font-size: 32px;"><strong>Java 条件语句：和 Python 有什么不同</strong></p>
<p style="font-size: 16px;">• if (条件) { }</p>
```

后果不是"多几个字"，是**注入块变成垃圾**：`coverage-gap` / `quiz-grounding` 把
`font` / `style` / `size` / `strong` / `16px` / `14px` / `monospace` / `Consolas` /
`color` / `family` / `nbsp` 全当成"这门课讲过的词"。实测注入的词表**前 12 个全是它们** ——
而那块注入的作用正是告诉出题器"只许用这些词"，于是**比不注入更糟**。

**修法**：`stripMarkup()` 在**两个入口**各剥一次 —— `extractTaughtText()`（haystack
必须是无标记纯文本）和 `contentChunks()`（它是共享单位，两侧都从这里过，在入口剥比
要求每个调用点记得剥可靠）。剥完实测同一门课：

| | 词表前 12 个 |
|---|---|
| 剥之前 | `font / style / size / strong / 16px / 14px / nbsp / monospace / Consolas / family / color / int` |
| 剥之后 | `int / Java / for / Python / else / if / boolean / Maven / JDK / 素数 / 条件 / String` |

**规矩**：任何把 `document_scenes.data->'content'` 当文本用的地方（生成、检索、计数、
向量化），先过 `stripMarkup()` 或 `extractTaughtText()`。回归 pin：
`tests/quiz/coverage-gap.test.ts`「strips tags so CSS keywords never become "taught terms"」。

### 6.8 ★ `个人数据\` 只放**学习成长**的东西 —— harness 的调试产物跟 harness 走

用户的原话：「**个人数据里不要塞和我学习成长无关的东西，审计归审计**」。

我往里写过一个提示词 dump 和一个会话轨迹导出，被当场纠正 —— 这是对的：
`个人数据\` 里是**关于这个人**的东西（`学习画像.md` / `学习状态.md` / `材料清单\`），
而"某个工具输出了什么"是**机器的调试垃圾**。混在一起之后，就没有人分得清哪些该保留、
哪些可以随时删。

| 东西 | 放哪 |
|---|---|
| 学习画像 / 学习状态 / 材料清单 | `个人数据\`（**只放这些**） |
| 提示词 dump、会话轨迹、审计报告等 harness 产物 | `_tools\openmaic\diagnostics\` |
| harness 运行日志 | `_tools\openmaic\logs\` |
| 课程产物与练习 | `课程与学习\`（**不是** `个人数据\`） |

写新 dump/报告时**默认值就往 `_tools\openmaic\diagnostics\` 写**，别让默认值落到
`个人数据\`（`tests/agent-runtime/prompt-audit-live.test.ts` 的 `DUMP_DIR` 是可以照抄的
样子，需要时用 `OPENMAIC_PROMPT_DUMP_DIR` 覆盖）。

### 6.9 ★ 拿上游的估算器当下游决策依据之前，先问它假设了什么没变

全文与实测读数在 [`复盘/已结案结论.md`](复盘/已结案结论.md#估算器的假设)。引用上游的估算/判据/渲染
函数做决策前先写下它的假设，再问「我新加的功能打破了哪一条」——尤其是假设里出现
「上一次 / 最新一次 / 默认 / 不变」时。

### 6.10 ★ 分段的工具里，「前面所有页」必须指**全课**的前面 —— 否则假阳性是工具自己造的

`review_course` 按字符预算分段跑（剩下的用 `fromOrder` 接着审），曾有两处把「这一段」
当成「整门课」⇒ **审查者照着工具给的错前提说话**。已修：前缀吃满**本段之前**的所有页，
提示词改成「全课目录（共 M 页）」+「本次给你的正文：第 A–B 页」。

★ 判据必须让 `fromOrder` 落在**第二页** —— 拿"一次给两页"的夹具，前缀恰好在本段里，照不到这个洞。

**同形还有三条未修**（别再当成"审查者不行"）：`stripMarkup` 会把纯文本里的 `<…>` 换成空格
（`List<String>` → `List `）；压平 `left`/`top` 让审查把**两栏**读成"挤在同一行"；jsdom 报错
要按「按钮还绑不绑得上」分真假（`renderMathInElement is not defined` 是桩、非致命；
`CodeMirror is not a function` 是**真缺陷**）。

★ **通用判据**：「审查说蠢话」分两种，修法相反 —— **(A) 工具给了错前提 ⇒ 修工具**；
**(B) 工具对了、模型没照做 ⇒ 修提示词 + 加机器复核**。先量是哪一种。
**审查者的输出不能超过它拿到的输入** —— 看到蠢话先问「它当时看到的到底是什么」。

量第 2 条的工具：`_tools/openmaic/diagnostics/probe-interactive-offline.mjs`（退出码 1 = 有死页）；
全部细节与读数 → 结论库 2.26。

---

## 7. 已经查清、**不要重新论证**的结论 → [`复盘/已结案结论.md`](复盘/已结案结论.md)

> **动手前先读它。** 那里是**已经量过、已经结案**的东西（每条附复现命令）——
> 不读就会把同一件事重新量一遍。

**为什么搬出去（别改回去）**：本文件是**自动注入**的，注入有 **65536 字节硬预算**，
超了会**静默截断**。2026-10-07 实测：本文件涨到 **65807 字节** ⇒ 被截到 **65242**，
也就是说从某处开始的结论**不再进入新窗口，而读的人不知道自己少读了**。
当时 §7 一块就占 **24030 字节**（全文 37%），正是它把文件顶过预算的。

**规矩**：新结论加进 `复盘/已结案结论.md`；本文件只留**变更频繁的规则**与指针。
每次改完量一下：`wc -c AGENTS.md` **必须显著小于 65536**。

---

## 8. 未决项

1. **必须真人做**：在 DSH 面板里点一页，让 `openmaic_active` 有值。现回 `{"ok":true,"active":null,…}`，
   点过后应回 `{"active":{"stageId":"stage-…","sceneId":"…"}}`。★ **别用 curl 探面板是否加载**（静态资源在
   签名 cookie 认证后；`browse_page` 对回环回 `blocked`）—— 只能靠眼睛，见 §1.13。
2. **重启 DSH 后复验两件** ★ 判「没修好」前先比**进程启动时间与代码 mtime**（实测主进程 10-30 17:22:40
   起、部署副本 10-31 04:53 才同步 ⇒ 现仍跑旧码）：① **`markupChanged`**（§1.7.1）——只改标签的差集现在
   **还不报**，重启后应出 `markupChanged:1` / `textChanged:0`；② **侧栏图标与名字**（§1.14）——重启后应是
   OpenMAIC 立方体 + `OpenMAIC`，不是「课件 课件」。

别的「未决」只跟主仓别的子项目有关，与本 fork 无关，别当 bug 重修：
`zone-of-proximal-development` 措辞与题量参数未对齐（见 §4）；`program/#228`、
`program/framework`、`program/pdf-compress` 未归类、`selfcheck/` 与 `literature-eval/`
是否并入 `ultrarag/`（用户说先留着）；`dblp.ico` 是自绘的等官方 logo；两条 1KB 残留
（`owner_material` 的 `端到端测试材料.md`、孤儿目录 `data/materials/owner-1/`）。

---

## 9. 干活的标准循环

```
1. 读 §2 的地图，确认你要改的东西有没有主
2. 改 lib/ 或 app/（不要动 packages/@openmaic）
3. node node_modules/prettier/bin/prettier.cjs --write <改过的文件>
   npx tsc --noEmit  +  node scripts/check-i18n-keys.mjs  +  python -X utf8 scripts/check-layers.py
4. 重启 next dev（§3.2）—— agent-runtime 不热重载；改了插件见 §12
5. curl /api/whoami 确认开关进去了
6. 要真跑一遍：让用户在工作台里跑，然后**用 §3.3 的 SQL 查事件流**下结论
7. 把结论写回两处：
   · 新规则 / 新坑 / 新结论（附能复现它的命令）→ 本文件 §6 或 复盘/已结案结论.md
   · 现状变了（HEAD / 门禁绿不绿 / 未决项增减）→ 本文件 §0.1 与 §8 **就地改**，不追加旧段
```

**第 7 步是这两份文件存在的理由。** 没写回来的结论，下一个窗口的你要从头再量一遍。

### 一条硬规矩：单元测试通过 ≠ 效果达成

`vitest` 绿只说明**代码按写的方式跑**，不说明**学习者拿到的东西变好了**。
效果只有在真实会话的事件流里读得出来（§3.3）。所以凡是"改产品行为"的改动，
**必须写下"让用户真跑一遍 + 用哪条 SQL 验"**，并且在真读出来之前，不要说"修好了"。

---

## 10. 批量下载（工作台）

功能说明（入口 / 流程 / 产物 / 命名 / 失败隔离 / 浏览器级验证）在
[`docs/intention/needs.md`](docs/intention/needs.md) 的 N8 与
[`docs/specification/domains/F4-bulk-export.md`](docs/specification/domains/F4-bulk-export.md)；
这里只留动手前必看的三条：

动手前必看：`lib/export/batch-export.ts` 顶部的注释（设计口径）；`复盘/已结案结论.md` 里
「不能静态 import `use-export-pptx`」那条（这条链路上最容易踩的性能坑）；入口在**课程**标签
（**默认是对话标签**，别在对话页找它）。

---

## 11. ★ 多窗口并发：两个对话窗口共用一个工作区

2026-10-06 实测过一次真事故：两个窗口都在改 `AGENTS.md`，一次 `git add AGENTS.md`
把对方那一段一起提交了 —— 提交信息只讲 139，内容里却多了一整个章节；
文档从此**描述了一个代码还没进 git 的功能**，别人 checkout 会看到指向不存在文件的文档。

**规矩（按根治力度排序）：**

1. **要并行干不相干的活，用 `git worktree` 分开**，不要共用一个工作区。
   这是唯一根治，前两条只是减损：

   ```bash
   git worktree add ../OpenMAIC-<主题> -b <分支>
   ```

   工程侧本来就是这个口径（每张卡一棵 worktree）。隔离之后还要装节点，见
   [`docs/implementation/运维.md`](docs/implementation/运维.md) §四 —— 新建的 worktree
   **默认开不起来**，还差四步，且 `node_modules` 必须用 PowerShell 的
   `New-Item -ItemType Junction`（`cmd //c mklink /J` 会静默失败）。

2. **提交前永远用显式路径**：`git add <明确的文件>`。
   **绝不用 `git add -A` / `git add .` / `git commit -a`** —— 工作区里随时可能有
   另一个窗口的半成品，一次顺手就卷进你的提交，而**提交信息会撒谎**。
   （反过来说，`git add <单个文件>` 也**不**安全 —— 如果那个文件两边都在改。）

3. **开工前先看有没有别人在动**：`git status --short` 里有没有**不是自己建的**文件；
   有没有文件的 mtime 比上次操作还新；`git rev-parse --short HEAD` **现算**一次
   （§0.1 记的 HEAD 是写那一刻的快照，看到不符先 `git log --oneline <记的>..HEAD`
   查是谁推进的，**别当成数据损坏**）。

4. **`AGENTS.md` 是共享文件**：只加不改旧段（§0.1 与 §8 例外，那两处就是要就地更新）。

---

## 12. ★ DSH 宿主层：插件不在本仓，改完必须两步

目标是**换宿主**（DSH 里看课件、随口问、顺手改，不开 Edge、不维护两套）⇒ 插件是产品的一部分。
插件在 `D:/文档/jelly_ware/_tools/dsh-plugins/`，两包 **20 个工具**（`openmaic-course` **15** +
`openmaic-local-capabilities` 5），每个包分**宿主半**与**浏览器半**：

- **宿主半** `index.js` ⇒ 改完**重启 DSH**；**浏览器半** `client.src.js` ⇒ `node build.mjs` → **再重启**（`client.js` 13.9 MB 是产物、**不要手改**）。
- **★ 两坑**：① 部署副本是**实体拷贝** ⇒ 必须 cp 再重启（`diff -rq lib <部署目录>` 应为空）；② 只改浏览器半才重建。
- **判据**：`node smoke-render.mjs` 末行 `SMOKE: PASS ✅`（别用 `smoke-client.mjs`）。
- **已收口缺陷**：① `/page` 回页本体、**没有 `data` 层** ② 差集剥几何要同时剥文字 ③ `SlideCanvas` 是唯一渲染器。
- **侧栏**：图标是 `register(spec, 图标函数)` 的**第二参数**（不是 label），取 `lib/brand/brand-config.ts` 的 `productName`/`markSrc` → §1.14

**诊断/冻结/纸/材料 8 个工具**都走 `lib/diag.mts` 桥子进程（数据由 index.js 取好走 stdin，桥不碰库）。
★ tsx 要点名 `node_modules/tsx/dist/cli.mjs`（`.bin/tsx` 是 shell 脚本）、别名只能 `import * as m` 再 `m.default ?? m`。
**都不复刻**、直调仓内同名 builder（守卫措辞逐字一致）→ §1.16/§1.17。
**纸与材料落文件系统**：草稿纸 `data/scratchpad/<owner>.json`（复用本机唯一 owner，`sNNN` **永不复用**）；材料库 `个人数据/材料清单/*.md`（目录读 `.env.local`，**没配不回默认值**）★ 写入走沙盒且**先把真文件复制进去**，否则 `append` 报 Created 还丢原内容。

**写入面**：`document_scenes` **没有版本列** ⇒ 并发保护只能靠 jsonb 值本身（CAS `where stage_id=$2 and id=$3 and data=$4::jsonb`）；默认 `dryRun:true` 只算差集 = **设计不是不方便**。`openmaic_active` 是**进程内状态**，重启就空 —— **空 ≠ 坏**。
