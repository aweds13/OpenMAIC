# DSH 宿主层：插件不在本仓，改完必须两步

> **这份文件回答什么**：产品跑在 DSH 宿主里时，插件（**不在本仓**）由哪两半组成、改完各要做什么、
> 哪些判据**必须留在仓里**而不是在插件里重抄，以及已经收口的缺陷长什么样。
> **谁该读**：要动 DSH 插件、要把某个仓内能力「接进 DSH」、或排查「插件改了没生效」的人。
> **★ 路径口径**：本文的 `index.js`、`client.src.js`、`client.js`、`build.mjs`、`db.mjs`、`db-write.mjs`、
> `lib/diag.mts`、`smoke-*.mjs` **全在本仓之外**，实文件在
> `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/` 下；两包分别是
> `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/` 与
> `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-local-capabilities/`。
> **`→ §1.x` 指哪儿**：都指 `复盘/已结案结论.md` 的同号小节（完整的排查经过在那里）。
> **规格判据**在 `docs/specification/domains/F10-dsh-host.md` 与 `docs/contracts/domains/F10-dsh-host.md`。
>
> 原文是 `AGENTS.md` §12（2026-10-31 搬出）：除把 `§1.x` 指针补成带文件名的写法、以及把
> 材料库那条通配符的反引号收到星号之前外，一字未改。

