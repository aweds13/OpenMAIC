# 材料库机制对比 —— 官方 vs 我方

> 记录时间 2026-11-05。**这份文档只记实测读数与判据，不写「应该怎样」。**
> 所有行号都是实测 `git show origin/main:<path> | nl -ba` 或 `nl -ba <file>` 读出来的。
> 官方 = 上游 `origin/main`（`1b641161`，2026-11-04）；我方 = 读代码时的 HEAD `918b4f0d`（`upgrade/v1.3.0`，2026-11-01）。
> 两棵树的 merge-base 是 `3618238d`（2026-10-29），不是包含关系：`origin/main` 领先 27 个提交，`HEAD` 领先 263 个。
> ★ 复核时 HEAD 已前进到 `4fa27693`（一个 docs 提交）；`git diff --numstat 918b4f0d HEAD -- materials-library.ts runner.ts prompt-context-file.ts learner-profile.ts config.ts` **空输出**，材料相关代码一字未变，本文行号仍然有效。

## 0. 一句话结论

**官方那套是「数据库 + owner 分区 + 抽取流水线 + 真文件夹」，我方那套是「一个目录 + 一堆 Markdown + 两个读写工具」。**
两者不是同一层东西：官方在 HEAD 里**一行没改**（下面第一节有 `git diff --numstat` 读数），我方是**另加**一套平行的文件系统实现。

最关键的一条实测：**官方 10 个工具在 HEAD 里全都在，而且和我们的 2 个工具同时注册进同一个 runner**（runner.ts:1885 / :1920 / :1921），不是替代关系。所以「搬官方机制」在很多地方**不是搬代码，是接线**。

---

## 1. 前置读数：谁在上游，谁不在

### 1.1 官方 17 个文件的实测行数

任务点名 16 个；我多加了 `lib/server/material-extraction/owner-extraction.ts`（owner 级抽取链），因为它是「抽取流水线」这一节绕不开的第三套 worker。

| 文件 | 行数 |
| --- | --- |
| lib/persistence/material-library.ts | 593 |
| lib/server/agent-runtime/material-library-tools.ts | 359 |
| lib/server/agent-runtime/material-tools.ts | 1207 |
| lib/persistence/material-roots.ts | 149 |
| lib/persistence/owner-materials.ts | 1386 |
| lib/persistence/owner-material-extraction.ts | 572 |
| lib/persistence/session-material-links.ts | 463 |
| lib/persistence/material-extraction-format.ts | 36 |
| lib/server/materials/extraction.ts | 935 |
| lib/server/material-extraction/owner-extraction.ts | 732 |
| app/api/materials/route.ts | 463 |
| app/api/materials/[id]/route.ts | 159 |
| app/api/materials/folders/route.ts | 68 |
| app/api/materials/library/route.ts | 98 |
| app/api/materials/move/route.ts | 75 |
| components/workbench/workspace/MaterialLibraryPage.tsx | 1964 |
| components/workbench/workspace/MaterialLibraryDialogs.tsx | 301 |

### 1.2 我方三份文件的上游状态

```
$ for p in lib/server/agent-runtime/{materials-library,learner-profile,prompt-context-file}.ts; do
    git cat-file -e origin/main:$p 2>/dev/null && echo "IN $p" || echo "NOT-UPSTREAM $p"; done
NOT-UPSTREAM lib/server/agent-runtime/materials-library.ts
NOT-UPSTREAM lib/server/agent-runtime/learner-profile.ts
NOT-UPSTREAM lib/server/agent-runtime/prompt-context-file.ts
```

`git merge-base --is-ancestor 6583b187 origin/main` → **NOT ancestor**。
提交 `6583b187`（2026-10-06）标题：`feat(二开): 学习者画像 + 材料库（两条"每次运行重读"的上下文文件）`。

### 1.3 F 系 docs 的归属（任务里点名要确认的）

```
$ find docs -name "*F7*"
docs/contracts/domains/F7-context-materials.md
docs/specification/domains/F7-context-materials.md
$ 逐个 git cat-file -e origin/main:<path>
NOT-UPSTREAM docs/contracts/domains/F7-context-materials.md
NOT-UPSTREAM docs/specification/domains/F7-context-materials.md
$ git ls-tree -r --name-only origin/main -- docs | wc -l
0
$ git ls-files docs | wc -l
38
```

**结论：整棵 docs/ 树都是我方自建**（上游根本没有 `docs/` 目录），不只 F7 这两份。这两份 F7 文档、以及 F1/F6/conventions/traceability/教学取向 全部 `NOT-UPSTREAM`。

### 1.4 官方那套在 HEAD 里改没改

```
$ for f in lib/persistence/material-library.ts lib/server/agent-runtime/material-tools.ts \
           lib/server/agent-runtime/material-library-tools.ts lib/server/materials/extraction.ts; do
    echo "$f => $(git diff --numstat origin/main HEAD -- $f)"; done
lib/persistence/material-library.ts => SAME
lib/server/agent-runtime/material-tools.ts => SAME
lib/server/agent-runtime/material-library-tools.ts => SAME
lib/server/materials/extraction.ts => SAME
$ git diff --numstat 3618238d origin/main -- <上面这些 + owner-materials + owner-material-extraction \
    + session-material-links + material-prompt + app/api/materials/>
(空输出)
```

⇒ 官方材料库这套**从头到尾没被我方动过**，且 merge-base 之后上游也没再动过它。

---

## 2. 数据模型表（官方）

### 2.1 表结构

| 表 | 字段（实测 DDL） | 关系 | 落点 / 备注 |
| --- | --- | --- | --- |
| `owner_material` | `id TEXT PK`, `owner_id TEXT NOT NULL`, `kind TEXT NOT NULL`, `derived_from TEXT`, `mime TEXT`, `bytes DOUBLE PRECISION NOT NULL`, `original_name TEXT`, `oss_key TEXT NOT NULL`, `sha256 TEXT`, `status TEXT NOT NULL DEFAULT 'ready'`, `extraction JSONB`, `created_at DOUBLE PRECISION NOT NULL`, `deleted_at DOUBLE PRECISION`（owner-materials.ts:200-219） | 自引用 `derived_from` → 派生项（image/关键帧）指向源 | v5 迁移再补齐：`asset_id`、`retention TEXT DEFAULT 'temporary' CHECK IN ('temporary','library')`、`folder_id`、`display_name`、`extraction_token`、`extraction_claims INTEGER DEFAULT 0`、`extraction_lease_at`、`extraction_error`、`extraction_result JSONB`、`extraction_cache_key`（owner-materials.ts:266-349） |
| `material_folders` | `owner_id TEXT NOT NULL`, `id TEXT NOT NULL`, `name TEXT NOT NULL`, `normalized_name TEXT NOT NULL`, `created_at`, `updated_at`, `PRIMARY KEY (owner_id, id)`, `UNIQUE (owner_id, normalized_name)`（owner-materials.ts:319-328） | `owner_material.(owner_id, folder_id)` → `material_folders.(owner_id, id)` `ON DELETE RESTRICT`（:333-347，`NULL folder_id` 不检查，MATCH SIMPLE） | **扁平、一层深、owner 作用域**；未归档 = `folder_id IS NULL`，不占行 |
| `agent_session_materials` | `id`, `session_id REFERENCES agent_sessions(id) ON DELETE CASCADE`, `kind`, `title`, `owner_material_id`, `source_url`, `text_asset_id`, `raw_asset_id`, `text_chars DEFAULT 0`, `derived_from REFERENCES 本表(id) ON DELETE CASCADE`, `extraction_status DEFAULT 'done'`, `extraction_attempts DEFAULT 0`, `extraction_error`, `extraction_stats JSONB`, `extractor_version`, `extraction_lease_worker_id`, `extraction_lease_worker_pid`, `extraction_lease_heartbeat_at BIGINT`, `created_at TIMESTAMPTZ`（packages/@openmaic/storage/src/material/pg.ts:57-98） | 会话内材料（老路）；`kind CHECK IN ('source','extraction','transcript','audio-track','image','web')` | 唯一索引 `(session_id, owner_material_id) WHERE owner_material_id IS NOT NULL`；部分索引 `(created_at) WHERE kind='source' AND extraction_status IN ('pending','running')` |
| `agent_session_material_links` | `session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE`, `material_id TEXT NOT NULL`, `created_at DOUBLE PRECISION NOT NULL`, `PRIMARY KEY (session_id, material_id)`（session-material-links.ts:53-60） | 会话 ↔ 库材料 **多对多链接** | **挂一份材料不复制字节**，只写一行（:400-462 的 `attachOwnerMaterialsToSession`） |

