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

原 `二开说明.md` / `怎么用.md` / `架构图.md` 已并入五层；`复盘/上游合并清单.md` 与
`复盘/多窗口并行-worktree.md` 里**日后还要照着敲**的部分并入
[`docs/implementation/运维.md`](docs/implementation/运维.md)，其余随文件删除（历史在 git 里）。

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
| 「我是自学，不喜欢听课」 | 见 `docs/specification/教学取向.md` |
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
改之前先看这里，**你要改的东西大概率已经有主了**；**本 fork 独有的文件全表（45 个文件 + 5 个运行期目录，逐行带「干什么 / 关键实测依据」）在 `docs/implementation/modules.md` 第四节**，这里只做路由。

| 我要改… | 去哪一节（括号里是入口文件；细节都在 modules.md 第四节） |
|---|---|
| 运行期开关 / 上下文压缩 / 会话命令 | §二 M2/M5（`lib/server/agent-runtime/config.ts`、`lib/server/agent-runtime/session-commands.ts`、`lib/server/agent-runtime/compaction.ts`、`lib/server/agent-runtime/prompt-context-file.ts`、`usageAnchorIsStale()`） |
| 生成提示词 / brief 规矩 / 听课 vs 自学 | §二 M4（`lib/server/agent-runtime/course-design.ts`、`lib/server/agent-runtime/study-mode.ts`、`lib/server/self-study-mode.ts`、`lib/server/agent-runtime/course-outline-write.ts`） |
| 写入后诊断 / 版面判据 / 审查 | §二 M9/M13（`lib/server/agent-runtime/scene-diagnostics.ts`、`lib/quiz/layout-check.ts`、`lib/slide/text-metrics.ts`、`lib/server/agent-runtime/review-tools.ts`、`lib/server/agent-runtime/page-review.ts`、`sceneWriteDiagnosticsWithReview()`、`outOfScopeGapClaims()`） |
| 答题状态 / 覆盖缺口 / 出题注入 / 题库文本 | §二 M6/M12（`lib/quiz/attempt-fold.ts`、`lib/quiz/learner-state.ts`、`lib/quiz/coverage-gap.ts`、`lib/quiz/quiz-grounding.ts`、`lib/quiz/page-text.ts`） |
| 练习 / 草稿纸 / 计划冻结 / 导出翻页 / MCP 与审计 | §二 M3/M7/M8/M10/M11（`lib/practice/scaffold.ts`、`lib/practice/results.ts`、`lib/scratch/scratchpad.ts`、`lib/server/agent-runtime/plan-freeze.ts`、`lib/export/batch-export.ts`、`lib/playback/reading-navigation.ts`、`lib/server/agent-runtime/mcp-tools.ts`、`lib/server/agent-runtime/audit-tools.ts`、`refreshLearnerStateFromRuntime()`） |

---

## 3. 证据：怎么知道改对了

三条铁律，**命令原文、报错原文、实测数字、判据全部在 `docs/implementation/自检.md` §8**（原 §3 整段搬去的就是）：

1. **§3.1 先跑测试，别先跑产品** —— 改完固定四步、顺序不要换：prettier → `npx tsc --noEmit`（必须 0 error）→ `node scripts/check-i18n-keys.mjs` → `python -X utf8 scripts/check-layers.py`（末行要 `LAYER CHECKS: PASS ✅`）；看到红**先单跑那一个文件**（`npx vitest run tests/agent-runtime/generation-tools.test.ts` 这种单个路径）—— 本机全量有 Windows 环境假红，CI 才是判据。
2. **§3.2 然后重启，这一步不能省** —— `lib/**`、`app/**` 一律整台 `next dev` 重启（`lib/server/agent-runtime/**` **不会热重载**）；修完不重启＝白修。第一站永远是 `local_services`，别再拿 `curl :3000/workspace` 当判据。
3. **§3.3 真话在数据库里，不在日志里** —— 「agent 到底做了什么」只有 `agent_session_events` 能查（工具名、入参、结果全在里面）；量 token 用 `data/usage/*.jsonl`，**上下文 = `inputTokens` 一个数字，别加 `cacheReadTokens`**。

---

## 4. 自学 vs 听课（**已经吵过一轮，别重开**）

