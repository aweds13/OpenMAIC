# F9 写入闸与版面差集 —— 契约

## 这条契约管什么

管「一次写入能不能落盘、落盘之后我们能证明什么」这条路的验收：写前过四道闸且被拦时给出解法、一批 op 原子生效、写后独立校验、状态能从库里读回来、自检结论指向可复查的位置、写入是 CAS、默认只算差集不落盘。

不管版面检查的算法细节（那是 `lib/quiz/layout-check.ts` 的事），也不管闸的阈值怎么标定。只关心**拦没拦、拦下说什么、写没写、写完能拿出什么证据**。

> 路径口径：`lib/...`、`packages/...`、`tests/...` 都是相对 OpenMAIC 仓根；凡是写成 `lib/db-write.mjs`、`lib/index.js`、`lib/db.mjs` 的，指的是 DSH 插件 `D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course/lib/` 下那一份（不在本仓 git 里）。

## 逐条验收

### SR-F9.1 写入前必须过闸；被闸拦下时必须给出「怎么解」而不是只报错

- **输入**：`patch_stage({ stageId, target, intent, ops })`，在四种会触发闸的状态下各调一次 —— (a) 计划门槛开着而这一页不在已冻结的计划里；(b) 目标页被判超载（一次引入的新块数超过 `NOVEL_P90 = 60` 这个实测 90 分位）；(c) 这门课里有空页或页码引用指向空页；(d) 课有 8 页以上而这一次运行里还没审过。

- **期望**：四道闸按固定顺序过（计划闸 → 超载闸 → 空洞闸 → 审查闸），任何一道拦下都要**同时**给出三样东西：`blocked` 代号（`plan-not-frozen` / `page-overloaded` / `course-has-holes` / `course-not-reviewed`）、这件事的**读数**（第几页、引入多少个新块、90 分位是多少、哪些页是空的、课有多少页）、以及**下一步怎么做**（去看计划 / 用 `ask_user` 问学习者想怎么修再带 `overloadAcknowledged: true` 重试 / 先补空页且不许删页合并 / 先跑 `review_course` 或带 `reviewAcknowledged: true`）。闸只拒第一次，不是棘轮 —— 带上凭据就该放行。

- **失败长什么样**：只回一句「被拒绝」或一句 `blocked`，模型只能猜怎么解；或者拦下了但没说哪一页（一门课 20 页，模型只能从头翻）；或者拦下之后页面其实已经被改了（闸在写入之后才算）；或者闸变成了棘轮，带凭据也不放行。

- **判据落点**：`tests/agent-runtime/patch-stage-gates.test.ts`（21 例）—— 计划门槛 3 例（`门槛关着时不拦` / `★ 门槛开着 + 计划为空 ⇒ 拒；而且消息里报的是【patch_stage】，不是 generate_scene` / `★ 该放行时放行`）、超载闸 4 例（`夹具前提成立：那一页真的被判超载` / `★ 超载页 + 没有确认 ⇒ 拒，并把数字给出来` / `★ 带上确认 ⇒ 放行` / `★ 别把一切都拒掉：**不超载**的页不需要确认`）、空洞闸 3 例（`★ 课里有空页 ⇒ 拒绝，并把页码摆出来；页面一个字没动` / `★ 引用指向空页也算洞 ⇒ 拒绝` / `★ 带上凭据 ⇒ 放行（闸只拒第一次，不是棘轮）`）、审查闸 4 例（`★ 8 页的课 + 这次运行里没审过 ⇒ 拒绝，并说清两条出口` / `★ 同一运行里审过 ⇒ 放行（凭据真的被读了）` / `★ 课太小（< 8 页）不拦 —— 审查一次的成本比收益大` / `★ 明说不用审 ⇒ 放行`）、审查凭据落盘 2 例（`★ 盘上有凭据 ⇒ 放行（这次运行没审过也算）` / `★ 盘上**没有**凭据 ⇒ 照旧拒（别把闸放成空的）`）。命令：`npx vitest run tests/agent-runtime/patch-stage-gates.test.ts`。

