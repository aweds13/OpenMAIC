# AGENTS.md —— OpenMAIC 二开维护手册

> 这份文件会被 DSH 自动注入（`@deepseek-ai/dsh-agent-instructions`：从**最近的 `.git`
> 所在目录**到会话工作目录，逐层加载 `AGENTS.md`）。目的是让**一个新开的对话窗口**
> 不用重新摸索就能干活。
>
> 写法约定：**只写操作知识**（顺序、前置检查、常见错、该看哪个产物）。判据在代码里。
> 一条结论只有在**实测过**之后才写进来，并附上能复现它的命令。

## 四份文件，四个读者 —— 别混

| 文件 | 给谁看 | 装什么 | 什么时候改 |
|---|---|---|---|
| [`二开说明.md`](二开说明.md) | **人** | 这个二开**做了什么、为什么**（每条附实测读数）+ 怎么跑 + 目录地图 | 加/改了一个**功能**时 |
| **本文件**（`AGENTS.md`） | **agent** | **规则**：改哪一层、文件地图、证据命令、坑、已结案的结论 | 发现新规则 / 新坑 / 新结论时 |
| [`复盘/新窗口交接卡.md`](复盘/新窗口交接卡.md) | **agent** | **状态**：当前 CHECKPOINT + **新窗口照抄的第一条消息** | 每干完一件事 |
| [`复盘/已结案结论.md`](复盘/已结案结论.md) | **agent** | **已量过、已结案**的结论（每条附复现命令）。**动手前先读** | 有新结论时 |

**新窗口的第一条消息在交接卡里，照抄即可。** 本文件是被它引用的规则层。

★ **别把功能说明写进本文件**：那是 `二开说明.md` 的位置。这里只写"怎么不出错"，
那里只写"做了什么、为什么"。两处都写必然漂。

---

## 0. 一句话现状

这是 THU-MAIC **OpenMAIC** 的二开分支（`my-extensions`，基线 `57fbcc4`）。
改动**全部在 `lib/` `app/` `tests/` 和 `skills/agent-runtime/`**，`packages/@openmaic/**`
一行没动 —— 那是上游，当只读用。

使用者是**一个自学者**（天津大学计算机大一，备二面）。他对产物的要求是实测出来的，
不是偏好：

| 他说的 | 实测出来的数字 |
|---|---|
| 「幻灯片好粗糙，内容单薄，不如我自学」 | 默认 61 汉字/页 vs 天大真实课件 **352–390**/页 |
| 「我是自学，不喜欢听课」 | 见 §4「自学 vs 听课」 |
| 「题量对不上」 | 自检页曾经**永远是 3 题**（写死的兜底），其余靠 agent 手补 |
| 「读网页会被拦、会截断，这不是假的吗」 | 预览 2000 字符 vs 正文平均 **17,443** —— 只读到 **11%** |

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

注册一个新工具要同时改**四处**（少一处就是"看得见、调不动"）：

1. `lib/server/agent-runtime/<能力>.ts` —— `resolveXxxCapability()` + 工具 + 提示词块
2. `lib/server/agent-runtime/runner.ts` —— `const x = resolveXxxCapability()` → `xxxTools`
3. `runner.ts` 的 `assembleRunnerTools(...)` —— 加一组
4. `runner.ts` 的 `allowedToolNames` —— **必须同时放行**，否则调用被拒
   （另有 `course-tools.ts` 的 `CoursePromptBlocks` 要加字段，否则提示词块推不进去）

`runner-course-search-registration.test.ts` 是这套东西的 pin，照它写新能力的测试。

### 1.2 提示词缓存：一句话成本

系统消息在 provider 的 prefix cache 里是**一个整体**。**改动任何一个字节 ⇒ 整个系统
消息重新计费。**

