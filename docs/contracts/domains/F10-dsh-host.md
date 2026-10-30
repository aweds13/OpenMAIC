# F10 DSH 宿主与当前页 —— 契约

## 这条契约管什么

管「课件住进 DSH 之后」这件事的验收：面板里能不能走完选课 → 选页 → 看到这一页的真样子、是不是真用上游 `SlideCanvas` 画的、有没有偷偷拉起外部浏览器、两边是不是读同一个库、「当前页」是不是点了就立刻读得到、没有的时候会不会老实说没有、在 DSH 里改完旧 UI 能不能看见。

不管写入闸怎么判（那是 F9），也不管检索与抓取工具本身（F5 / F6）。这里只验**换宿主带来的新增约束**。

> 路径口径：`lib/index.js`、`lib/client.src.js`、`lib/client.js`、`lib/db.mjs`、`lib/db-write.mjs`、`build.mjs`、`smoke*.mjs`、`_probe/` 都指 DSH 插件 `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/` 下的那一份（不在本仓 git 里，`.gitignore:11:/_tools/` 忽略整个 `_tools/`）；`app/...`、`tests/...`、`packages/...` 相对 OpenMAIC 仓根。

## 逐条验收

### SR-F10.1 课程列表、页列表、单页渲染必须在 DSH 内完成，不依赖旧 Web UI

- **输入**：在 DSH 面板里打开课件座位（`main` 与 `sidebar.panellist` 两个座位各注入一次），不预先选任何课。

- **期望**：首屏自己走完三跳 `/courses` → `/scenes?stage=` → `/page?stage=&scene=`，左栏出现课程名、中栏出现页标题、右栏出现这一页的实际渲染；全程只打插件自己的缝 `/dsh-openmaic/*`，不请求 `127.0.0.1:3000` 上的旧 Web UI。

- **失败长什么样**：面板空着等用户去浏览器里选；或者列表出来了、点页时跳去旧 UI 的 `/classroom/<id>`；或者三跳里少一跳 —— 课表有了但页列表一直「读课表…」。也会以另一种形式出现：`/courses` 通了但 `/page` 返回的形状与浏览器半预期的不一致，于是右栏永远停在「取文本…」（这一种正是 SR-F10.2 记录过的真实事故）。

- **判据落点**：**仓库内 vitest 无判据** —— `grep -rln "dsh-openmaic\|openmaic-course\|openmaic_active" tests/` 零命中，插件不在 vitest 覆盖内。判据在插件目录的冒烟脚本里，两条命令：`node D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/smoke-render.mjs`（jsdom + 真跑 `useEffect`，不是 `renderToString`；末行必须是 `SMOKE: PASS`，退出码 0）与 `node D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/smoke.mjs`（假 ctx 挂宿主半，验 `apply` 不抛、七个工具进 `ctx.tools`、路由登记成 `prefix /dsh-openmaic`、真调一次 `openmaic_courses` → `openmaic_scenes` → `openmaic_page`）。`smoke-render.mjs` 的首屏三条 check 就是这一条：`课表读到了（左栏有课程名）` / `页列表读到了` / `slide 页不卡在「取文本…」`。活体核对另有一条命令：`curl http://127.0.0.1:<DSH 端口>/dsh-openmaic/courses`，实测回 `{"ok":true,"courses":[{"id":"stage-…","name":"…","folder":"…","scenes":28},…]}`。

- **两边各自要满足**：
  - 宿主侧（`lib/index.js`）：`export const inject = ["tools", "webServer"]`；`apply` 里**先挂路由、再注册工具**（工具注册炸了不许把路由带走）；缝固定是 `const SEAM = "/dsh-openmaic"`，路由必须 `kind: "prefix"`。
  - 浏览器半（`lib/client.src.js`）：`export const inject = ["slots", "locale"]`；mount 时自己发 `/courses` 并自动开第一课第一页，不许等用户先点。
  - 部署侧：`lib/client.js` 必须由 `build.mjs` 从 `client.src.js` 打出来（IIFE + `window.__ModuleLoader__.load({id, factory})`，`id` 逐字等于 `dsh-openmaic-course`），手改构建产物不算数；profile 的 `dsh.profile.bundles` 里要有这个 id。