### 2.2 文件系统落点与字节池

| 项 | 实测读数 |
| --- | --- |
| 字节存储 | `LocalMaterialByteStore(root = resolve(process.cwd(), 'data'))`（lib/server/materials/bytes.ts:35-38）—— **落在仓内 `data/`**，不是学习者个人目录 |
| 路径逃逸防护 | `safeLocalPath(root, key)`：`resolve` 后必须等于 root 或 `startsWith(root + sep)`，否则 `throw new Error(\`invalid material object key: ${key}\`)`（bytes.ts:26-32） |
| 原子写 | `put` 先写 `${path}.${randomUUID()}.tmp` 再 `rename`（bytes.ts:35+，读方永不见撕裂对象） |
| 上传后的正式落点 | asset pool 条目 + `('material', id)` reference root；principal = `assetPrincipalForOwner(ownerId).key`（material-roots.ts:125）；pool 之前的老材料归 `LEGACY_SHARED_ASSET_PRINCIPAL`，永不 re-key（owner-assets.ts:4-34） |
| 检索 | 无 `readdir` 式扫盘；唯一相关的 `readdir` 在 `LocalMaterialByteStore` 里。**一切靠 SQL**（`material-library.ts:143` 的 `ILIKE`、`session-material-links.ts:293-300` 的三列 `ILIKE`） |

### 2.3 抽取状态机

**两套格式并存，靠一个适配层判定**（lib/persistence/material-extraction-format.ts，36 行）：

| 函数 | 判据 |
| --- | --- |
| `usesClassicExtraction(record)` :4-16 | `resultKey` 存在，或 status ∈ {ready, extracting} → classic；否则 `!assetId && !extractionResult && status ∉ {pending,running,done}` → classic |
| `libraryExtractionStatus(status)` :24-32 | `extracting→running`、`ready→done`；其余非 pending/running/done/failed → `idle` |
| `hasClassicText(record)` :34-36 | `status === 'ready' && Boolean(resultKey)` |

状态全集（owner-materials.ts:61-69，**7 个值**）：
`idle` / `pending` / `running` / `done` / `extracting` / `ready` / `failed`

状态流转（classic 那套，owner-material-extraction.ts:204-239 `ensureOwnerMaterialExtraction`）：
```
idle | failed  ──ensure──▶ pending（同时清 worker/heartbeat/claims/token/lease/error）
pending | running | done ──不动（返回 queued:false）
pending ──claim──▶ extracting（写 extraction_worker + extraction_heartbeat_at）
extracting ──心跳──▶ extracting（只更新 extraction_heartbeat_at）
extracting ──settle 成功──▶ ready
extracting ──settle 失败且可重试且 attempts < max──▶ extracting（放开 worker）
extracting ──settle 失败且预算用尽──▶ failed（带 reasonCode，error 截到 4000 字符）
```

token 那套（owner-material-extraction.ts:256-319）是另一套并发控制：`pending` → `running`（写 `extraction_token` + `extraction_lease_at`）；`running` 且 `extraction_lease_at < now - leaseTtlMs` 可被重新认领；`extraction_claims >= MAX_OWNER_EXTRACTION_CLAIMS`(3) 时直接写 `failed` + `'extraction did not finish within its claim budget'`。

### 2.4 抽取流水线：三套 worker 并存（这是最容易看漏的一点）

`instrumentation.ts` 实测启动三处：

| 行号 | 启动的东西 | 队列 |
| --- | --- | --- |
| instrumentation.ts:220-221 | `startOwnerMaterialExtractor()`（lib/server/materials/extraction.ts:702-796） | classic owner 队列（`extraction_worker` / `extraction_heartbeat_at`） |
| instrumentation.ts:243 | `extraction.startMaterialExtractionRunner()`（lib/server/material-extraction/runner.ts:57+） | **session 链**（`agent_session_materials`） |
| instrumentation.ts:249 | `ownerExtraction.startOwnerExtractionRunner()`（lib/server/material-extraction/owner-extraction.ts:681-732） | owner 级链（`extraction_token` / `extraction_claims`），RFC #1716 Phase 2 |

instrumentation.ts:245-247 的原注释：

> `Owner-level extraction of library sources (RFC #1716): what a conversation links is extracted once per owner, beside the session chain, which keeps serving copies made before links.`

任务里点名的那一句，实测在 **lib/server/materials/extraction.ts:662-674**：

```ts
export async function runNextOwnerMaterialExtraction(
  workerId: string,
  options: ExtractionLeaseOptions & { leaseTtlMs: number; perOwnerLimit?: number },
): Promise<boolean> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const claim = await claimOwnerMaterialExtraction(pool, workerId, {
    leaseTtlMs: options.leaseTtlMs,
    perOwnerLimit: options.perOwnerLimit ?? perOwnerExtractionLimit(),
  });
  if (!claim) return false;
  await runClaimedOwnerMaterialExtraction(claim, options);
  return true;
}
```

`{leaseTtlMs: 60_000, perOwnerLimit: 2}` 这个组合不是代码里的默认值，是 **DSH 插件自己传的**（`D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/diag.mts:158-161`）：
代码默认分别是 `agentRuntimeConfig.leaseTtlMs`（config.ts:15，默认 `10_000`）与 `perOwnerExtractionLimit()`（extraction.ts:687-689，`OPENMAIC_MATERIAL_EXTRACTION_PER_OWNER` 默认 `2`）。

---

## 3. 数据模型表（我方）

### 3.1 逻辑结构

