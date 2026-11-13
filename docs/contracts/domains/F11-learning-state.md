# F11 学习状态与回流 —— 契约

## 这条契约管什么

管「一次学习行为结束后，什么被记下来、以什么形状、凭什么信」这条路的验收：逐题对错存在哪、三级粒度各自成立的条件、先修边凭什么存在、练习结果怎么读进来、两份学习者文件谁是权威。

不管题怎么出（F3），也不管页面怎么读（F2）—— 只关心**学完之后留下的那份东西，能不能被人读懂、能不能被机器重算、以及两者冲突时听谁的**。

本域两条规格（SR-F11.4 / SR-F11.6）**在「形态与结构」上已落地一部分、在「使用」上仍未落地**，所以它们的「判据落点」要分两半读：**结构那一半是可跑的命令**（2026-11-10 起，SR-F11.4 有 5 条源码判据），**使用那一半仍是落地时必须先满足的验收条件**。这一点在每条里分开写，不许把后半读成「已有判据」。

## 逐条验收

### SR-F11.1 答题判分结果必须落库，且必须能从原始作答重算

- **输入**：一组同一个自检页的三阶段答题记录（`draft` → `submitted` → `reviewed`），以及那一页当前的题面（`document_scenes.data->'content'->'questions'`）。

- **期望**：折叠出的逐题判定必须与「按当前题面重算」的结果**逐题一致**，且这条一致性有测试钉住；同时，凡是题面已不存在的题目，必须被显式标注成「题面已丢失」而不是静默跳过或算成「未作答」。已验证的事实是：174 条记录按最新快照重判，与库内 `results` **48 道题 48 道一致、0 分歧** —— 这说明**重算这条路今天是通的**，但也说明今天只有这条路。

- **失败长什么样**：逐题对错只能靠把页面 JSON 拉出来重跑一遍才有；某天页面被重生成，历史记录显示「无法解释」或者干脆从列表里消失（看起来像「没做过」）。另一种更隐蔽的失败：把「页面还在」当成前提写进代码，于是重生成页面之后答案全错但没人报错。

- **判据落点**：`tests/quiz/attempt-fold.test.ts` —— `folds a full lifecycle into per-question verdicts`（三阶段折叠成逐题判定）、`keeps a corrected mistake in everIncorrect but clears incorrectNow`（改对之后仍记得曾错）、`orders records by seq, never by timestamp`（**按序号不按时间戳**，这条防的是时钟回拨）、`explains a question id that no longer exists on the page`（题面丢失时给出解释而不是静默）。连真库：`tests/quiz/attempt-fold-live.test.ts`。命令：`npx vitest run tests/quiz/attempt-fold.test.ts tests/quiz/attempt-fold-live.test.ts`。**「判分结果落库」这一半今天没有判据**（`docs/implementation/coverage.md` 标「松」）—— 落库实现之后，这条契约要求新增一条断言：删掉页面行之后，逐题对错仍读得出来。

- **两边各自要满足**：
  - 存储侧：判分结果必须与「作答快照」分开存，不许把对错编码进 `answers` 的字符串里（那会让「A」和「A(对)」两种形状混在一个字段）。
  - 读取侧：题面缺失必须走「显式标注」分支，不许走「跳过」分支 —— 跳过会让统计分母悄悄变小。

### SR-F11.2 掌握度必须按页、按题、按知识点三种粒度分开记录，不得跨粒度推算

- **输入**：三个粒度各自的原始观测 —— (a) 页级：某页的逐题判定集合；(b) 题级：某道题的历次作答；(c) 知识点级：某个概念挂到的题集合。

- **期望**：三级各自能独立回答「掌握没有」，并且**每一级都带得出它的观测条数**。某一级没有任何观测时，必须返回「不知道」这个第三态，不得返回 0、不得返回 `null` 冒充、也不得用相邻级填。已知的覆盖率事实是：**234 页 100% 有 `outlineId`；138 页能对上计划条目；仅 37 页的条目带 `keyPoints`**（Java 一门课占全部 37 页），另 6 门课连计划条目都没有 —— 这意味着知识点级在 8 门课里必然长期是「不知道」，这是正确状态，不是缺陷。

- **失败长什么样**：某页 8 道题全对，状态文件里写成「已掌握 OOP」；或者知识点空缺按 0 分显示，读者以为「考了但没会」；或者把 `outlineId` 当知识点 id 用（它是计划条目 id，一个条目可以覆盖多页，且实测同一门课内还有 10 个 id 重复出现 2 次）。

- **判据落点**：`tests/quiz/learner-state-render.test.ts` —— `known 带置信下界，not-learned 带上界，unknown 带 reason 的人话`（**第三态必须存在**：`unknown` 不是 0 也不是 null；三个节名分别是 `## 已达判据（置信下界 ≥ 0.55，且 3 天后复测仍答对）` / `## 未达判据（置信上界 ≤ 0.30）` / `## 暂未定（证据不足，不作判断）`，旧名一个不留 —— 节名的主语是**页**，不是人；并列成「已会 / 不会」就成了对错榜）、`★ 每行带 n= / k= —— 不带样本量的置信区间无从核对`、`★ 零评价词 —— 八个词一个都不许出现`、`★ stageId 与 sceneId 都在行里 —— 35 个 scene id 跨课复用`（**跨课不许借**，直接对上 112 个 scene id 里 35 个跨课复用、34 个连类型都不同的实测）、`★ too-few-items 时算出「再做对 N 题可判」，且与判会用同一套下界`（证据不足时给的是「还差多少」，不是猜一个数）。命令：`npx vitest run tests/quiz/learner-state-render.test.ts`。**「三级分开」今天只有页级** —— 落地时要求：给同一页造一份页级全对、知识点级零观测的输入，断言知识点级返回「不知道」而不是「已掌握」。

- **知识点级读数落地**（2026-11-10）：`lib/persistence/xq-concept-mastery.ts` 的 `readConceptMastery(queryable, { stageIds?, concepts?, now?, limit? })` 返回 `readonly { conceptId: string | null; concept: string; verdict: TriVerdict; questions: number }[]`。三条与页级刻意不同的选择（算而不存 `xq_concept_state` / 盲猜率按题型分 0.25 与 0.0638 / 题目身份是 `(stage, scene, question)` 三元组）。判据 `tests/persistence/xq-concept-mastery.test.ts` 19 例：`★ 一道题的最高档唯一概念才把证据算给它`、`★ 最高档并列时这条证据不算给任何一个`、`★ 三门课五次观测合到一处，才第一次跨过「至少三题」的门槛`、`★ 同一道题答两次是两条证据，counted_n 各自算`、`★ 多选题的盲猜率按 0.0638 算，不是 0.25`、`★ 别的课的证据不许混进来`、`★ 题目身份是 (课, 页, 题) 三元组`、`★ 映射不上 id 的概念照样出现，conceptId 是 null`、`★ 不给 stageIds 就是所有课`、`★ 只读：算三次不改任何一张表`、`★ 结果按名字排序`。第一处消费是复习卡：`GET /api/persistence/xq/reviews` 每张卡带 `mastery`（`{ tri, n, questions } | null`），判据 `tests/persistence/xq-review-queue.test.ts` 两条（跨课证据合到一处 / 没有可判证据时 `null` 而不是「暂未定」）。**第二处消费是状态块**：`refreshLearnerStateFromRuntime()` 把 `readConceptMastery()` 的结果一起折进 `renderLearnerStateBlock({ concepts })`，排在页级三节前面；只列 `known` / `not-learned`（`unknown` 一条不列，页级已说过为什么不够判）、一行不写 stage/scene（概念是跨页的）、只写 `n` 不写 `questions`（两个都叫「题数」会混）、节名主语换成「知识点」但阈值照写一遍。判据 `tests/quiz/learner-state-render.test.ts` 八条：`★ 判得出来的知识点进块，且排在页级前面`、`★ 暂未定的知识点不列 —— 页级已经说过为什么`、`★ 未达判据的知识点也进块，且用上界`、`★ 一行里不写 stage/scene`、`★ 只写 n 不写 questions`、`★ 只有知识点也能渲染`、`★ 全是 unknown 且别处也空 ⇒ 仍是空字符串`、`★ 知识点按概念名码点序`。真机 `cells=6 / concepts=15`、15 个全 `unknown` ⇒ 块里零行、文件字节不变（1573 B）。★ 真库今天 **15 个概念全部 `unknown` / `too-few-items`** —— 56 条证据里 17 条映射到唯一概念，最多 2 题，而门槛是 `MIN_ITEMS_FOR_VERDICT = 3`。这不是缺陷，是这条规格要的样子：没跨过门槛就说没跨过。