### SR-F10.2 课件渲染必须用上游 `SlideCanvas` 原生渲染，不得自绘近似版

- **输入**：一页 `type: "slide"` 且 `content.canvas` 存在的页，在面板里被选中。

- **期望**：走 `SlideCanvas`。浏览器半 `lib/client.src.js:6` `import { SlideCanvas } from '@openmaic/renderer';`，`:134-135` 判 `data.type === 'slide' && content.canvas` 之后 `return h('div', { style: S.canvasBox }, h(SlideCanvas, { slide: content.canvas, canvasPercentage: 6 }))` —— 只传这两个 props，画布尺寸、内边距、字号换算、主题变量全交给渲染器。渲染结果里应当出现 `<svg`（渲染器自己的画布），以及**只在 canvas 元素里、不在侧栏标题里**的那段正文。

- **失败长什么样**：用 `left/top/width/height` 自己摆绝对定位的 div；或者只渲染标题、把正文吞掉；或者把页面截成图片。**这一条真的违反过一次，形态值得记住**：`client.src.js:130` 曾写成 `const data = page.data || {};`，而宿主 `/page` 返回的形状是 `{id, stageId, type, title, order, content, actions}`，**没有 `data` 这一层** —— 于是 `data` 恒为 `{}`、`data.type` 恒 `undefined`、slide 分支恒不成立，页面永远停在「取文本…」。当时的旧冒烟脚本只 `renderToString` 首屏（此时 `courses === null`），压根走不到那个分支，所以它绿着而 bug 还在。**当前状态：已修**（`:132` 改成 `const data = page;`，`:130-131` 留了说明注释），并用 jsdom 冒烟双向钉住（修好版 6 项全绿；故意回退成 `page.data` 的版本 3 项红）。注意 `docs/specification/domains/F10-dsh-host.md` 里那段「**当前状态**：这条规格目前不成立」是修复前的记录，已过时 —— 以本节为准。

- **判据落点**：`node D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/smoke-render.mjs`（**主判据**，jsdom + 真跑 effect；夹具是 `_probe/page-fixtures.json`，`slide.page` 是真实 `/page` 形状、没有 `data` 层）。三条 check 逐条对应上面三件事：`slide 页不卡在「取文本…」` / `canvas 专属正文出现在 DOM 里（"陶哲轩"）`（marker 必须只在 canvas 元素里，否则左栏标题也会命中、变成假阳性 —— 第一版踩过）/ `输出里有 <svg（SlideCanvas 的画布），实测 N 个`（`N > 0`，没有 svg 就说明走的是文本分支）。另有一条防御性 check `不出现「类型 undefined」`。仓库内 vitest 无判据。人工核对第二条命令：`grep -c "page.data" D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/client.src.js` 与 `grep -o "page.data" D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/client.js | wc -l` —— 前者必须只剩注释文本那 1 处、后者必须是 0（构建产物里不许带这个形状）。

- **两边各自要满足**：
  - 浏览器半：只从 `@openmaic/renderer` 取 `SlideCanvas`，不许在插件里重写一份渲染；取数据的层级必须与宿主返回的形状逐字对齐（读 `page.type` / `page.content`，不读 `page.data`）。
  - 宿主侧：`/page` 的返回形状必须固定为 `{ ok: true, page: { id, stageId, type, title, order, content, actions }, at }`（`lib/db.mjs:99-117`）；要整份 `data` 的调用方去走 `raw` 分支（那里才有 `data`），不许让 `/page` 一会儿有一会儿没有。
  - 构建侧：`lib/client.src.js` 改了必须重跑 `build.mjs`；`lib/client.js` 是产物，不能手改。

### SR-F10.3 不得要求打开 Edge/外部浏览器来完成查看

- **输入**：在面板里看课件、点「预览」、切页的完整一轮。

- **期望**：一个外部浏览器进程都不起。宿主半只有两处 `spawnSync`，且都用 `process.execPath` 跑 node 脚本（`:90` 跑 `db.mjs`、`:118` 跑 `db-write.mjs` / `db.mjs`），没有第三个可执行文件。README 的自我约束是逐字的「不开 Edge、不起 3000」。