```
<materialsDir>/
  INDEX.md            ← 索引层：有哪些主题、每个一句话。每次注入系统提示词
  <topic>.md          ← 主题文件：具体条目。按需读
```

实测真值：`.env.local:172` → `OPENMAIC_MATERIALS_DIR=D:/文档/jelly_ware/个人数据/材料清单`

真实目录内容（`ls -la` 实测，2026-11-05）：

| 文件 | 字节 | 字符 | mtime |
| --- | --- | --- | --- |
| INDEX.md | 1661 | 867 | Oct 7 20:58 |
| dart-flutter.md | 2840 | 1385 | Oct 8 |
| dev-environment.md | 4921 | 3192 | Oct 31 04:52 |
| java-backend.md | 7399 | 3926 | Oct 7 21:52 |
| proof-logic-analysis.md | 37555 | 20187 | Oct 5 14:19 |
| **合计** | **54376** | **29557** | — |

**5 个文件、0 个子目录。** 「没有文件夹层级」不是推断，是这个目录的实测形态。

### 3.2 schema（无 DDL，只有路径规则）

| 层 | 规则 | 行号 |
| --- | --- | --- |
| 目录来源 | `agentRuntimeConfig.materialsDir`，即 `process.env.OPENMAIC_MATERIALS_DIR?.trim() \|\| undefined` | config.ts:127 |
| 求值时机 | **路径**在模块加载时求值（换路径要重启）；**内容**每次运行重读 | config.ts:100-105 注释 |
| 索引名 | `INDEX_NAME = 'INDEX'` | materials-library.ts:42 |
| 文件名 | `topicPath(dir, topic)`：`INDEX` → INDEX.md，否则校验 slug 后拼接 topic 名 + 「.md」 | :61-65 |
| 主题清单 | `listTopics(dir)`：`readdirSync` 过滤 .md 后缀、去掉 INDEX.md、`slice(0,-3)`、再过一遍 slug、`sort()`；任何异常返回 `[]` | :68-78 |

### 3.3 slug 规则（唯一的安全边界）

```ts
const TOPIC_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
```

materials-library.ts:44-50 的注释明写设计意图：

> 严格到只有小写字母、数字、短横线 —— 于是 `.`、`/`、`\`、`..` 在正则层面就被排除，**路径穿越不可能发生**，不需要额外的事后校验。中文主题名请用英文 slug（如 java-backend），中文写在文件内容里。

⇒ 长度上限 64 字符；首字符不能是短横线；**中文主题名不可能存在**。

### 3.4 沙盒边界（三层，只有两层在这份文件里）

| 层 | 做法 | 位置 |
| --- | --- | --- |
| ① 参数层 | `TOPIC_SLUG` 正则 + `INDEX` 字面量；非法直接 `isError`，不落盘 | materials-library.ts:61-65、:272-283（read）、:326-337（update） |
| ② 注入层 | `readPromptContextFile` 三个上限：文件 > 64KB 当没配、字符 > 24000 截断加 `…（已截断）`、剥 HTML 注释；任何异常返回 `null` | prompt-context-file.ts:28、:31、:34、:42-53 |
| ③ 宿主层（DSH 插件，不在仓内） | 文件名白名单 `/^[A-Za-z0-9._-]+\.md$/` 且不含 `..`；`path.dirname(target) !== path.resolve(MATERIALS_DIR)` 就拒；然后才 `writeFileSync` | `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/index.js:1787-1800` |
| ③′ 写沙盒 | `update_materials` 先在 `mkdtempSync` 临时目录里跑，把生成内容截下来交给宿主决定写不写；**跑之前先把该主题的真文件复制进沙盒**，否则 `append` 在空目录上会走 `existed = false`、回话报 Created 且原内容整段丢（实测踩到过） | `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/diag.mts:558-568`、:607、:609-624、:625 |

diag.mts:561-564 的理由（原注释）：

> 写（update_materials）**先在临时目录里跑**，把生成的文件内容截下来交给 index.js 决定写不写。理由：材料库在 `D:/文档/jelly_ware/个人数据/材料清单` —— 是学习者的真实资料，不是插件的草稿区。让桥直接写等于把「写学习者资料」这个决定埋进一个子进程里，宿主侧就看不见了。

### 3.5 我方没有的东西（逐项实测确认）

`grep -n "owner\|pool\|Session\|pg" lib/server/agent-runtime/materials-library.ts` → **无输出**。
import 只有：`node:fs`（5 个函数）、`node:path` 的 `join`、`typebox`、`AgentTool` 类型、`./config`、`./prompt-context-file`。

⇒ 我方这一套：**无表、无 owner、无会话、无连接池、无字节池、无抽取、无配额表、无审计事件、无并发控制。**

---

## 4. 工具面对照

### 4.1 官方 5 个文件夹工具（lib/server/agent-runtime/material-library-tools.ts）

| 工具 | 参数（实测 schema） | 返回 details | 行号 |
| --- | --- | --- | --- |
| `list_material_folders` | `query?: string 1..200`（:30-34） | `{status:'listed', folders:[{folderId,name,materialCount}]}`；空时文本 `No folders yet.` | 实现 :141-165 |
| `create_material_folder` | `name: string 1..80`（:35-37） | `{status:'created'\|'exists', folderId, name, created}`；同名（忽略大小写）返回既有 | :167-211 |
| `rename_material_folder` | `folderId: string`, `name: 1..80`（:38-41） | `{status, folderId, name}`；`invalid_name`/`not_found`/`name_taken` 三种 isError | :213-255 |
| `move_materials` | `materialIds: string[] 1..100 unique`, `folderId: string`（`'top-level'` = 移出）（:42-54） | `{status, materialIds, folderId, movedCount, folderLabel?}`；**全有或全无** | :257-317 |
| `rename_material` | `materialId: string`, `name: 1..255`（:55-58） | `{...outcome}`；只改 display name，原始文件名保留；派生物不能单独改名 | :319-353 |

共同的三条硬约束（:107-111、:113-139）：

1. `const write = { ownerId: deps.ownerId, fence: 'background' as const }` —— **owner 永远是 run 的，永远不是参数**；写走转发 fence。
2. **agent 不能删任何东西**。删材料/删文件夹是老师在学习库页面上的动作（material-prompt.ts:29 也对模型说了这句）。
3. 每个真变化都发 `onLibraryChanged` → 持久 `library_changed` 事件（`folder_created` / `folder_renamed` / `materials_moved` / `material_renamed`）。

### 4.2 官方 5 个材料工具（lib/server/agent-runtime/material-tools.ts）

| 工具 | 参数 | 返回 details | 行号 |
| --- | --- | --- | --- |
| `list_materials` | `scope?: 'session'\|'library'`, `folderId?`, `query? 1..200`, `before?`（:104-126） | `{materials, nextBefore?}`；每 source 附 `derivativeCount`；源永远排在派生物前 | :614-718 |
| `read_material` | `materialId`, `offset? ≥0`, `revision?`（offset>0 必填）, `scope?`（:127-139） | `{materialId, revision, offset, totalChars, nextOffset?}`；content 两段 = 围栏正文 + 元数据 | :720-820 |
| `search_material` | `query 1..200`（字面量，不支持正则）, `materialId?`, `scope?`（:140-150） | `{query, mode:'literal', scannedChars, truncated, hits}` | :822-981 |
| `extract_material` | `materialId`, `scope?`（:151-154） | `{materialId, ...state, started}`；只排队，不干活 | :983-1045 |
| `wait_for_materials` | `materialIds? 1..unique`（library scope 必填）, `timeoutSec? 1..300`, `scope?`（:155-172） | `{complete, timedOut, requiresExtraction?, materials[]}` | :1047-1143 |

`SCOPE_SCHEMA`（:96-102）原文：

> `'session' (default): materials attached to or made in this conversation.`
> `'library': every material in the user's knowledge base, attached or not.`