- **题级映射已落库，判定仍未分级**（2026-11-09）：`xq_question_concept` 71 行 / 13 页，由 `lib/concepts/question.ts` 从**题干**推出（不含选项与解析：含选项会把挂载从 71 行抬到 124 行且大量是反向噪声），强弱两档 `confidence` 0.80 / 0.50。★ 那一行概念标签的规则是**最高档恰好挂 1 个概念才给** —— 真库读数把这条逼出来的（`scene-p18` 最高档三个 0.80 全是题干里那段 `class Person { String name; … }` 带出来的），判据 `tests/agent-runtime/learner-state-concept-label.test.ts` 5 条。**标签不是知识点级结论**：它只是把页级判定那一行的人话换个主语。

- **复习闭环第一次对上历史错题**（2026-11-09）：`xq_review_schedule` 建表以来一直是 0 行 —— 历史那批学情证据来自一次性探针（只调 `ingestProbeItems` 与 `recomputeCellState`，不调排期），所以「答错了要复习」只对将来的答题成立。现在生产入口 `recordProbeFromRuntimeAppend` 会排期，`scripts/backfill-review-schedule.ts` 把已有错题补上：真库 5 道错题 → **20 行**（每道 4 关，1/3/7/15 天）。★ 挂哪个概念只有一条判据 `XqLearnerStore.conceptForQuestion()`：这道题的**最高档恰好只有一个概念**时才是它，并列或没有题级映射一律留 `''`（与状态块拿格子标签同一套 `ties = 1` 规则，粒度换成一道题）。**留空不是失败** —— 四关按题排，`concept` 是可选标注；而「挑一个也行」会把唯一键里的 `concept` 换掉，同一道错题就此变成两组四关，两组都到期时要重做两遍。真库里只有 2/5 道错题有唯一概念（`scene-p18/q7 → 类与对象`、`scene-p35/q4 → setState 与状态管理`）。判据 `tests/persistence/xq-probe-recorder.test.ts` 的两条（`★ 一道题的最高档只有一个概念时，排期就用它 —— 不是恒空` / `★ 最高档并列时留空 —— 挑一个就会让同一道错题第二天变成另一组四关`）。

- **「会」必须由延迟证据推出**：页级判「会」只认 `Δ = now − asked_at ≥ 3 天` 的那批证据（`n_delayed ≥ 3` 且延迟桶的下界仍达判据）。裸的 `n/k` 统计上没错，但构念上测的是「曾经答对的比例」—— 同一批题反复测与答对就撤，一周保持率 80% vs 33–36%（d=4.03），而这个差别学习者自己预测不出来。延迟桶不足时状态必须是 `unknown`（`reason='mixed'`），不是「已掌握」。3 天不是文献值，是四关排程第 2 关就是第 3 天；判据 `tests/quiz/xq-mastery.test.ts` 的 `延迟桶：会 = 隔了几天还答得对` 一组。

- **两边各自要满足**：
  - 计算侧：三级不许互相读对方的结果；共用的只有最底层的逐题判定。
  - 展示侧：三级必须能分别被点名（`page:scene-p12 / question:q3 / concept:<id>`），否则读者无从判断这句话在说哪一级。

### SR-F11.3 先修关系必须带来源与置信度，无证据不得参与排序

- **输入**：一条声称「A 应先于 B」的边，连同它的来源（人写 / 语料统计 / 外部图谱映射）与置信度。

- **期望**：三种来源各自有明确的置信度上限，且**外部映射来源在字面命中但语义不同时必须被拒**。排序算法只接受置信度达标的边；不达标的边可以存在、可以被展示成「推测」，但不得改变学习顺序。已实测的反面案例：一张 130 节点 / 158 边的外部算法竞赛图谱匹配本库 234 页只命中 10 页，**其中 8 页是同形异义**（外部图里「构造」= 构造题，Java 课里 = 构造方法）；同一张图的 `tier` 字段也不是拓扑层级（16 个 `tier=0` 的节点有先修入边）。

- **失败长什么样**：因为两门课都讲「构造」，于是判定「学完构造方法能做构造题」；或者把外部图的 `tier` 当先修层直接排序；或者从语料共现直接生成先修边（共现只说明一起出现，不说明谁先）。

- **判据落点（2026-11-10 之后：一半有了）**：
  - **「带来源」这一半成立了**。`ConceptEdge` 此前只有 `fromId`/`toId`/`relation`/`strength`，`source` 与 `reason` 在 SQL 的 `SELECT` 列表里就没有 —— 于是「这条边谁写的」在读得到图的人手里根本无从回答，规格也就无从核对。现在两列都在，并且**依据与结论分开回**：`directPrerequisites()` 给去重排序后的结论，`prerequisiteEvidence()` 给一条边一行的依据（同一个先修被两张外部图各支持一次是**两条**证据，合并之后就没法回答「这条我信不信」）。判据 6 例在 `tests/persistence/xq-concept-graph.test.ts`：带来源与理由 / 两图两证据且默认只认 strict / 来源未知是 `null` 不是空串 / **排序用码点不用 `localeCompare`**（后者随 ICU 与系统语言变，同一份数据两台机器会排出不同顺序）/ `contains` 不算依据且目标过合并链 / 起点解析不出仍是缺口不静默丢。路由 1 例在 `tests/persistence/xq-concepts-route.test.ts`（`?id=` 同时回结论与依据）。真机 `分支结构` 回两条：`strict/acm-graph` 与 `recommended/course-outline`。
  - **「无证据不得参与排序」这一半仍然是空的**：没有任何代码按 `strength` 决定「许不许排序」，也没有任何排序行为上线（`GET /xq/concepts` 不产出顺序，4 例禁词判据禁 `recommendOrder`/`studyOrder`/`nextConcept`）。所以这条规格今天记「松」不记「有」—— **能核对来源 ≠ 已经拿它当门槛**。
  - 仍缺的两样：① 上述那条真实的同形异义案例（130 节点外部图匹配 234 页、8 页同形异义）还没有被写成判据 —— 现在能带出 `source`，但没有任何东西会因为 `source` 是 `acm-graph` 而拒绝一条边；② 边没有 `confidence` 列（只有 `strength` 三档），规格原文要求的是「来源与置信度」两样。

- **两边各自要满足**：
  - 数据侧：边必须带 `source` 与 `confidence` 两列，缺一列的行在读取时就被当成不存在。（2026-11-10 现状：`source` 有了，**`confidence` 列不存在** —— 只有 `strength` 三档。三档是证据强度不是概率，把它当置信度是偷换。）
  - 消费侧：排序函数只接受显式传入的「达标边集合」，不许自己去查全表 —— 让「谁能进排序」成为一个可测试的参数，而不是一个隐式查询。

### SR-F11.4 课程必须以可演进的知识图谱为基准（**结构已落，使用未落**）

- **输入**：一次图谱变更 —— 新增类型、新增节点、修改既有类型的属性、改名、删除概念，五种各一次。

- **期望**：五种变更各有明确后果 —— 新增是 additive（不触碰既有行）；修改既有类型必须整体迁移且**不允许半迁移状态跨越一次重启**；改名必须原地改显示名并保住标识（历史记录不改读路径就能读出新名）；删除必须留墓碑（历史记录仍能解释「这个概念删了」，不是变成孤儿）。版本化的一条硬要求：**老课程保留它建课时的旧图谱**，新图谱不得回填改写老课的挂载。

- **失败长什么样**：把概念名直接当主键写进页面标题，改一个名要重跑 200 多页；删一个概念后学习状态里出现指向不存在概念的记录且无人解释；两个版本的图谱共用一个 id 空间，一次迁移把老课的挂载全指到新概念上。