- 所以 `sessionMaterialsPromptBlock()` 被改成**无参、恒定**的：它以前把材料列表写进
  系统提示词，每登记一次材料就换一次提示词，持续 3% 的缓存未命中。
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
| `lib/server/agent-runtime/materials-library.ts` | `read_materials` / `update_materials` | agent 自己维护的材料库 |
| `lib/server/agent-runtime/mcp-tools.ts` + `mcp-client.ts` | 外部 MCP（GitHub）接进工作台 | 连不上只记 failed，不拖死会话 |
| `lib/server/agent-runtime/compaction.ts` | 原生上下文压缩 | **默认关**，本部署开着 |
| `lib/server/agent-runtime/session-commands.ts` | `/compact` 之类的会话命令 | |
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
| `lib/server/agent-runtime/course-outline-write.ts` | **T1：让 brief 落盘** —— `generate_scene` 写页之后，把这条 `SceneOutline` 按 outlineId/order upsert 进课程计划 | 见 结论库「计划从来没落盘过」 |
| `lib/server/agent-runtime/audit-tools.ts` | **`course_audit`**：课程级审计（承接率 + 超载），**纯只读**、无条件注册 | 修一门已有课程**先审它**；见 结论库「先量再建」 |
| `lib/server/agent-runtime/scratch-tools.ts` | **草稿纸**：存储 + `scratch` 工具 + 提示词块（照材料库成例一个文件） | `promote` 按 `listMaterialTopics()` **对照磁盘校验**；见 结论库「幽灵参数」 |
| `lib/server/agent-runtime/practice-tools.ts` | **`practice_scaffold`**（写练习文件夹）+ **`practice_result`**（读回结果） | **不起进程**；与 VS Code 的联动靠 `.vscode/` 配置 |
| `lib/practice/scaffold.ts` | 脚手架**内容**生成（`check.mjs` runner / README / `.vscode`） | 编码坑（GBK）在 runner 里**修一次** |
| `lib/practice/results.ts` | 读练习目录下的 `result.json` → 渲染进 `学习状态.md` | T9 走**读取侧**，不开新写入路径 |
| `lib/scratch/scratchpad.ts` | 草稿纸**纯逻辑**：编号 `s001`（永不复用）/ 两层 / 索引 / 「只有 1 个来源」 | 与材料库的边界在 `promote` |
| `lib/server/agent-runtime/plan-freeze.ts` | 阶段冻结的**判据**（`planGate` 三条）+ 总开关 `planGateEnabled()` | 开关默认关；本部署 `OPENMAIC_PLAN_GATE=1` |
| `lib/server/agent-runtime/plan-freeze-store.ts` | 冻结状态的**独立小文件**读写（`data/plan-freeze/`） | 不放 `document_outlines`（怕静默失效） |
| `lib/server/agent-runtime/plan-freeze-tools.ts` | **`plan_freeze`**（add / backfill / freeze / revise）+ 提示词块 | `backfill` **只补缺、绝不覆盖** |
| `lib/quiz/course-audit.ts` | 课程级**审计判据**（承接率 + 超载线 `NOVEL_P90=49`），纯函数 | 超载线是 146 个真实讲解页的 p90 标定的 |
| `lib/quiz/plan-check.ts` | **计划期**依赖校验：超前引用 / 无归属 / 预算（三条只输出「补」和「挪」） | `conceptsPerPage` 默认关；见 结论库 |
| `components/generation/self-study-button.tsx` | 首页那条链上的「自学」开关（经典路径，与工作台的 `study-mode.ts` 不同一条路） | 在工作台路径上搜不到 `selfStudy` |
| `lib/server/agent-runtime/scene-diagnostics.ts` | **两条写入路径共用**的写入后诊断（`generate_scene` **与** `patch_stage`） | 见 结论库「门禁必须挂在两条路径上」 |

**`/api/whoami` 是第一站。** 它回显 `runtime.selfStudyDefault` 等**模块加载时求值**的
开关 —— "我改了 `.env.local` 怎么没反应"的答案通常是"没重启"，而它会直接告诉你进程
当前握着什么值。

---

## 3. 证据：怎么知道改对了

### 3.1 先跑测试，别先跑产品

