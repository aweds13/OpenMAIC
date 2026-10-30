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

## 四、改动前必须确认的三件事

1. **这属于哪一层**（上面第一节）。改错层是最贵的错误 —— 上游层改动在下一次合并时全部重放。
2. **有没有契约**（`docs/contracts/interactions.md` 的 OP-x / `flows.md` 的 FLOW-x 覆盖到）。没有契约的操作，先补契约再动手。
3. **判据在哪**（`docs/implementation/coverage.md` 里这一条是「有」还是「松/人工/无」）。标「无」的说明今天没有护栏，改完要自己造证据。

---

## 五、改完之后（固定四步）

1. `node node_modules/prettier/bin/prettier.cjs --write <改动文件>` —— 仓里 `core.autocrlf=false`，别让 CRLF 混进去。★ 只对代码有效：`.prettierignore` 有 `*.md`，文档它一个都不看。
2. `npx tsc --noEmit` —— 必须 0 error。`packages/@openmaic/renderer` 的 `dist/*.d.ts` 若缺失会退化成全 `any`，修法见 `AGENTS.md`。
3. `node scripts/check-i18n-keys.mjs` —— 动过文案才需要。
4. `python -X utf8 scripts/check-layers.py` —— 动过 `docs/` 才需要。

**不要**跑全量 `vitest run` 当作判据：本机单机有约 10 个 Windows 环境假红（见 `AGENTS.md`），CI 才是判据。
