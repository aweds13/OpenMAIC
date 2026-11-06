# OpenMAIC 二开指南差异：官方规范 vs 我方实际（实测）

> 勘察对象：`D:/文档/jelly_ware/program/OpenMAIC`
> 我方 = 本地 HEAD `918b4f0d`（分支 upgrade/v1.3.0）；官方 = `origin/main` `1b641161`（2026-11-04 21:23）
> merge-base = `3618238d`（2026-10-29）；origin/main..HEAD = 263 笔，HEAD..origin/main = 27 笔（我方落后 27）
> 本机：node v24.19.0 / npm 11.17.0 / **pnpm 未安装** / docker 29.7.2 / gh 2.98.0
> 全部结论来自读源码与跑命令，读数原样贴；拿不准的写「不知道」，集中在第 7 节。
> 本次勘察**未修改 OpenMAIC 仓任何文件**（git status 仍只有 3 个未跟踪 md）。

---

## 0. 一句话结论

官方 CONTRIBUTING.md 里可逐条判定的要求共 **47 条**，我们**遵循 12（含 2 条打折的）、部分 13、未遵循 15、不适用 7**（不适用全部因为「我们不走 PR」）；
但真正要紧的不是条数，而是三件事：**我们 263 笔提交没有一笔走过 PR/issue 流程**、**官方 CI 的判据在我方分支上从未运行过一次**、
**13 个 fork 自造的运维级环境变量一个都没进 .env.example**。publishable 包版本纪律实测**零违规**，
但这份「通过」是空洞的（区间内根本没有 publishable 变更），我们从未真正练习过那条门禁。

### 0.1 先纠正两条被当作「已实测」的前提

任务给的背景事实里有两条与实测不符，报告以实测为准：

| 背景事实 | 实测 | 读数 |
| --- | --- | --- |
| 我方本地 HEAD 没有 CONTRIBUTING.md | **有**，且与上游是同一个 blob | `git rev-parse HEAD:CONTRIBUTING` 输出 = `5818e6c9c9724284e7d1bbe89d5e1b032430f6bb`，与 origin/main 版 CONTRIBUTING.md **同值**；233 行 / 11767 B；来自上游提交 `76009ef9 docs: add Codex review rules and review-thread guidance (#2039)` 被 merge 带进来 |
| 官方没有独立二开文档 | **不成立**，上游有两处 | ①`packages/docs/`（69 文件，Fumadocs 站点，`content/docs/` 下 7 主题 × 6 语言 `.mdx`，其中 hosting.mdx 986 行，README 的 host extension hooks 指向它）②`skills/openmaic/references/`（extend.md 56 行、extend-sdk.md 83 行、extend-cookbook.md 83 行）|

「`origin/main` 的 docs/ 树为空」这条**复核成立**：`git ls-tree -r origin/main -- docs/` 输出 0 行。
上游顶层 `*.md` 只有 7 个：AGENTS.md、CHANGELOG.md、CONTRIBUTING.md、README-zh.md、README.md、SECURITY.md、comfyui-setup-instructions.md。

### 0.2 复核任务里的第三条结论：「官方没有独立 plugin SDK 文档」

任务给的判据是 `grep -iE "contribut|develop|extension|plugin|开发者|二次开发"` 只命中 CONTRIBUTING.md 与 skills/ 下的 zone-of-proximal-development。
**带上后缀过滤重跑，这个结论不成立**（不加后缀会命中 `lib/quiz/` 下压缩字体的 base64 巨串，所以必须带）：

```
$ git grep -ilE "contribut|develop|extension|plugin|开发者|二次开发" origin/main -- '*.md' '*.mdx' | wc -l
46

（前 30 条，原样）
origin/main:AGENTS.md
origin/main:CHANGELOG.md
origin/main:CONTRIBUTING.md
origin/main:README-zh.md
origin/main:README.md
origin/main:comfyui-setup-instructions.md
origin/main:eval/whiteboard-shapes/README.md
origin/main:eval/zone-of-proximal-development/LOCAL_VALIDATION.md
origin/main:eval/zone-of-proximal-development/README.md
origin/main:lib/pbl/v2/prompts/evaluator-final.md
origin/main:lib/pbl/v2/prompts/evaluator-task.md
origin/main:lib/pbl/v2/prompts/simulator-narrator-system.md
origin/main:lib/pbl/v3/README.md
origin/main:lib/server/sandbox/README.md
origin/main:packages/@openmaic/dsl/README.md
origin/main:packages/@openmaic/generation/templates/procedural-skill-content/system.md
origin/main:packages/@openmaic/generation/templates/requirements-to-outlines/system.md
origin/main:packages/@openmaic/generation/templates/slide-content/system.md
origin/main:packages/@openmaic/importer/SKILL.md
origin/main:packages/docs/README.md
origin/main:packages/docs/content/docs/deployment.mdx
origin/main:packages/docs/content/docs/getting-started.ar.mdx
（… 另有 4 种语言的 getting-started、hosting.mdx、vocational-task-engine.mdx、render-service/README.md 等）
```

仅 `skills/` 下的命中就有 **18 个文件**，不止 zone-of-proximal-development：
```
origin/main:skills/agent-runtime/deep-research/SKILL.md
origin/main:skills/agent-runtime/k12-core-literacy-planning/SKILL.md
origin/main:skills/agent-runtime/k12-core-literacy-planning/references/subjects/{humanities,languages,mathematics,science}.md
origin/main:skills/agent-runtime/pptx-import/outline-constraints.json
origin/main:skills/agent-runtime/slide-dsl/SKILL.md
origin/main:skills/agent-runtime/spiral-curriculum/SKILL.md
origin/main:skills/agent-runtime/stage-dsl/SKILL.md
origin/main:skills/agent-runtime/stage-dsl/references/widget.md
origin/main:skills/agent-runtime/zone-of-proximal-development/SKILL.md
origin/main:skills/openmaic/SKILL.md
origin/main:skills/openmaic/references/extend-cookbook.md
origin/main:skills/openmaic/references/extend.md
origin/main:skills/openmaic/references/generate-flow.md
origin/main:skills/openmaic/references/startup-modes.md
```

所以更准确的说法是：**官方没有「plugin SDK」这种以插件为名的独立文档，但它有二开文档，而且不止一处** ——
openmaic 技能里的 extend / extend-sdk / extend-cookbook 三份参考（路径 D:/文档/jelly_ware/program/OpenMAIC/skills/openmaic/references/，讲怎么在既有产品上加东西）、
`D:/文档/jelly_ware/program/OpenMAIC/packages/docs/content/docs/hosting.mdx`（986 行，讲宿主扩展钩子）、
`D:/文档/jelly_ware/program/OpenMAIC/packages/docs/content/docs/vocational-task-engine.mdx`（讲职教任务引擎）、
以及若干包内的 README / SKILL.md（`D:/文档/jelly_ware/program/OpenMAIC/packages/@openmaic/dsl/README.md`、`D:/文档/jelly_ware/program/OpenMAIC/packages/@openmaic/importer/SKILL.md`、`D:/文档/jelly_ware/program/OpenMAIC/lib/pbl/v3/README.md`、`D:/文档/jelly_ware/program/OpenMAIC/lib/server/sandbox/README.md`）。
关键在于：**这些文档散在四个不同的地方（skills/、packages/docs/、包内 README、lib/ 下 README），没有统一入口** ——
这恰好解释了为什么「官方有没有二开文档」这件事本身就会判错。

