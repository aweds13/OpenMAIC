# traceability.md — 规格 → 实现追踪（implementation 层）

> 这张表把 `specification/domains/**` 的每条 SR 挂到**具体模块**（文件 + 行）。
> 它是 `N → SR`（`../specification/traceability.md`）之后的第二跳，两跳合起来才闭合。
> 一条 SR 可以挂多个模块；一个模块可以承载多条 SR。**没有模块的 SR 说明没实现**，检查器会红。

## 模块索引

| 模块 | 文件 | 职责 |
|---|---|---|
| M1 内容生成 | `lib/server/agent-runtime/runner.ts`、`skills/agent-runtime/**` | 提示词、工具装配、生成轮次 |
| M2 版面与密度 | `lib/quiz/layout-check.ts`、`lib/server/agent-runtime/scene-diagnostics.ts` | 版面检查、密度核算、差集 |
| M3 写入闸 | `lib/server/agent-runtime/dsl-tools.ts`、`lib/server/agent-runtime/plan-freeze.ts` | `patch_stage` 四道闸、原子写、写后自证 |
| M4 存储 | `packages/@openmaic/storage/src/document/pg.ts` | `document_stages` / `document_scenes` 表与 CAS |
| M5 阅读页 | `components/**`（阅读/播放）、`lib/playback/engine.ts` | 翻页、节奏、假控件 |
| M6 自检页 | `lib/quiz/page-text.ts`、`lib/quiz/**` | 题量、文本抽取 |
| M7 导出 | `lib/export/**`、`app/api/**` | 批量归档 |
| M8 课程库检索 | `lib/chat/pi/tools/course-search.ts`、`lib/chat/pi/tools/read-document.ts`、`lib/server/agent-runtime/course-search.ts` | `course_search` / `read_document` |
| M9 浏览器抓取 | `lib/chat/pi/tools/browse-url.ts`、`lib/server/agent-runtime/browse-url.ts`、`lib/web-search/**` | `browse_url`、`web_search`、SSRF |
| M10 上下文与压缩 | `lib/server/agent-runtime/runner.ts`、`lib/server/agent-runtime/compaction.ts` | 系统提示词、材料注入、压缩预算 |
| M11 工具注册 | `lib/server/agent-runtime/runner-contract.ts`、`app/api/chat/pi/route.ts`、`lib/chat/pi/tools/call-agent.ts` | 三处注册点、允许表 |
| M12 MCP | `lib/server/agent-runtime/mcp-client.ts`、`lib/server/agent-runtime/mcp-tools.ts` | 外部 MCP 连接与工具 |
| M13 DSH 宿主 | `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/index.js`（宿主半）、`lib/client.src.js`（浏览器半）、`lib/db.mjs`（只读取数）、`lib/db-write.mjs`（CAS 写入） | 七工具 + seam 路由 + 三栏面板 |

## SR → 模块

**F1 内容密度与页面形态**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F1.1 | M1、M2 | `skills/agent-runtime/slide-craft/`、`lib/quiz/layout-check.ts`（溢出检查） |
| SR-F1.2 | M1 | `skills/agent-runtime/slide-dsl/`、`lib/server/agent-runtime/dsl-tools.ts`（DSL 工具集） |
| SR-F1.3 | M1、M2 | 密度目标写在技能提示词；核算在 `lib/quiz/layout-check.ts` |
| SR-F1.4 | M2、M3 | `dsl-tools.ts` 的 `textFitRefusal`（`estimateTextHeightPx` 超限拒写） |
| SR-F1.5 | M2、M3 | `maxFontSizePx` / `fontSize` 下限；`textFitRefusal` 明确拒绝压字号 |

**F2 阅读节奏与翻页**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F2.1 | M5 | `lib/playback/engine.ts`（无自动前进） |
| SR-F2.2 | M5 | `MIN_READING_MS`（阅读页不强制停留） |
| SR-F2.3 | M5 | 阅读页外壳（隐藏播放器控件） |
| SR-F2.4 | M5 | 滚轮/点击/方向键三条输入 |
| SR-F2.5 | M5 | 翻页去抖常量 |
| SR-F2.6 | M5 | 滚轮翻页开关 |

**F3 自检页**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F3.1 | M6、M1 | 题量参数透传链 |
| SR-F3.2 | M6 | 题量不足报错 |
| SR-F3.3 | M6 | `lib/quiz/page-text.ts` 的 `learnerVisibleText(page)` |