目标是**换宿主**（DSH 里看课件、随口问、顺手改，不开 Edge、不维护两套）⇒ 插件即产品。
插件在 `D:/文档/jelly_ware/_tools/dsh-plugins/`，两包 **31 个工具**（`openmaic-course` **26** +
`openmaic-local-capabilities` 5），每包分**宿主半**/**浏览器半**：

- 宿主半 `index.js` ⇒ 改完**重启 DSH**；浏览器半 `client.src.js` ⇒ `node build.mjs` → 再重启（`client.js` 13.9 MB 是产物）
- **★ 两坑**：① 部署副本是**实体拷贝** ⇒ cp 再重启（`diff -rq lib <部署目录>` 空）；② 只改浏览器半才重建
- 判据：四条冒烟末行 `… PASS ✅`（render/quiz/wheel/thumb；**别用** smoke-client.mjs）
- 已收口缺陷：① `/page` 回页本体、**没有 `data` 层** ② 差集剥几何要同时剥文字 ③ `SlideCanvas` 是唯一渲染器
- 侧栏图标是 `register(spec, 图标函数)` 的**第二参数**，取 `lib/brand/brand-config.ts` 的 `productName`/`markSrc` → `复盘/已结案结论.md` §1.14

- ★ **桥脚本必须跑在路径不含 `node_modules` 的地方**：tsx 不对 `node_modules` 下的文件应用 tsconfig `paths`（junction 也不行，它看路径串不看 realpath）⇒ `DIAG_SCRIPT` **源码优先**（源仓 `lib/diag.mts` 存在就用它，否则退回本地副本）；改坏时部署副本里**所有走 `runDiag` 的工具**全报 `Cannot find package '@/lib'`，而纯 `readDb` 快路正常 → `复盘/已结案结论.md` §1.25
**诊断/冻结/纸/材料/练习 10 个工具**都走 `lib/diag.mts` 桥（index.js 取数走 stdin，桥不碰库）：tsx 点名 `node_modules/tsx/dist/cli.mjs`、别名须 `import * as m` 再 `m.default ?? m`；**都不复刻**、直调仓内 builder → `复盘/已结案结论.md` §1.16/§1.17
- 纸与材料落文件系统：草稿纸 `data/scratchpad/<owner>.json`（`sNNN` **永不复用**）；材料库 `个人数据/材料清单/`*.md（目录读 `.env.local`，**没配不回默认值**）★ 写走沙盒且**先把真文件复制进去**（否则丢原内容）
- 练习落 `课程与学习/练习/<stage>/`（桥纯算、宿主判越界与不覆盖）★ 沙盒 env 必须设**在 import 之前**（常量加载期求值）→ `复盘/已结案结论.md` §1.18
**编排四件**（`stage_admin` 六动作 / `whoami` / `read_document` / `quiz_fold`）：stage_admin 的 list·outline 走桥（
`mergeStageOutline` 判据只一份）、四条写走 `db-write.mjs`（**index.js 里不拼 SQL**）→ `复盘/已结案结论.md` §1.20
- ★ **归属只在 `stage_meta`**（`document_stages.owner_id` 恒 null）；库里 9 行、本机 owner 看得见 **7 门**
- ★ **`generation_complete` 两处独立**：`stage_meta` 全 false、计划信封全 true ⇒ 桥按**信封**判（同 `curriculum-tools.ts`）
- ★ quiz 记录必须按 `data->'payload' ? 'phase'` 过滤（只判 payload 非空会混进 pbl 事件）
**审查两件**（`review_course` / `page_review`）**唯一真调模型**：模型只在宿主 ⇒ 桥走**行协议 RPC**（`spawn` 保持 stdin、桥写一行 `{"__rpc":"llm",…}`、宿主调 `ctx.llm.stream` 回一行），判据不重抄 → `复盘/已结案结论.md` §1.21。★ `inject` 加 `llm`+`agentDefaultModel`，**不复用** OpenMAIC 授权链；桥写完须 `stdin.destroy()` + `write` 回调里 `process.exit(0)`（否则宿主 `close` 不触发）；`page_review` 的 `null`/抛错都只是「没验成」⇒ `notVerified`，**绝不让写入失败**
**导出两件**（`export_course` / `export_batch`）走**同一条**桥命令（单课 = 只传一门课的批量）：打包在桥做（教室 ZIP 要注入真 `store` + 内存 KV，interactive 内联要 jsdom），宿主只决定落哪。★ 桥的 `paths` 必须**扫 `exports` 表把 33 条 `@openmaic/*` 子路径全映射**（只映射两条会逐个炸）→ `复盘/已结案结论.md` §1.22
**面板件**（quiz / 滚轮 / 缩略图 / 画布编辑）判据全从仓里引（esbuild `alias` 打进 bundle），**一条不重抄**；quiz **只本地判分不写库**（记录归浏览器端 `lib/quiz/runtime.ts`，再写一份两边分叉）；缩略图走 `/thumbs`（只带 slide canvas）→ `复盘/已结案结论.md` §1.23、画布编辑走 `POST /patch`（缺省 `dryRun`）→ `复盘/已结案结论.md` §1.24
**面板四件（F88 标签页 / F77 批量下载 / F84 折叠 / F89 请求活动，2026-11-01 落地）**：
- F88 课程标签页只搬**行为契约**（`role=tablist` + `aria-selected` + ←/→ Home/End Delete + 关闭按钮
  `tabIndex:-1` 且 `stopPropagation` + 关掉当前页签接管给邻页签、都没有就留空）；仓里那 259 行用的
  是 `.ws-ctab` 样式表 + 滚动淡出贴图，面板里没有那张表，搬过来等于搬一半进去。
- F77 批量下载：宿主 `POST /export-batch` → 桥 `mode:"batch"`（`buildBatchExportZip` 同一条路，判据一条不重抄）；
  **必须用 `runDiagAsync`（spawn + Promise）** —— 原来的 `runDiag` 是 `spawnSync`，批量导十门课几分钟会把
  DSH 事件循环按住。回执里**不含 blob**：ZIP 落磁盘、回路径；面板再造一条下载链会把「落在哪」变成两个答案。
- F84 折叠：左栏/中栏可折（折叠后 16px 竖条，点它展开），**主区永远不折** —— 与仓里
  `resolveWorkspaceRender` 的「最后一个可见 pane 不能折叠」同一条理由。
- F89 请求活动：宿主 `ACTIVITY` 环形缓冲（最近 40 条）+ `GET /activity`，挂 `res` 的 `finish` **与** `close`
  （正常结束走 finish、连接早断走 close）；`/activity` 自己不入账（面板每开一次就来读，记了会把要看的冲掉）。
- ★ **视图互斥只写一遍**：材料/活动/下载三个视图收敛成一个 `setView(next)`。第一版让每个按钮各自去关
  另外两个，实测漏了材料那处（点材料时活动面板不关）—— 三处逻辑必须永远一致，改一处就漏一处。
- ★ **面板级断言必须限定在那一块区域里**：F85 折叠判据用全局 `textContent`，命中了课程标签条里的课名；
  F87「没有写按钮」扫了全部 `<button>`，命中工具栏的画布编辑按钮（F18）。同一个词会同时出现在导航、
  工具栏、内容区三处，全局匹配会把「另一处的正确行为」当成「这一处的错误」。

**写入面**：`document_scenes` **没有版本列** ⇒ 并发保护靠 jsonb 值本身（CAS `where stage_id=$2 and id=$3 and data=$4::jsonb`）；★ CAS 基准必须取**整份 data**（`db.mjs raw`），用 `page`（只有精选字段）当基准会稳定报「被别人改过了」。`dryRun:true` 默认只算差集 = **设计不是不方便**。`openmaic_active` 是**进程内状态**，重启就空 —— **空 ≠ 坏**。