---

## 1. 官方规则逐条清单（CONTRIBUTING.md，233 行）

行号来自 `git show origin/main:CONTRIBUTING.md | cat -n`。章节头实测位置：
L5 How to Contribute、L17 Claiming Issues、L25 Prerequisites、L32 Getting Started、L64 Development Workflow、
L78 Environment Variable Changes、L87 Before You Submit a PR、L104 Local Testing、L114 PR Guidelines、
L123 Review Threads、L134 Commit Message Convention、L156 Changing a Published Package、L180 App Releases、
L190 AI-Assisted PRs、L202 Project Structure、L214 Reporting Bugs、L223 Requesting Features、L227 Security、L231 License。

判定口径：✅ 遵循 / ⚠️ 部分（做到了但形态不同或只覆盖一部分）/ ❌ 未遵循 / — 不适用。

| # | 行号 | 官方要求 | 我方 | 证据 |
| --- | --- | --- | --- | --- |
| R1 | L9 | Bug fix 直接开 PR，有 issue 就链 | ❌ | 0 个 PR：`gh pr list --repo aweds13/OpenMAIC --state all` 空 |
| R2 | L10 | 扩展现有功能（新 provider、新 TTS）直接 PR | ❌ | 同上，无 PR 通道 |
| R3 | L11 | 新功能/架构变更**先**开 Discussion 或 Discord | ❌ | `gh api repos/aweds13/OpenMAIC --jq '.has_discussions'` = `false`；我们改的是 agent-runtime 架构级能力（plan-freeze、自学/听课分流），一次都没走讨论 |
| R4 | L12 | 设计/UI 变更先讨论并附 mockup | ⚠️ | 有 UI 改动（BatchDownloadDialog、self-study 按钮）但只在本地复盘文档里画了草图，没有 Discussion |
| R5 | L13 | **纯重构 PR 不接受** | — | 我们没有纯重构 PR（也没 PR） |
| R6 | L19 | 开工前在 issue 下评论认领 | ❌ | fork 的 issues 被关：`gh issue list` → `the 'aweds13/OpenMAIC' repository has disabled issues` |
| R7 | L21 | 1 天内无 PR/实质更新可能被改派 | — | 无 assign 机制，不适用 |
| R8 | L22–23 | 别人已 assign 先协调；干不动要留言 | — | 同上 |
| R9 | L27 | Node >= 22.19.0 | ✅ | 本机 v24.19.0；`node scripts/check-node-engine-contract.mjs` → `Node engine contract passed: root minimum 22.19.0 satisfies 35 engine-constrained direct production dependencies.` rc=0 |
| R10 | L28 | pnpm（latest） | ❌ | `where pnpm` 找不到文件；`corepack --version` 抛 `node:internal/modules/cjs/loader:1520 throw err`；`node_modules/.bin/` 无 pnpm。实际全程用 `npx` / `npm` 直接调脚本 |
| R11 | L29 | Docker 跑 PG（pnpm db:up）或任何 PG16 + DATABASE_URL | ✅ | 用自建 PG（docker-compose.db.yml 存在，1274 B），`.env.local` 有 DATABASE_URL |
| R12 | L30/L43 | 从 .env.example 复制出 .env.local | ✅ | `.env.local` 13254 B，含 1 行 `^DATABASE_URL=` |
| R13 | L46–50 | 本地 PG 在 127.0.0.1:5432，示例 `postgres://openmaic:openmaic-dev@127.0.0.1:5432/openmaic`，可用 OPENMAIC_DB_PORT 换端口 | ⚠️ | 实测 `.env.local` 第 3 行 = `DATABASE_URL=postgres://postgres:***@127.0.0.1:5433/postgres` —— **端口 5433、库名 postgres、用户 postgres**，与官方示例完全不同，且 `OPENMAIC_DB_PORT` 未设（直接改了 DATABASE_URL）。这是「另一套本地库」，官方 L46 明说 5432 被本机每个 checkout 共用 |
| R14 | L54 | pnpm dev 在没有 DATABASE_URL 时拒绝启动 | ✅（未实测该拒绝行为） | 有 DATABASE_URL，所以没触发；拒绝启动这条分支**未验证** |
| R15 | L57 | pnpm db:down 停库保数据 | ❌ | 我们的库不是 compose 起的（`netstat` 查 :543x 当前无 LISTENING，说明是手动起停），db:down 对我们无效 |
| R16 | L58 | pnpm test:e2e 需要 DATABASE_URL | ⚠️ | 有 DATABASE_URL，但 e2e 一次没跑过（见第 5、7 节） |
| R17 | L60–62 | 改 standalone player 后手动 pnpm build:standalone-player | ⚠️ | AGENTS.md 里 `grep -c standalone` = **0**，维护手册完全没提这件事；但 `lib/standalone-player` 未被我们改过（非 merge 提交 0 笔），所以没踩 |
| R18 | L66 | fork 后从 main 开分支 | ⚠️ | 有 fork（mine = aweds13/OpenMAIC），但分支从 `main` + upstream 1.2.0rc1 起的，不是干净 main |
| R19 | L70–73 | 分支命名 feat/ fix/ docs/ | ❌ | 本地 4 个分支：`main`、`merge/upstream-1.2.0rc1`、`my-extensions`、`upgrade/v1.3.0` —— 没有一个用官方前缀 |
| R20 | L75 | 提交前跑**全部** CI 检查 | ❌ | 我方 AGENTS.md §3 只定四步：prettier → tsc --noEmit → check-i18n-keys → check-layers.py；**不含 eslint、不含 vitest、不含 package-tests、不含 e2e**。且 `.prettierignore` 30 行里有 `*.md`，对文档是空跑 |
| R21 | L76 | 对 main 开 PR | ❌ | `git log --no-merges --format='%s' origin/main..HEAD \| grep -oE '\(#[0-9]+\)' \| wc -l` = **0**；263 笔直接落在 upgrade/v1.3.0 |
| R22 | L78–85 | 新增/改名**运维可见**环境变量必须同 PR 更新 .env.example，并写 optional/默认值/构建期还是运行期 | ❌ | 13 个 fork 新增 OPENMAIC_* 变量在 `.env.example` 命中数**全部为 0**；且 `git log --no-merges --oneline origin/main..HEAD -- .env.example` = **0 笔**（我们从未改过这个模板）。详见 §2.3 |
| R23 | L87–102 | 提交前 pnpm format / pnpm lint --fix / npx tsc --noEmit | ⚠️ | `npx prettier . --check` → `All matched files use Prettier code style!` rc=0；`npx tsc --noEmit` rc=0；**eslint 默认跑不绿**：`✖ 4600 problems (588 errors, 4012 warnings)` rc=1，但 588 error **全部**来自未跟踪的 `.tmp/`（`.gitignore:112`），`npx eslint --ignore-pattern '.tmp/**'` → `✖ 21 problems (0 errors, 21 warnings)` rc=0 |
| R24 | L104–112 | Ready for Review 前必须：验证目标 / 手工回归 / 本地跑 CI；没验完留 Draft | ⚠️ | 我们没有 PR 所以没有 Draft 概念；但「手工回归 + 已知缺口如实记」做到了（提交 body 里写 `已知缺口如实记`、`4 项真没做`） |
| R25 | L116 | **每个 PR 必须链 issue**，不链不会被 review | ❌ | `git log origin/main..HEAD \| grep -icE '\b(closes\|fixes\|resolves) #[0-9]+'` = **0** |
| R26 | L117 | 一个 PR 只做一件事 | ⚠️ | 无 PR；但提交粒度很杂：单笔提交同时改 AGENTS.md + 复盘 + 代码的情况常见（如 `42cfb009 docs(DSH): 面板四件（F88/F77/F84/F89）落地`） |
| R27 | L118 | 填 PR 模板 | ❌ | 模板在（`.github/pull_request_template.md`，51 行，同 blob `3ce79bf9…`），但从没用过 |
| R28 | L119 | UI 改动附前后截图 | ⚠️ | 有截图落在 engineering 仓的 `D:/文档/jelly_ware/program/engineering/docs/research/程天学-截图索引.md`，不在 PR 上 |
| R29 | L120 | 请求 review 前 CI 要过 | ❌ | CI 从未在该分支运行：`gh api repos/aweds13/OpenMAIC/actions/runs` 共 50 次，`upgrade/v1.3.0` 上 **0 次** |
| R30 | L121 | 所有 UI 文案必须 i18n | ✅ | 我方新增 UI 文件仅 3 个（`git log --no-merges --diff-filter=A --name-only origin/main..HEAD -- 'components/**' 'app/**'`）：`app/api/whoami/route.ts`、`components/generation/self-study-button.tsx`、`components/workbench/workspace/BatchDownloadDialog.tsx`；前者的文案走 `app/page.tsx:1035` 的 `label={t('toolbar.selfStudyModeLabel')}`，该 key 在 12 个 locale JSON 各 1 次命中；扫描 components/app 的 107 处 CJK 硬编码抽样核验**均为上游既有** |
| R31 | L125 | 每个非草稿 PR 每次 push 跑自动 Codex review | ❌ | 0 个 PR，从未触发；另：`.github/` 里 `codex` 只出现在 `issue-triage.yml:96-99`（`openai/codex-action@86365089…`），**8 个 workflow 里没有 PR review 的 workflow** —— 那条自动 review 推测是 GitHub App，`gh api .../installation` 返回 401 无法证实 |
| R32 | L127 | main 只在所有 review thread resolved 后才接受 PR | — | 无 PR |
| R33 | L129–130 | 先答复再 resolve；过时 thread 也要回一句 | — | 无 PR |
| R34 | L131 | 还在改就留在 draft | — | 无 PR |
| R35 | L134–154 | Conventional Commits：`<type>(<scope>): <desc>`，9 种类型 | ⚠️ | 261 笔非 merge 全部落在允许类型内（docs 134 / feat 53 / fix 50 / test 14 / chore 7 / perf 1），但 **2 笔 subject 不合规范式**（scope 用了 `a+b` 复合写法）：`945d4a4a docs(复盘)+chore: …`、`b8216176 docs+test: …` |
| R36 | L134–154 | （可选）body / footer | ✅ | body 是中文叙述（现象/根因/改法/读数/已知缺口）；但 trailer 几乎不用：`Task:` 1 次、`Gates:` 1 次、`Refs:` 0、`Ledger:` 0（唯一那笔是 `6b0ca7e8`） |
| R37 | L160 | 改了 publishable 文件必须**同 PR** bump 该包 version | ✅（空洞通过） | 我方非 merge 提交碰 `packages/@openmaic/` = **0 笔**；包树与 merge-base 逐字节一致（tree 同为 `5be5d0ef…`）；`node scripts/check-package-version-bumps.mjs 3618238d` → `Package version check passed.` rc=0。详见 §4 |
| R38 | L166 | publishable = 除 docs/ test/ vitest.config.ts 等永不进 tarball 的文件 | ✅ | 判据脚本在仓里（685 行），我们只是没改过包 |
| R39 | L168–176 | semver 自己判断；0.x 下 minor 即 breaking、patch 即兼容；dsl 收窄即 breaking | — | 我方一次都没 bump 过任何包版本，无从判断 |
| R40 | L178 | 你不自己发布；合并后自动发；tag 是标记不是触发器 | ✅ | 我方没有发布动作，也没有打 `@openmaic/*` tag |
| R41 | L184–188 | App 版本：minor 主题发布、patch 1–3 周一次、CHANGELOG 必须有段 | ⚠️ | App 版本我方 `1.3.0`（上游 `1.4.0`）；CHANGELOG.md 在（1110 行）但 `git log --no-merges --oneline origin/main..HEAD -- CHANGELOG.md` = **0 笔** —— 我们加了一堆二开能力，CHANGELOG 里一个字没有 |
| R42 | L194 | **Mark it**：PR 标题或描述注明 AI-assisted | ❌ | 全提交 `grep -icE 'AI-assisted\|Generated with\|Co-Authored-By: Claude\|🤖'` = **0** |
| R43 | L195 | **先自己跑 AI code review**（对 AI 辅助 PR 是 required） | ⚠️ | 有四步门禁 + check-layers + i18n key 校验，但**没有 diff 级的 AI review 步骤**；官方那条自动 Codex review 也从未跑过 |
| R44 | L196 | 你对提交的东西负责，要理解代码而不只是 prompt | ✅ | 提交 body 记录了真缺陷与修法（如 `42cfb009` 写「★ 一处真缺陷：三个视图（材料/活动/下载）互斥…修法：收敛成 setView(next)」），是「理解过」的证据 |
| R45 | L200 | AI 辅助 PR 与其它 PR 同一质量标准 | ⚠️ | 标准不同：我们用的是自己那套（四步门禁），不是官方 CI 全量 |
| R46 | L227–229 | 安全漏洞走 GitHub Security Advisories，不许开公开 issue | ✅ | 我们从没开过公开 issue（issues 是关的）；也没有安全相关提交 |
| R47 | L231–233 | 贡献按 MIT | ✅ | `LICENSE` 存在 1065 B |