- **两边各自要满足**：
  - 宿主侧（`lib/server/agent-runtime/dsl-tools.ts`）：四道闸必须在 `structuredClone` **之前**、`putSceneBringingCurrent` **之前**判完；`details` 里的结构化读数与正文消息里的数字必须同源（读同一个 audit 结果），不许一处算一遍。
  - 闸的判据提供方（`auditCourse` / `planGate` / `readReviewReceipt`）：读不到状态时不许默认放行 —— 读不到就是「没审过」「没冻结」，走拦。
  - 调用方（模型）：被拦时应当照消息里的解法做，而不是换个参数硬闯；`*Acknowledged` 三个布尔只能在学习者真的答复之后才置 true（`PATCH_COURSE_SCHEMA` 里每个字段的 description 都写死了这一点）。

### SR-F9.2 一次写入必须整批原子：要么全成，要么一个都不写

- **输入**：一个 3 条 op 的批次，第 2 条必然失败（例如 `{ op: 'remove', path: '/content/canvas/nope' }`）。

- **期望**：整批不落盘 —— `putScene` 一次都没被调用，场景对象与调用前逐字节相同，返回 `isError: true` 且 `details.failedOp: 2`。所有 op 都作用在一个 `structuredClone` 出来的副本上（`lib/server/agent-runtime/dsl-tools.ts:1365`），只有整批成功之后才写一次库（`:1444-1447`）。

- **失败长什么样**：前两条 op 已经写进库、第三条失败，页面停在半成品状态；或者逐条 op 各写一次库（打三次请求、中途断了就留下中间态）；或者失败之后返回的 details 里没有 `failedOp`，模型不知道是哪一条坏的。

- **判据落点**：`tests/agent-runtime/dsl-tools.test.ts` —— `rolls back the entire batch when a middle op fails`（断言 `toMatchObject({ isError: true, details: { failedOp: 2 } })`、`expect(current.putScene).not.toHaveBeenCalled()`、`expect(JSON.stringify(current.get())).toBe(before)`）；同文件 `applies set/remove atomically and clears stale speech audio` 覆盖「整批成功时只写一次」。命令：`npx vitest run tests/agent-runtime/dsl-tools.test.ts`。

- **两边各自要满足**：
  - 宿主侧：一批 op 只能有一次 `putScene`；`structuredClone` 之后对副本逐条 `applyPatchOp`，任何一条失败立即整批返回，不许「跳过坏的继续做好的」。
  - 存储侧：`putScene` 必须是单条事务/单条 SQL，不许拆成「先删后插」两步 —— 拆了两步就不再原子了。

### SR-F9.3 写入必须被独立校验，不得信任调用方自述

- **输入**：一批在单条 op 层面都「看起来合法」的 op —— 例如第一条把画布改坏、第二条再把它改回来；或者几条 op 拼起来才产生一个必须拒绝的占位符；或者调用方给的字段类型在最终屏障处才暴露。

- **期望**：校验发生在**宿主侧**、发生在**整批应用之后**、并且是**对着批次开始时的原始画布**做的事后校验（`lib/server/agent-runtime/dsl-tools.ts:1407-1418` 的注释：这样先前的 op 不能把违规「洗」成后一条 op 眼里的既有数据）。至少三道独立屏障：画布结构校验（`validateSlideCanvas`）、跨 op 拼出的读页占位符检测（`:1428-1435`）、最终对象形状校验（`:1436`）。模型自己在 `intent` 里说「已经改好了」不算数。

- **失败长什么样**：模型说改好了，读回来还是坏的；或者前一条 op 把 `type` 改成非法值、后一条 op 又改回来，于是最终对象合法、但中间态曾经非法而没人发现；或者校验只看调用方传进来的 ops，不看应用之后的对象。