### 4.3 我方 2 个工具（lib/server/agent-runtime/materials-library.ts）

| 工具 | 参数（实测 typebox） | 返回 details | 行号 |
| --- | --- | --- | --- |
| `read_materials` | `topic?: string maxLength 64`（:200-212） | 不给 topic：`{topics}`，文本 = INDEX 正文 + `### Topics on disk` 列表；给 topic：`{topic}`，文本 = 文件全文 | :237-303 |
| `update_materials` | `topic: 1..64`, `content: string minLength 1`, `mode: 'append'\|'replace'`（:214-234） | `{topic, mode, created}` —— **不返回任何 id** | :307-385 |

### 4.4 能力差异矩阵

| 能力 | 官方 | 我方 |
| --- | --- | --- |
| 列全部材料 | ✅ `list_materials`（两种 scope；library scope 每页 100，`listLibrary` 默认 limit=100 上限 200；session scope 每页 50 = `SESSION_LIST_PAGE`，material-tools.ts:94） | ⚠️ 只能列**主题名列表**（`### Topics on disk`），列不出条目 |
| 按名字/类型搜 | ✅ 三列 `ILIKE`（`display_name`+`original_name`+`mime`） | ❌ 无 |
| 全文搜 | ✅ `search_material`（预算 5000ms、单材料 10 命中、总 30、扫描 1MB） | ❌ 无 |
| 分页读长文 | ✅ 8000 字符/页 + `revision` + `nextOffset` | ❌ 一次 `readFileSync` 全文 |
| 「读时文本变了」检测 | ✅ `revision_changed` + 从 0 重读 | ❌ 无 revision 概念 |
| 不可信内容围栏 | ✅ 围栏开闭标是 `untrusted-material-content-<16 hex nonce>`（`UNTRUSTED_MATERIAL_TAG`，material-tools.ts:268 + :276-289），payload 含 tag 就重抽（最多 4 次），仍含则 throw | ❌ 裸文本直出 |
| 创建/重命名/移动/列举文件夹 | ✅ 4 个工具 | ❌ 无（只有 INDEX 表格是「软索引」） |
| 改名材料 | ✅ `rename_material`（只改 display name） | ❌ 无（文件名 = 主题名，改名等于换主题） |
| 删除 | ❌ agent 不能（页面/HTTP 才能） | ❌ agent 不能（也没有页面） |
| 上传/抽取 | ✅ 上传路由 + 三套 worker + `extract_material` + `wait_for_materials` | ❌ 完全无 |
| 追加内容 | ❌ 无 append（只能整份覆盖/组织） | ✅ `mode: 'append'` |
| 自由写任意 Markdown | ⚠️ 只能写「名字」，正文来自抽取 | ✅ `mode: 'replace'` 写任意正文 |
| 无 DB 也能用 | ❌ 强依赖 `DATABASE_URL`（无 → `throw new Error('Agent runtime requires DATABASE_URL')`，material-tools.ts:252-256） | ✅ 只要目录可写 |
| 多会话共享 | ✅ owner 库 + 链接表 | ✅ 全局共享（就一个目录，所有会话读同一份） |
| 事件/审计 | ✅ `library_changed` 共 6 种 change（`folder_created`/`folder_renamed`/`materials_moved`/`material_renamed`/`extraction_started`/`extraction_settled`，material-library-tools.ts:73-80）+ 顶层 `isError` 供 error audit 读 `data->>'isError'` | ❌ 只有 `isError` 布尔，无事件 |

**「官方有我没有」= 10 个工具 + 抽取流水线 + 文件夹层级 + 分页/搜索/围栏/事件。**
**「我有官方没有」= append 模式 + 零依赖（不需要库/owner/抽取）+ 自由正文写入。**

---

## 5. 机制差异清单（12 条）

### 差异 1 —— 存储介质：SQL 表 vs 一个目录

| | |
| --- | --- |
| **官方做法** | `owner_material` + `material_folders` + `agent_session_materials` + `agent_session_material_links` 四张表（DDL 见 §2.1）；一切查询走 SQL，`ILIKE` 做名/类型过滤（session-material-links.ts:293-300） |
| **我方做法** | 一个目录 + N 个 Markdown；`readdirSync` 就是「查询」（materials-library.ts:68-78），文件名就是主键 |
| **差异后果** | 我方拿不到：按类型/日期/大小过滤、分页、并发安全的原子改名、唯一性约束、引用完整性。官方拿不到：无库部署、人类直接 `git diff` 读材料。**同一条「材料库」在两个实现里不是同一个数据模型的投影。** |

### 差异 2 —— 抽取流水线：三套 worker + 租约 vs 完全没有

| | |
| --- | --- |
| **官方做法** | `instrumentation.ts:220-221` 起 classic owner 提取器；`:243` 起 session 链；`:249` 起 owner 级 token 链。单次执行 `runNextOwnerMaterialExtraction(workerId, {leaseTtlMs, perOwnerLimit})`（extraction.ts:662-674）；classic claim 用 `pg_advisory_xact_lock('owner-materials:extraction-claim')` 串行化所有 claimer（owner-materials.ts:1101、:1122），心搏 `extraction_heartbeat_at`，同 owner 同 sha256 的更早上传还在抽时**主动等它**（:1148-1157） |
| **我方做法** | **没有抽取**。材料是 Markdown，人工/agent 直接写正文。整份实现无任何 worker、无租约、无心搏、无重试 |
| **差异后果** | 我方没有「上传 PDF 后等它变可读」这个问题，也因此**拿不到「一份源只解析一次、结果被所有会话共享」这条收益**（CHANGELOG:225 明写这是知识库的核心卖点）。反过来官方那套要跑 MinerU 之类的解析器，DSH 宿主里根本没进程起它 —— 所以插件才自己驱动（diag.mts:1413-1417：「工具只**排队**，真正干活的是进程里的 background extractor（instrumentation.ts 里起的），DSH 宿主里没有它。所以这两个动作由桥自己驱动一次」） |

### 差异 3 —— 文件夹层级：真表 + 外键 vs 手工维护的 INDEX 表格