**计数（用脚本逐行数上表，R1–R47 共 47 行；脚本读数：❌15 / ⚠️13 / —7 / ✅10 /「✅（未实测）」1 /「✅（空洞通过）」1）**：

| 判定 | 条数 | 编号 |
| --- | --- | --- |
| ✅ 遵循 | **12** | R9 R11 R12 R14 R30 R36 R37 R38 R40 R44 R46 R47 |
| ⚠️ 部分 | **13** | R4 R13 R16 R17 R18 R23 R24 R26 R28 R35 R41 R43 R45 |
| ❌ 未遵循 | **15** | R1 R2 R3 R6 R10 R15 R19 R20 R21 R22 R25 R27 R29 R31 R42 |
| — 不适用 | **7** | R5 R7 R8 R32 R33 R34 R39 |

两个 ✅ 要打折扣：**R37 是空洞通过**（区间内没有 publishable 变更，不是我们 bump 过，见 §4）、
**R14 只验了一半**（有 DATABASE_URL，所以「没有 DATABASE_URL 就拒绝启动」这条分支没被触发过）。
扣掉这两个，**真·硬遵循 = 10 条**。
7 条「不适用」全部因为「我们没有 PR / fork 关了 issue」—— **这不是免责，它们正是 §2.1 那条差距的表现**。

---

## 2. 三条最重要的差距（按风险排序）

### 2.1 第一：263 笔提交零 PR、零 issue、零讨论 —— 我们做的所有事都不在官方的协作面内