- **失败长什么样**：点预览时 `start msedge`；或者用 puppeteer / playwright 起一个 headless 浏览器去截图再显示；或者悄悄把 `/classroom/<id>` 在新标签里打开。另一种更隐蔽的形态：把「看课件」建在本机抓取服务（8730 上的 Playwright）上 —— 于是同一个网络问题会同时打死看课件与抓网页两件事。

- **判据落点**：**暂无自动化判据（仓库内与插件内都没有断言）** —— 可跑的判据是两条 grep 命令：`grep -n "process.execPath" D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/index.js` 必须只有 `:90` 与 `:118` 两行；`grep -nEi "puppeteer|playwright|chrome|msedge|start msedge|child_process.*exec\(" D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/index.js D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/db.mjs D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/db-write.mjs` 必须零命中（实测就是这个读数）。人工核对方式：打开面板走一轮后看任务管理器，进程里不该多出 `msedge.exe` / `chrome.exe`。

- **两边各自要满足**：
  - 宿主侧：所有子进程只能是 `process.execPath`；不许 `require('node:child_process').exec` 一条 shell 命令去拉起浏览器。
  - 浏览器半：渲染必须在 DSH 的 iframe / 座位里完成，不许 `window.open` 到外部浏览器。
  - 能力侧：需要抓网页时走 F6 那条本机抓取服务，与「看课件」这条路完全分开。

### SR-F10.4 同一份数据只能有一个真源，DSH 与旧 UI 不得各存一份

- **输入**：同一台机器上，DSH 面板与旧 Web UI（Next，`app/classroom/[id]`）各读一次同一门课。

- **期望**：两边读的是同一个 PostgreSQL、同一批表（`document_stages` / `document_scenes` / `document_folders`）。插件的连接串解析是 `DATABASE_URL` 环境变量 → OpenMAIC 仓 `.env.local` 里的 `DATABASE_URL=` 行 → 兜底 `postgres://postgres:postgres@127.0.0.1:5433/postgres`（`lib/db.mjs:16-27`，`lib/db-write.mjs:21-30` 同款），也就是说它读的就是旧 UI 那一份配置。插件运行期**不落任何课程缓存**：唯一的文件写入是 `patchStage` 那一次把 `{base, next}` 写到 `os.tmpdir()` 的临时文件、写完立刻删（`lib/index.js:337-342`）；插件目录里没有 `courses.json` 之类的东西（只有 `_probe/page-fixtures.json`，那是冒烟夹具，不是运行期缓存）。

- **失败长什么样**：插件启动时把课程 dump 成 `courses.json` 再读它；或者在 DSH 侧另建一张表 / 另存一份 JSON；或者把课程内容塞进 DSH 的配置当作「缓存真源」。进程内允许缓存瞬时状态（「当前页」就是），但**不许缓存课程内容**。

- **判据落点**：**暂无自动化判据** —— 可跑的判据是命令：`grep -n "DATABASE_URL" D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/db.mjs D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/db-write.mjs`（两处都必须走 env → `.env.local` → 5433 兜底，不许写死别的库）；`find D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course -maxdepth 2 -name "*.json" -not -path "*/node_modules/*"` 只该看到 `package.json` 与 `_probe/page-fixtures.json`；`grep -nE "writeFileSync|appendFile|createWriteStream" D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/index.js` 只该有 `:338` 那一行（写临时 patch）。人工核对方式：分别用插件与旧 UI 读同一门课，比对课程名与页数（实测插件侧：9 课、`stage-BH39OH54cL` 28 页）。

- **两边各自要满足**：
  - 插件两侧：读库（`db.mjs`）与写库（`db-write.mjs`）必须各自独立地从同一份配置解析连接串，不许各写一份；两个脚本都必须以 OpenMAIC 仓为 `cwd` 起（那样 `pg` 从仓里的 `node_modules` 解析，插件目录不用装依赖）。
  - 旧 Web UI 侧：不许为了「让 DSH 也能读」而多写一份导出；它的 `/api/stages/[id]/scenes` 与 `/api/stages/[id]/manifest` 仍然是它自己的读路径。

### SR-F10.5 「当前页」必须在 UI 选中时立刻可被工具读到

- **输入**：在面板里点中一页（不管 slide 还是非 slide）。