| | |
| --- | --- |
| **官方做法** | `material_folders` 表；`UNIQUE (owner_id, normalized_name)`（owner-materials.ts:327）+ 外键 `ON DELETE RESTRICT`（:333-347）；名字按**显示宽度**校验（全角 2、半角 1，`FOLDER_NAME_MAX_WIDTH = 40`，folder-name-validation.ts:12）；每 owner 上限 50（`FOLDER_COUNT_LIMIT`，:15）；同名创建返回既有（`created: false`，material-library.ts:189-227）；移动**全有或全无**，一次最多 100 个（`MAX_MOVE_MATERIALS`，:86）；派生项随源移动、永不单独移动 |
| **我方做法** | 目录**平铺**，无子目录（实测 5 个 .md、0 个子目录）。「分类」只存在于 INDEX.md 的一张 Markdown 表格里，靠提示词第 184 行「Create a new topic file when a subject has none, and add its row to INDEX.md」让 agent 自觉维护 |
| **差异后果** | 我方没有约束：主题名可以「撞名」（大小写归一后仍可并存 `Foo` 与 `FOO`？—— 实测不能，slug 只允许小写；但 `java` 与 `java-backend` 可以并存且语义重叠）；INDEX 表格可以与磁盘不一致（代码已承认这点，materials-library.ts:114-117：「INDEX.md 是智能体自己维护的，它可能忘了更新索引表。把磁盘上真实存在的文件列出来，模型就不会"以为"某个主题不存在而重复新建」）。官方那套**结构上不可能不一致**（表就是权威）。 |

### 差异 4 —— 归属/权限：owner fence vs 环境变量路径

| | |
| --- | --- |
| **官方做法** | 每个写操作先取 owner 写栅栏：`'request'` → `fenceOwnerWrite`（拒已退役 owner），`'background'` → `forwardOwnerWrite`（跟随 claim 后的新 owner）（material-library.ts:88-95；owner-merges.ts:308、:327）。owner **永远不出现在模型可见参数里**（material-library-tools.ts:110；runner.ts:1576-1577 同一条纪律）。字节池按 `assetPrincipalForOwner(ownerId)` 分区，配额按 owner 计（owner-assets.ts:4-34、:62） |
| **我方做法** | 无 owner 概念。目录来自 `OPENMAIC_MATERIALS_DIR`（config.ts:127），单值、进程级。DSH 侧靠宿主常量 `OWNER_ID`（`.../lib/index.js:597`）**只用于另一套**（`openmaic_material_ops`），主题文件那套（`openmaic_materials`）根本不传 owner |
| **差异后果** | 我方**一个部署只能有一个材料库**。多用户/多学习者要隔离，只能靠起多个进程改 env（而 env 在模块加载时求值一次，config.ts:100-105，换路径必须重启）。官方天然多租户。 |

### 差异 5 —— 多会话共享：链接表 vs 全局目录

| | |
| --- | --- |
| **官方做法** | 两层：`agent_session_materials`（会话内材料，老路，含 `owner_material_id` 与 `derived_from`）+ `agent_session_material_links`（会话 ↔ 库材料，新路）。挂一份材料**不复制字节**：`attachOwnerMaterialsToSession` 只 `INSERT ... ON CONFLICT DO NOTHING`（session-material-links.ts:446-451），返回 `attachment: 'link' \| 'copy'`（:453-461）。列表时**副本只在该会话的工具作用域内遮蔽 id，owner 页面必须列原始条目**（:281-286 的 `NOT EXISTS` 子查询）。工具层还有专门提示：写改名/移动后，若该会话有更早的副本，返回 `sessionCopyIds` + 一句「This conversation reads its own earlier copy of ...; the copy keeps its previous name and folder.」（material-library-tools.ts:113-139） |
| **我方做法** | 没有「挂」这个动作 —— 目录只有一个，**所有会话默认看见全部材料**。唯一的会话级耦合是 URL 信任闸：建会话时把**全部主题文件全文**解析出 URL 灌进该会话（store.ts:42-63） |
| **差异后果** | 我方「共享」是**无条件的**：会话 A 的材料会话 B 立刻看见，也没有「这份是这次对话专用的」概念。官方能区分「挂上的」「库里的」「会话自己造的副本」，代价是两表 + resolver 里的优先级规则（session 行赢过同 id 的 owner 材料，material-resolver.ts:82-94）。 |

### 差异 6 —— 进上下文的方式：恒定块 + 工具结果 vs INDEX 正文进系统提示词

| | |
| --- | --- |
| **官方做法** | `materialsPromptBlock(_materials)` **不读材料集合**（material-prompt.ts:1-16 注释：「no names, ids, kinds, counts, or extraction status」「The block must not read it」），每次运行字节完全一样；材料内容只从 `read_material` 的工具结果进上下文，且带不可伪造围栏（material-tools.ts:270-289）。runner.ts:1989-1991 的注释就是这句：`// Always: a conversation with nothing attached can still use the knowledge base.` |
| **我方做法** | `materialsIndex: materialsIndex ? materialsIndexPromptBlock(materialsIndex) : undefined`（runner.ts:1984），其中 `materialsIndex = resolveMaterialsIndex()`（:1565）= **INDEX.md 正文 + 磁盘主题名列表**（materials-library.ts:133-148）。主题文件正文**不进**提示词（按需 `read_materials` 读） |
| **差异后果** | 我方的系统提示词里有一块**由 agent 自己改写的内容**：`update_materials` 可以 replace INDEX，下一轮 `resolveMaterialsIndex()` 就变了 ⇒ 系统提示词跟着变。**严格说这不违反 SR-F7.3** —— 那条的前提是「只要影响内容的输入没变」，INDEX 变了就是输入变了。也不是 SR-F7.2 的字面范围 —— 那条管的是**会话级**材料的名称/数量/状态，INDEX 是 owner 级材料库的索引，不是「本次会话装载了什么」的清单。**代价是另一件事**：按 F7 规格自己给的读数（会话里插一行材料，命中率 99.1% → 38.5%），每改一次 INDEX 就要付一次全量输入的钱；官方那块永远是常量，改写材料库不动系统提示词。★ 我**没有实测**我方这份 INDEX 改动带来的命中率变化（见 §8 诚实清单第 4 条），这里只报结构。

### 差异 7 —— 读：8000 字符分页 + revision vs 全文一次性

| | |
| --- | --- |
| **官方做法** | `TEXT_WINDOW_CHARS = 8000`；`codePointBoundary` 防切半个 surrogate（material-tools.ts:291-310、:798-801）；`offset > 0` 不给 `revision` → **isError** `revision_required`（:771-782）；`revision` 不匹配 → **非错误** `revision_changed` + 「Read again from offset 0」（:783-794）；`details` 只回 `{materialId, revision, offset, totalChars, nextOffset?}`，**只有 content 到模型，details 不到**（:809-816 注释） |
| **我方做法** | `content: [{type:'text', text: readFileSync(path,'utf8')}]` 一次给全文（materials-library.ts:298-301）。无分页、无 revision、无上限 |
| **差异后果** | 材料长到现在这个规模（proof-logic-analysis.md 实测 **20187 字符**）还可以；再长就会**一次性烧掉大量上下文且无法中断**。官方那套的 `totalChars` 还能让模型自己判断「要不要继续读」。我方连「还有多少没读」都不知道。 |