```bash
cd D:/文档/jelly_ware/program/OpenMAIC
npx vitest run tests/agent-runtime/          # 主战场（~1100 用例，~55s）
npx tsc --noEmit -p tsconfig.json            # 必须 0 error
npx eslint <改过的文件>                       # 必须 clean
```

**已知假红**：`tests/agent-runtime/voice-clone-tools.test.ts` 的
`clips to a 24 kHz mono PCM WAV` 在整包并行时会 **5s 超时**，单跑 1.2s 过。
它是 CPU 抢占，不是回归 —— 单跑确认一遍再下结论。

**第二条已知假红**：`tests/workbench/workspace-rail-session-rename.test.ts` 的
`shows the name the user gave it…` 在整包并行时 **5s 超时**，**其余 4 条连锁失败**
（第一条没渲染完，后面的行就找不到）。单跑 **~2.8s** 过。已 A/B 实测过两次，
都不是它自己坏了：把改动 `git stash` 掉、或把新加的测试文件移走，**同样红**。
真凶是机器负载（dev server / msedge / 一堆常驻服务）。单跑一遍再判。

**新加的两处测试**（批量下载）：
- `tests/export/batch-export.test.ts` —— 组合逻辑，注入假 deps，node 环境，快。
- `tests/export/batch-export-real-builders.test.ts` —— **用真的三个 builder** 组装，
  jsdom + `fake-indexeddb`。真 PPTX 是 CPU 密集的，所以它自己带 **30s** 超时；
  5s 默认值在整包并行下会误红（同类假红）。

**一条既有的真红（不是本轮引入）**：`node scripts/check-i18n-keys.mjs`
（`pnpm check:i18n-keys`）会报 **10 个语言各缺 2 个键**
（`toolbar.selfStudyModeHint` / `toolbar.selfStudyModeLabel`）。实测：这两个键在
**HEAD 里也只存在于 en-US / zh-CN / zh-TW**，是自学模式那一轮留下的缺口，
与后来的改动无关。要么补 10 份翻译，要么先别把这个脚本加进 CI —— 别以为是自己弄坏的。

**第二条既有的真红**：`tests/store/` 里有 3 条**一直**红（单跑也红，不是负载）——
`settings-claude-web-search.test.ts`「falls back to the default provider when claude is
disabled while selected」、`disable-switches-selection.test.ts`「web search: … falls back
to tavily」、`kv-persist.test.ts`「says nothing to the user when a healthy backend simply
had not hydrated yet」，实测报的都是 `expected 'metaso' to be 'tavily'`。
根因是**本 fork 把默认搜索提供方换成了 metaso**（`lib/store/settings.ts` 的
`webSearchProviderId: 'metaso'`），而上游那几条用例仍期望 tavily。
已 A/B 实测：`git checkout -- lib/store/settings.ts` 之后**同样红**。改搜索相关的东西
之前先知道这件事，别把它们算进自己的账。

**第三条既有的真红**：`tests/quiz/runtime.test.ts` 有 4 条**挂住**（不是慢）——
`recovers when another tab wins the same session create race without Web Locks`、
`deduplicates concurrent identical lifecycle writes without Web Locks`、
`rolls over when another tab completes after this tab observed active`、
`reuses one active retry for concurrent retry requests across tabs`。
2026-10-07 实测：`--testTimeout=20000` **仍然全红**（整轮 80.9s = 4 × 20s），
所以它不是 §3.1 开头那种"并行 5s 抢占"的假红。已 A/B：当时 `git status --short`
**只有本轮新增的两个 untracked 文件**、`HEAD = d7a5ca4`，且新模块**没有任何
importer**（`grep -rn "attempt-fold" lib app components tests` 只有它自己的测试）——
所以与本轮改动无因果。**都是"没有 Web Locks 时的并发路径"，改 quiz 写入之前先看这 4 条。**

**测试是 hermetic 的**：`tests/setup-env.ts` **默认不加载 `.env.local`**。所以你的测试
不依赖本机配置；要跑真端点才用 `TEST_LOAD_LOCAL_ENV=1`。