- **期望**：这一次点击必须触发一次 `POST /dsh-openmaic/active`（`lib/client.src.js:98-102`，在 `setPage` 之后**无条件**发，body 是 `{ stageId, sceneId, title, type }`），宿主半把它记成进程内的 `ACTIVE`（`lib/index.js:476-498`），工具 `openmaic_active` 立刻读得到同一份值（`:573-580`），HTTP 缝 `GET /dsh-openmaic/active` 也读得到。读到的必须是**刚点中的那一页**：不滞后一次点击、不返回上一次会话的值。

- **失败长什么样**：把当前页写进磁盘、下次启动当有效值读回来；或者只有 slide 页才 `POST /active`（于是点非 slide 页时当前页停在上一页 —— 这个坑很自然，因为 `/text` 那条路只在非 slide 时走）；或者工具读的是自己的缓存副本、与缝里的值不是同一份。

- **判据落点**：`node D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/smoke.mjs` —— 该脚本先问一次 `openmaic_active`（此时还没人选题）、再 `POST /dsh-openmaic/active`、再问一次 `openmaic_active`，两次输出必须不同（后者带刚写的 `stageId` / `sceneId`）。活体命令：`curl -X POST -H "content-type: application/json" -d '{"stageId":"stage-X","sceneId":"scene-p1","title":"t","type":"slide"}' http://127.0.0.1:<DSH 端口>/dsh-openmaic/active` 之后 `curl http://127.0.0.1:<DSH 端口>/dsh-openmaic/active`，实测回 `{"ok":true,"active":{"stageId":"stage-X","sceneId":"scene-p1","title":"t","type":"slide","at":"2026-10-30T05:43:19.021Z"}}`。`smoke-render.mjs` 的第二段（点「你选 ε」那一行）间接覆盖「切页也会重新 `POST /active`」。仓库内 vitest 无判据。

- **两边各自要满足**：
  - 浏览器半：`POST /active` 必须在 `openScene` 里无条件发（不能挂在「非 slide」分支里）；失败可以只记日志，但**不许**因此阻塞页面渲染。
  - 宿主侧：`ACTIVE` 是模块级进程内变量（`let ACTIVE = null;`），只有 POST 会改它；GET 与工具都读同一个变量，不许各存一份。
  - 顺序：`POST /active` 必须在 `GET /page` 成功之后发 —— 没拿到那一页就不该声称「当前页是它」。

### SR-F10.6 「当前页」缺失时必须明说没有，不得猜测或沿用上次

- **输入**：DSH 刚启动（或刚重启）后，用户还没点过任何一页，此时调用 `openmaic_active`，或 `GET /dsh-openmaic/active`。

- **期望**：老实说没有，并给原因。工具侧逐字是 `{ ok: false, error: "还没有用户在面板里选过页（或 DSH 刚重启过）", active: null }`（`lib/index.js:580`）；HTTP 缝侧是 `{ ok: true, active: null, lastError: "<上一次失败的原文，没失败过就是空串>" }`（`:473-475`）。两处形状不同是**故意的**：缝的 `ok` 表示「这次查询本身成功了」，`active: null` 表示「没有当前页」；工具的 `ok: false` 表示「这个能力这次给不出答案」。两种都要能被调用方区分开。绝不回退到「第一课第一页」、绝不回退到库里的最近一条记录、绝不返回空对象让调用方自己判断。

- **失败长什么样**：返回 `{ ok: true, active: { stageId: 'stage-1', sceneId: 'scene-p1' } }`（默认首屏被当成了用户的选择）；或者回一个空对象 `{}` / `{ active: {} }`；或者 DSH 重启后从磁盘恢复上一次的「当前页」—— 那时候人和页面早就不是那个上下文了，模型会对着陌生内容开始解释，而用户以为自己问的是刚才那页。

- **判据落点**：`node D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/smoke.mjs` —— 该脚本第一段就是在「还没人选题」的状态下问 `openmaic_active`，输出里必须出现上面那句 `还没有用户在面板里选过页（或 DSH 刚重启过）` 与 `"active":null`。活体命令：重启 DSH 后 `curl http://127.0.0.1:<DSH 端口>/dsh-openmaic/active`，实测回 `{"ok":true,"active":null,...}`（`lastError` 可能非空 —— 那是**上一次别处失败的残留**，不影响 `active` 的判定）。仓库内 vitest 无判据。人工核对方式：另外确认插件目录里没有任何持久化「当前页」的文件（见 SR-F10.4 的 `find` 命令），因为落盘是这一条最容易被违反的方式。