### 差异 8 —— 写：5 个组织工具 + 事件 vs 2 模式覆盖 + 静默

| | |
| --- | --- |
| **官方做法** | 只能改「组织信息」（名字/文件夹），不能改内容；每次真变化发 `MaterialLibraryChange`（material-library-tools.ts:73-80）：`folder_created` / `folder_renamed` / `materials_moved` / `material_renamed` / `extraction_started` / `extraction_settled`，经 `onLibraryChanged` 变成持久事件，驱动页面刷新（use-material-library-tree.ts:3-39 的第 ④ 条 freshness） |
| **我方做法** | `update_materials` 两模式：`append`（`${old.trimEnd()}\n\n${block}\n`）与 `replace`（`${block}\n`）（:350-369）。无事件、无变更通知、无版本、无冲突检测；两个会话同时 append 会**后写覆盖前写**（`readFileSync` → 拼 → `writeFileSync`，无锁） |
| **差异后果** | 我方 agent 能写任意正文但**组织能力为零**（想把 `java-backend` 拆成 `java-core` / `java-web` 只能新建文件 + 手改 INDEX，旧文件没有删除工具）。并发写是真实风险：DSH 插件侧有宿主守卫，但仓内这条路径**没有任何锁**。 |

### 差异 9 —— 删除：分层授权 vs 都没有

| | |
| --- | --- |
| **官方做法** | agent 侧**没有**删除工具（material-library-tools.ts 只有 5 个，material-prompt.ts:29 明说 `you cannot delete`）；HTTP/页面侧**有**：`DELETE /api/materials/[id]`（CHANGELOG:281：一事务删源+派生物、撤回 pool roots、tombstone 取消 pending/running 抽取，204）、`DELETE /api/materials/folders/[id]`（folders/[id]/route.ts:59+，把内容移到顶层再删文件夹，204） |
| **我方做法** | 也没有删除工具（`MATERIALS_TOOL_NAMES` 只有两个，:388）；也没有页面 |
| **差异后果** | 「agent 不能删」这条**两边一致**，但官方把「人怎么删」补齐了（页面 + 路由 + tombstone + pool root 撤回），我方留了个洞：**材料库只能长不能缩**，除非人手动去 `D:/文档/jelly_ware/个人数据/材料清单` 删文件（而这又会让 INDEX 表格悬空）。 |

### 差异 10 —— 错误与本地化：页面措辞 + reason code vs 裸英文串

| | |
| --- | --- |
| **官方做法** | `materialModelCopy(locale)`（material-model-copy.ts:79+）：12 个 locale 白名单（:26-39），用知识库页面自己的措辞说解析状态；失败只给页面稳定 reason code 与措辞，**绝不**给后端诊断（docstring :1-7：「that carries parser endpoints and configuration hints the model would repeat. The diagnostic stays in the server log.」）；另有 `MATERIAL_USER_WORDING`（:125-130）禁止对用户显示工具名/字段名/id/原始值 |
| **我方做法** | 硬编码英文 + 硬编码中文混写：`Invalid topic "<t>". Lowercase letters, digits and dashes only, or "INDEX".`（文本在 :332，分支 :326-337）、`Refused: <n> characters exceeds the 200000 limit...`（文本在 :343，分支 :338-348）、`（INDEX.md 尚未创建）`（:147）、`…（已截断）`（prompt-context-file.ts:49）。无 locale、无 reason code、无 guidance |
| **差异后果** | 我方错误对模型是够用的（都是可行动的指令），对用户界面是**不可用的**（没有码，没法翻译，没法做「点这里重试」）。官方那套的前提是「有个页面」，我方没有页面 —— 这是**结构性配套缺失**，不是单纯少写了几句话。 |

### 差异 11 —— 配额：三档配额 vs 三个字符上限

| | |
| --- | --- |
| **官方做法** | `LibraryLimits`（library-view.ts:102-115）：`documentMaxBytes` / `mediaMaxBytes` / `maxCount` / `maxTotalBytes` / `usedCount` / `usedBytes` / `assetQuotaBytes` / `assetUsedBytes`；默认 `maxMaterialsPerOwner = 100`（config.ts:50）、`maxUploadBytes = 50MB`（:46）；超限 `MaterialQuotaExceededError`（owner-materials.ts:169-181，`quota: 'count'\|'bytes'`）；**实测 HTTP 映射不是 413/507**：条数/字节超限在 `app/api/materials/route.ts:313-319` 映射为 **429**（`quota_exceeded`）；413 是 `materialTooLarge`（:79-87，单次上传体超过 `maxBytes`）；507 是 `ASSET_QUOTA_EXCEEDED`（:398，asset pool 配额） |
| **我方做法** | 三个独立的字符上限：单次写入 200_000 字符（materials-library.ts:54）、单文件注入 64KB（prompt-context-file.ts:28）、注入后 24_000 字符截断（:31）。**没有总量配额、没有条数配额、没有用量读数** |
| **差异后果** | 我方没有「库有多大」这个概念：目录可以无限长，INDEX.md 也可以无限长（它每次进系统提示词！）。官方的 `limits` 还能从 `GET /api/materials/library?limits=1` 读到（library/route.ts:35-36、98）。 |

### 差异 12 —— 界面：1964 行页面 + 3 秒轮询 vs 无界面

| | |
| --- | --- |
| **官方做法** | MaterialLibraryPage.tsx（1964 行，3 个导出：formatLibraryDate :110 / newFolderName :514 / 主组件 MaterialLibraryPage :735）+ MaterialLibraryDialogs.tsx（301 行，⋯ 菜单 + 对话框）+ use-material-library-tree.ts（643 行，四个游标 / 一次换掉 / 刷新不改视图 / 3 秒轮询 `MATERIAL_LIBRARY_TREE_POLL_MS = 3_000`）+ 8 个 API 路由 |
| **我方做法** | 无页面、无路由。唯一「界面」是 DSH 插件里的两个聚合命令 `material-ops` / `material-folders`（`.../lib/diag.mts:1355-1453`、:1465-1523）—— 那是给 agent 用的，不是给人看的 |
| **差异后果** | 我方材料库的内容**只有 agent 和人肉看文件两种访问方式**。官方那套「页面与工具说同一套话」（material-model-copy.ts 的全部存在理由）在我方没有落点。 |

---

## 6. 官方有、我方可直接搬的机制（按可搬性排序）

排序依据：**改动面**（要改几个文件）× **前置依赖**（要不要库/服务/页面）。越靠前越便宜。

### 6.1 可搬性 S —— 已经是原生代码，只差接线

**① `search_material` 的语义搜索能力（部分可搬）**

- 现状：HEAD 里 `lib/server/agent-runtime/material-tools.ts:822-981` 一字未改，`buildMaterialTools()` 已经能用。但它的候选来自 `listLibrary`（DB）。
- 搬法：把它包成「在 `<materialsDir>` 里做字面量搜索」的独立函数，复用它的**预算常量与截断语义**（`MAX_SEARCH_HITS_PER_MATERIAL = 10`、`MAX_SEARCH_HITS_TOTAL = 30`、`SEARCH_TIME_BUDGET_MS = 100`、`SEARCH_WALL_TIME_BUDGET_MS = 5_000`，:78-94）。
- 要改的文件：`lib/server/agent-runtime/materials-library.ts`（加 `search_materials` 工具）。
- 成本判断：**代码量小，但要重写扫描循环**（DB 版按 chunk 扫 pool 文本，文件版可以直接 `readFileSync` 后 `indexOf`，几百字符）。没有新依赖。