- **判据落点（结构那一半，2026-11-10 有了）**：`tests/persistence/xq-learner-schema.test.ts` —— `★ 同一时刻只允许一个开放的图谱版本`（冒第二行 `duplicate key value violates unique constraint "xq_graph_version_one_open"`；冻结旧版之后才能开新版；`frozen_at` 早于 `created_at` 被 `xq_graph_version_freeze_order` 挡）、`★ 概念只能标进存在的版本`（`xq_concept_created_in_fkey`）、`★ 概念 id 的形状与名字非空由 CHECK 兜住`（`xq_concept_id_shape` / `xq_concept_name_nonempty`）、`★ 退役版本必须晚于进入版本`（`xq_concept_retire_order`）、`★ 重测链指回上一次观测，且不许指向不存在的行`（`xq_probe_item_retest_of`）。实现：迁移 `3 graph-version` + `4 concept-expand`（`lib/persistence/xq-learner.ts` 的 `XQ_LEARNER_V3` / `XQ_LEARNER_V4`）。命令：`npx vitest run tests/persistence/xq-learner-schema.test.ts`（26 例）。

- **判据落点（版本推进那一小段，2026-11-10 有了）**：`tests/persistence/xq-graph-version.test.ts`（17 例）—— `★ 冻结旧版与开新版是同一次`（中间不存在「没有开放版本」的时刻）、`★ 比较并交换`（`from` 不是当前开放版就整条不生效）、`★ 中间版本不许被跳过`、`★ 只写 created_in IS NULL 的行`、`★ 幂等`（同一批重跑写 0 行）、`★ 库里不存在的概念如实报 missing`、`★ 往已冻结的版本里塞新概念要拒`、空 label / 非正整数 `from` 抛 `RangeError`、label 重复被 UNIQUE 挡。实现：`lib/persistence/xq-graph-version.ts`（`readGraphVersions` / `openGraphVersion` / `advanceGraphVersion` / `assignConceptsToVersion`），入口 `scripts/advance-graph-version.ts`。★ 推进**故意不是 HTTP 路由**：它是一次导入的边界，失败模式是「另一个窗口先推进了」，需要人看一眼。真机（2026-11-10，跑完已还原）：`--dry-run` 回 `1 版 / v1 open / concepts=104`，`--label v2` 真跑后 `v1 frozen 104 / v2 open 0`，重跑回 `already-frozen`（退出码 2）与 `--from 2` 回 `not-found`（退出码 2）。命令：`npx vitest run tests/persistence/xq-graph-version.test.ts`。

- **判据落点（出现记录带上批次，2026-11-10 有了）**：`scripts/backfill-concept-occurrences.ts --execute --batch`（按课各开一批 → 同步器按 `stage → batchId` 写归属 → 全成功才落定）。判据在 `tests/persistence/xq-concept-occurrence-sync.test.ts` 26 例里新增五条：传 `batchIds` 时行上带批次与页指纹 / 不传时 `batch_id` 留空而 `page_hash` 照写（指纹是页的属性，不依赖谁知道自己是哪一批）/ 换一批重算时**内容没变也要更新归属**（一行必须指得出最近一次确认它的导入）/ 同一批再跑是「未变」不刷全表 / 页改了 `page_hash` 跟着变。
  · 期望读数：真库 `xq_import_batch` 9 行全 `applied`，`xq_concept_occurrence` 645 行全带 `batch_id`（9 个不同批次）与 `page_hash`，`first_seen_at` / `last_seen_at` 各 645 行，`stale_since` 0 行；重跑「命中」九批、`新增 0 更新 0 未变 645`、`落定 0 / 9`。
  · 失败长什么样：`--dry-run --batch` 真去开批（开批自己就是一次 INSERT）—— 那条守卫写在脚本里，`--dry-run` 只打印「不真开批次」。
- **判据落点（导入批次，2026-11-10 有了）**：`lib/persistence/xq-import-batch.ts` + `tests/persistence/xq-import-batch.test.ts` 34 例。
  · 开批幂等：同一份内容 + 同一抽取器 + 同一版图开两次 ⇒ 第二次 `created: false` 且 `batchId` 相同、全库仍 1 行。
  · 四个维度各自能分出新批：内容变（换 `contentHash`）/ 换抽取器 / 跨版图（换 `graphVersion`）/ 换课（换 `stageId`）。
  · ★ `source_graph` 为 NULL 也参与唯一性（`NULLS NOT DISTINCT`）—— 少了这条，自有课程每导一次都会新开一批。
  · 内容哈希：输入顺序不影响（按 `scene_order` 排）、**页序变了哈希就变**、内容改了哈希就变、**键序不影响**（jsonb 往返会重排键）、空课也有哈希。
  · 状态机：`applied` 写上 `applied_at`、**重复落定不重写时刻**、**已落定的不许被改成 `abandoned`**、不存在的批次回 `ok: false` 而不抛。
  · 库侧双向约束：手写一行 `status='applied'` 但 `applied_at IS NULL` 被 `xq_import_batch_applied_pair` 拒；手写 `origin='own-course'` 却带 `source_graph` 被 `xq_import_batch_origin_graph` 拒。
  · 形状校验：`contentHash` 不是 64 位小写十六进制、`stageId` / `extractor` 空、`graphVersion` 非正整数、`external-graph` 不带 `sourceGraph` —— 全部抛 `RangeError` 且**一行都不写**。
  · 期望读数：`npx vitest run tests/persistence/xq-import-batch.test.ts` → 34 passed。
  · 失败长什么样：把 `UNIQUE NULLS NOT DISTINCT` 写成普通 `UNIQUE`，那条「NULL 也参与唯一性」会红；把 `canonicalJson` 换成 `JSON.stringify`，「键序不影响哈希」会红。
- **判据落点（种子图进库那一跳，2026-11-10 有了）**：`tests/persistence/xq-seed-sync.test.ts`（14 例）—— `★ 库里已有的概念保留它原来的 id`（换 id 会把 644 条出现记录与 71 条题级映射指空）、`★ 退役或合并过的概念照样认领 id，但不写别名`、`★ 外部 id 已指向别的概念时不改方向，只报冲突`、`★ 别名已被别的概念占用时跳过并记一条问题`（其余别名照写，一条冲突不把整批停下）、`★ strength 或 reason 变了就更新，并计入 updated`、`★ 空库上跑真种子图：104 概念 / 357 别名 / 63 外部引用 / 105 边`、`★ 真种子图也是幂等的：第二次全部 0`、不传 `execute` 时只报告（库里一行都没有）、新概念归到当前开放的图谱版本、端点不在种子图里的边整条跳过并报出来。实现：`lib/persistence/xq-seed-sync.ts`（`syncSeedGraph` / `aliasFormsOf`），入口 `scripts/seed-concept-graph.ts`。
- **判据落点（出现记录的写入方，2026-11-10 有了）**：`tests/persistence/xq-concept-occurrence-sync.test.ts`（21 例）—— `★ 一条大纲对多页：两页都拿到要点（单值 Map 会漏后一页）`、`★ 正文口径只有一份：staticPageText()`（逐字比对，钉的是裁决不是行为）、`★ interactive 带 widgetConfig 时读 widget 字段，不只看外壳 HTML`、`同一页同一概念只留最高档 —— keyPoint 压过正文`、`★ 没有大纲的页只靠标题与正文（真库 96 页属于这一类）`、`跨课同名 scene id 各算各的`、`不传 execute 时一行都不写，但报告照给`、`重跑一次全部计数为 0`、`★ 页改了标题，旧那一行被删、新那一行被写`、`★ manual 行一行都不许删`、`概念在库里没有行就报出来，不顺手新造`。
  **入口**：`npx tsx --conditions=import --env-file-if-exists=.env.local scripts/backfill-concept-occurrences.ts [--execute]`。
  **期望**（真库 2026-11-10）：`页 234，其中 138 页的 outlineId 能在大纲里找到` + `算出来 645 行：keypoint 19 / title 126 / body 500` + `新增 31，未变 614，待删 60`；`--execute` 后 `行 674 → 645，覆盖页 211 → 209`，再跑 `新增 0 / 未变 645`。
  **失败长什么样**：正文口径自己另写一份 ⇒ 数会变成 674 行 / body 529 / 页 211（看着像"多算了"，其实是 interactive 外壳 HTML 被当正文、48 个 widgetConfig 页的真实正文被漏掉）；`manual` 行被一起删掉 ⇒ 人挂的判断消失且无人能解释。