- **两边各自要满足**：
  - 宿主侧：`ACTIVE` 初值必须是 `null`（不是 `{}`、不是默认首屏）；重启后不许从任何地方恢复它。
  - 浏览器半：不要在 mount 时「顺手」把第一课第一页当成用户的选择去 `POST /active` —— 自动打开第一页是为了让人有东西看，但那是 UI 行为，`POST /active` 只该由**点击**触发（当前 `lib/client.src.js` 的 `openStage(list[0], true)` 与 `openScene(row, list[0])` 走的也是同一条 `openScene`，所以首屏会写一次 `ACTIVE`；这条口径与「没有选中页」的边界要在改动时想清楚，别把自动打开当成用户意图）。
  - 调用方（模型）：读到 `ok: false` 时必须去问用户「你现在在翻哪一页」，不许自己挑一页顶上。

### SR-F10.7 在 DSH 内做的修改必须落回同一个数据库，且可被旧 UI 看到

- **输入**：在 DSH 里用 `openmaic_patch_stage` 带 `dryRun: false` 改一页；随后打开旧 Web UI 的 `/classroom/<stageId>` 刷新。

- **期望**：改动落在 `document_scenes` 的 `data` 字段上（与旧 UI 同一张表、同一批字段名），走的是与旧 UI 同一套闸（F9 那四道 + CAS）。刷新旧 UI 必须看到这次改动。旧 UI 侧的可见性机制是现成的：`document_scenes` / `document_stages` 上的触发器会 bump 版本号并 `pg_notify`，`app/api/stages/[id]/freshness/route.ts` 的 SSE 在 rev 动时发一帧、不动时静默。

- **失败长什么样**：DSH 侧写自己的表，或写同一张表但换一套字段名；或者写进了库但旧 UI 因为缓存/版本号没动而看不见；或者写完两边显示不一致，于是有人开始「再加一次同步」—— 同步逻辑本身就成了新的 bug 源。

- **判据落点**：**暂无自动化判据（coverage.md 把这一条记为「无」，理由是端到端未验过）**。目前能钉住的只有机制的两半，不是端到端：一半是 `tests/agent-runtime/stage-freshness-route.test.ts`（5 例）—— `opens the stream with the retry hint and the current rev` / `emits a frame when the stage rev moves` / `stays silent while the rev is unchanged (heartbeats aside)` / `answers 404 for a missing or foreign stage and still rides the owner cookie` / `answers 404 when server persistence is not configured`，命令 `npx vitest run tests/agent-runtime/stage-freshness-route.test.ts`；另一半是 `tests/agent-runtime/document-writes.test.ts`（5 例）证明写入走的是 owner-bound document store、`not-current` 时会回退聚合保存，命令 `npx vitest run tests/agent-runtime/document-writes.test.ts`。人工核对方式（这就是这条契约真正的验收）：在 DSH 里改一页 → `psql -p 5433 -c "select data->>'title' from document_scenes where stage_id='…' and id='…'"` 确认字段真的变了 → 浏览器刷新旧 UI 的 `/classroom/<stageId>` → 眼睛确认那一页就是改后的样子。这一步没跑过，就不算验过。

- **两边各自要满足**：
  - 插件侧：写库只能走 `lib/db-write.mjs`（唯一会改库的入口），SQL 必须是 `update document_scenes set data = $1::jsonb where stage_id = $2 and id = $3 and data = $4::jsonb`；不许另开一条写路径，不许写别的表。
  - 宿主侧：`putSceneBringingCurrent` 必须在 `not-current` 时才回退聚合保存，其它错误原样抛（详见 F9 的 SR-F9.6）。
  - 旧 UI 侧：`/api/stages/[id]/manifest` + `/api/stages/[id]/scenes` 是它的读路径，`freshness` 是它的刷新信号 —— 它的可见性不依赖 DSH 做任何额外动作，只依赖库里的 rev 真的动了。