**② 不可伪造围栏 `untrustedMaterialBlock`**

- 现状：`material-tools.ts:270-289`，纯函数，只依赖 `node:crypto` 的 `randomBytes`。
- 搬法：把 `read_materials` 的正文包进同样的围栏。**payload 本来就要逐字保留**（我方也没有转义），所以零语义损失。
- 要改的文件：`lib/server/agent-runtime/materials-library.ts`（`buildReadMaterialsTool` 的 :298-301）。
- 成本判断：**最低成本、最高收益的一条**。我方材料正文全部来自抓取的网页/文档，现在是裸文本直出模型 —— 这正是官方注释里说的注入通道。
- 注意：围栏正文那三行说明是英文的，搬过来要保持措辞一致（官方 docstring 明写「同一套家规形状与措辞，让模型只遇到一种框定」）。

### 6.2 可搬性 A —— 需要新增状态，但不需要 DB

**③ `read_materials` 的分页 + revision**

- 现状：官方 `TEXT_WINDOW_CHARS = 8000` + `revision` 校验（material-tools.ts:760-818）。
- 搬法：`revision` 用 `statSync(path).mtimeMs` 的十六进制即可（不需要内容哈希，只要「变了就换号」）。`offset` 与 `codePointBoundary`（:291-310）可以原样拷。
- 要改的文件：`lib/server/agent-runtime/materials-library.ts`（`READ_PARAMS` :200-212 加分页参数、`buildReadMaterialsTool` :298-301 分页切片）。
- 成本判断：约 60 行。风险点：`details` 不能到模型（官方靠 `content` 与 `details` 分离），我方要保持这个分离。

**④ 文件夹层级的「软」版本：目录即文件夹**

- 现状：官方真表（见差异 3）；我方目录平铺。
- 搬法有两个层次：
  - **轻**：仍平铺，但给每个主题加一行 front-matter（`direction:` / `updated:`），让它可被过滤 —— 不动目录结构，只改 INDEX 约定。
  - **重**：真用子目录，即 materialsDir 下 folder 名一层、再 topic 文件名。这会让 `TOPIC_SLUG` 从「一段」变成「两段」（`/^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63})?$/`），但**路径穿越仍然在正则层被排除**（`..` 不含于字符类）。`listTopics` 要从 `readdirSync` 改成递归。
- 要改的文件：`lib/server/agent-runtime/materials-library.ts`（:51、:61-78、:200-234）；**以及** `.../lib/index.js:1792-1798` 的宿主守卫（现在的 `path.dirname(target) !== path.resolve(MATERIALS_DIR)` 会把子目录写全部拒掉 —— 必须改成 `startsWith(MATERIALS_DIR + sep)`）。
- 成本判断：仓内 ~80 行，**插件侧必须同步改**，否则写子目录会被宿主拒。这是唯一一条「改了仓内不改插件就坏」的机制。

**⑤ `library_changed` 式事件（只做「变了」通知）**

- 现状：官方 6 种 change 类型 + 持久事件（material-library-tools.ts:73-80）。
- 搬法：我方只需一个布尔「材料库变了」。触发点：`update_materials` 成功写入后。消费方：runner 里可以据此判断是否需要重算 `materialsIndex`（目前是每轮无条件重读，所以事件的价值主要是「让 UI / 宿主知道」）。
- 要改的文件：`lib/server/agent-runtime/materials-library.ts`（返回值加一个字段）、`lib/server/agent-runtime/runner.ts:1984`（消费）。
- 成本判断：很小，但**收益取决于有没有消费方**。现在没有页面，所以收益低 —— 排在 A 的末尾。

### 6.3 可搬性 B —— 要动数据层，成本明显上升

**⑥ 配额与用量读数**

- 现状：官方 `libraryLimits()`（library-view.ts:118-133）+ `ownerLibraryUsage()`（owner-materials.ts:570）。
- 搬法：不需要 DB，`readdirSync` + `statSync` 求和即可算出 `usedCount` / `usedBytes`。难点是**阈值从哪来**：官方从 `config.ts:50` 的 `maxMaterialsPerOwner` 拿，我方得新增 `OPENMAIC_MATERIALS_MAX_COUNT` / `..._MAX_BYTES` 两个 env。
- 要改的文件：`lib/server/agent-runtime/config.ts`（加两个键）、`lib/server/agent-runtime/materials-library.ts`（写前校验 + `whoami` 暴露读数）、`app/api/whoami/route.ts:62`（加一项）。
- 成本判断：中等，但**没有界面就没有人看得见用量** —— 除非 DSH 插件加一个读数命令。

**⑦ 多会话共享的「挂载」语义**

- 现状：官方 `agent_session_material_links`（见差异 5）。
- 搬法：**不建议直接搬表**（要我方引入 DB 才能做）。文件系统版本的等价物是「每个会话一个清单文件」：`<materialsDir>/.sessions/<sessionId>.json` 记录挂载的主题名。但这样会把材料库目录弄成半结构化，和「人类直接改 Markdown」的初衷冲突。
- 要改的文件：`lib/server/agent-runtime/materials-library.ts` + `store.ts:42-63`（现在无条件全文喂 URL 闸，要改成按挂载过滤）。
- 成本判断：**高，且和现有设计哲学冲突**。除非确定要做「同一部署多学习者」，否则不建议。

### 6.4 不建议搬的

| 机制 | 为什么不建议 |
| --- | --- |
| 抽 取 流 水 线（三套 worker + 租约 + 心搏） | 我方材料是 Markdown，没有「解析」这一步。搬过来要先把材料变成二进制上传，等于换掉整个设计。**且 DSH 宿主里没有进程起 extractor**（diag.mts:1413-1417 已经实测过这个坑，所以才自己驱动） |
| `owner_material` 全套 DDL + v1–v5 迁移 | 引入库依赖。我方现在的「无库也能用」是真实优势（`DATABASE_URL` 没配时官方 `material-tools` 直接 `throw`，material-tools.ts:252-256） |
| 1964 行页面 + 3 秒轮询树 | 没有宿主容器。DSH 插件里没有 React 页面 |
| `materialModelCopy` 的 12 locale | 没有页面就没有「页面措辞」这个锚点，搬过来只是多一份翻译表 |

---

## 7. 两条实现并存时的一个实测事实

runner.ts 里三处注册（实测行号）：

```
1885:        materialsTools,          ← 我方 read_materials / update_materials（条件注册）
1920:        materialTools,           ← 官方 5 个材料工具
1921:        materialLibraryTools,    ← 官方 5 个文件夹工具
```

⇒ **同一个 agent 同时拿到 12 个材料相关工具**。模型看到的是：