**官方要求原文**（L116）：
> **Every PR must link to an issue** — use `Closes #123` or `Fixes #456` in the PR description. If no issue exists yet, create one first. PRs without a linked issue will not be reviewed.

配套的还有 L127（main 只在 thread 全 resolved 后接受 PR）、L129（先答复再 resolve）、L19（开工前认领 issue）。

**我方现状（5 条实测）**：
```
$ gh pr list --repo aweds13/OpenMAIC --state all
（空输出，0 个 PR）

$ gh issue list --repo aweds13/OpenMAIC
the 'aweds13/OpenMAIC' repository has disabled issues

$ gh api repos/aweds13/OpenMAIC --jq '.has_discussions, .has_issues'
false
false

$ git log --no-merges --format='%s' origin/main..HEAD | grep -oE '\(#[0-9]+\)' | wc -l
0

$ git log origin/main..HEAD | grep -icE '\b(closes|fixes|resolves) #[0-9]+'
0
```
即：**fork 上 issue 是关的、讨论是关的、PR 是零**，263 笔提交直接堆在 upgrade/v1.3.0 上。官方设计的整条协作链路（认领 → PR → 自动 review → thread 答复 → resolved → 合并）在我们这条路上**一个环节都没接上**，而且是**结构性接不上**（issues disabled）。

**不补会怎样**：任务里说的「基于官方规范开发、共建生态」在这条路上永远做不到 —— 上游维护者看不到任何东西，我们的 263 笔只存在于一个他们不会访问的 fork 里。更实际的风险是：我们改的 `lib/server/agent-runtime/*` 与上游同文件持续分叉（`HEAD..origin/main` 已落后 27 笔），每次合并都要手工解冲突，而冲突裁决没有任何外部 review 兜底。

### 2.2 第二：官方 CI 的判据在我方分支上从未运行过 —— 「本机绿」不等于「官方绿」

**官方要求原文**（L75 + L120）：
> Run **all CI checks** locally before committing
> Make sure CI passes before requesting review

**我方现状**：
```
$ sed -n '1,30p' .github/workflows/ci.yml
on.push.branches: [main, integration/kv-asset-server-backend, integration/agent-workbench,
                   integration/material-library, integration/workbench-home]
on.pull_request.branches: 同列表 + runtime-server-backend
（不含 upgrade/v1.3.0）

$ gh api repos/aweds13/OpenMAIC/actions/runs   # 50 次运行
upgrade/v1.3.0 分支：0 次
```
我方自己那套门禁是四步（AGENTS.md §3）：prettier → `npx tsc --noEmit` → `node scripts/check-i18n-keys.mjs` → `python -X utf8 scripts/check-layers.py`。
**官方 CI 在这些之外还跑**：eslint、vitest（4 分片）、7 个包的 test/typecheck、storage 的 typecheck+test、package-tarball smoke、Node consumer smoke、playwright e2e（postgres:16）、render-service 的 docker build、main-image docker build、`check-package-version-bumps`、`check-internal-dependency-ranges`、`check-node-engine`、以及一条「install 不许改写 tracked 包文件」的断言。

我这轮把官方这几条**能在我方树上跑的**都跑了，读数（原样）：
```
node scripts/check-node-engine-contract.mjs   → Node engine contract passed: root minimum 22.19.0 satisfies 35 engine-constrained direct production dependencies.   rc=0
node scripts/check-internal-dependency-ranges.mjs → Internal dependency check passed: 6 expected dependents declare each owned dependency exactly once, in dependencies, as workspace:^.  rc=0
node scripts/check-i18n-keys.mjs             → i18n key alignment check passed (12 locale files, source: en-US.json).  rc=0
npx tsc --noEmit                             → rc=0（约 4 分钟，无输出）
npx prettier . --check                       → All matched files use Prettier code style!  rc=0
npx eslint                                   → ✖ 4600 problems (588 errors, 4012 warnings)  rc=1   ← 588 error 全在未跟踪的 .tmp/
npx eslint --ignore-pattern '.tmp/**'        → ✖ 21 problems (0 errors, 21 warnings)  rc=0
npx vitest run                               → 崩：[low_level_alloc.cc : 554] RAW: Check new_pages != nullptr failed: VirtualAlloc failed（无汇总行）
npx vitest run --maxWorkers=2 tests/agent-runtime tests/i18n
                                             → Test Files 1 failed | 140 passed | 8 skipped (149)
                                               Tests 13 failed | 1925 passed | 15 skipped (1953)  rc=1   ← 13 个全在 document-image-parser.test.ts，Windows 路径分隔符，而非我方回归
```

**不补会怎样**：官方 CI 是「合并前最后一道闸」。我们从未让它跑过，等于**对「这棵树在 Linux/CI 上是什么颜色」一直处于未知**：
`.tmp/` 让 eslint 在本地红（CI 上没有该目录，所以 CI 会绿）、13 个 Windows-only 失败（CI 上不存在）、
全量 vitest 在本机直接因内存分配崩掉（**所以「全量单测通过」这句我们根本没法断言**）。
下一次真正需要往上游提 PR 时，这些会一次性爆出来，而且是在维护者眼前爆。

### 2.3 第三：13 个 fork 自造的运维级环境变量，一个都没进 .env.example

**官方要求原文**（L78–85，逐字）：
> When adding or renaming an operator-facing environment variable, update [.env.example](.env.example) in the same PR. Document whether it is optional, its safe default or example value, and whether it is read at build time or runtime. Variables used only by tests, CI, or internal development scripts do not need to be added to the template, but their owning file or documentation must make that limited scope clear.

**我方现状**：`origin/main..HEAD` 里新引入的 env 读取共 13 个 `OPENMAIC_*`：

| 变量 | 在 .env.example 命中 | 在 docs/ 命中 | 读取位置（抽样） |
| --- | --- | --- | --- |
| OPENMAIC_SELF_STUDY | 0 | 有 | app/api/whoami/route.ts、lib/server/agent-runtime/config.ts、generation-tools.ts、lib/server/generation/run/types.ts |
| OPENMAIC_LEARNER_STATE_PATH | 0 | **0（AGENTS.md 也 0）** | 服务端 |
| OPENMAIC_LEARNER_PROFILE_PATH | 0 | 有 | lib/server/agent-runtime/config.ts、course-tools.ts |
| OPENMAIC_MATERIALS_DIR | 0 | 有 | config.ts、course-tools.ts |
| OPENMAIC_PLAN_GATE | 0 | 有 | config.ts、course-tools.ts |
| OPENMAIC_PLAN_FREEZE_DIR | 0 | 有 | plan-freeze 相关 |
| OPENMAIC_PRACTICE_DIR | 0 | 有 | 练习相关 |
| OPENMAIC_SCRATCHPAD_DIR | 0 | 有 | 草稿纸相关 |
| OPENMAIC_MCP_SERVERS | 0 | 有 | MCP 相关 |
| OPENMAIC_BROWSE_URL / OPENMAIC_COURSE_SEARCH_URL | 0 | 有 | 工具层 |
| OPENMAIC_AGENT_COMPACTION_CONTEXT_BUDGET | 0 | 有 | 上下文压缩 |
| OPENMAIC_DEBUG_PROMPT_FINGERPRINT | 0 | 1 | 调试 |