- **判据落点**：`tests/agent-runtime/dsl-tools.test.ts` —— `loud-fails unknown fields and rejects media omission placeholders`、`rejects wrong optional quiz field types at the final validation barrier`、`applies set/remove atomically and clears stale speech audio`；`tests/agent-runtime/patch-stage-gates.test.ts` —— `★ 一张缺 data 的表 ⇒ 一行说清「type=table 缺必需字段 data」，且没有鉴别器噪声`、`★ fontsize: 14（数字）⇒ 整张表合格，页面改得动`、`★ type=code 的元素 ⇒ **不许**说"不在合同里"`、`★ 真正不认识的名字 ⇒ 才报"不在合同里"（并列出合同有哪些）`、`★ 改旁边那个 text ⇒ 必须成功（不许因为表少一个可选字段锁死整页）`。命令：`npx vitest run tests/agent-runtime/dsl-tools.test.ts tests/agent-runtime/patch-stage-gates.test.ts`。**「写完之后重新从库里读一遍再算诊断」这一步没有自动化断言**；人工核对方式：在 `lib/server/agent-runtime/dsl-tools.ts:1466` 打断点或加一行临时日志，跑一次成功的 `patch_stage`，确认 `loadDocument` 在 `putSceneBringingCurrent` 之后被调用了一次 —— 诊断读的是**库里那份**，不是内存里那份。

- **两边各自要满足**：
  - 宿主侧：三道屏障都要有，且都对着「批次开始时的原始画布」判；校验失败的 details 要能指到具体元素（`elementIndex` / 元素 id），不许只回一句「校验失败」。
  - 存储侧：`putScene` 不许自己再做一遍「宽松兜底」把非法对象存下去 —— 兜底会把宿主的校验变成摆设。

### SR-F9.4 状态必须能从数据库读回来核对，不得只信进程内状态

- **输入**：一次成功的 `patch_stage`，以及随后的两类核对请求 —— (a) 宿主侧写完之后的重读；(b) 运维侧问「这个部署现在到底开着哪些旋钮」。

- **期望**：真话在库里。写入之后宿主自己会 `loadDocument` 重读一次再算诊断（`lib/server/agent-runtime/dsl-tools.ts:1466`，注释明写「**不回滚**：patched 的内容已经落盘，这里只把证据交给 agent」）；运维侧有 `GET /api/whoami` 这份现成入口，把「模块加载时读一次的旋钮」原样回显（`compactionEnabled` / `compactionContextBudgetTokens` / `planGate` / `learnerProfilePath` / `materialsDir` / `scratchpadDir` / `planFreezeDir` / `practiceDir` / `maxConcurrent`），所以「我改了 .env.local 但没反应」有一个不靠猜的答案。

- **失败长什么样**：写入成功之后诊断读的是内存里那份对象，于是「库里的」与「报告里的」可能不是同一份；或者改完 env 重启服务，行为没变，只能靠反复重启猜是哪个旋钮没读到；或者某个状态只活在进程内存里（如「这一次运行里审过了」），重启后闸的判定悄悄变了而没人知道。

- **判据落点**：**暂无自动化判据** —— `tests/` 里没有对 `GET /api/whoami` 的断言（`grep -rln "whoami" tests/` 的命中只有 `tests/workbench/text-block.test.ts` 里一段无关的 shell echo fixture）。人工核对方式：`curl http://127.0.0.1:<port>/api/whoami`，把返回的 `runtime.*` 与 `.env.local` 里写的值逐个对齐；再直接查库确认某个 `document_scenes.data` 真的变了（`psql -p 5433 -c "select id, data->>'title' from document_scenes where stage_id = '<id>'"`）。`patch_stage` 侧那条「写后重读」的核对方式见 SR-F9.3。

- **两边各自要满足**：
  - 宿主侧：凡是「读一次就记住」的配置，必须有一个读回来的出口（当前是 `/api/whoami`），否则它就是不可核对的；凡是写操作之后的结论，必须基于重读的结果。
  - 运维侧：判定一律以库里的读数为准；进程内状态（例如本次运行审过哪些课）只能当加速缓存，读不到时回落到库/盘的凭据（`readReviewReceipt` 就是这条的落地）。