- `read_materials` / `update_materials`（写 Markdown 目录，无 owner）
- `list_materials` / `read_material` / `search_material` / `extract_material` / `wait_for_materials`（读 owner 库，需 DB）
- `list_material_folders` / `create_material_folder` / `rename_material_folder` / `move_materials` / `rename_material`（组织 owner 库）

两套词汇都叫「材料库 / materials library」，但**指向两个不同的存储**。这是当前状态里最容易被模型误用的一点，也是 §6 里那些「搬」的动作真正要解决的界面问题 —— 不是缺功能，是**同名两套**。

（`DATABASE_URL` 没配时，官方那 10 个工具仍然注册，调用时才 `throw new Error('Agent runtime requires DATABASE_URL')`，material-tools.ts:252-256 —— 也就是说**没库的部署里这 10 个工具是坏的但可见**。）

---

## 8. 诚实清单

逐条列出**没读到 / 读不懂 / 无法验证**的点与原因。

1. **真实库里的行数、文件夹数、链接数 —— 没读到。**
   `node -e` 连 `postgres://postgres:***@127.0.0.1:5433/postgres` 返回
   `CONN ERR connect ECONNREFUSED 127.0.0.1:5433`；
   `openmaic_ensure_services` 回 `{postgres:{port:5433,listening:false}, started:false, attempt:0}`。
   起点脚本存在（`D:/文档/jelly_ware/_tools/openmaic/start_all.ps1`，:41 的 `$PGCTL`、:235 的 `Ensure-Service -Probe { Test-Port 5433 }`），但本会话审批关闭、且起服务不是只读动作，**没有起**。
   ⇒ 数据模型只能从 DDL 与代码判，不能从实况判。

2. **没有跑任何测试。** 只读了代码与 DDL。官方材料相关测试实测 53 个文件（`git ls-tree -r --name-only origin/main -- tests | grep -ci material`），我方 9 个（tests/agent-runtime/materials-library.test.ts，165 行）。**跑没跑通、有没有红，我不知道。**

3. **抽取流水线的运行时行为没实测。** 三套 worker 的启动、claim、心搏、settle 全部是读代码；MinerU 起没起、一份 PDF 抽多久、`extraction_cache_key` 命中率，**都没测**。

4. **差异 6 的缓存后果没实测。** 我报的是结构（INDEX.md 正文进系统提示词，而 agent 自己能改 INDEX）。**没有测过命中率**，不能说「实测掉到多少」。仓库里 docs/specification/domains/F7-context-materials.md 的 SR-F7.2 引了 99.1% → 38.5% 的旧实测，但那是「会话材料进提示词」，不是「INDEX.md 进提示词」，两者不是同一件事。

5. **`agent_session_materials` 与 `agent_session_material_links` 两表并存的运行时取舍，没完全读懂。** `session-material-links.ts:279-286` 的注释说「副本只在该会话的工具作用域内遮蔽 id，owner 页面必须列原始条目」，但**什么情况下会产生副本**（是 `bindOwnerMaterialsToSession` 还是老的绑定路径）我只看到两条线索（`session-materials.ts:234`、`agent_session_materials.owner_material_id`），没追到完整调用链。

6. **UI 组件没有渲染验证。** MaterialLibraryPage.tsx 1964 行、Dialogs 301 行，只读了导出符号、顶层声明与 docstring，**没有跑起来看**。任何关于「页面上长什么样」的结论都不可靠（本文档也刻意没写）。

7. **上游 27 个提交没逐条看。** 我只做了两步：`git diff --numstat origin/main HEAD` 与 `git diff --numstat 3618238d origin/main`（对材料相关文件，两次都空）。所以「材料库这套从 merge-base 到 origin/main 没变」是有读数的，但**这 27 个提交里有没有间接影响（比如 config 默认值、`agentRuntimeConfig` 字段改名）没查**。

8. **DSH 插件里两套「材料库」并存的冲突，没有权威文档。** `openmaic_materials`（主题文件，`.../lib/index.js:1741-1827`）与 `openmaic_material_ops` / `openmaic_material_folders`（上传材料，:2748+、:2810+）是两套东西。**有没有一份文档说清它们的边界，我没找到。** 只在代码注释里看到间接区分。

9. **我方注入上限的边界情况没验证。** proof-logic-analysis.md 实测 20187 字符，`MAX_CHARS = 24_000`（prompt-context-file.ts:31）。**没超，但离上限只有 3813 字符。** 一旦超过，`resolveMaterialsIndex()` 返回的 INDEX 会被截断加 `…（已截断）` —— INDEX 现在 867 字符，还有很大余量；**但主题文件被 `listMaterialText()` 读进 URL 闸时也会走同一个 `readPromptContextFile`**，那份 20187 字符的文件已经在截断边缘。超了会发生什么（URL 少喂几条）**没测**。

10. **`use_material_media` / `import_pptx` 只看了提示词里的引用**（material-prompt.ts:26、:30），**没读实现**。所以「官方有图像/PPT 能力」这句话我只能说到「提示词里承诺了」，不能说到「代码里实现了」。

11. **`check_layers.py` 对中文文件名 .md 的行为只读了正则，没构造样例。** 正则 `re.compile(r"`([^\s`]*?\.md)`")` 理论上支持中文路径，且工具自带的自检（卡 159）声称覆盖了「中文文件名断链必须被抓」。**我没有独立复现这条自检。**

12. **读代码时的 HEAD 与最终复核时的 HEAD 不是同一个提交。** 读的是 `918b4f0d`，复核时是 `4fa27693`（`docs(结论库): §1.27 presentationMeta 裸 spec 就能挂…`）。已实测 `git diff --numstat 918b4f0d HEAD -- <5 个材料相关文件>` 为空，但**没有逐条看这两个提交之间其它文件有没有间接影响**。

13. **我方 `check_layers.py` 基线绿是「这一次」的读数。** 报告写完后的复审见 §9；基线与复审之间，其它文件有没有被别的进程改动，我不知道。

---

## 9. 报告自身的验收

| 项 | 读数 |
| --- | --- |
| 路径 | D:/文档/jelly_ware/program/engineering/docs/research/材料库机制对比-官方vs我方.md |
| 字节 | 约 51.7 KB（约 51700 字节；精确值写进来会改变自身大小，故取约数） |
| 行数 | 563（按换行符计数） |
| CR 字节数 | 0（LF） |
| 控制字符（除换行与制表） | 无 |
| 结尾换行 | 有 |
| 仓内 .md 路径被放进反引号的 | 0 处 |
| check_layers 结论 | `[info] 引用完整性：这次实际检查了 1564 条引用（断链 0 处）` + `LAYER CHECKS: PASS` |
| 本报告引入的断链 | 0 处（写报告前基线 PASS、断链 0；中途自己引入过 3 处，已全部修掉） |

中途曾红过 3 处断链，全是示意名被 check_layers.py 当成仓内真实路径：

1. 一个反引号包住的 topic 文件名示意（含花括号占位符）；
2. 一个反引号包住的裸扩展名；
3. 一个反引号包住的三段式子目录示意路径。

三处都已移出反引号或改写为自然语言。