- ★ **为什么这一跳是必须有的**：2026-11-10 实测全仓 `buildSeedGraph` 只命中 `lib/concepts/index.ts` 的 re-export、`scripts/backfill-question-concepts.ts`（只拿它建别名索引做匹配，不写概念表）与两个测试 —— 「种子图 → 库」这条链**从来不在仓里**。库里那 104/357/63/105 是 2026-11-09 用一个已不在盘上的 `.tmp` 脚本灌的：换台机器、重建一个库、或者只是想加一个概念，第一步就卡住。
- ★ **为什么默认不写库**（`execute` 不传只报告）：它动的是 `xq_concept`，所有学情表的外键父表。真库 `--execute` 读数（2026-11-10）：认领 104 行 / 新增 0 行；别名新增 0 跳过 357；外部引用新增 0 跳过 63；边新增 0 更新 0 未变 105 —— 与那次历史导入**逐一吻合**，正好是同步器归一化规则与认领规则没漂的反向验证。命令：`npx tsx --conditions=import --env-file-if-exists=.env.local scripts/seed-concept-graph.ts [--execute]`。

- **判据落点（**五种变更**那一半地还没有）**：新增 / 修改 / 改名 / 删除 / 开新版五种变更**各自跑一遍**的验收还不存在 —— 今天只有结构能挡住「写进一个不存在的版本」「退役早于进入」「两个开放版本」，挡不住「一次迁移把老课的挂载全指到新概念上」。这一半仍然只有**约束**：不得出现半迁移态、必须留墓碑、必须原地改名。★ 另外三条也仍空：**没有任何导入批次会调用推进流程**（种子图进库也是手动脚本，不是导入链的一环）（任务与单元两张表 2026-11-10 起有写入方 `scripts/intake-begin.ts`，但没有任何导入链会调它；提案表同样只有手动裁决台会写；104 个概念全在 `created_in = 1`），以及**按 `prereq` 排序**明确不许上线。所以版本化今天是「可用的能力」，不是「在用的机制」。

- **两边各自要满足**：
  - 存储侧：图谱的版本标识必须出现在每一次挂载记录上（否则「老课保留旧图」无从实现）。
  - 读取侧：读路径**不过滤**墓碑（要能看见它、解释它），过滤发生在展示层。这一条与成熟实现的选择相反（有项目明写「read path is deliberately unchanged」来避免跟 redirect），本仓选「读路径能看见墓碑」是因为学习记录必须可解释。

### SR-F11.5 练习结果必须回流进学习状态，读取失败必须表现为「没有记录」

- **输入**：一个练习根目录，里面可能有：(a) 一份正常结果文件；(b) 一份半截 JSON；(c) 一个不存在的目录；(d) 超过上限个数的文件。

- **期望**：(a) 被读进来并渲染成状态文件里独立的一节，**且必须写明它来自练习而非答题记录**；(b)(c) 都退化成「这一类没有记录」，不抛、不中断整次刷新；(d) 有上限且超限时行为可预期。另有一条边界必须成立：**只有练习结果、没有答题记录时，状态文件仍要写出来**；两者都没有时不写空文件。

- **失败长什么样**：练习跑完了状态里只有答题记录；或者结果文件删掉后状态里还留着上一次的「2/3 通过」；或者一个坏文件让整次 `D:/文档/jelly_ware/个人数据/学习状态.md` 刷新失败，连带答题记录那一段也没了。

- **判据落点**：`tests/agent-runtime/practice-results.test.ts` —— `★ skips broken files instead of failing the whole refresh`（坏文件跳过）、`returns nothing when the root does not exist (never throws)`（目录不存在不抛）、`★ says where it came from, so it cannot be mistaken for runtime_records`（**标明来源**）、`respects the file cap`、`★ writes the state file when there are NO quiz records but there ARE practice results`、`★ still returns null when there is neither`。实现：`lib/practice/results.ts:117` 的 `readPracticeResults`（注释原文「**永不抛**：坏 JSON、读不动的文件、不是目录的东西，一律跳过」）。命令：`npx vitest run tests/agent-runtime/practice-results.test.ts`。

- **两边各自要满足**：
  - 写侧（练习脚手架）：结果文件是**产物**不是真源，可以被删；删了就等于没做过。
  - 读侧：上限必须显式（今天 200），且不许把「超上限没读到」静默当成「没有」。

### SR-F11.6 笔记层可以作为学习痕迹的载体，但不得成为状态的唯一真相（**未落地**）

- **输入**：一次对笔记的写入请求，以及一次「从笔记重建状态」的尝试。

- **期望**：写入默认不落盘（先算差集）、带内容指纹前置校验**且带独占锁**；重建必须能从库里的真源完成，不依赖笔记里的任何字段。两条一起才成立：只有校验没有锁，实测会静默丢更新（双进程同指纹对写 40 轮，**15%（6/40）静默丢更新**，两个写者都回报「通过」）。

- **失败长什么样**：掌握度写进每篇笔记的元数据，跑一次格式化之后状态全丢；或者两个进程同时写同一篇笔记，后写的静默覆盖先写的而双方都以为成功。

- **判据落点**：**落地前不存在**（OpenMAIC 与 Obsidian 至今零集成）。落地时的最低判据是并发写测试，不是单写测试 —— 单写通过不证明任何事，这正是实测踩到的坑。

- **两边各自要满足**：
  - 写入侧：锁必须在「校验」与「落盘」之间持续持有，不能校验完就放锁（实测的丢更新就发生在这一步）。
  - 读取侧：不得把笔记当状态真源；重建路径必须能在笔记全丢的情况下跑通。

### SR-F11.7 机器生成的产物必须自证身份，人写与机写必须分文件

- **输入**：两份学习者文件 —— 人写的那份、机器生成的那份；以及一次人对机器文件的修改。

- **期望**：机器文件里必须写明「由谁生成、什么时候、不要手改」；人改一个字之后，下一次刷新会覆盖它**且这件事在文件里事先写明**。两份文件矛盾时，必须以人写的那份为准，并且在状态里显式说明矛盾，而不是把两句互斥的话同时塞进上下文。已实测的当初正是反面：一份 **946 B 全部由代码生成**（2026-11-09 读数；现为 1798 B 四节），人改无效且无人写明「不要手改」（这一句 2026-11-10 已补，见下）；另一份 **1851 B 是人写的**，两份互相矛盾（人写说「Dart/Flutter 未知」，机写记着这两门课错了 4 道）。

- **失败长什么样**：人手工在机器产物里补了一条笔记，下一轮消失且无任何提示；或者「我不会这台机器」与「这两门课你错了 4 道」同时出现在同一轮上下文里，模型随机相信一边。

- **判据落点**：`tests/quiz/learner-state-render.test.ts` —— `块首第一行就是那句声明，且只出现一次`（**块自带身份声明**，这是「自证身份」的现有形态）、`★ 不写「不要念给学习者听」这类元指令`（身份声明只能标「这段是什么」，不能扩成「你该怎么用」）。生成端：`lib/server/agent-runtime/learner-state.ts:353` 的 `refreshLearnerStateBestEffort`。命令：`npx vitest run tests/quiz/learner-state-render.test.ts`。