### SR-F9.5 自检结论必须指向可复查的落点（表/行/字段）

- **输入**：一次成功的 `patch_stage` 回话（`summary` 与 `details`），以及一次带版面问题的写入。

- **期望**：结论能落到具体位置，不落到「这一页有点问题」。至少三层落点必须齐全：(a) **页级**：`details.updated = { sceneId, order, type, ops }`，正文里说清第几页、哪一页；(b) **元素级**：版面问题带元素下标（`layoutFindingKey` = `code` + `elementIndex`，必要时再加 `elementIndex2`，`lib/quiz/layout-check.ts:106-110`），正文是逐条 `· <message>`；(c) **结构级**：`coverageGapCount` / `planIssueCount` / `coverageGapsCode` / `coverageGapProseCount`，以及条件展开的 `coverageGaps`（最多 12 条）与 `planIssues`。

- **失败长什么样**：只回「已更新」；或者版面问题只说「有 2 处装不下」却不说是哪两个元素（模型改不了）；或者缺口只给个数不给类别，模型不知道该补代码块还是补人话。

- **判据落点**：`tests/agent-runtime/scene-diagnostics.test.ts`（6 例）—— `checks coverage only on quiz pages` / `renders the plan diagnostic when the plan has a forward reference` / `★ says NOTHING about the plan when the plan is empty — T3 cannot audit an existing course` / `tolerates a missing envelope entirely`；`tests/agent-runtime/scene-diagnostics-density.test.ts`（10 例）—— 字数带 4 例（`太薄 ⇒ 说一句，并指向"加页"而不是"塞长句"` / `过大 ⇒ 说成**布局风险**，并指向"拆页"` / `中间那段（120–800）机械层闭嘴` / `非 slide 页不算字数`）；`tests/quiz/layout-check.test.ts` —— `★ 换了一个元素出问题 ⇒ 是**新增**（身份带元素下标）` / `★ 页面级的发现（没有元素下标）身份就是 code 本身`。命令：`npx vitest run tests/agent-runtime/scene-diagnostics.test.ts tests/agent-runtime/scene-diagnostics-density.test.ts tests/quiz/layout-check.test.ts`。**「表/行/字段」这一级（数据库层面的落点）没有判据** —— 现有判据只到页级与元素级；要落到库，得人工执行一次 `select stage_id, id, data->'content'->'canvas'->'elements'-><i> from document_scenes where …` 逐字段比对。

- **两边各自要满足**：
  - 宿主侧：`details` 必须是结构化的（能机器读），正文必须是给人读的人话 —— 两者不许互相替代；元素级结论必须带下标，不许只带 message。
  - 诊断提供方：算不出来的时候要**闭嘴**（返回空串 / 空数组），不许拿一段「看起来像诊断」的默认文案凑数（`scene-diagnostics-density.test.ts` 的「中间那段机械层闭嘴」就是这个口径）。

### SR-F9.6 写入必须是 CAS：旧值不匹配就拒绝，不得覆盖他人改动

- **输入**：两个写者先后改同一页 —— 甲读到 `base` 之后、写回之前，乙把这一页改了；甲带着过期的 `base` 提交。

- **期望**：甲的写入被拒，库里保持乙的那一版。按值 CAS 的实现在插件侧：`lib/db-write.mjs` 的 SQL 逐字是 `update document_scenes set data = $1::jsonb where stage_id = $2 and id = $3 and data = $4::jsonb`，`rowCount === 1` 才算成功（`{"ok":true,"rows":1}`）；不成功就回查，页面还在就回 `{"ok":false,"reason":"stale","rows":0,"error":"这一页在你编辑期间被别人改过了（CAS 不成立），重新读一遍再改"}`，页面没了就回 `reason: "missing"`。注意这条在**两处**实现口径不同、必须都写清：宿主侧 `packages/@openmaic/storage/src/document/pg.ts:1577 putScene` **不是按值 CAS**，它靠的是 `SELECT … FOR UPDATE` 行锁 + `dslVersionOf(stored) !== DSL_VERSION` 判 `not-current`（kind `'not-current'`），再由 `lib/server/agent-runtime/document-writes.ts:32-48 putSceneBringingCurrent` 在 `not-current` 时回退成整篇聚合保存。

