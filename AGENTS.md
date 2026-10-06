# AGENTS.md —— OpenMAIC 二开维护手册

> 这份文件会被 DSH 自动注入（`@deepseek-ai/dsh-agent-instructions`：从**最近的 `.git`
> 所在目录**到会话工作目录，逐层加载 `AGENTS.md`）。目的是让**一个新开的对话窗口**
> 不用重新摸索就能干活。
>
> 写法约定：**只写操作知识**（顺序、前置检查、常见错、该看哪个产物）。判据在代码里。
> 一条结论只有在**实测过**之后才写进来，并附上能复现它的命令。

## 两份文件，两个用途 —— 别混

| 文件 | 装什么 | 什么时候改 |
|---|---|---|
| **本文件**（`AGENTS.md`） | **规则**：改哪一层、文件地图、证据命令、坑、已结案的结论 | 发现新规则 / 新坑 / 新结论时 |
| [`复盘/新窗口交接卡.md`](复盘/新窗口交接卡.md) | **状态**：当前 CHECKPOINT + **新窗口照抄的第一条消息** | 每干完一件事 |

**新窗口的第一条消息在交接卡里，照抄即可。** 本文件是被它引用的规则层。

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
| `app/api/whoami/route.ts` | 一次性诊断：owner + 课程数 + **运行期开关实际值** | 改 `.env.local` 后先看这里 |

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

---

## 7. 已经查清、**不要重新论证**的结论

| 结论 | 依据 |
|---|---|
| 工作台忽略 UI 上的模型设置 | `generation-ai-call.ts` 调 `resolveModel({ stage })`，**不传 `modelString`** ⇒ 由 `DEFAULT_MODEL` / `MODEL_ROUTES` 决定 |
| `deepseek-v4-flash` 就是 **V4.1 Flash** | 官方 API id 是 `deepseek-flash`，name 是 `DeepSeek-V4.1-Flash`；显示名见 `lib/ai/providers.ts` |
| 课程"看不见"的根因是缺 `NEXT_PUBLIC_PERSISTENCE` | owner 由 cookie 派生；没有它前端存不进 PG |
| 上下文压缩**默认关** | `resolveCompactionSettings` 的默认值是 `enabled: false` |
| `session_start` 必须是本次运行的第一个持久帧 | 压缩排在 driver 之后，下一次运行才生效 |
| L4 整篇文档读不出来 | 已修（`l4_chunks.py` 保留母文档）；实测 **3091/3091 可读，0 失败** |
| 首次中文检索要 8 秒 | bge-m3 冷加载（Ollama 没驻留）；之后 ~0.85s。不是 bug |
| 开发态首次访问某路由很慢 | Next dev 按需编译。`/api/persistence/documents` 首次 **5.26s** vs 二次 0.03s |
| 成本大头是 agent 本身 | 单次琐碎工具轮 **22,720** input tokens；长会话到 **291,608**/轮。真正的杠杆是**每门课新开对话** |

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