- **「不要手改」这句 2026-11-10 落地了**。渲染器在块首声明**之后**写一行 HTML 注释（`learner-state-render.ts` 的 `PROVENANCE`）：

  > `<!-- 本文件由代码生成（学习状态刷新器）。手改会在下一次刷新时被整段覆盖 —— 要改判定，改库与判据，不要改这里。 -->`

  选 HTML 注释不是随手：块内不许出现元指令（渲染器约束 2），而注入链路 `prompt-context-file.ts` 的 `HTML_COMMENT` 会把注释整段剥掉 —— 这句话**人打开文件看得到、模型读到的那段里一个字符都没有**。两侧都有判据：`tests/quiz/learner-state-render.test.ts` 的「约束 7」四例（人看得到 / 它是 HTML 注释 / 声明后仍是空行 / 只有一处投影）与 `tests/agent-runtime/learner-state-provenance.test.ts` 四例（含真机写入后 `readPromptContextFile` 读出来不含这句）。真机读数：磁盘文件 1405 → 1573 字节、第三行就是这句注释；注入块仍是 1405 字节、首行仍是那句声明、`<!--` 一个都不剩。

  **矛盾检出落地（2026-11-10）**

- 入口：`lib/server/agent-runtime/profile-contradictions.ts` 的 `parseUnknownDomains()` / `domainTokens()` / `findProfileContradictions()`；接线在 `lib/server/agent-runtime/learner-state.ts` 的 `contradictionsOf()`（读不动画像回 `[]`，绝不抛）。
- 判据为什么不是「域 → 概念」：`SELECT … FROM xq_concept WHERE canonical_name = 'Dart'` 与 `… FROM xq_concept_alias WHERE alias = 'Dart'` 在真库上都是 0 行；`Java`、`程序设计基础` 同样 0 行。按字符串精确匹配写的判据会永远不红。
- 判据落点：`tests/agent-runtime/profile-contradictions.test.ts` **20 例**（只认知识状态表整格 `UNKNOWN`、合称要拆、单字丢弃、`unknown` 的格不算矛盾、`not-learned` 也算、无标题跳过、大小写不敏感、排序稳定、同域多页一条不少）+ `tests/quiz/learner-state-render.test.ts` **8 例**（措辞非判决书、排在所有节之前、带标题也带 stage/scene、两档说法不同、无矛盾时不出现、只有矛盾也不许返回空串、排序稳定、标题换行被压平）。
- 期望：`RefreshLearnerStateResult.contradictions` 是处数；渲染器输出里这一节的标题是 `## 画像与状态不一致（两份输入打架 —— 以画像为准，但这几处要问）`，且**位于所有其他节之前**。
- 失败长什么样：这一节写成「画像已过期，应改为…」—— 那是机器替人裁决，违反「矛盾时以人写为准」。判据：`text` 不含 `错误` / `画像过期` / `应改为`。

**仍不成立的两条**：① 文件里**没有**「什么时候生成」——写具体时刻会让每次刷新都变一个字节，而这一行存在的意义是「说明它会变」；精确时刻在库里。② 人写/机写的**矛盾仍不能被机器发现**：判据要写成「画像里任何一行 `X = UNKNOWN` 不得同时存在同领域 `tri != 'unknown'` 的格」，但画像里的 `Dart` 与 `Java` 在概念表里**一个都查不到**（别名 0、规范名 0），「`Dart / Flutter`」整体也对不上 `Flutter` —— 按字符串匹配写的判据在真库上会永远不红。要做这条得先有一张「画像域 → 概念 id」的人工映射表，那是新数据不是新判据。

- **两边各自要满足**：
  - 生成侧：文件头必须机器可读地标注身份，不能只写在一句自然语言里。
  - 消费侧：两份文件都进上下文时，冲突必须显式化；不许依赖模型自己发现矛盾。

### SR-F11.8 外来课程与既有图谱重合的概念必须归并到同一个身份（**未落地**）

- **输入**：同一门学科的两份材料 —— 一份已经在库里建过课，一份是刚导入的外来课程；两份材料里都有「矩阵的秩」这个概念，写法不同（一篇写「秩」、一篇写「矩阵的秩」），另外各有一批本课程独有的概念。

- **期望**：走完导入之后，「秩」在两份材料里指向**同一个概念标识**，两条出现记录分别挂在各自的课程与页面上。名字（含别名、英文名、外来图谱的叫法）挂在概念上作为多条别名，来源挂在出现记录上而不是概念上。外部图谱的节点 id 只存在于映射表里：同一个我们的概念可以挂多个外部 id，同一个外部 id 只能指向一个我们的概念（多对一）。**身份不得由名字派生，也不得由外部 id 拼接派生。**

- **失败长什么样**：同一门「线性代数」导入两次，库里出现两套概念，按概念查历史答题记录一半查不到；或者接入第二个外部图谱时把它的节点 id 直接写进主键，之后换图谱就得全量重写历史记录。可复算的现成反例：用 `${图id}:${节点id}` 前缀拼接做主键，一次按后缀 `split_part` 的 join 会让 3 行静默变 6 行。

- **判据落点**：**落地前不存在**。落地时要给出的验收顺序是：先有「同一概念两种写法归并」与「两个外部图谱的同一个概念」两个用例，再谈自动匹配。今天能给的约束只有三条：概念表主键与名字分表、外部 id 单独一张映射表并加唯一约束、出现记录必须同时带 `stage_id` 与概念 id。

- **两边各自要满足**：
  - 存储侧：概念标识必须是生成的、不含语义的（不是名字、不是外部 id、不是拼接串）；别名表对 `(概念, 别名)` 唯一，映射表对 `(外部来源, 外部 id)` 唯一。
  - 写入侧：导入同一份材料两次，第二次必须只增新的出现记录，不产生第二套概念（用内容哈希判「同一份」）。

### SR-F11.9 外来课程里图谱未覆盖的概念只能以提案身份存在（**匹配器已落地，提案裁决未落地**）

- **输入**：一门外来课程，其中一部分页面讲的是库里已有的概念，一部分是全新的；再给一份已知的同形异义样本（「构造」在两门课里指不同东西）。

- **期望**：匹配必须分成三段，每段有各自唯一允许的动作：**命中** → 归并 + 加出现记录；**存疑** → 进提案表、标「待裁」、不改图谱；**未命中** → 也进提案表、标「新概念候选」。三段**都不得**改变学习顺序。晋升是显式动作；拒绝留痕，使同一份材料再次导入时不重复提出同一条。同形异义不得靠字面相似度单独成立 —— 命中的判定必须至少有两个独立信号（例如字面匹配 + 所在课程的上下文或外部图谱的父类一致），或者在只剩字面匹配时降级成「存疑」而不是「命中」。

- **失败长什么样**：导入一门新课后图谱凭空多出几十个节点，一半是「构造」「排序」这类一词多义；或者提案还没人批，学习路径已经把「未确认的新概念」排在「已确认的基础」前面。