- **失败长什么样**：SQL 少了 `and data = $4::jsonb` 这一句（`docs/specification/domains/F9-write-gates.md` 记的违反形态逐字就是 `update ... set data = $1 where stage_id = $2 and id = $3`）—— 于是后写的人静默覆盖先写的人，而且两边都以为自己成功了。或者 CAS 失败了但回 `ok: true`，调用方以为写进去了。

- **判据落点**：**暂无自动化判据** —— `grep -rln "db-write\|db\.mjs\|openmaic-course" tests/` 零命中，插件不在 vitest 覆盖内。可核对的判据只有 SQL 文本本身与手工读数。人工核对方式：先用同一个 `base` 连写两次 —— 第一次回 `{"ok":true,"rows":1}`，第二次必须回 `{"ok":false,"reason":"stale","rows":0}` 且库里还是第一次写进去的值（实测就是这个读数）。宿主侧的 `not-current` 回退有测试：`tests/agent-runtime/document-writes.test.ts`（5 例）—— `uses the incremental write when the document is current` / `falls back to an aggregate save with the scene spliced in on not-current` / `replaces an existing scene by id in the fallback save` / `rethrows the original error when the document vanished before the reload` / `rethrows unrelated putScene failures without touching the aggregate`。命令：`npx vitest run tests/agent-runtime/document-writes.test.ts`。

- **两边各自要满足**：
  - 插件侧（`lib/db-write.mjs`）：`where` 子句里必须同时有 `stage_id`、`id`、`data = $base::jsonb` 三者；`patch.json` 必须同时带 `base` 与 `next`（缺一个就抛 `patch.json 需要 { base, next } 两个字段`）；成功与失败的返回形状必须不同（`ok` 与 `reason` 不能同时模糊）。
  - 宿主侧（`putSceneBringingCurrent`）：只对 `not-current` 做聚合回退，其它错误必须原样抛出去 —— 把所有错误都当成 `not-current` 会把「连接断了」也变成一次静默重写。
  - 两边都不许「读-改-写」而不带旧值：`base` 必须是从库里读回来的那一份原始 `data`，不是本地拼出来的近似值。

### SR-F9.7 写入必须默认只算差集、不落盘，落盘必须是显式选择

- **输入**：`openmaic_patch_stage` 一次调用，**不传** `dryRun`。

- **期望**：默认只算差集、**一个字节都不写库**。返回里带 `dryRun: true` 与人话提示「没写库。看差集没问题后传 `dryRun:false` 再跑一次。」；差集形状固定为 `counts: { before, after, added, removed, moved, resized, textChanged, markupChanged, restyled }` 外加同样八组明细（`restyled` 明细最多 12 条）。其中 `markupChanged` 专收「可见文字逐字相同、只有标签或空白变了」的改动 —— 它和 `restyled` 一样**必须与 `textChanged` 互斥**，否则一次改动会被记进两个桶。只有显式传 `dryRun: false` 才走写库子进程，返回里 `dryRun: false` 且带 `write` 的读数。

- **失败长什么样**：不传就当写；或者 `dryRun` 传了 `false` 之外的真值（`0` / `"false"` / `null`）被当成「真要写」；或者 dryRun 也把 `write` 字段填上，调用方分不清到底写没写。已经踩过的坑（两个，都是实测出来的）：① `restyled` 判定如果不先剥掉 `content`，改一个字会同时记成 `textChanged` 与 `restyled`，差集读数虚高；② 但如果只剥 `content` 而不单独收 markup-only 改动，反过来会漏 —— 把 `<strong>` 的边界挪一下（可见文字逐字相同）时写库成功、`changes` 报「文字改」而七个桶全 0，调用方看到「说要改，又说没改」，**而库里字节确实变了**（`4007 → 4008`）。所以必须有 `markupChanged` 这个桶，且七个变更桶全 0 时要在 `note` 里明说「差集看不见这次改动，但库里字节会变」。