实测命令与读数：
```
$ git log --no-merges --oneline origin/main..HEAD -- .env.example
（0 笔 —— 我们从未改过这个模板）
$ git diff --stat 3618238d HEAD -- .env.example
（空 —— 我方 .env.example 与 merge-base 逐字节一致）
$ git diff --stat 3618238d origin/main -- .env.example
 .env.example | 103 +++++++++++++++++++---------------------------------
 100 insertions(+), 3 deletions(-)
```
即：我方 `.env.example`（819 行）比上游（916 行）少的 97 行**全是上游新增、我们还没合的**，不是我们删的。
我们新增的 13 个变量**一个都没进去**，其中 `OPENMAIC_LEARNER_STATE_PATH` 连自己的文档都没有。

**不补会怎样**：这 13 个里有 5 个（SELF_STUDY / LEARNER_STATE_PATH / PLAN_GATE / MATERIALS_DIR / MCP_SERVERS）在 `3618238d` 与 `origin/main` 的 `*.ts` 里 **0 命中**，是**纯 fork 自造的服务端配置**（HEAD 上分别出现在 5 / 1 / 5 / 4 / 2 个文件里）。后果很具体：
①换一台机器、或交接给下一个人，跑起来的目录/开关是隐式的，配置不可复现；
②一旦真往上游提 PR，这就是官方唯一一条「必须同 PR 更新模板」的硬规定上的直接违规；
③`.env.example` 与 merge-base 逐字节一致这件事本身说明我们**没有把它当活文档**，它在我们仓里是死的。

---

## 3. AI-Assisted PRs 三条：对我们现状的逐条评估

前提：我们所有提交都是 AI 辅助产的（这也是任务给定的）。官方这三条是**针对 PR** 写的，而我们 0 个 PR，所以要分「字面」与「精神」两层看。

### 3.1 L194「Mark it」——❌ 未遵循（字面与精神都没做到）

官方原文：
> **Mark it** — note in the PR title or description that the PR is AI-assisted.

实测：
```
$ git log --format='%s%n%b' origin/main..HEAD | grep -icE 'AI-assisted|Generated with|Co-Authored-By: Claude|🤖'
0
```
263 笔提交里**没有任何一处**标明 AI 参与。不等于「隐瞒」—— 我们的 body 里大量写「读数」「已知缺口」「修法」，读者能看出是 agent 干的活 —— 但这**不是可检索的标记**，机器筛不出来，人也要读三屏才判断得出。

要不要补：如果只在 fork 里自用，这条的实际价值是「半年后自己知道哪些是 AI 写的」。如果要往上游客串，这条是**字面硬要求**，且成本极低（commit trailer 一行）。

### 3.2 L195「先自己跑 AI code review」——⚠️ 部分遵循

官方原文（重点在 required）：
> **AI-review your own code first** — before requesting maintainer review, run an AI code review (e.g. Claude, Codex, Copilot) on your changes and address the findings. This is **required** for AI-assisted PRs to avoid dumping large amounts of unreviewed generated code on maintainers.

我方**有**的：一套四步门禁（prettier/tsc/i18n/check-layers）+ 每笔提交 body 里的自证读数 + 一条「单元测试通过 ≠ 效果达成」的硬规矩（AGENTS.md §9）。这套东西在**形式审查**上比多数人的 AI review 更严。

我方**没有**的：**diff 级的 AI 复审**。四步门禁全是「整树级别」的机械判据，没有一步是「拿这笔 diff 问一遍『这段生成代码有没有骗人』」。而官方说的正是后者。
另一条官方自动 review（L125/L198「每个非草稿 PR 每次 push 都跑一次 Codex review」）我们**从未触发过**（0 PR），且 `.github/` 里也没有对应的 workflow 文件 —— `codex` 只出现在 `issue-triage.yml:96-99`。

结论：**满足「有 review 动作」，不满足「对 diff 做 AI review」**。而且官方那条自动兜底网我们是完全没有的。

### 3.3 L196「你对提交的东西负责」——✅ 遵循（这条我们做得比要求好）

官方原文：
> **You are responsible for what you submit** — understand the code, not just the prompt.

证据（任取一笔）：
```
42cfb009 docs(DSH): 面板四件（F88/F77/F84/F89）落地 —— 结论库 §1.26 + 宿主层文档
body: 「盘点表 C 类…4 项真没做…」「★ 一处真缺陷：三个视图（材料/活动/下载）互斥…修法：收敛成 setView(next)」
      「SMOKE: PASS ✅」「已知缺口如实记」
```
```
a7ea68ba docs(结论库): §1.25 部署副本 diag 必挂 —— tsx 不对 node_modules 下的文件应用 paths
body: md5 相同 / 路径含 node_modules 的关键变量对照；rc=0 与 rc=1 两组读数
      「python -X utf8 scripts/check-layers.py → 156 条引用（断链 0 处）/ LAYER CHECKS: PASS」
```
这类 body 不是「我让 AI 改了 X」，而是「我验了 Y，读数是这样，还剩 Z 没做」。**这是 L196 想要的东西**。

### 3.4 三条小结

| 条 | 判定 | 一句话 |
| --- | --- | --- |
| L194 标记 | ❌ | 0 处标记，机器不可检索 |
| L195 先自审 | ⚠️ | 有整树机械门禁，缺 diff 级 AI 复审；官方自动 Codex review 从未跑过 |
| L196 负责任 | ✅ | body 里全是读数与已知缺口，这条是强项 |

---

## 4. publishable 包版本纪律：我方实际有没有违反

### 4.1 结论：**零违规**，但这份「通过」是空洞的

官方判据（L160 + `scripts/check-package-version-bumps.mjs`）：
> If you change any publishable file in one of these packages, bump that package's `version` in its `package.json` **in the same PR**.

四条实测：

```
① $ git log --oneline origin/main..HEAD -- 'packages/@openmaic/'
   9830a1bf  Merge ...        ← parents 0b6af936 + 3618238d
   b2ce2f40  Merge ...        ← parents adfdf58e + 6760c2b7
   （只有 2 笔，且都是 merge）

② $ git log --no-merges --oneline origin/main..HEAD -- 'packages/@openmaic/'
   （0 笔）

③ $ git diff --stat 3618238d HEAD -- 'packages/@openmaic/'
   （空）
   $ git ls-tree 3618238d -- packages/@openmaic     → tree 5be5d0ef…
   $ git ls-tree HEAD     -- packages/@openmaic     → tree 5be5d0ef…   ← 逐字节一致

④ $ node scripts/check-package-version-bumps.mjs 3618238d
   Package version check passed.        rc=0
   $ node scripts/check-package-version-bumps.mjs origin/main
   Package version check passed.        rc=0
```

**所以：违规清单 = 0 条。** 一个包都没在非 merge 提交里被改过，包树与 merge-base 完全一致，官方门禁当然通过。

但这正是要紧的地方：**门禁通过是因为区间内没有 publishable 变更，不是因为我们 bump 过版本**。
`scripts/check-package-version-bumps.mjs` 用的是三点 diff（`git diff --no-renames --diff-filter=ACDMRT ${base}...HEAD -- packages/@openmaic/<name>`），
比的是 merge-base→HEAD；我们的 7 个包在这个区间里**一个字节都没动**。**这条纪律我们从未真正练习过。**

### 4.2 七个包的版本对照（`git show <ref>:packages/@openmaic/<p>/package.json`）