- **判据落点（匹配器，2026-11-10）**：`tests/persistence/xq-three-way-match.test.ts` **44 条**（2026-11-13 从 33 增 11），分五组 ——
  - 归一与索引 3 条：走的是 `normalizeConceptName`（全角减 `0xfee0`、连续空白压一个、`toLowerCase`），**不是另一套规则**；规范名与别名进同一张索引（否则「查不到」取决于它是哪种写法）；一个名字指两个概念时索引里就是两个（歧义是事实，不是脏数据，排序按码点稳定）。
  - 两个度量 3 条：bigram 相似度对重复字要按**多重集**算；单字名没有 bigram、只能判完全相等；义项锚求交回**命中的词**不是布尔（要能数「几种锚中了」）。
  - 判定树 12 条：一个 bigram 都不重合 ⇒ `miss`（理由 `no-lexical-candidate`）；★ **`BIGRAM_TAU = 0.45` 标定之后这一支分成三份** —— 一个二字窗口都不重合 ⇒ `no-lexical-candidate`、像但没到 τ ⇒ `bigram-below-tau`、像到 τ 以上 ⇒ `bigram-similar`（存疑）；τ 的取法见规格那份的三集合读数；候选 ≥ 2 ⇒ `suspect`；★★ 「构造」这个真例子：字面中了、锚一个都没中 ⇒ **不许判命中**，且上下文支持也救不回来；锚交集非空 ⇒ `hit`；★★ **外来侧没给锚时，带着锚的候选也不许被否决**（空缺不是反对证据）；没有锚的候选不许被否决（沉默不是证据）；无锚 + 本课已有 occurrence ⇒ `hit`；别的课出现过不算上下文；`kind` 一致算支持、外来侧没说 `kind` 时不算；已映射祖先有路径 ⇒ `hit`；候选自己就是祖先时不算。
  - 路径判定 2 条：一步中、两步中、三步不中；不相干不中、同一节点算中。
  - 从库里读事实 4 条：**别名不按 `ambiguous` 过滤**（含混的别名读进来会自然落成「候选 ≥ 2 ⇒ 存疑」，过滤掉反而变成假的确定答案）；锚、页分布、路径都读得进来；没有锚的概念在 facts 里是**没有这个键**不是空数组；`decideMany` 与逐个判一致。
  - 真机：104 个种子名当外来名、`senseAnchors` 留空 ⇒ `suspect 104`、理由全 `lexical-only`（同一张图自己对自己，只剩字面 —— 正确，也说明它没被任何真实外来名单验过）；把某门课的 31 个概念当外来名并给出 `stageId` ⇒ `hit 31`（信号 B ②「本课已有 occurrence」成立）。
  - 报告脚本：`scripts/match-external-names.ts --names names.json [--stage stage-xxx] [--json]`。**它不写库**（不写 occurrence、不写 proposal、不建概念）—— 写提案是 `recordProposal()` 的事，写任务与对齐单元是 `beginIntake()` 的事（2026-11-10 都有代码与入口了），匹配器自己不落一行。
  - **三处被实测咬出的判定错，同一个毛病：把「我们没说话」当成「它不符合」** —— ① 没给锚被读成锚不符（空集与任何集合的交都空，于是 36 个带锚概念全被否决、理由写着「被义项锚否决」）；② 「anchors 非空」被当成第二个信号（仍然是只有一个信号）；③ 候选自己当祖先被算成上下文支持。三条各有一条判据钉住。
  - **2026-11-13 又补三处，毛病不同：度量本身有定义域** —— ④ 别名表完全不参与模糊匹配（702 个真名里 701 条走这条路，其中 39 条本可靠别名命中）；⑤ Dice 在「两侧都短」时只可能取 0 或 1，判「像但不确定」在这类对上不存在；⑥ `bestSimilarity` 用 `0` 表达「没比过」会被读成「比过、毫不相干」。另有一条判据钉住「闸门落在**这一对**而不是外来名」——`循环` vs `循环结构` 必须仍能判存疑。
- **判据落点（燃料，2026-11-10）**：义项锚 `tests/persistence/xq-concept-anchors.test.ts` 20 条 —— 切词 6 条（中文按词切不是 n-gram / 首尾虚字碎片整条丢 / 英文标识符不收 / 一个字不收 / 空串回空 / 停用词表里没有真义项词）、算锚 7 条（到处都有的词 lift < 2 不算 / 锚不许是概念名或把它包进去 / 页数 < 4 不给 / 门槛是常量本身 / 排序按码点不按 locale / 缺页当空串 / 总页数 0 回空）、落库 7 条（不传 `execute` 一行不写 / `execute` 后锚真在库里且不含概念名 / 已有锚默认跳过 / `force` 才覆盖 / 幂等 / 没有出现记录的概念不参与 / `pageKeyOf` 跨课算两页）。真机：`--execute` 后 36 个概念 / 147 个词；`类与对象`（58 页）/ `字符串`（56 页）/ `继承`（23 页）抽不出锚 —— **那是正确的行为**，它们该走「只靠字面 ⇒ 存疑」。三段用例的写法要求不变：命中组断言「概念数不增加、出现记录增加」；存疑组断言「图谱不变、提案表 +1、拒绝后再导入不重复提案」；未命中组断言「提案表 +1、学习顺序输出与导入前逐字节相同」。

- **两边各自要满足**：
  - 匹配侧：字面相似只能产生候选，不能产生命中；必须能输出「为什么判成这一段」（哪些信号、各是什么值）。**信号 C（义项锚）今天有了数据**：36/104 有锚，且锚是「相对全库的富集」不是词频 —— 所以它能当**否决**用（锚不相交 ⇒ 不许判命中），不能当**确认**用（相交了也不足以判命中，那是 `J` §3.3「独立信号 ≥2」的活）。
  - 排序侧：学习顺序的输入只接受已确认概念，提案在类型上就不该出现在那条查询的结果集里（不是靠调用方记得过滤）。

### SR-F11.9 的提案裁决（2026-11-10 落地）

**输入**：一条待裁提案的编号，加一个署名的人。

```
tsx scripts/review-intake-proposals.ts --accept 12 --operator owner
tsx scripts/review-intake-proposals.ts --reject 12 --operator owner --why '这是构造题，不是构造方法'
```

**期望**：

| 动作 | 期望 |
|---|---|
| `--accept` | 新增一个 `xq_concept`（`status='active'`、`created_in` = 当前开放版、`anchors` 为空）；提案变 `accepted` 且 `accepted_concept_id` 指向它；`signals` 展开成 `source='foreign-body'`、`weight=0.80` 的出现记录；给 `prereqEdges` 时边落 `status='proposed'` |
| `--reject` | 提案变 `rejected`、记 `decided_by` 与 `decision_note`；**行不删**、`signals` 保留；同一名字再导入时 `seen_count` 涨而状态不变 |
| 不带参数 | 只列 `status='proposed'` 的队列（最多 20 条），每条带 `tri`、来源、见过几次、前 3 条页证据 |

**失败长什么样**：

- 同名 `active` 概念已存在 ⇒ `name-taken`，**不插第二行**（判据：`xq_concept` 里叫那个名字的仍只有 1 行）。
- 没有开放的图谱版本 ⇒ `no-open-version`（`created_in` 不许指向一个不存在的版本）。
- 提案已被别人裁过 ⇒ `not-proposed`（`UPDATE … WHERE status='proposed'` 回 0 行）。
- 晋升中途任何一步失败 ⇒ **整条事务回滚**：概念、提案状态、出现记录一样都不留（判据：拿一个不存在的 `fromId` 造先修边，让最后一步撞外键，然后断言三张表的行数全回到原值）。
- 缺 `--operator` ⇒ 脚本退 2；库里那条 `decision_pair` 约束也会把空署名当成「没裁过」。

**判据落点**：`tests/persistence/xq-intake-proposal.test.ts` **30 条**（2026-11-13 从 19 增 11）—— 进队 6 条（`miss` 不进概念表 / `hit` 自动归并且 `decided_by` 是非人名常量 / `hit` 缺概念在发 SQL 前抛 / 空名空来源抛 / 重复导入仍 1 行 `seen_count 2` / 拒绝后再导入状态与判定都不被改写）、晋升 8 条（五步全落 / 页不存在时跳过并报数 / 同页重复只 1 行 / 外来边 `status='proposed'` / `name-taken` / 三种失败原因分开 / `no-open-version` / 中途失败整条回滚）、队列 3 条（默认只读待裁 / 按 `tri` 筛且 `limit` 非正回空 / 页证据读得回）。

★ 两条不许动的地方：**`hit` 的 `decided_by` 是 `auto:three-way-hit` 而不是人名**（机器判的不许记在人头上）；**晋升第 ③ 步是 `DO NOTHING` 而不是 `DO UPDATE`**（外来证据 `0.80` 不许顶掉我们自己抽的 `1.0`，而这件事不会报错）。

### SR-F11.10 学习行为必须留下只追加的事件流，会话是事件的包络（2026-11-09 落地）

- **输入**：一串学习行为 —— 会话开始、翻到某页、交了某道题、结束会话。同一件事可能重发（网络重试、页面刷新、三个页签同开）。

- **期望**：每条行为落成一行 `xq_event`，带 `occurred_at`（当事人时刻）与 `recorded_at`（服务端时刻）两个时间、一个由本来稳定的字段派生出来的幂等键。**同一件事重发两次，行数不变**（第二次回 `duplicate: true`，不是 409 也不是新增一行）。会话 id **等于**该会话第一条事件的 `event_id`；会话行上的 `event_n` / `scene_n` 是关闭时一次写定的派生量。撤销靠再写一条 `kind='voided'` 的事件，历史行不动。