**F4 批量导出**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F4.1 | M7 | 批量归档入口 |
| SR-F4.2 | M7 | 资源打包 |
| SR-F4.3 | M7 | 逐课结果汇总 |

**F5 本地课程库检索**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F5.1 | M8 | `course-search.ts` 的 `LAYERS`（L0–L4 + auto） |
| SR-F5.2 | M8 | 结构化命中（层级、docId、chunkIndex） |
| SR-F5.3 | M8 | 「不得编造」文案 + 空命中明说 |
| SR-F5.4 | M8 | `read-document.ts` 的 `DOC_MODES`（`peek` / `full`） |
| SR-F5.5 | M8 | `nextOffset` 续读指针 |

**F6 真浏览器抓取**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F6.1 | M9 | `browse_url` 的 `waitMs`（等 JS 渲染） |
| SR-F6.2 | M9 | 返回体带最终 URL / 状态 / 耗时 |
| SR-F6.3 | M9 | 反爬判定作用域（只对正文抽取） |
| SR-F6.4 | M9 | 预览与持久化分离 |
| SR-F6.5 | M9 | `maxChars` 上限 + 截断明说 |

**F7 会话上下文与材料**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F7.1 | M10 | 材料/画像按会话读取，不缓存进程级 |
| SR-F7.2 | M10 | `runner.ts` 材料工具化（`listSessionScopeMaterials`） |
| SR-F7.3 | M10 | 系统消息构造（逐字节稳定） |
| SR-F7.4 | M10 | `compaction.ts`（原生压缩） |
| SR-F7.5 | M10 | 压缩预算常量与环境变量 |

**F8 工具注册与提示词口径**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F8.1 | M12 | `mcp-client.ts` 失败只记录、`mcp-tools.ts` 不注册 |
| SR-F8.2 | M11 | `resolveCourseSearchCapability()` / `resolveBrowseCapability()` 返回 null 不注册 |
| SR-F8.3 | M11 | `runner.ts` 的 `allowedToolNames: new Set(tools.map(t => t.name))` |
| SR-F8.4 | M11 | `runner.ts` / `route.ts` / `call-agent.ts` 三处同一口径 |

**F9 写入闸与版面差集**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F9.1 | M3 | `dsl-tools.ts` 四道闸（plan / overload / holes / review） |
| SR-F9.2 | M3 | 逐条 `applyPatchOp` → 一次 `putSceneBringingCurrent` |
| SR-F9.3 | M3 | `validateSlideCanvas` + `sceneWriteDiagnosticsWithReview` |
| SR-F9.4 | M4 | `document_scenes` 表；`GET /api/whoami` 复读 |
| SR-F9.5 | M3、M2 | `scene-diagnostics` 六段摘要 |
| SR-F9.6 | M4、M13 | `pg.ts` 的 CAS；`db-write.mjs` 的 `where data = $old` |
| SR-F9.7 | M13 | `openmaic_patch_stage` 的 `dryRun` 默认 true + 差集 |

**F10 DSH 宿主与当前页**

| SR | 模块 | 落点 |
|---|---|---|
| SR-F10.1 | M13 | `openmaic_courses` / `openmaic_scenes` / `openmaic_page` |
| SR-F10.2 | M13 | `client.src.js` 的 `SlideCanvas({slide: content.canvas})` |
| SR-F10.3 | M13 | 面板在 DSH 内渲染，无外部浏览器依赖 |
| SR-F10.4 | M13 | `db.mjs` 只读同一个 PostgreSQL |
| SR-F10.5 | M13 | `POST /dsh-openmaic/active` + `openmaic_active` |
| SR-F10.6 | M13 | `ACTIVE = null` 初值；返回 `{active: null}` |
| SR-F10.7 | M13 | `db-write.mjs` 写回同一张表 |

**横切（NF）**

| SR | 模块 | 落点 |
|---|---|---|
| SR-NF1 | 全局 | `AGENTS.md` §3 证据命令；`复盘/` 全部读数 |
| SR-NF2 | M6、M8、M9、M10 | 各工具的 `not_configured` / 明确报错分支 |
| SR-NF3 | M10 | 系统消息稳定 + 材料工具化 |
| SR-NF4 | M11、M8、M9 | 各工具 `parameters` schema 与范围 |
| SR-NF5 | M9、M10 | 提示词里的「不可信内容」声明 |
| SR-NF6 | M8、M9、M13 | 结构化失败四类 |
| SR-NF7 | 全局 | 本目录与 `复盘/` 的维护约定 |
| SR-NF8 | 全局 | 测试里的路径比较方式、`scripts/` 的跨平台写法 |