| 包 | origin/main | HEAD | 差 |
| --- | --- | --- | --- |
| @openmaic/dsl | **0.13.0** | 0.12.0 | 落后 1 个 minor（0.x 下 minor 即 breaking ⇒ **我们落后一个 breaking 版本**）|
| @openmaic/geometry | 0.1.0 | 0.1.0 | 同 |
| @openmaic/generation | 0.3.28 | 0.3.28 | 同 |
| @openmaic/storage | **0.39.2** | 0.38.1 | 落后 1 个 minor（0.38.1 → 0.39.2，同上，contract 级）|
| @openmaic/renderer | 0.2.0 | 0.2.0 | 同 |
| @openmaic/editor | 0.0.12 | 0.0.12 | 同 |
| @openmaic/importer | 0.3.1 | 0.3.1 | 同 |

`packages/@openmaic/` 下两边都是同样 7 个目录，无新增/删除。
差的这两个版本来自还没合进来的上游提交：`2a5147cf`（merge PBL v3 + shared sandbox for v1.4.0 (#2151)）、`fe2cf7da` (#2113)、`03dee2bb` (#2092 storage)。

**风险不在「我们违规」，在「我们落后」**：官方 extend-sdk 参考文档第 176 行明确说 dsl 是契约、收窄即 breaking，
而我们差着一个 dsl minor 与一个 storage minor。我们现在是「按 0.12.0 的行为写代码」，上游消费者（和即将合并进来的 1.4.0）是按 0.13.0 的。
一旦合并那 27 笔，dsl 的契约判定就得重新对一遍 —— 而我们从没走过那条门禁，**不知道到时候会红几处**。

### 4.3 顺带：App 版本与 CHANGELOG

- `package.json` version：我方 `1.3.0`，上游 `1.4.0`。
- 我方非 merge 提交碰 `package.json` 仅 1 笔（`9aa2aec3 feat(review): …`），**未改 version 行**。
- tag：`v1.2.0-rc.2 / v1.2.1 / v1.3.0 / v1.3.0-rc.1 / v1.3.1 / v1.4.0` 全是上游打的，我方没打新 tag。
- CHANGELOG.md 1110 行，顶部 `## [Unreleased]` → `### Bug Fixes` → 第一条即 #2093；
  `git log --no-merges --oneline origin/main..HEAD -- CHANGELOG.md` = **0 笔**。
  ⇒ 官方 L188「每次发布都有 CHANGELOG 段」这条，如果我们要发自己的版本，**现在开始写就是空白起点**。

---

## 5. 门禁对照表：官方 CI 跑什么 vs 我方 22 道门跑什么

### 5.1 官方 CI 实际跑的（`.github/workflows/ci.yml`，上游 565 行；我方 550 行）

我方 `ci.yml` 与上游**同名同 8 个 workflow**（ci / docs-build / flaky-report / issue-triage / pr-reminders / publish-openmaic-skill / publish-packages / storage-pg-contract），
差异只有 3 个文件 11 insertions / 44 deletions：删掉 `integration/shared-sandbox` 触发分支；e2e 从「3 分片 / ubuntu-24.04 / 20 分钟」改回「单 job / ubuntu-latest / 15 分钟 / 无 --shard」。

官方 ci.yml 的 job（我方行号，内容一致）：

| job | 名称 | 干什么 |
| --- | --- | --- |
| issue-triage (`:41`) | Issue Triage (offline contracts) | `node --test .github/scripts/*.test.mjs` |
| lint (`:61`) | Lint & Typecheck | `ci-run-parallel.sh` 自检 → `check-package-version-bumps.mjs $BASE_SHA`（PR/merge_group）→ main push 变体（base 不可用直接失败）→ `check-internal-dependency-ranges.mjs` → `pnpm check:node-engine` → **「install 不许改写 tracked 包文件」**（`git diff --quiet $GITHUB_SHA -- packages/@openmaic`）→ 并行 prettier / eslint / tsc / i18n |
| unit (`:173`) | Unit Tests (shard/4) | `vitest run --shard=N/4`，4 分片 |
| package-tests (`:197`) | Unit Tests (packages) | 7 个包各自 test/typecheck + Node consumer smoke（起 `generation-node-smoke-server.mjs --port 43127`，断言 outlines 非空且 sceneValidation.valid） |
| storage-tests (`:256`) | Unit Tests (storage) | storage typecheck（含测试树）+ test |
| check (`:278`) | Lint, Typecheck & Unit Tests | **required status check**，jq 断言 4 个 need 全 success |
| render-service (`:296`) | — | typecheck + npm test + docker build |
| e2e (`:332`) | E2E Tests | postgres:16 service + playwright（我方无分片，上游 3 分片）|
| docker-main-image (`:461`) | — | buildx 构建 deps+builder 阶段 |

另有 `storage-pg-contract.yml`（postgres:16，105 行）、`docs-build.yml`（37 行，只跑 main + packages/docs 路径）、`publish-packages.yml`（485 行，validate/publish/mark）、`publish-openmaic-skill.yml`（314 行）、`flaky-report.yml`（55 行）、`pr-reminders.yml`（54 行）。

### 5.2 我方 22 道门实际跑的（engineering 仓 `scripts/run_gates.py`）

门表不写死在 run_gates.py 里，从 `gates/defs/` 三个模块 import 拼装：6 + 5 + 7 = 18，加 REAL 2 + BROWSER 2 = **22**。

| 层 | 门 | 判据 |
| --- | --- | --- |
| lang_python（6）| pytest / acceptance / pytest_chain / ruff / mypy / check_layers_selftest | Python 单测、验收层、链路 e2e、ruff、mypy、check_layers 自检 |
| contract（5）| audit / invariants / audit_titles / docs / skills_claims | 声称必须有 file:/text:/test: 指针；新能力必须进不变量台账；台账↔规格标题对账；死指针/漂移 ratchet；技能正文命令逐条核存在性 |
| product_timeflow（7）| check_layers / contrast / style / ui_text / commands / ui_dom_probe / proxy | 五层文档对齐、WCAG AA、样式审计、中文文案棘轮、四个面共用一个命令源、DOM 探针、代理指标对账 |
| REAL（2）| lf1_live / web_live | 真机起服务验证（起不了记 not_run）|
| BROWSER（2）| render / ui_flow | 真浏览器渲染与交互流程（每次采两遍做确定性自检）|

### 5.3 关键发现：22 道门与 OpenMAIC **零交集**

```
$ grep -rn "program/OpenMAIC|../OpenMAIC" --include=*.py --include=*.toml --include=*.json scripts/ tools/ gates/defs/ docs/workbacklog.toml
scripts/retro/retro_index.py:736:  （一句注释：本索引只覆盖本仓 复盘/；OpenMAIC 的复盘在 ../OpenMAIC/复盘/）

$ grep -c "OpenMAIC" docs/workbacklog.toml     # 332 张卡
0

$ python -c "from tools.pipe_root import data_root; print(data_root())"
D:\文档\jelly_ware\program\engineering
```
⇒ 这 22 道门跑的是 **engineering 仓自己**（Python 代码 + 它自己的五层文档 + 它的 UI）。OpenMAIC 那个 TypeScript 仓**一道门都没被覆盖**。
`scripts/run_gates.py` 的门表里 0 处提到 OpenMAIC，`workbacklog.toml` 332 张卡里 0 张是 OpenMAIC 的。

OpenMAIC 仓里也**没有** `gates/`、`pipeline.toml`、`tools/wb_*`（`ls -d` 全无）；`复盘/` 只剩 1 个跟踪文件（已结案结论.md，152638 B）。

### 5.4 「官方有我没有」与「我有官方没有」

**官方有、我方在 OpenMAIC 仓里没有（或从未真跑）**：

| 官方判据 | 我方状态 | 实测 |
| --- | --- | --- |
| check-package-version-bumps（真跑）| 脚本在，从未真跑 | ci.yml `:86` 有该行，但分支不在触发列表 ⇒ 0 次运行 |
| check-internal-dependency-ranges | 本地跑过 rc=0 | 只手动跑，不在任何闸门 |
| check-node-engine | 本地跑过 rc=0 | 同上 |
| 「install 不许改写 tracked 包文件」 | ❌ 无对应 | 我方四步没有这条 |
| prettier（含 md） | ⚠️ 空跑 | `.prettierignore` 30 行含 `*.md`、`*.yml` ⇒ 文档与 workflow 不检查 |
| eslint | ⚠️ 不在门禁内 | 手动跑：排除 .tmp 后 0 error / 21 warning |
| tsc --noEmit | ✅ 在四步内 | rc=0 |
| i18n key 校验 | ✅ 在四步内 | 12 locale，rc=0 |
| vitest 全量（4 分片） | ❌ 未跑成 | 全量在本机崩（VirtualAlloc failed）；有界重跑 13 失败（Windows-only） |
| 7 个包的 test/typecheck + Node consumer smoke | ❌ 完全没跑过 | 本机 pnpm 缺失，且从没跑过 |
| storage typecheck + test | ❌ 完全没跑过 | 同上 |
| e2e（playwright + postgres:16） | ❌ 完全没跑过 | 同上 |
| render-service docker build / main-image build | ❌ 没跑过 | docker 在（29.7.2），没跑 |
| docs-build（packages/docs） | ❌ 不在触发分支 | 只跑 main |
| storage-pg-contract | ❌ 不在触发分支 | 只跑 main 与 5 个 integration/feat 分支 |
| CI 真的在该分支跑 | ❌ | Actions 0 次 |

**我有、官方没有**：

| 我方判据 | 说明 | 官方对应 |
| --- | --- | --- |
| check_layers.py（五层文档对齐 + 156 条引用判链）| 已在 OpenMAIC 仓跑通 `156 条引用（断链 0 处）/ LAYER CHECKS: PASS`，但**没接进 npm script、也没接进 CI**（`grep -rn "check-layers" package.json .github/` 空）| 无 |
| 五层 docs 体系（38 个文件：intention/specification/contracts/implementation/taste）| 上游 docs/ 树为空 | 无 |
| 复盘/ 结论库、AGENTS.md 303 行维护手册（相对上游 +295 −19）| 上游 AGENTS.md 只 27 行，是给 Codex review 的规则 | 无 |
| 22 道门本体 | 覆盖 engineering 仓，不覆盖 OpenMAIC | 无 |

一句话：**官方那套是「代码 + 包 + e2e」的闸门；我方那套是「文档 + Python + UI」的闸门；两套不重叠，所以我方 22 道门全绿也不能说明 OpenMAIC 能合上游。**

---

## 6. 可执行的补齐清单（基于官方规范开发、共建生态，最少要补这几件）

按「补了立刻有价值」排序，每件都给文件与命令。

### 6.1 把 check-layers 接成闸门（1 小时，零风险）

现在它有工具没闸门：OpenMAIC 仓 `scripts/check-layers.py` 341 行，跑得出 PASS，但没人自动跑它。

- 文件 `D:/文档/jelly_ware/program/OpenMAIC/package.json`，scripts 里加：
  ```
  "check:layers": "python -X utf8 scripts/check-layers.py",
  ```
- 文件 `D:/文档/jelly_ware/program/OpenMAIC/.github/workflows/ci.yml`，`lint` job 的并行段（`:165-168` 附近）加一路：
  ```
  - name: Layers
    run: python -X utf8 scripts/check-layers.py
  ```
- 验证：`python -X utf8 scripts/check-layers.py` → 末行必须是 `LAYER CHECKS: PASS ✅`

### 6.2 让 CI 真正跑在我们的分支上（30 分钟，改变最大）

ci.yml 的触发列表里没有 upgrade/v1.3.0，所以 Actions 0 次运行。

- 文件 `D:/文档/jelly_ware/program/OpenMAIC/.github/workflows/ci.yml`，`on.push.branches` 与 `on.pull_request.branches` 都加 `upgrade/**`。
- 或（更贴近官方）**在 fork 上开 PR**：`gh pr create --repo aweds13/OpenMAIC --base main --head upgrade/v1.3.0`（注意 fork 的 issues 是关的，得先 `gh api -X PATCH repos/aweds13/OpenMAIC -f has_issues=true`）。
- 验证：`gh run list --repo aweds13/OpenMAIC --branch upgrade/v1.3.0` 应出现记录。

### 6.3 补 .env.example 的 13 个变量（1 小时，直接消除一条硬违规）

- 文件 `D:/文档/jelly_ware/program/OpenMAIC/.env.example`，按官方 L78–85 三要素写：是否 optional、安全默认值或示例值、构建期还是运行期读。
- 至少这 5 个必须写（fork 自造的服务端配置）：`OPENMAIC_SELF_STUDY`、`OPENMAIC_LEARNER_STATE_PATH`、`OPENMAIC_PLAN_GATE`、`OPENMAIC_MATERIALS_DIR`、`OPENMAIC_MCP_SERVERS`。
- 验证：`grep -c "OPENMAIC_SELF_STUDY\|OPENMAIC_PLAN_GATE\|OPENMAIC_MATERIALS_DIR" .env.example` 应 ≥ 3（现在 0）。

### 6.4 装回官方工具链（10 分钟，解开「pnpm 缺失」这条）

官方 extend.md 硬要求 pnpm@10.28.0，本机没有。

- `npm i -g pnpm@10.28.0`（或 `corepack enable pnpm`，本机 corepack 已坏，需先修 node 安装）。
- 验证：`pnpm --version` 应输出 `10.28.0`；然后 `pnpm check`、`pnpm lint`、`pnpm test` 三条才和 CI 同形。

### 6.5 让本地 lint 与 CI 同形（20 分钟）

`.tmp/` 让 `npx eslint` 在本地 588 error（CI 上没有该目录）。

- 文件 `D:/文档/jelly_ware/program/OpenMAIC/eslint.config.mjs` 的 `globalIgnores`（`:30-57`）加 `'.tmp/**'`。
- 验证：`npx eslint` → 应变成 `✖ 21 problems (0 errors, 21 warnings)` rc=0。

### 6.6 给提交加机器可读的 AI 标记（10 分钟，补 R42）

- 文件 `D:/文档/jelly_ware/program/OpenMAIC/.gitmessage`（新建），内容：
  ```
  <type>(<scope>): <desc>

  <body>

  AI-Assisted: yes
  ```
- `git config commit.template .gitmessage`
- 批量补历史（可选，会改写历史，慎用）：`git filter-branch --msg-filter 'printf "%s\n\nAI-Assisted: yes\n" "$(cat)"' origin/main..HEAD`
- 验证：`git log -1 --format='%b'` 应含 `AI-Assisted: yes`。

### 6.7 丢掉「一次提交多件事」的习惯（流程，不用改代码）

官方 L117 一个 PR 一件事。我们单笔提交常同时改 AGENTS.md + 复盘 + 代码。

- 做法：提交前 `git diff --stat` 自检，若跨 ≥2 个顶层目录（`lib/` 与 `复盘/` 与 `docs/`）就拆。
- 验证：`git log --no-merges --format='%h' origin/main..HEAD | head -20` 逐笔看 `git show --stat`。

### 6.8 补 CHANGELOG（如果要发自己的版本）

- 文件 `D:/文档/jelly_ware/program/OpenMAIC/CHANGELOG.md` 的 `## [Unreleased]` 段下加本次二开条目（学习者画像、五层 docs、agent-runtime 能力）。
- 验证：`git log --no-merges --oneline origin/main..HEAD -- CHANGELOG.md` 不应再是 0 笔。

### 6.9 让 22 道门能看见 OpenMAIC（工程量大，但要「共建」迟早得做）

现在的门是给 engineering 仓的，`workbacklog.toml` 332 张卡里 0 张 OpenMAIC。
最小可行：在 engineering 仓加一道 **`openmaic_gate`**，只做三件事 ——
① 在 OpenMAIC 仓跑 `npx tsc --noEmit`；② 跑 `node scripts/check-i18n-keys.mjs`；③ 跑 `python scripts/check-layers.py`；任一非零即红。
- 文件 `D:/文档/jelly_ware/program/engineering/gates/defs/product_timeflow.py`（或新模块），在 GATES 里加一项，命令用 `--cwd D:/文档/jelly_ware/program/OpenMAIC`。
- 验证：`python -X utf8 scripts/run_gates.py --only openmaic_gate`。

---

## 7. 诚实清单（没读到 / 读不懂 / 无法验证）

1. **全量单测是否绿，不知道**。`npx vitest run` 在本机崩在 `[low_level_alloc.cc : 554] RAW: Check new_pages != nullptr failed: VirtualAlloc failed`，没有汇总行、没有 rc。有界重跑（`--maxWorkers=2 tests/agent-runtime tests/i18n`）是 `1 failed | 140 passed | 8 skipped`，13 个失败全在 `document-image-parser.test.ts` 且根因是 Windows 路径分隔符（`expected 'D:\...\OpenMAIC\lib…' to be 'D:\...\OpenMAIC/lib…'`）—— 我判断是平台性而非我方回归，但**没有在 Linux 上验证过**。
2. **e2e / package-tests / storage-tests / render-service / docker build 全都没跑**。本机 pnpm 缺失、playwright 未装，且这些 job 从未在该分支触发过。所以「官方 CI 在我方树上会不会红」我**给不出答案**。
3. **官方那条自动 Codex PR review 到底是什么**，不知道。CONTRIBUTING L125/L198 说每个非草稿 PR 每次 push 都跑，但 8 个 workflow 文件里找不到对应 job（`codex` 只出现在 issue-triage 的 `openai/codex-action`）。推测是 GitHub App 装的，`gh api repos/aweds13/OpenMAIC/installation` 返回 401（token 权限不足），**无法证实**。
4. **`packages/docs/` 我方比上游少 231 行**（`15 files changed, 39 insertions(+), 231 deletions(-)`，主要在 supported-models.*.mdx）。我没有逐份比对确认这是我们主动删的还是上游新增没合；从 `.env.example` 的同类现象（我方与 merge-base 一致）推测**也是上游新增我们没合**，但**没验证**。
5. **13 个 env 变量里哪些真属「operator-facing」**：我是按「读取位置在服务端配置/工具层」判断的，官方那条的标准是「面向运维」。`OPENMAIC_DEBUG_PROMPT_FINGERPRINT` 明显是调试用、可以按官方那句「只给内部脚本用不必进模板，但要说明受限范围」豁免 —— 我把它列进 13 个里是**偏保守**的。
6. **上游维护者会不会接受「fork 长期分叉 + 无 PR」这种模式**，不知道。CONTRIBUTING 全篇预设的是 PR 流程，没有给「自用 fork」写任何条款（skills/openmaic/references/extend.md 反而明确说了自用可以直接 clone 不 fork、禁 CI 是按需 —— 所以**官方的二开文档与贡献文档是两套口径**，这一点我只读了文字，**没找到谁仲裁过它们冲突时以哪个为准**）。
7. **`packages/docs/content/docs/hosting.mdx`（986 行）我只读了结构，没读完**。README 的 host extension hooks 指向它的 `#host-extension-hooks`，那份才是「宿主扩展」的正式契约文档；本轮篇幅没展开，**结论里没引用它的内容**。
8. **我方 22 道门的具体判据我只读了门表与命令，没逐道跑**（任务要求「只读不跑」）。所以「22 道门各自现在红不红」我不知道 —— 只有 `check_layers` 与 `check_docs --mode report` 两条我实跑过。
9. **`git status` 里有 3 个未跟踪 md**（入会申请 / 毕业论文相关），与本任务无关，我没动它们。
10. **HEAD 里的 CONTRIBUTING.md 存在这件事与任务给定的前提冲突**。我按实测写，但**不排除**任务方是想说「我方提交历史里没有自己写的 CONTRIBUTING」—— 这个说法成立（`git log --no-merges --oneline origin/main..HEAD -- CONTRIBUTING` = 0 笔），只是文件本身在。

---

## 附：本次勘察用到的核心命令（可复跑）

```bash
cd "D:/文档/jelly_ware/program/OpenMAIC"

# 官方规则原文（233 行，带行号）
git show origin/main:CONTRIBUTING.md | cat -n

# 上游 AGENTS.md 只有 27 行；我方 303 行（git diff --numstat = 295 insertions / 19 deletions）
git show origin/main:AGENTS.md | wc -l ; wc -l AGENTS.md

# 上游 docs/ 树为空；我方五层 38 文件
git ls-tree -r origin/main -- docs/ | wc -l
git ls-tree -r --name-only HEAD -- docs/ | wc -l

# 提交面
git rev-list --count origin/main..HEAD          # 263
git rev-list --count --no-merges origin/main..HEAD   # 261
git rev-list --count HEAD..origin/main          # 27（落后）

# publishable 包纪律
git log --no-merges --oneline origin/main..HEAD -- 'packages/@openmaic/'
git diff --stat 3618238d HEAD -- 'packages/@openmaic/'
node scripts/check-package-version-bumps.mjs 3618238d

# 官方判据在我方树上
node scripts/check-node-engine-contract.mjs
node scripts/check-internal-dependency-ranges.mjs
node scripts/check-i18n-keys.mjs
npx tsc --noEmit
npx prettier . --check
npx eslint --ignore-pattern '.tmp/**'
npx vitest run --maxWorkers=2 --reporter=dot tests/agent-runtime tests/i18n

# 协作面
gh pr list --repo aweds13/OpenMAIC --state all
gh api repos/aweds13/OpenMAIC --jq '.has_discussions, .has_issues'
gh api repos/aweds13/OpenMAIC/actions/runs --jq '.workflow_runs[].head_branch' | sort | uniq -c

# 门禁（engineering 仓）
cd "D:/文档/jelly_ware/program/engineering"
grep -c "OpenMAIC" docs/workbacklog.toml        # 0
python -X utf8 scripts/check_layers.py
```