取向定过了：内容在屏幕上，不是听讲。**提示词约束不住的东西必须在代码里给默认值**
（`OPENMAIC_SELF_STUDY=true`），实测数字与「曾经的错」都在正文里。
详见 `docs/specification/教学取向.md`；密度判据 `docs/specification/domains/F1-content-density.md`。

---

## 5. 读网页：三道门

`web_search` / `fetch_url` / `browse_url` / `read_material` 分工固定，**「看」和「存」必须分开讲**；
`fetch_url` 是上游文件，改动要小、要带注释。
详见 `docs/implementation/网页读取.md`；验收判据 `docs/contracts/domains/F6-browser-fetch.md`。

---

## 6. 坑（每条都真实浪费过一小时）→ 全文见 [`docs/implementation/坑.md`](docs/implementation/坑.md)

> **动那个东西之前，先扫一眼这里有没有对应的坑。** 每一条都**真实浪费过一小时**，
> 每一条都是**实测**的（命令 / 读数 / 日期 / 报错原文都在全文里）。搬出去的理由同 §7：
> 本文件会被自动注入，有 **65536 字节**硬预算，超了**静默截断**。

- **§6.1 Turbopack junction**：硬杀 dev server 会留下 junction 残留，下次启动第一秒必 panic → 详见 `docs/implementation/坑.md`
- **§6.1b Next 16 的 dev origin 拦截**：`127.0.0.1` 打开时按钮全没反应 —— 不是组件坏了，是 JS 分块被当跨域拦掉 → 详见 `docs/implementation/坑.md`
- **§6.2 这台机器上会挂死的命令**：`taskkill` / `Get-CimInstance` / 给启动脚本接管道，都能让作业永不返回 → 详见 `docs/implementation/坑.md`
- **§6.3 其他零碎**：改 `.env.local` 要重启、单会话单 worker、左栏两层折叠、`DELETE /api/stages` 是软删 → 详见 `docs/implementation/坑.md`
- **§6.4 两条已结案的环境事实**：注释里的数字可能是上游账号快照；`@openmaic/dsl` 没有 `require` 条件 → 详见 `docs/implementation/坑.md`
- **§6.6 `sceneId` 只在 stage 内唯一**：按 sceneId 做键必须带 `stage_id`，否则会把别门课的题干注进这个人的提示词 → 详见 `docs/implementation/坑.md`
- **§6.7 slide 的 `content` 就是 HTML**：当纯文本用会把 CSS 关键词当成「讲过的词」喂给模型，比不注入更糟 → 详见 `docs/implementation/坑.md`
- **§6.8 `个人数据\` 只放学习成长的东西**：harness 的调试产物跟 harness 走，别混进去 → 详见 `docs/implementation/坑.md`
- **§6.9 拿上游估算器做下游决策前先问假设**：先写下它假设了什么没变，再问新功能打破了哪一条 → 详见 `docs/implementation/坑.md`
- **§6.10 分段工具的「前面所有页」必须指全课**：否则假阳性是工具自己造的；「审查说蠢话」先分工具错前提还是模型没照做 → 详见 `docs/implementation/坑.md`

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
`zone-of-proximal-development` 措辞与题量参数未对齐（见 `docs/specification/教学取向.md`）；`program/#228`、
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
4. 重启 next dev（§3.2）—— agent-runtime 不热重载；改了插件见 `docs/implementation/DSH宿主.md`
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

功能与流程在 N8 与 F4，不在手册。动手前必看 `lib/export/batch-export.ts` 顶部注释、
以及「不能静态 import `use-export-pptx`」那条性能坑；入口在**课程**标签（默认是对话标签）。
详见 `docs/implementation/架构图.md` §7。

---

## 11. ★ 多窗口并发：两个对话窗口共用一个工作区

并行干不相干的活用 `git worktree`；只用 `git add <文件>`，**绝不 `-A` / `.` / `commit -a`**；
开工先现算 `git status --short` 与 `git rev-parse --short HEAD`。
详见 `docs/implementation/运维.md` §八（纪律）与 §四（怎么建 worktree）。

---

## 12. ★ DSH 宿主层：插件不在本仓，改完必须两步

宿主半改完重启 DSH、浏览器半 `node build.mjs` 再重启 —— 少一步就是不生效。
判据是四条冒烟（render / quiz / wheel / thumb），**别拿 `smoke-client.mjs` 当验收**。
详见 `docs/implementation/DSH宿主.md`。