### 3.2 然后重启 —— 这一步不能省

> **`lib/server/agent-runtime/**` 的任何改动都不会热重载。** 必须整台 `next dev` 重启。

```bash
# 1) 找 3000 的 PID（taskkill / Get-CimInstance 在这台机器上会挂死，别用）
netstat -ano | grep -E ":3000\s" | grep LISTENING
# 2) 杀
powershell -NoProfile -Command "Stop-Process -Id <PID> -Force"
# 3) 起（脚本自己会清 Turbopack 残留链接，见 §6）
powershell -NoProfile -ExecutionPolicy Bypass -File "D:/文档/jelly_ware/_tools/openmaic/start_all.ps1"
# 4) 验
curl -s http://127.0.0.1:3000/api/whoami
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/workspace   # 要 200
```

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
FROM document_scenes WHERE data->>'type'='quiz' ORDER BY 1,2;
```

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

### 6.2 这台机器上会挂死的命令

| 别用 | 用 |
|---|---|
| `taskkill`、`Get-CimInstance` | `netstat -ano` 找 PID + `Stop-Process -Id` |
| `powershell … \| tr -d '\r'` | 重定向到文件再读。**有 detached 子进程继承管道时它永不返回** |
| `$pid`（PowerShell 里只读） | `$procId` |
| PowerShell 5.1 读非 BOM 的 `.ps1`（当 ANSI） | **脚本只写 ASCII**，路径从 `$PSScriptRoot` 推 |

### 6.3 其他

- **改环境变量要重启**：`.env.local` 在进程启动时读。先看 `/api/whoami` 的 `runtime`。
- **`RUNNING_MAP` 单会话单 worker**：`OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT=1` 是故意的。
- **UI 有两层折叠**：左边栏默认「对话」，课程在折叠的文件夹里 —— 用户说"课程不见了"
  先怀疑这个，再怀疑数据。
- **`DELETE /api/stages/<id>` 是软删**（`stage_meta.deleted_at`），不是真删。
- **`psql` 中文 SQL 字面量** ⇒ 见 §3.3。

### 6.4 ★ 代码注释里的数字，可能是**上游作者自己账号**的快照

这条是真花掉过时间的，所以单列。

`components/workbench/workspace/WorkspaceRail.tsx:33` 与 `:504` 都写着
**"this account has 139 courses"** —— 拿它去查数据库会一无所获：本部署
`stage_meta` 只有 **7 行**（1 个 owner、0 公开、0 删除），课程库那边也没有任何
计数是 139（`/health` 报 60072；30 个抓取源里恰好 139 的只有
`courseleaf:utexas-math` = UT Austin 数学系，**与这个注释毫无关系**）。

那 139 是**上游作者自己的账号**，写在这里是为了论证一个设计：课程列表**一页一页
reveal**，因为"reveal everything 不是一种导航"。文件本身我们一行没改
（`git log 57fbcc4..HEAD -- <该文件>` 为空）。

**所以：注释里的具体数字只能当"这段代码在防什么"来读，不能当本部署的数据来用。**
要本部署的数字，只有三个来源：`/api/whoami`（owner 与课程）、`/api/...` 实际响应、
以及 §3.3 的 SQL。**注释不算证据。**

顺带一个容易误判的读数：`RAIL_INITIAL_ROWS = 10` / `RAIL_PAGE_SIZE = 20`
（`lib/workbench/workspace-paging.ts`）—— 本部署 7 门课**根本触发不了分页**，
所以"课程列表要点开下一页"这类抱怨在当前数据量下不成立，别照注释去查分页逻辑。

### 6.5 ★ 想"写个脚本读真数据"时：`@openmaic/dsl` 没有 `require` 条件

2026-10-07 实测（想给 `attempt-fold` 写个读 PG 的小脚本，浪费了两次尝试）：

`node_modules/@openmaic/dsl/package.json` 的 `exports` 只有
`{".": {"types": "...", "import": "./dist/index.js"}}` —— **没有 `require` 条件**。
而本仓库的 `package.json` 没有 `"type": "module"`，所以：

- `npx tsx scripts/xxx.ts`（tsx 把它当 **CJS**）→ `require('@openmaic/dsl')`
  → **`ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined`**；
- 改名 `.mts` 让入口变 ESM 也不行：它 `import` 的那个 `.ts` 仍被当 CJS 加载
  → **`does not provide an export named 'foldQuizAttempts'`**。

`lib/runtime/payload-validators.ts` 里那种「从 `@openmaic/dsl` 取运行时值」的写法
**只在 Next/Turbopack 和 vitest 下成立**，不要在裸 node 里复刻。

**规矩：要给"读真数据"的代码留可复现入口，别写独立脚本 —— 写成 vitest 用例。**

```bash
TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/attempt-fold-live.test.ts
```

模式是仓库自己的（`tests/setup-env.ts` 的注释就是这么写的）：用例用
`describe.skipIf(process.env.TEST_LOAD_LOCAL_ENV !== '1')` 守卫 —— **默认 hermetic
（CI 无网无库也绿），要真库时一行环境变量**；断言写成"任何部署都成立的不变式"，
具体读数用 `console.log` 打出来看。`tests/quiz/attempt-fold-live.test.ts` 是范本。

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
   在编译期就不可能（同 §12 的 `readingPage` 必填那条思路）。
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

## 8. 未决项（**别当成 bug 重新修**）

- `skills/agent-runtime/zone-of-proximal-development` 等技能里的"自检"措辞与题量参数
  还没对齐（见 §4 的题量改动）。
- `program/#228`、`program/framework`、`program/pdf-compress` 未归类，用户说先留着。
- `selfcheck/`、`literature-eval/` 是否并入 `ultrarag/` —— 用户说"留着先吧"。
- `dblp.ico` 是自绘的，等官方 logo。
- 两条 1KB 残留待用户决定：`owner_material` 里 `端到端测试材料.md`（owner
  `anon:c03e0fe5…`）、孤儿目录 `data/materials/owner-1/`。