- **判据落点**：**暂无自动化判据** —— 同上，`tests/` 里没有插件侧的任何断言。人工核对方式：跑一次不传 `dryRun` 的 `openmaic_patch_stage`，确认返回 `dryRun: true` 且没有 `write` 字段；同时用 `select data from document_scenes where stage_id=… and id=…` 前后各取一次，两份必须逐字节相同。实测的空差集读数是 `counts {before:10, after:10, added:0, removed:0, moved:0, resized:0, textChanged:0, markupChanged:0, restyled:0}`（同值写回时也是这个形状，且**不带** `note`）；markup-only 改动时形状相同但 `markupChanged:1` 且带那条 `note`。

- **两边各自要满足**：
  - 插件侧（`lib/index.js` 的 `patchStage`）：判断必须是 `dryRun !== false`（严格不等），这样 `undefined` / `null` / `0` / `"false"` 全都算 dry run；写库分支只能有一条路径（写临时 `patch.json` → `db-write.mjs write` → 删临时文件）。
  - 工具 schema 侧：`dryRun` 的 description 必须明写「默认 true（只看差集）；确认后传 false 才真写库」，让模型知道默认是安全的。
  - 调用方（模型）：`dryRun: false` 之前必须先把差集给学习者看过 —— 这是默认值存在的理由，不是可选礼仪。

## 版面差集：这条契约里唯一「算出来」的结论

`patch_stage` 是唯一能同时拿到「改前那一页」与「改后那一页」的地方，所以版面差集只能在这里算。口径是 `lib/quiz/layout-check.ts:132 layoutDelta(before, after)`：身份用 `layoutFindingKey()`（`code` + 元素下标），**不用 message** —— 估算出来的数字改一个字就变，拿它当身份会把同一条报成「新增」。三个结果必须分开说：`added` 是这次引入的、`removed` 是这次修掉的、`kept` 是改前就有的（**不是这次改出来的**）。`formatLayoutDelta` 在全空时返回空串（调用方就别多说话）。

唯一调用点在 `lib/server/agent-runtime/scene-diagnostics.ts:210`，且只有「改前改后都是 slide」时才算；`generate_scene` 写新页时没有 `previousScene`，于是 `layoutDeltaText` 为空串、`layoutDelta` 为 `{added: [], removed: [], kept: []}` —— 不许在这条路上编一个「新页有 N 处问题」出来。

判据：`tests/quiz/layout-check.test.ts` 的 `describe('★★ 版面差集：这次改动引入了什么 / 哪些是既有的')`（7 例：`同一条问题（只是估算数字变了）⇒ 算【既有】，不算新增` / `既有问题 ⇒ 人话直说"没有引入新的问题""不是你这次改出来的"` / `新引入 ⇒ 点名"这次改动新引入了 N 处"` / `改好了 ⇒ 说"修掉了"，不说成新增` / `换了一个元素出问题 ⇒ 是**新增**（身份带元素下标）` / `什么都没变 ⇒ 空串` / `页面级的发现（没有元素下标）身份就是 code 本身`）；`tests/agent-runtime/scene-diagnostics-density.test.ts` 的 `describe('★★ 版面差集：patch_stage 才拿得到"改前那一页"')`（3 例，其中 `★ 没给 previousScene（generate_scene 写新页）⇒ 一个字都不说` 断言 `layoutDeltaText === ''` 且 `layoutDelta` 等于空三件套）。命令：`npx vitest run tests/quiz/layout-check.test.ts tests/agent-runtime/scene-diagnostics-density.test.ts`。