- **失败长什么样**：翻页什么都没留下；同一次翻页因为组件重渲染被记成 3 条；跨零点的学习被劈成两天的两段会话（凌晨 2 点学的那一课时该算前一天）；事件外键指向一个还没插进库的会话（先发事件后建会话）；客户端把自己的时钟写进 `recorded_at`。

- **判据落点**：
  - 写入器 `tests/persistence/xq-event-recorder.test.ts` 14 条 —— 会话 id = 首事件 id；同一次开始投递两次只建一个会话；同页同时刻重发只算一次而隔一分钟是新的一次；手点三页 = 3 条 `page_viewed`；结束会话写 `ended_at` + `end_reason` + `event_n` + `scene_n`；答题与复习事件走同一条路；`localDayOf` 在 04:00 前后分属两天；同日第二会话 `seq_no = 2`；`deriveDedupeKey` 稳定且换页换键；非法时间戳与空 `stageId` 抛错且不写半条；**契约漂移**（`pg_get_constraintdef` 里逐字核对 16 个 kind、7 个 end_reason 与 2 个 hint_subtype，DDL 加值而代码没跟上会当场红）；**提示分型写得进去**（`hint_requested` + `instrumental` 落 `hint_subtype` 列）；**说了要提示却不说类型，发 SQL 之前就抛**；**别的 kind 挂提示类型抛**（那是写错行，不是宽容）。
  - 路由 `tests/persistence/xq-events-route.test.ts` 8 条 —— 走真路由 + 真写入器，只把连接池换成 PGlite：手点三页落 3 条；同一事件重发两次 `count(*)` 不变（201 → 200 + `duplicate: true`）；未知 kind 当场 400；非 POST 405；结束会话后 `event_n` / `scene_n` / `end_reason` 都对；**提示分型从浏览器到表里是一条完整的路**（两个方向必须分开落，合成一个「用过提示」就再也折不出折扣）；未知提示类型 400；要求提示却不说类型 400 而不是 500。
  - 浏览器发送端 `tests/learning/xq-event-client.test.ts` 8 条 —— 只开一条会话；三个页签同 tick 齐发也只开一个；不同课各开一条；**5xx 重试一次且复用同一个 `occurredAt`**；失败不抛只告警；4xx 不重试；结束会话后要重新开；没开过会话就不发结束。
  - 触发判据 `tests/learning/use-xq-page-view.test.ts` 4 条 —— 正常翻页记；占位页 `__pending__` 不记；无课程 id 不记；无页面 id 不记。
  - 答题事件 `tests/learning/xq-answer-events.test.ts` 7 条 —— 坐标三样（`stageId` / `sceneId` / `attemptId`）缺一或缺题号就不发；同一轮同一题的键稳定；换题、换轮（`att-1` vs `att-1:retry:1`）都换键；`answer_attempted` 与 `answer_submitted` 是两个不同的键。**为什么这两条要单独测**：`recordAnswerAttempt()` / `recordAnswerSubmitted()` 一进去就发网络，副作用层断言不了「发了几条」，而「该不该发」「键是不是同一个」正是它们唯一会出错的地方。**幂等键不能由 `occurredAt` 派生** —— 同一道题的答案他会改三遍，三个时刻派生三个键，「他动过手」就变成三行；`attemptId` 必须进键，重做换 `:retry:N`，不能被上一轮吃掉。
  - 提问闸 `tests/persistence/xq-hint-gate.test.ts` 5 条 + `tests/persistence/xq-events-route.test.ts` 里的 7 条 —— 只挡 `instrumental` 的题目级提问；`executive` 放行（自由口子，如实记账）、页面级放行（没有「先答」的对象）、别的 kind 不进闸；没先动过手就问 `instrumental` 回 **409 `ANSWER_FIRST`** 且**一行都不写**；先答过再问放行；**答在问之后不算**（闸判先后，不是有没有）。闸在**服务端写入侧**（UI 侧挡不住直接调接口），判据只查事件存在性、**不调模型** —— 让模型判「你想清楚了没有」恰好会在迎合时放行（`2605.16207` / `2605.12748`）。
  - 问的那一头 `tests/learning/xq-hint.test.ts` 7 条 + `tests/learning/xq-hint-prompt.test.ts` 8 条 + `tests/learning/quiz-ask-wiring.test.ts` 6 条 + `tests/i18n/quiz-ask-locales.test.ts` 49 条 —— **先记事件再发消息**（顺序可观测）；分型与题干在记事件时一起带上，不是事后猜；闸挡住时消息**根本不该发出去**；「闸挡住」与「记不上」是两种结果（界面说的话不同）；记事件抛错不冒泡；记上了但消息发不出去回 `unsent`；题干按**码点**截断（代理对不被切坏）；模板漏占位符时退回题干本身（不发一句只剩框架的话）；客户端的 `ANSWER_FIRST` 与服务端同名常量一致（漂了以后症状是安静的：闸照样挡，界面却把它说成「发送失败」）；Provider 包住画布而中间三层零改动；取不到把手时按钮**不渲染**；两个按钮记两个不同分型；「被挡住」与「真失败」不是同一条文案；十二个 locale 的两种问法不是同一句话、`template` 都带 `{{stem}}`。

- **两边各自要满足**：
  - 写入侧：会话必须**先于**它的第一条事件之外的所有事件存在（写入顺序本身要保证，不是靠调用方）；幂等键必须只由本来稳定的字段派生，不许要求调用方记得传。
  - 读取侧（今天还不存在）：任何读方都不得把 `dwell_ms` 当判定输入 —— 它是诊断标签，只回答「这一页停留了多久」，不回答「学会了没有」。

### SR-F11.12 自评只进事实表，永不参与判定（2026-11-10 落地）

**输入**：一份 `quizAttempt` payload 里的 `confidence` 映射（`{ [questionId]: 25 | 50 | 75 | 95 }`），由做题页四档按钮填入；草稿与提交都带它。

**期望**：
- 四档取值**恰好**是 25 / 50 / 75 / 95。近似值（`50.0001`）、字符串（`"50"`）、`null` 一律不收 —— 收不进来的条目**整条丢，不抛**（丢一条自评只少一行事实，抛会毁掉整次提交）。
- 自评跟着作答一起走 `scheduleDraft`：刷新页面时答案与把握都要回来。只存组件 state 的话，刷新一次答案还在、把握没了，看起来像被吞了。
- 提交闸：**答过的题**每题都要有一个把握才允许交卷；**没作答的题不问**（跳过的题不存在「有多大把握」这种判断，强行要一个会把「跳过」变成必填）。缺口在按钮的 `title` 里点名。
- 落库落在 `xq_probe_item.confidence_pre`，**只此一处**。`lib/quiz/xq-mastery.ts` 的 `EvidenceItem` 只有 `countedN` / `correct` / `guessRate` / `askedAt`。
- 校准（可选展示）：`expected` = 自评均值，`actual` = 实际正确率，`bias = expected - actual`；`|bias| <= 20` 算准，`>= 20` 算过度自信，`<= -20` 算低估。**题数 < 8 时不出标签**，只说「还差几道」。`correct: null`（AI 批改没回来）**不计入**。
- 复习态不显示自评行。

**失败长什么样**：
- 自评被当权重乘进掌握度 ⇒ 「很有把握但答错」那格反而更接近已掌握。
- 自评一填就把某格推成「已掌握」⇒ 把「他觉得自己会」当成了「他会」。
- 题数不足就出「你很准」⇒ 说了一句它并不知道的话。
- `correct: null` 计入实际正确率 ⇒ 实际正确率凭空掉一截，而这个数直接给人看。
- 空映射被写成 `{}` ⇒ `samePayload` 把两次不同草稿判成相同，草稿静默丢掉。