---

## 9. 干活的标准循环

```
1. 读 §2 的地图，确认你要改的东西有没有主
2. 改 lib/ 或 app/（不要动 packages/@openmaic）
3. npx vitest run tests/agent-runtime/  +  tsc  +  eslint
4. 重启 next dev（§3.2）—— agent-runtime 不热重载
5. curl /api/whoami 确认开关进去了
6. 要真跑一遍：让用户在工作台里跑，然后**用 §3.3 的 SQL 查事件流**下结论
7. 把结论写回两份文件：
   · 新规则 / 新坑 / 新结论 → 本文件（附上能复现它的命令）
   · 新状态 / 下一步        → 复盘/新窗口交接卡.md（**追加**一段，不删旧的）
```

**第 7 步是这两份文件存在的理由。** 没写回来的结论，下一个窗口的你要从头再量一遍。

### 一条硬规矩：单元测试通过 ≠ 效果达成

`vitest` 绿只说明**代码按写的方式跑**，不说明**学习者拿到的东西变好了**。
效果只有在真实会话的事件流里读得出来（§3.3）。所以凡是"改产品行为"的改动，
**必须在交接卡的"下一步"里留下"让用户真跑一遍 + 用哪条 SQL 验"**，
并且在真读出来之前，不要说"修好了"。

---

## 10. 批量下载（工作台）

**问题**：想拿某门课的 PPTX / 可交互页，只能**打开那门课**再用 Stage Header 的下载菜单
—— 课一多就是"一门门打开"。而且浏览器**会拦截一个页面连续触发的多次下载**，
所以"批量"必须打成**一个 ZIP**。

| | |
|---|---|
| 入口 | 工作台左侧栏 → **课程**标签 → 搜索行右侧的 ⬇（`data-testid="pro-nav-batch-download"`）。**只在课程标签页渲染**（默认标签是对话，别在对话页找它） |
| 流程 | 勾课（全选/清空/筛选）→ 选内容（PPTX / 交互式页面 HTML / 完整课堂 ZIP，默认全开）→ 下载 ZIP |
| 产物 | `OpenMAIC-batch-<yyyy-mm-dd-hhmm>.zip`，每个课程一个文件夹：`<课>.pptx`、`interactive/NN_标题.html`、`<课>.maic.zip` |
| 命名 | 非法字符换 `_`，重名追加 ` (2)`（大小写不敏感去重）——ZIP 条目撞名会**静默吞掉**一门课 |
| 失败隔离 | 某门课抛错只记一行（结果面板里标红、`title` 是原因），**其余照跑**；全失败则不落盘 |
| 取消 | 对话框里的取消 / 直接关窗都 abort；**已经组装的部分被丢弃**，不产生半个 ZIP |
| 进度 | 逐课串行（PPTX 与媒体收集本来就吃满一个线程，并发只会把峰值内存乘上去） |

**为什么每课还要 `.maic.zip`**：测验页和 PBL 页**没有独立 HTML 导出**——它们靠应用的
React 渲染器（`components/scene-renderers/quiz-renderer.tsx`、`pbl-renderer.tsx`）。
`.maic.zip`（`manifest.json` + 结构 + 媒体，见 `classroom-zip-types.ts`）是**唯一**
能把一门课**整门**带走、还能再导入回来的产物。它**不含** PPTX。

**改这块之前先读**：`lib/export/batch-export.ts` 顶部的注释（设计口径），以及 `复盘/已结案结论.md` 里
"不能静态 import `use-export-pptx`" 那条 —— 那是这条链路上最容易踩的性能坑。

**浏览器级验证**（这轮实测用的办法，无需用户数据；`/workspace` 的 rail 是**纯客户端**的，
`curl` 拿到的 HTML 里**没有** rail，别用 curl 验 UI）：

```bash
# 1) 需要 dev server 在跑（§3.2）。2) playwright 在 pnpm store 里，不在根 node_modules：
#    require('…/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright')
# 3) 脚本要点（照抄即可）：
#    page.goto('http://127.0.0.1:3000/workspace')
#    waitForSelector('[data-testid="pro-nav-tablist"]')
#    click('[data-testid="pro-nav-tab-courses"]')          # 默认在对话标签！
#    waitForSelector('[data-testid="pro-nav-batch-download"]')
#    click(...) → waitForSelector('[data-testid="batch-download-dialog"]')
```

实测读数（2026-10-06，本机）：工具栏 = `["pro-nav-import-course","pro-nav-new-folder",
"pro-nav-batch-download"]`；`aria-label="批量下载"`；对话框标题 `批量下载`、
按钮 `下载 ZIP`（未选课时 **disabled**）、计数 `已选 0 / 0 门`、3 个内容勾选、
`maic.zip` 与 `PBL` 提示语都在；**console errors: none**。
新窗口（无 cookie）owner 为空 ⇒ 课程列表 0 条，属正常。

---

## 11. ★ 多窗口并发：两个对话窗口共用一个工作区

2026-10-06 实测到的一次，值得记住 —— 因为**犯错的不是"另一个窗口"，是提交时的顺手**。

### 发生了什么

同一时刻两个窗口在这个仓库里干活：一个在记「139 那条注释」的坑，另一个在做
**批量下载**（`lib/export/batch-export.ts` + `BatchDownloadDialog.tsx` + 12 个 locale）。
两边**都在改 `AGENTS.md`**。结果：

- `git status` 里出现 20 项**不是自己建的**改动；
- 一次 `git add AGENTS.md` **把对方写的那一段一起提交了** —— 提交信息只讲 139，
  内容里却多了一整个 `## 10. 批量下载`；
- 更深一层：`AGENTS.md` 从此**描述了一个代码还没进 git 的功能**
  （`BatchDownloadDialog.tsx` 当时还是 untracked）。别人 checkout 这个提交，
  会看到指向**不存在文件**的文档。