**判据落点**：
- `tests/quiz/confidence.test.ts` 21 条 —— 只认四值 / 近似值与字符串不收 / 坏条丢不抛 / 空题号不是题 / 数组 null 标量当没有 / `withConfidence` 不改入参 / `answeredQuestionIds` 跳过空白 / 没作答不选自评也不挡 / 缺哪几道点得出来 / 一道没判出什么都不说 / 不到门槛 label 为 `undefined` / `correct:null` 不计入 / 过度自信 over / 低估 under / 容差内 good / 边界 bias 25 算 over / 只吃两边都有的题。
- `tests/quiz/confidence-not-a-verdict.test.ts` 3 条 —— **读源码**断言 `lib/quiz/xq-mastery.ts` 里不出现 `confidence_pre` / `confidencePre` / `ConfidenceMap` / `ConfidenceLevel`；`EvidenceItem` 块里不含自评；自评只经探针写入器落 `confidence_pre`。（★ 这里**不能**笼统禁 `confidence`：该文件有一个同名统计常量 `CONFIDENCE = 0.8`，那是 Beta 可信区间的置信水平。）
- `tests/persistence/xq-probe-recorder.test.ts` 22 条（新增 3 条）—— 自评落进 `confidence_pre` / 没自评的题留 `NULL`（「空不是 50，空是没问过」）/ **自评不影响判定**（同一学习日重测，`n` +1、`k` +0.5；自评故意给反的：答对的说 25、答错的说 95，若它参与判定 k 会朝错的那边动）。
- `tests/quiz/view-state.test.ts` 9 条 —— 四条完整对象的断言里都要有 `confidence`（缺了它意味着 hydration 把把握丢了）。

**两边各自要满足**：界面侧不许在复习态问自评、不许把「没作答的题」也算进必填；判定侧永远不 import 自评符号。任何一侧越界，上面那 3 条源码判据就会红 —— 它们不跑函数，读的是文件。

### SR-F11.13 状态块在「库变了」的那一刻跟上（2026-11-10 落地）

**输入**：一条让状态块三样来源发生变化的写 —— 现在有两条：`quizAttempt` 的 `phase='reviewed'` 记录被 append 成功（新探针事实落库，可能带新排期），以及一次复习结果被接受（`pass` / `fail` 会关闭或重排关）。

**期望**：
- 写成功之后用**调用方已有的连接**刷一次（`refreshLearnerStateWithConnection(queryable)`），不新建池、不 await 到调用方。
- 只在**库真的变了**时刷：`inserted === 0`（重复投递）或没有可判的题（`correct === null` 全跳过）都不刷 —— 库没变，刷新只会白读一遍文件。
- 刷新失败**绝不回滚**已经成功的写，也绝不让调用方以为写失败。钩子内部抛错被吞掉并记日志，`appendRecord` 照常返回。
- 内容没变时不写文件（不白动 `mtime`）—— 这条在刷新器里，不在钩子里。

**失败长什么样**：答完题关掉标签页，第二天再看那份文件，它描述的是前一天（实测磁盘 946 字节 vs 同库渲染 1405 字节，差一整节「练习」）；或者刷新被 `await` 并把异常冒出去，用户看到「提交失败」而答案其实已经存好 —— 后者比前者更糟。

**判据落点**：
- `tests/persistence/xq-probe-recorder.test.ts` 的 `onRecorded` 组 4 条 —— 真的插了新事实叫一次 / 重复投递不叫 / `correct === null` 全跳过时不叫 / 钩子自己炸了不影响 `inserted: 2`。
- `tests/agent-runtime/learner-state-refresh.test.ts` 5 条 —— 库连不上也不抛 / 没配路径时在碰库之前就返回 / 路由的 `onRecorded` 用的是 `pool` 而不是新建 / 复习成功分支也刷 / 两处都是 `void`。

**两边各自要满足**：写路径侧只负责「通知」，不判断内容变没变（那是刷新器的事）；刷新器侧永不抛、永不因为失败进重试队列（幂等，下一次写会再触发）。

### SR-F11.11 计划必须与事实对得上（2026-11-09 落地）

- **输入**：一道错题已经排了四关（1 / 3 / 7 / 15 天），到期日当天学习者在复习界面里对它做出了三种反应之一 —— 答对、答错、跳过。

- **期望**：三种反应都必须把那一关**收掉**，使「今天到期的复习」里不再出现它。答对与答错**另外**各写一条事件（`review_passed` / `review_failed`），事件里带 `round` 与 `outcome`；跳过**不写事件**（它不是一次学习行为，十六个 kind 里也没有它）。顺序固定为**先写事实、再改计划**：关不存在时整笔拒绝，不写假事实。答错时四关**全部重排**回未完成（不是只把这一关标错）。同一请求重投两次，事件只落一条、排期状态不变。

- **失败长什么样**：排期里的关到期后永远清不掉，越积越多；为了清掉它直接删排期行，「他做错了」这件事不可考；`skip` 也写一条 `review_passed`，状态层以为他答对了；先改排期后写事件且事件失败，那一关关掉了但失败计数少一次；重试时重新取 `now()`，同一关一条失败变两条，计数翻倍。

- **判据落点**：
  - 写入器 `tests/persistence/xq-review-recorder.test.ts` 11 条 —— 答对写一条 `review_passed` 且只关这一关（后三关不动）；答错写一条 `review_failed` 且四关全部重排回未完成；跳过不写任何事件只标掉这一关；这一关不存在时抛 `XqReviewRoundMissingError` 且不写任何事件；同一时刻重投两次只留一条事件（`duplicate: true`，`eventId` 相同）；**真的又错一次（时刻不同）就该是两条**（这正是降级规则要数的）；事件 `payload` 里带 `round` / `outcome` / `concept`（光看 `kind` 分不出是第几关）；记完之后那一关不再出现在 `dueReviews()` 里。
  - 路由 `tests/persistence/xq-reviews-route.test.ts` 10 条 —— 走真路由 + 真写入器：答对 201 且这一关关掉；答错写 `review_failed` 且四关重排；跳过 201 且 `eventId: null`；重投 200 + `duplicate: true` 且库里仍一条；**关不存在回 404 `REVIEW_ROUND_NOT_FOUND` 而不是 400**（请求形状没错，是那一关没了 —— 400 会让客户端以为该改请求）；`outcome` 拼错当场 400；`round` 必须是正整数（`0` / `1.5` / `'1'` 都拒）；缺 `sessionId` 拒；非 POST 405；记完之后 `dueReviews()` 少一条且不再含第 1 关。

- **做错几次会改变排期（2026-11-10 补，P5 四关重置降级）**：
  - **规则**：重置时用哪一行阶梯，由「这道题以前失败过几次」决定。第 0 次（第一次做错）走 `[1,3,7,15]`，第 1 次及以上走 `[3,7,15,30]`，**整行后移**，行内仍严格递增。
  - **计数口径**：`kind = 'review_failed'`，同 `(stage_id, scene_id, question_id)`，`coalesce(payload->>'concept','')` 与排期行一致，且 **`occurred_at` 严格早于这一次**（`<` 不是 `<=`）。严格小于不是风格问题：`recordXqReview` 先写事件再改排期，这一次自己的失败事件若被算进 `prior`，第一次做错就会用上第二行 —— 一期「做错仍回 1/3/7/15」的判决被悄悄推翻。
  - **为什么整行后移而不是按关次逐个加长**：阶梯的语义是「这一轮要走几步」，不是「每一步多长」。按关次加长会得到非递增序列，`due_at` 就不再能当排序依据。
  - **为什么只分两行**：第 N 次失败仍用第二行。更长的间隔只是「把它彻底忘掉」；再细分需要真实数据，而今天一条 `review_failed` 都还没有。
  - **判据**：`tests/persistence/xq-learner-store.test.ts` 25 条（新增三条：第二次起整行后移 3/7/15/30；第 N 次仍用第二行；同一时刻自己的失败事件不算「以前」）。真机 2026-11-10 验过：合成一道题一关，第一次 `fail` 后仍是 `1:1d 2:3d 3:7d 4:15d`，第二次 `fail` 后变成 `1:3d 2:7d 3:15d 4:30d`。

- **两边各自要满足**：
  - 写入侧：必须自己确认那一关存在（不能指望数据库外键 —— 排期表没有指向事件的外键）；事件的幂等键只由本来稳定的字段派生，重试必须复用同一个 `occurredAt`。
  - 读取侧（今天还不存在）：`skip` 不得计入任何「做错次数」；`review_passed` 只有在延迟足够长时才算「会了」的证据（`xq-mastery.ts` 的置信下界负责，不在这一层）。