- 对方交接卡里记着 `HEAD = 14a239b`，而实际 HEAD 已被这边推进两笔 ——
  **它以为的现状是错的，而且它不知道。**

### 规矩

1. **提交前永远用显式路径**：`git add <明确的文件>`。
   **绝不用 `git add -A` / `git add .` / `git commit -a`** —— 工作区里随时可能有
   另一个窗口的半成品，一次顺手就卷进你的提交，而且**提交信息会撒谎**。
   （反过来说：`git add <单个文件>` 也**不**安全 —— 如果那个文件两边都在改。
   所以第 3 条才是根治。）
2. **开工前先看有没有别人在动**：
   - `git status --short` 里有没有**不是自己建的**文件；
   - 有没有文件的 mtime **比上次操作还新**；
   - 交接卡最新一段的作者是不是自己。
3. **要并行干不相干的活，用 `git worktree` 分开**，不要共用一个工作区：

   ```bash
   git worktree add ../OpenMAIC-<主题> -b <分支>
   ```

   工程侧本来就是这个口径（`复盘/新窗口交接卡.md`：**每张卡一棵 worktree**）。
   这里只是没做。
4. **`AGENTS.md` 与交接卡是共享文件**：交接卡 **append-only**（两边同时追加会在
   同一位置冲突）；`AGENTS.md` 只加不改旧段。
5. **交接卡里的 `HEAD` 是写卡那一刻的快照，不是现状。** 动手前
   `git rev-parse --short HEAD` **现算**。看到"记的 HEAD ≠ 实际 HEAD"，
   先 `git log --oneline <记的>..HEAD` 查是谁推进的，**别当成数据损坏**。

---

## 12. 「课程是播放器，不是阅读器」—— 阅读页怎么走

### 判据只有一条

```
readingPage = (scene.actions?.length ?? 0) === 0
```

自学模式（现在的默认）下**每页 actions 都是空的**。这样一页**没有讲稿可放**，
所以它是一张**要读的纸**，不是一段要播的东西。

### 旧行为（用户的原话：「就像放视频，我不需要这种东西」）

`resolvePlaybackCursor` 会给空动作的页合成一个 `EMPTY_SCENE_DWELL`（空文本
speech），空 speech 走朗读计时器，而空文本落到 `MIN_READING_MS = 2000`：

```
estimateSpeechDurationMs('') = max(2000, 0 × 240) = 2000ms
```

**每页停 2 秒**，然后 `onComplete`。`PlaybackChromeRoot` 的 onComplete 在
**自动播放**（工具栏那个 ⟳，`autoPlayLecture`，默认关但**会记住**）打开时
`setCurrentSceneId(下一页)` —— 于是整门课以 2 秒/页播完。
自学页正文 350–400 字 ≈ 1–2 分钟阅读量，**差了 30–60 倍**。

### 新行为

| 文件 | 干什么 |
|---|---|
| `lib/playback/engine.ts` | 空动作的页**停住等人**（`parkedOnReadOnlyScene`）。不再计时、不再 `onComplete`；此时 `resume()` = "这页看完了，往下走" |
| `components/canvas/canvas-area.tsx` | 不显示中间那个大播放键；**点页面 = 下一页**；**滚轮 = 翻页** |
| `lib/playback/reading-navigation.ts` | 滚轮判据（阈值 12 / 去抖 450ms）抽成纯函数 —— 少了去抖，一次轻甩翻十几页 |
| `components/canvas/canvas-toolbar.tsx` | 藏播放/暂停与自动播放开关（在阅读页上它们都是**假控件**）；翻页键留着 |
| `components/edit/PlaybackChromeRoot.tsx` | `←`/`→` 以前只在**全屏演示**里翻页；现在阅读页也能翻 |

### ★ 两个会让人改错的坑

1. **引擎是拿 `[currentScene]`（一个场景）建的**，不是整门课。
   跨页前进靠 `onComplete` → `setCurrentSceneId` → **重建引擎**，
   **不是引擎自己走场景**。不知道这条会写错测试（我第一版按多场景写，全红）。
   所以 `onSceneChange` 在这里基本是空的 —— 别指望它。
2. **`readingPage` 是"传了才生效"的布尔量**：漏传不报错，只会**静默地把播放键
   还回来**，正好退回被修掉的那个 bug。所以 `CanvasToolbarProps.readingPage`
   是**必填**的，靠编译器兜 —— 设成必填的当下它就抓出了 3 个我漏掉的调用点，
   还暴露了 `CanvasArea` 其实是**自己算**这个值（所以 `CanvasAreaProps` 用
   `Omit<CanvasToolbarProps, 'readingPage'>`）。

### ★ 滚轮翻页必须能关掉，且不许抢页内的滚动

用户的原话：「滚轮功能可以自己自由在看课时关掉才行，因为有时课件内部也要上下滑动，
有冲突」。冲突是**真的**：`scene-renderers/quiz-renderer.tsx` 的根就是
`overflow-y-auto`，`pbl/v2/*`、`CodeElement` 也各自有可滚容器 —— 长测验页会在翻页的
同时被滚走。所以这条手势上有**两个闸**，判据都在 `lib/playback/reading-navigation.ts`：

| 闸 | 判据 | 少了它会怎样 |
|---|---|---|
| 用户的开关 | `canTurnPageOnWheel(ctx)`，读 `settings.wheelPageTurn`（默认 `true`，**持久化**） | 开关**静默失效**：关掉后滚轮继续翻页，没有任何报错 |
| 页内还能滚 | `innerScrollConsumesWheel(target, deltaY, currentTarget)` | 长测验页 / PBL 面板被抢走手势（滚到**头**再继续滚才翻页 —— 这是有意的滚链，别改成"只要可滚就永不翻页"，那会让长页变成死胡同） |

**开关按钮**在 `components/canvas/canvas-toolbar.tsx`，渲染条件是
`onToggleWheelPageTurn && readingPage` —— 两个条件都必要：有讲稿的页滚轮从来不翻页；
**roundtable 布局渲染同一个工具栏但舞台上没有 `onWheel`**，在那里摆开关就是假控件
（§1.1 的同一条原则）。`wheelPageTurn` / `onToggleWheelPageTurn` 由 `CanvasArea` 从
store 读并自己拥有（`CanvasAreaProps` 把这两个 `Omit` 掉）—— 滚轮处理就在它里面，
让调用方传就等于有两个接线点，必有一个会漂。

**文案**：`stage.wheelPageTurn` / `…Off` / `…On`，12 个 locale 全都要有
（`tests/i18n/wheel-page-turn-locales.test.ts` 钉住）。

### 怎么测

仓库**没有 @testing-library**，但渲染测试是能写的 —— 照
`tests/components/roundtable-reference-send.test.ts`：文件头 `// @vitest-environment jsdom`、
`createRoot` + `act`、`vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)`、
`vi.mock('@/lib/hooks/use-i18n', ...)`（组件要 `t`）。
新加的 pin：`tests/playback/reading-page-park.test.ts`、
`tests/playback/reading-navigation.test.ts`、
`tests/components/canvas/canvas-toolbar-reading-page.test.ts`、
`tests/playback/wheel-inner-scroll.test.ts`（jsdom，几何用 `Object.defineProperty`
摆出来 —— jsdom 不做布局）、`tests/components/canvas/canvas-area-wheel-gate.test.ts`
（**真的挂 `CanvasArea`、派发真的 `wheel` 事件**，锁住"开关真的被读了"）、
`tests/i18n/wheel-page-turn-locales.test.ts`。

**这两条必须做变异测试**（实测过，两次都会红）：把 `canvas-area.tsx` 里传给
`canTurnPageOnWheel` 的 `wheelPageTurn` 改成 `true`、或删掉
`innerScrollConsumesWheel` 那一行 —— 对应的用例立刻失败。纯函数测试抓不住
"组件忘了读开关"这类错，所以这两条钉在组件上。


