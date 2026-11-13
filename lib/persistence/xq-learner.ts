/**
 * 学情（xq）：把「答过一次题」变成能被反复算出来的状态。
 *
 * 为什么单独一组表，而不是往 `runtime_records` 上挂列：
 *
 * 1. `runtime_records` 属于 `@openmaic/storage` 这个上游包，它的迁移集只有
 *    一个 version（`RUNTIME_PG_MIGRATIONS`），加列必须写 version 2 并改动上游包；
 *    我们改上游的每一次都会在下次合并 v1.3.x 时变成冲突。
 * 2. 那张表是**会话记录**：一条 = 一次答题的草稿/提交/复核快照，客户端写。
 *    它没有 `asked_at`、没有逐题对错、没有复习排期，也没法按知识点聚合。
 * 3. 学情要按**知识点**聚合，而知识点不是会话的属性。
 *
 * 所以这里是外挂的一组表。三条硬规矩：
 *
 * - **不改任何现有表**。全部 `CREATE TABLE IF NOT EXISTS` + 独立的 store 名。
 * - **主键必须带 `stage_id`**。全库实测 234 页里有 35 个 scene id 跨课程复用，
 *   其中 34 个连页类型都不一样 —— 只按 `scene_id` 建键会把两门课的题算成一题。
 * - **同一份事实只落一处**。对错落 `xq_probe_item`，掌握度是从它算出来的
 *   （`xq_cell_state` 是缓存，可随时整表重算），复习排期落 `xq_review_schedule`。
 *   「谁在哪天答了什么」永远只有一个答案。
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

/**
 * 版本 1：全部表。
 *
 * 一次建完而不是按功能拆版本，理由是这个 store 还没有任何已部署的数据库 ——
 * 拆分版本是为「已经有人跑着旧版本」准备的，现在没有。等它上线之后，
 * 每一处改动才需要一个新的 version。
 *
 * 所有表都用 `IF NOT EXISTS`，所以重跑是幂等的；`transaction: false` 是因为
 * `up` 是一整段多语句 SQL 字符串（`applySchemaMigrations` 对字符串按单批执行）。
 */
export const XQ_LEARNER_SCHEMA = `
-- ---------------------------------------------------------------------------
-- 一、观测：一条 = 谁在哪天答了哪道题、对没对、答之前多自信
-- ---------------------------------------------------------------------------
-- 这张表是**唯一的事实源**。掌握度、复习排期都是从这里算的派生量，
-- 所以它只追加、不更新（唯一的例外是 \`counted_n\`：同题重测时把 1.0 降成 0.5，
-- 表示这一条证据只算半题的份量）。
--
-- \`asked_at\` 不在 \`runtime_records\` 里 —— 那里的时间戳是会话创建时间，
-- 同一天做十轮练习会全部撞在一起，排期没法算。所以这里必须自带。
CREATE TABLE IF NOT EXISTS xq_probe_item (
  id                bigserial PRIMARY KEY,
  task_id           text NOT NULL,
  stage_id          text NOT NULL,
  scene_id          text NOT NULL,
  question_id       text NOT NULL,
  asked_at          timestamptz NOT NULL,
  correct           boolean NOT NULL,
  confidence_pre    smallint CHECK (confidence_pre IN (25, 50, 75, 95)),
  elapsed_ms        integer,
  same_day_retest   boolean NOT NULL DEFAULT false,
  counted_n         numeric(3,1) NOT NULL DEFAULT 1.0,
  source            text NOT NULL CHECK (source IN ('existing', 'generated', 'manual')),
  UNIQUE (task_id, stage_id, scene_id, question_id, asked_at)
);

CREATE INDEX IF NOT EXISTS xq_probe_item_page_idx
  ON xq_probe_item (stage_id, scene_id, asked_at);

CREATE INDEX IF NOT EXISTS xq_probe_item_recent_idx
  ON xq_probe_item (asked_at DESC);

-- ---------------------------------------------------------------------------
-- 二、cell 状态：一页一格，是 xq_probe_item 的缓存
-- ---------------------------------------------------------------------------
-- 可以整表删掉重算，不丢任何事实。留下来的理由是每次都重算要把 174 条记录
-- 全扫一遍，而它在每轮对话开头都会被读（状态文件）。
--
-- \`tri\` 只有三态，不是五态：程天学的「未掌握/掌握部分/已掌握」在 UI 上画三个
-- 词，但阈值 tips 写 60/70/80、星图着色用 40/70 两档 —— 两套口径同时存在。
-- 这里只留三态，把阈值留在算它的那一处（\`xqCellTri\`），这样改阈值不改表。
CREATE TABLE IF NOT EXISTS xq_cell_state (
  stage_id    text NOT NULL,
  scene_id    text NOT NULL,
  tri         text NOT NULL CHECK (tri IN ('known', 'not-learned', 'unknown')),
  n           numeric(4,1) NOT NULL DEFAULT 0,
  k           numeric(4,1) NOT NULL DEFAULT 0,
  lb5         numeric(4,3),
  ub95        numeric(4,3),
  reason      text CHECK (reason IN ('no-quiz', 'too-few-items', 'mixed', 'not-selected')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stage_id, scene_id)
);

-- ---------------------------------------------------------------------------
-- 三、题 → 概念：今天唯一的来源是课程计划里的 keyPoint
-- ---------------------------------------------------------------------------
-- 全库实测：234 页 100% 有 outlineId，138 页能对上计划条目，其中只有 37 页的
-- 条目带 keyPoints（Java 90 页里 37 页）。所以这张表**大部分课是空的**，
-- 这是事实不是缺陷 —— 空的时候掌握度只能算到页，算不到知识点，
-- 而「算到页」已经能让错题四关跑起来（四关按题排，不按概念排）。
--
-- \`concept_kind\` 只有两种：'keypoint' 是课程作者写的原字符串；
-- 'chapter-band' 是拿课程章节名兜底（confidence 只有 0.50，因为它只能说明
-- 「这题大概属于这一章」）。
CREATE TABLE IF NOT EXISTS xq_question_concept (
  stage_id     text NOT NULL,
  scene_id     text NOT NULL,
  question_id  text NOT NULL,
  concept      text NOT NULL,
  concept_kind text NOT NULL CHECK (concept_kind IN ('keypoint', 'chapter-band')),
  link         text NOT NULL CHECK (link IN ('exact', 'normalized', 'band')),
  confidence   numeric(3,2) NOT NULL,
  PRIMARY KEY (stage_id, scene_id, question_id, concept, concept_kind)
);

CREATE INDEX IF NOT EXISTS xq_question_concept_concept_idx
  ON xq_question_concept (concept);

-- ---------------------------------------------------------------------------
-- 四、错题四关：1/3/7/15 天
-- ---------------------------------------------------------------------------
-- 程天学的原文规则：做错进第 1 关（第 1 天），过了进第 3 天，再过了进第 7 天，
-- 最后第 15 天；任何一关做错**回到第 1 关**。
--
-- 为什么是四行而不是一行存 \`next_due_at\`：一行只能表达「下次什么时候」，
-- 表达不了「第几关」。而「回到第 1 关」是一个必须能看见的动作 ——
-- 把 round 从 3 改成 1，历史四行还在，谁都能看出来它退过。
CREATE TABLE IF NOT EXISTS xq_review_schedule (
  id           bigserial PRIMARY KEY,
  stage_id     text NOT NULL,
  scene_id     text NOT NULL,
  question_id  text NOT NULL,
  concept      text NOT NULL DEFAULT '',
  round        smallint NOT NULL CHECK (round BETWEEN 1 AND 4),
  due_at       timestamptz NOT NULL,
  done_at      timestamptz,
  outcome      text CHECK (outcome IN ('pass', 'fail', 'skip')),
  UNIQUE (stage_id, scene_id, question_id, concept, round)
);

CREATE INDEX IF NOT EXISTS xq_review_schedule_due_idx
  ON xq_review_schedule (due_at) WHERE done_at IS NULL;

-- ---------------------------------------------------------------------------
-- 五、接入任务：一次「我要学点什么」
-- ---------------------------------------------------------------------------
-- \`confidence\` 三档直接抄程天学的 confidence 判定：
--   probe-backed = 有实测证据，可以据此跳过
--   band-only    = 只知道大概在哪个领域，**不能据此跳过**
--   guess        = 明说「我不知道你会不会」
-- 三档不许合并成两档：合并之后「按课程带跳过」与「按答题跳过」就没区别了，
-- 而前者在实测里常常是错的（course-band votes ratio 1.38 < 1.5 的那些）。
CREATE TABLE IF NOT EXISTS xq_intake_task (
  task_id     text PRIMARY KEY,
  goal        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('course', 'outline', 'utterance')),
  source_refs jsonb NOT NULL,
  confidence  text NOT NULL CHECK (confidence IN ('probe-backed', 'band-only', 'guess')),
  status      text NOT NULL CHECK (status IN ('open', 'teaching', 'done', 'abandoned')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

-- ---------------------------------------------------------------------------
-- 六、对齐单元：一个任务被切成哪些「值得先教的东西」
-- ---------------------------------------------------------------------------
-- \`proxy\` 是关键位：true 表示这一格的结论来自推断（课程带、keyPoint 覆盖率），
-- 不是来自答题。SR/F11 的规矩是「代理证据不许当跳过依据」，
-- 所以这个布尔必须在数据层就存在 —— 没有它，下游只能靠字符串里有没有
-- "band:" 前缀去猜，那是一定会漏的。
CREATE TABLE IF NOT EXISTS xq_alignment_unit (
  task_id    text NOT NULL REFERENCES xq_intake_task(task_id) ON DELETE CASCADE,
  unit_id    text NOT NULL,
  idx        integer NOT NULL,
  label      text NOT NULL,
  unit_kind  text NOT NULL CHECK (unit_kind IN ('cell', 'chapter', 'keypoint')),
  stage_id   text,
  scene_id   text,
  chapter_id text,
  key_point  text,
  tri        text NOT NULL CHECK (tri IN ('known', 'half', 'not-learned', 'unknown')),
  n          numeric(4,1) NOT NULL DEFAULT 0,
  k          numeric(4,1) NOT NULL DEFAULT 0,
  lb5        numeric(4,3),
  ub95       numeric(4,3),
  anchor     text NOT NULL CHECK (anchor IN ('probe', 'course-band', 'keypoint-weak')),
  proxy      boolean NOT NULL,
  priority   text,
  kn_level   smallint,
  ord        integer NOT NULL,
  evidence   jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocked_by jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (task_id, unit_id)
);

CREATE INDEX IF NOT EXISTS xq_alignment_unit_order_idx
  ON xq_alignment_unit (task_id, ord);

-- ---------------------------------------------------------------------------
-- 七、概念身份：一个概念只有一行，**名字不是主键**
-- ---------------------------------------------------------------------------
-- 为什么 id 是 \`c_\` + 12 位十六进制而不是名字或外部 id：
--   拿名字当键 —— 同形异义会把两个概念合成一个（实测「构造」在算法竞赛图里
--     指构造题，在 Java 课里指构造方法，一次匹配就把 8 页错挂上去）；
--   拿外部 id 当键 —— 外部的图会改版、会改名，而且一个概念可能同时在两张
--     外部图里出现（多对一）。praxis 的做法是把「图id 冒号 节点id」拼进主键，一个按冒号切分再 join 的查询就让 3 行静默变 6 行。
--     实测一个 \`split_part(id, ':', 2)\` 的 join 就让 3 行静默变 6 行。
-- 所以主键只是一个不透明的稳定串，名字与外部 id 都放映射表。
CREATE TABLE IF NOT EXISTS xq_concept (
  id             text PRIMARY KEY,
  canonical_name text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('concept', 'topic', 'tool')),
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'merged', 'retired')),
  merged_into    text REFERENCES xq_concept(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'merged' OR merged_into IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS xq_concept_name_idx
  ON xq_concept (canonical_name, kind);

-- 别名表是**查找入口**：任何「按名字找概念」都必须走这里，不许直接查
-- xq_concept.canonical_name。理由：一个概念会有一堆叫法（中/英/缩写/
-- 课程作者的口语），只认 canonical_name 的话，第二个叫法进来就是新概念。
-- \`source\` 记录这个别名从哪来，合并不掉历史。
--
-- ★★ 主键必须是 (alias, kind, concept_id)，**不是** (alias, kind)。
--    同形异义是实测风险：「构造」在算法竞赛里指构造题、在 Java 课里指构造方法，
--    全库 25 页命中这两个义项。主键只到 (alias, kind) 时，给第二个概念写同一个
--    别名会直接 duplicate key ⇒ 同形异义**写不进去**，只能被迫把两个概念合成
--    一个 —— 这正是 SR-F11.8 要防的事。加上 concept_id 之后，一个别名可以指向
--    多个概念。
--
--    那「一个名字到底指谁」怎么保证不含糊？由 ambiguous 列显式声明：默认 false，
--    此时 (alias, kind) 必须唯一（下面那条部分唯一索引管住）；要把一个名字同时
--    挂给第二个概念，必须先把原有的置 true，再插新的。这样「含糊」是一条
--    **被记录下来的判断**，不是一次静默覆盖 —— 而且 contains_scope 那句
--    「模糊的名字不许直接匹配」在 SQL 层就有了落点。
CREATE TABLE IF NOT EXISTS xq_concept_alias (
  alias      text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('concept', 'topic', 'tool')),
  concept_id text NOT NULL REFERENCES xq_concept(id) ON DELETE CASCADE,
  source     text NOT NULL,
  confidence numeric(3,2) NOT NULL DEFAULT 1.00,
  ambiguous  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (alias, kind, concept_id)
);

-- 不含糊的别名，一个名字只能指一个概念。含混的（ambiguous=true）不进这条索引，
-- 因此可以一名多指 —— 但每一行都带着 ambiguous 这个可查的事实。
CREATE UNIQUE INDEX IF NOT EXISTS xq_concept_alias_unambiguous_idx
  ON xq_concept_alias (alias, kind)
  WHERE ambiguous = false;

CREATE INDEX IF NOT EXISTS xq_concept_alias_concept_idx
  ON xq_concept_alias (concept_id);

-- 外部 id 映射。主键是 (source_graph, external_id) ⇒ 多个外部 id 可以指向
-- 同一个概念（多对一），这正是 SR-F11.8 要求的方向。
-- 反过来的「一个外部 id 指向多个概念」不允许 —— 那说明归并还没做完。
CREATE TABLE IF NOT EXISTS xq_concept_external_ref (
  source_graph text NOT NULL,
  external_id  text NOT NULL,
  concept_id   text NOT NULL REFERENCES xq_concept(id) ON DELETE CASCADE,
  confidence   numeric(3,2) NOT NULL DEFAULT 1.00,
  PRIMARY KEY (source_graph, external_id)
);

CREATE INDEX IF NOT EXISTS xq_concept_external_ref_concept_idx
  ON xq_concept_external_ref (concept_id);

-- ---------------------------------------------------------------------------
-- 八、出现记录：概念在哪些页/讲/题上出现过（Q1 定的双层图）
-- ---------------------------------------------------------------------------
-- 概念是一等公民，页面不是概念的容器 —— 概念挂在事件上，事件再挂到页面。
-- \`weight\` 是这一页讲这个概念的比重（0–1）：一页顺带提一句 vs 一页专门讲它，
-- 是两个不同的证据。没有这个权，「出现在哪页」就只剩是/否，掌握度没法加权
-- （程天学的口径就是「关联题按比重加权得分率」）。
-- ★★ 页这一侧必须是**复合外键** (stage_id, scene_id) → document_scenes(stage_id, id)，
--    不能只存两个裸 text 列。实测：没有这个外键时能插进
--    「stage_id='stage-DOES-NOT-EXIST', scene_id='scene-p999'」并且成功 —— 那是一条
--    永远指不到任何页的出现记录，它会静默污染覆盖率（「这个概念挂了 3 页」
--    其实挂了 1 页 + 2 条幻影）。
--
--    为什么复合而不是只管 scene_id：document_scenes 的主键是 (stage_id, id)，
--    而 scene_id 会跨课复用（实测 234 页里 35 个 scene id 跨 stage、34 个连类型都
--    不同）⇒ 单列外键根本建不出来，也没有正确语义。
--
--    ON DELETE CASCADE 是刻意的：页被重生成删掉时，指向它的出现记录应当一起消失，
--    否则「覆盖率」会永远停在一个包含幽灵页的数上。要保留「这一页曾经讲过这个」
--    的历史，那是别的事（教学历史在课程文档的版本里，不在这张表）。
CREATE TABLE IF NOT EXISTS xq_concept_occurrence (
  concept_id text NOT NULL REFERENCES xq_concept(id) ON DELETE CASCADE,
  stage_id   text NOT NULL,
  scene_id   text NOT NULL,
  weight     numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (weight > 0 AND weight <= 1),
  source     text NOT NULL CHECK (source IN ('keypoint', 'title', 'body', 'manual')),
  PRIMARY KEY (concept_id, stage_id, scene_id),
  FOREIGN KEY (stage_id, scene_id)
    REFERENCES document_scenes (stage_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS xq_concept_occurrence_page_idx
  ON xq_concept_occurrence (stage_id, scene_id);

-- ---------------------------------------------------------------------------
-- 九、先修边：每条边都要有理由
-- ---------------------------------------------------------------------------
-- \`reason\` 不许为空，这是从三处独立结论合出来的：
--   Marble os-taxonomy：4,003 条边 100% 带 reason，平均 85.2 字符；
--   cs-math-skill-tree 的 prereq-notes.json：每条边一句理由 + 课程出处；
--   polymath：strength + 必填 reason。
-- 没理由的边在三个月后没人敢删，也没人能判断它是不是同形异义造的假边。
--
-- \`strength\` 抄 polymath 的三档（strict 47 / recommended 36 / helpful 7），
-- **不抄**它的 \`crossDiscipline\` 布尔 —— 实测 21 条 true 里 7 条两端同属一个
-- discipline，字段本身自相矛盾。
CREATE TABLE IF NOT EXISTS xq_concept_edge (
  from_id  text NOT NULL REFERENCES xq_concept(id) ON DELETE CASCADE,
  to_id    text NOT NULL REFERENCES xq_concept(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('prereq', 'contains')),
  strength text CHECK (strength IN ('strict', 'recommended', 'helpful')),
  reason   text NOT NULL CHECK (length(btrim(reason)) > 0),
  source   text NOT NULL,
  PRIMARY KEY (from_id, to_id, relation),
  CHECK (from_id <> to_id)
);

CREATE INDEX IF NOT EXISTS xq_concept_edge_to_idx
  ON xq_concept_edge (to_id, relation);

-- ---------------------------------------------------------------------------
-- 十、接入提案：外来内容里没对上的概念
-- ---------------------------------------------------------------------------
-- SR-F11.9 的三段判定落在 \`tri\`：hit / suspect / miss。
-- 三段都必须落库而不是只在内存里比对一遍，理由是同形异义是实测风险：
-- 拿一张 130 节点的算法竞赛图匹配本库 234 页，命中的 10 页里 8 页是错的。
-- 如果 miss/suspect 不落库，同一份材料下次再来会重提一遍，人每次都要重判。
--
-- \`status='accepted'\` 之后才允许建概念并写 occurrence；\`rejected\` 要留
-- \`decided_at\` 与 \`decided_by\`，因为「上次为什么拒了」是下次判定的输入。
CREATE TABLE IF NOT EXISTS xq_intake_proposal (
  id                bigserial PRIMARY KEY,
  task_id           text,
  external_name     text NOT NULL,
  external_source   text NOT NULL,
  external_kind     text NOT NULL DEFAULT 'concept',
  tri               text NOT NULL CHECK (tri IN ('hit', 'suspect', 'miss')),
  matched_concept_id text REFERENCES xq_concept(id) ON DELETE SET NULL,
  confidence        numeric(3,2),
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed', 'accepted', 'rejected')),
  decided_at        timestamptz,
  decided_by        text,
  UNIQUE (external_source, external_name, external_kind)
);

CREATE INDEX IF NOT EXISTS xq_intake_proposal_status_idx
  ON xq_intake_proposal (status, tri);
`;

/**
 * 版本 2：会话、事件、人写的画像，外加四列。
 *
 * ★ **只加不改**。版本 1 的十二张表里已经有七张有真实数据
 * （`xq_probe_item` 56 / `xq_cell_state` 7 / `xq_concept` 104 / `xq_concept_alias` 357 /
 * `xq_concept_external_ref` 63 / `xq_concept_occurrence` 644 / `xq_concept_edge` 105），
 * 所以这一版里没有一处 `ALTER ... TYPE`、没有一处改约束 —— 全是
 * `CREATE TABLE IF NOT EXISTS` 与 `ADD COLUMN IF NOT EXISTS`。
 * 换主键那件事（`xq_concept_alias` 要从 `(alias, kind)` 变成
 * `(alias, kind, concept_id)`，否则「构造」这种一词两义挂不上两个概念）
 * 要迁移 357 行，留到下一版。
 *
 * 三张新表各自的理由：
 *
 * - `xq_learner_persona`：目标与无障碍偏好是**人写的**，不是推断出来的。
 *   「这个人想干什么」无法从答题记录推出来，硬推就是编。单行表不是一个
 *   key-value 表 —— PNP 是一份 statement（ISO/IEC 24751），拆成多行会让
 *   「哪几行属于这个人」变成每次都要判断的问题。
 * - `xq_session` + `xq_event`：现在没有地方回答「今天学了什么」「这次练了多久」。
 *   为什么不能复用 `runtime_records`：那张表的时间戳是**会话创建时间**，
 *   不是事件时刻（同一天做十轮会全部撞在一起）；逐题对错埋在无索引的 JSONB 里；
 *   而且它属于上游包，加列要改上游的迁移集。
 *
 * ★ 会话与事件是**事实**，`xq_cell_state` 是**缓存** —— 掌握度不许写进这两张表，
 *   否则每次掌握度变都要 UPDATE 会话行，只追加与双时间线立刻失效。
 *
 * ★ 也不建 FSRS 那三张表（`xq_grading` / `xq_card_state` / `xq_scheduler_config`）：
 *   我方排期只有四关 1/3/7/15（`xq_review_schedule`），两套排期源并存时
 *   「同一道错题到底哪天到期」没有答案。FSRS 至少要四档评分（Again/Hard/Good/Easy），
 *   而现在只有 `correct boolean`；把 `correct` 硬映射成 1/3 会让
 *   「按 rating 取不同权重」那条公式退化成两条曲线。
 */
export const XQ_LEARNER_V2 = `
-- ---------------------------------------------------------------------------
-- 十三、人写的画像：目标与无障碍偏好（一行 = 这个人）
-- ---------------------------------------------------------------------------
-- ★ 这张表里**不存任何推断量**：不存掌握度、不存学习风格、不存元认知分数。
--   掌握度是会变的派生量（在 xq_cell_state），学习风格（VARK）已被证伪，
--   元认知量表的分数在单人本地部署里没有常模可比。
CREATE TABLE IF NOT EXISTS xq_learner_persona (
  learner_id      text        PRIMARY KEY DEFAULT 'local-owner',
  goal_long_term  text,
  goal_near_term  text,
  goal_kind       text        CHECK (goal_kind IN ('foundation', 'exam', 'project', 'unknown')),
  native_language text,
  pnp_font_scale  numeric(3,2),
  pnp_read_aloud  boolean,
  pnp_input_mode  text        CHECK (pnp_input_mode IN ('keyboard', 'voice', 'mixed')),
  pnp_notes       text,
  declared_at     timestamptz NOT NULL DEFAULT now(),
  revised_at      timestamptz
);

-- ---------------------------------------------------------------------------
-- 十四、会话：一次「坐下来学」
-- ---------------------------------------------------------------------------
-- ★ 为什么不是一张 learn_event：会话有跨事件的派生量（活跃时长、答了几题、
--   看了几页）。塞进事件表就得重复存 N 遍，而且改一次要 UPDATE 历史行。
-- ★ session_id 取本会话第一条事件的 event_id —— 不发明第二个 ID 生成器。
-- ★ started_at / ended_at / recorded_at 三列不许合并：前两个是现实里发生的
--   （客户端时钟，可回填），recorded_at 是服务端记账时刻，回填不许改它。
CREATE TABLE IF NOT EXISTS xq_session (
  session_id      uuid        PRIMARY KEY,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  task_id         text        REFERENCES xq_intake_task(task_id) ON DELETE SET NULL,
  intent          text,
  planned_scope   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- 结束方式：terminated 是学习者主动结束；三个 idle_* 是不同内容形态的空闲阈值
  -- （导航 5 分钟 / 默认 30 分钟 / 阅读 60 分钟 —— 数值来自事件间隔的双峰拟合，
  -- 不是「学满 30 分钟才算学会」）；abandoned / crash 是我方兜底。
  end_reason      text        CHECK (end_reason IN (
                                'terminated', 'idle_5m', 'idle_60m', 'idle_30m',
                                'day_boundary', 'abandoned', 'crash')),
  event_n         integer     NOT NULL DEFAULT 0,
  probe_n         integer     NOT NULL DEFAULT 0,
  probe_correct_n integer     NOT NULL DEFAULT 0,
  scene_n         integer     NOT NULL DEFAULT 0,
  active_ms       bigint,
  wall_ms         bigint,
  self_report     smallint    CHECK (self_report BETWEEN 1 AND 5),
  seq_no          integer     NOT NULL,
  local_day       date        NOT NULL,
  revisit_of      uuid        REFERENCES xq_session(session_id) ON DELETE SET NULL,
  schema_ver      smallint    NOT NULL DEFAULT 1,
  UNIQUE (local_day, seq_no)
);

CREATE INDEX IF NOT EXISTS xq_session_day_idx  ON xq_session (local_day, seq_no);
CREATE INDEX IF NOT EXISTS xq_session_open_idx ON xq_session (started_at) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- 十五、事件：这一刻发生了什么（只追加，不 UPDATE、不 DELETE）
-- ---------------------------------------------------------------------------
-- ★ 撤销靠再写一条 kind='voided' 的事件（voided_by 列指向它），不靠 UPDATE ——
--   「这次提交是错的」本身也是一件发生过的事。
-- ★ occurred_at 与 recorded_at 分列：客户端时钟可能错、可能被回填，
--   服务端记账时刻不许改。合并成一列就再也分不清「他说他那时在看」与
--   「我们那时收到了他说的」。
-- ★ stage_id 必须带：实测 234 页里 35 个 scene id 跨课程复用，34 个连页类型都不同。
--   只按 scene_id 聚会把两门课算成一门。
-- ★ dwell_ms 只做诊断标签，**不进任何判定式**：停留时长与学习收益的相关性
--   在多个已发表研究里都是弱或无（含一个已发表的零结果），而「活动量大 ⇒ 成绩差」
--   也有实测样例。它的用处只有一个：说「这题答得太快，可能是猜的」。
CREATE TABLE IF NOT EXISTS xq_event (
  event_id      uuid        PRIMARY KEY,
  session_id    uuid        NOT NULL REFERENCES xq_session(session_id) ON DELETE CASCADE,
  occurred_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  kind          text        NOT NULL CHECK (kind IN (
                              'session_started', 'session_ended', 'session_abandoned',
                              'page_viewed', 'page_skipped', 'page_revisited', 'page_completed',
                              'answer_submitted', 'answer_attempted',
                              'hint_requested', 'note_written', 'search_performed',
                              'review_due_opened', 'review_passed', 'review_failed',
                              'voided')),
  stage_id      text,
  scene_id      text,
  question_id   text,
  concept_id    text        REFERENCES xq_concept(id) ON DELETE SET NULL,
  dwell_ms      integer,
  dwell_capped  boolean     NOT NULL DEFAULT false,
  away_ms       integer,
  content_words integer,
  correct       boolean,
  confidence_pre smallint   CHECK (confidence_pre IN (25, 50, 75, 95)),
  -- 提示分两类：instrumental 是「这条提示怎么说」，executive 是「去执行这一步」。
  -- 两者的折扣不同，所以必须分型而不是只记「用过提示」。
  hint_subtype  text        CHECK (hint_subtype IN ('instrumental', 'executive')),
  outcome       text        CHECK (outcome IN ('pass', 'fail', 'skip')),
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key    text        UNIQUE,
  schema_ver    smallint    NOT NULL DEFAULT 1,
  voided_by     uuid        REFERENCES xq_event(event_id),
  source        text        NOT NULL DEFAULT 'self'
                            CHECK (source IN ('self', 'model', 'system', 'import')),
  CONSTRAINT xq_event_hint_subtype_chk
    CHECK (kind <> 'hint_requested' OR hint_subtype IS NOT NULL),
  CONSTRAINT xq_event_dwell_chk
    CHECK (dwell_ms IS NULL OR dwell_ms >= 0)
);

CREATE INDEX IF NOT EXISTS xq_event_session_idx ON xq_event (session_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS xq_event_kind_idx    ON xq_event (kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS xq_event_scene_idx   ON xq_event (stage_id, scene_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 十六、四列：每列都对应一条「现在的算法拿不到这个量」
-- ---------------------------------------------------------------------------
-- confidence_post：答题后再问一次「你刚才有多确定」。同一个量、同一批人，
--   做题前问与做题后问的自评准确性差一大截（r=0.33 vs r=0.53）——
--   现有的 confidence_pre 正好是差的那一种问法。成本是一列 + 一个界面步骤。
ALTER TABLE xq_probe_item
  ADD COLUMN IF NOT EXISTS confidence_post smallint
    CHECK (confidence_post IN (25, 50, 75, 95));

-- is_variant：四关的全部意义是「同一知识点的**变式**题」，不是「同一道题再答一遍」。
--   xq_review_schedule 只有 question_id，说不出第 3 天那道是不是换了题面。
ALTER TABLE xq_review_schedule
  ADD COLUMN IF NOT EXISTS is_variant boolean NOT NULL DEFAULT false;

-- n_delayed / k_delayed：延迟之后还答对的比例 —— 这是「掌握」与「刚记住」的区别。
--   现有 n/k 不含 Δ=now−asked_at，所以 Beta 区间统计上正确（Beta-二项共轭，
--   下界取 5% 分位），但**构念上测的是「曾经答对的比例」，不是「隔几天还能不能取出来」**。
--   实测的反面教材：反复测全部项 vs 答对就撤，一周后的保持率是 80% vs 33–36%，
--   效应量 d=4.03，而且被测试者自己预测不出来。
--   3 天的门槛不是文献值，是「四关的第 2 关就是第 3 天」。
--   两列刻意为 0 默认：老行没有延迟分层证据，不该被当成「测过且答对」。
ALTER TABLE xq_cell_state
  ADD COLUMN IF NOT EXISTS n_delayed numeric(4,1) NOT NULL DEFAULT 0;
ALTER TABLE xq_cell_state
  ADD COLUMN IF NOT EXISTS k_delayed numeric(4,1) NOT NULL DEFAULT 0;
`;

// ---------------------------------------------------------------------------
// 十七、图谱版本：让「这个概念是哪一版进的图」成为机器能查的事实
// ---------------------------------------------------------------------------
// ★ 为什么不是只加一列 created_in 就完：没有版本表，created_in 只是个整数，
//   「1」既是版本号又是裸数字，写错了没人拦。有了 xq_graph_version，才可能
//   把「这一版冻结之后不许再往里写」变成一条**偏索引**（下面那条 one_open），
//   而不是靠人记得。
// ★ 版本用 integer 不用 timestamptz：时间是事实，版本是**可重放的批号**；
//   now() 在同一事务里也不稳定 —— 两个概念在同一次导入里拿到不同秒数时，
//   「它们同属一版」就说不清了。
// ★ 顺序陷阱（实测）：必须先有 xq_graph_version 行，才能写 created_in，
//   否则 xq_concept_created_in_fkey 直接拒。
export const XQ_LEARNER_V3 = `
CREATE TABLE IF NOT EXISTS xq_graph_version (
  version     integer     PRIMARY KEY CHECK (version >= 1),
  label       text        NOT NULL UNIQUE CHECK (length(btrim(label)) > 0),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  frozen_at   timestamptz,
  CONSTRAINT xq_graph_version_freeze_order
    CHECK (frozen_at IS NULL OR frozen_at >= created_at)
);

-- 同一时刻只允许一个「开放版本」：否则 created_in 写哪个都在猜。
-- ((true)) 这个常量表达式让偏索引把「所有未冻结行」收成一组。
CREATE UNIQUE INDEX IF NOT EXISTS xq_graph_version_one_open
  ON xq_graph_version ((true)) WHERE frozen_at IS NULL;

-- 既有 104 个概念属于第 1 版。先建版本行，再回填（见下一条迁移）。
INSERT INTO xq_graph_version (version, label, note)
  VALUES (1, 'baseline', '本机种子图；早于版本化之前就已存在的概念都归这一版')
  ON CONFLICT (version) DO NOTHING;
`;

// ---------------------------------------------------------------------------
// 十八、概念表 expand + 重测链
// ---------------------------------------------------------------------------
// 这张表已经在库里（6 列、104 行），所以只能 ALTER，不能 CREATE TABLE IF NOT
// EXISTS —— 那不会补列。
// ★ 这条迁移**不** opt out 事务：建版本行 + 补列 + 回填 + 加约束是一个整体，
//   半途失败必须整体不生效，否则会留下「列有了但约束没上」的半截状态。
//   它只在启动时跑一次，锁的持有时间可以接受。
export const XQ_LEARNER_V4 = `
ALTER TABLE xq_concept ADD COLUMN IF NOT EXISTS anchors    text[]      NOT NULL DEFAULT '{}';
ALTER TABLE xq_concept ADD COLUMN IF NOT EXISTS created_in integer;
ALTER TABLE xq_concept ADD COLUMN IF NOT EXISTS retired_in integer;
ALTER TABLE xq_concept ADD COLUMN IF NOT EXISTS revived_at timestamptz;
ALTER TABLE xq_concept ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 既有行回填到第 1 版。放在加约束之前。
UPDATE xq_concept SET created_in = 1 WHERE created_in IS NULL;

-- 约束没有 ADD CONSTRAINT IF NOT EXISTS，所以用 DO 块探一次 pg_constraint。
-- 这样这条迁移可以安全重跑（transaction 提交失败后整条会重来）。
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_concept_id_shape') THEN
    ALTER TABLE xq_concept ADD CONSTRAINT xq_concept_id_shape
      CHECK (id ~ '^c_[0-9a-f]{12}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_concept_name_nonempty') THEN
    ALTER TABLE xq_concept ADD CONSTRAINT xq_concept_name_nonempty
      CHECK (length(btrim(canonical_name)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_concept_created_in_fkey') THEN
    ALTER TABLE xq_concept ADD CONSTRAINT xq_concept_created_in_fkey
      FOREIGN KEY (created_in) REFERENCES xq_graph_version(version);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_concept_retired_in_fkey') THEN
    ALTER TABLE xq_concept ADD CONSTRAINT xq_concept_retired_in_fkey
      FOREIGN KEY (retired_in) REFERENCES xq_graph_version(version);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_concept_retire_order') THEN
    ALTER TABLE xq_concept ADD CONSTRAINT xq_concept_retire_order
      CHECK (retired_in IS NULL OR (created_in IS NOT NULL AND retired_in > created_in));
  END IF;
END
$do$;

-- retest_of：这一次是「同一道题的又一次观测」时指回上一次。
-- counted_n = 0.5 已经能表达「算半题」，加这一列是为了能回答「这是第几次」；
-- 没有它，重测链路只能数总数，数不出「同一道题被测了几轮」。
ALTER TABLE xq_probe_item
  ADD COLUMN IF NOT EXISTS retest_of bigint REFERENCES xq_probe_item(id);
`;

// ---------------------------------------------------------------------------
// 十九、导入批次 + 提案裁决 + 出现记录的证据基础
// ---------------------------------------------------------------------------
// 这一版补的是「一次导入」这个单位。在它之前，`xq_graph_version` 只能被人
// 手动推进（`scripts/advance-graph-version.ts`），推进与「导入了什么」之间没有
// 任何连接 —— 版本号涨了，但没人说得出是哪个文件、哪次抽取、哪一门课。
//
// `xq_import_batch` 就是那条连接：一次导入 = 一批 = 一个内容哈希 + 一个抽取器 +
// 一个图谱版本。它同时回答了「重导会不会重复」：同一份内容、同一个抽取器、
// 同一个版本 ⇒ 主键约束挡住，不新开批。
//
// 三个容易写错的地方：
//
// ★ `UNIQUE NULLS NOT DISTINCT`（PG 15+）。`source_graph` 对自有课程是 NULL，
//   而 PG 默认把 NULL 视为互不相等 ⇒ 不加这条，自有课程每导一次都会新开一批。
//
// ★ `content_hash` 与 `extractor` 都是 NOT NULL 且不许空白。缺一个是「不知道
//   这份内容是什么」，缺另一个是「不知道谁抽的」—— 两者都会让幂等失效，而
//   失效的表现是「静默多出一批」，不是报错。
//
// ★ 提案表的 `decision_pair` 是**双向**的：裁了就必须有裁决人和时间，没裁就
//   不许有。单向约束（只写「accepted 必须有裁决人」）挡不住「status 还是
//   proposed 但已经填了 decided_at」那种半截状态。
export const XQ_LEARNER_V5 = `
CREATE TABLE IF NOT EXISTS xq_import_batch (
  batch_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id      text        NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  origin        text        NOT NULL CHECK (origin IN ('own-course', 'foreign-course', 'material', 'external-graph')),
  source_graph  text,
  source_ref    text,
  content_hash  text        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  extractor     text        NOT NULL CHECK (length(btrim(extractor)) > 0),
  graph_version integer     NOT NULL REFERENCES xq_graph_version(version),
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'abandoned')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz,
  CONSTRAINT xq_import_batch_origin_graph
    CHECK ((origin = 'external-graph') = (source_graph IS NOT NULL)),
  CONSTRAINT xq_import_batch_applied_pair
    CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CONSTRAINT xq_import_batch_applied_order
    CHECK (applied_at IS NULL OR applied_at >= created_at),
  UNIQUE NULLS NOT DISTINCT (stage_id, source_graph, content_hash, extractor, graph_version)
);

CREATE INDEX IF NOT EXISTS xq_import_batch_stage_idx
  ON xq_import_batch (stage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS xq_import_batch_version_idx
  ON xq_import_batch (graph_version);

ALTER TABLE xq_concept_occurrence
  ADD COLUMN IF NOT EXISTS batch_id      uuid REFERENCES xq_import_batch(batch_id) ON DELETE SET NULL;
ALTER TABLE xq_concept_occurrence
  ADD COLUMN IF NOT EXISTS page_hash     text CHECK (page_hash IS NULL OR page_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE xq_concept_occurrence
  ADD COLUMN IF NOT EXISTS outline_order integer;
ALTER TABLE xq_concept_occurrence
  ADD COLUMN IF NOT EXISTS stale_since   timestamptz;
ALTER TABLE xq_concept_occurrence
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE xq_concept_occurrence
  ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz NOT NULL DEFAULT now();

ALTER TABLE xq_intake_proposal
  ADD COLUMN IF NOT EXISTS accepted_concept_id text REFERENCES xq_concept(id) ON DELETE SET NULL;
ALTER TABLE xq_intake_proposal
  ADD COLUMN IF NOT EXISTS signals jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE xq_intake_proposal
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE xq_intake_proposal
  ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE xq_intake_proposal
  ADD COLUMN IF NOT EXISTS seen_count    integer NOT NULL DEFAULT 1 CHECK (seen_count >= 1);
ALTER TABLE xq_intake_proposal
  ADD COLUMN IF NOT EXISTS decision_note text;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_intake_proposal_decision_pair') THEN
    ALTER TABLE xq_intake_proposal ADD CONSTRAINT xq_intake_proposal_decision_pair
      CHECK ((status = 'proposed') = (decided_at IS NULL AND decided_by IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_intake_proposal_accepted_target') THEN
    ALTER TABLE xq_intake_proposal ADD CONSTRAINT xq_intake_proposal_accepted_target
      CHECK (status <> 'accepted' OR accepted_concept_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_intake_proposal_hit_target') THEN
    ALTER TABLE xq_intake_proposal ADD CONSTRAINT xq_intake_proposal_hit_target
      CHECK (tri <> 'hit' OR matched_concept_id IS NOT NULL);
  END IF;
END
$do$;

ALTER TABLE xq_concept_edge
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE xq_concept_edge
  ADD COLUMN IF NOT EXISTS created_in integer REFERENCES xq_graph_version(version);
ALTER TABLE xq_concept_edge
  ADD COLUMN IF NOT EXISTS retired_in integer REFERENCES xq_graph_version(version);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_concept_edge_status') THEN
    ALTER TABLE xq_concept_edge ADD CONSTRAINT xq_concept_edge_status
      CHECK (status IN ('active', 'proposed', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xq_concept_edge_active_needs_strength') THEN
    ALTER TABLE xq_concept_edge ADD CONSTRAINT xq_concept_edge_active_needs_strength
      CHECK (status <> 'active' OR strength IS NOT NULL);
  END IF;
END
$do$;
`;

// ---------------------------------------------------------------------------
// 二十、外来来源单独一档
// ---------------------------------------------------------------------------
// 基线里 `xq_concept_occurrence.source` 只有四档（keypoint / title / body /
// manual），全部是「我们自己从课程大纲与页正文算出来的」。外面那门课接进来时，
// 它带来的页证据也要落成 occurrence（`weight` 0.8），而那一行必须能与我们自己
// 抽的区分开 —— 否则「这个外部课程抽得不准，把它带来的挂载全撤掉」这件事
// 只能一行行认。
//
// ★ 为什么不复用 `body`：`source` 不是给读方看的标签，是**删得掉的依据**。
//   `DELETE … WHERE source LIKE 'foreign-%' AND batch_id = $1` 一句撤干净的前提，
//   是外来行有自己的名字。混进 body 之后，「撤掉那一门外来课」就变成「删掉所有
//   挂在这几页上的 body 行」，会连我们自己抽的一起删。
//
// ★ 为什么代码里的 `GENERATED_SOURCES` 不跟着扩（那份在
//   `xq-concept-occurrence-sync.ts`）：那个常量回答的是「本模块**生成**了哪些
//   来源」，重算时它会删掉这些来源里多出来的行。把 foreign-* 加进去，下一次
//   重算就会把外来课挂的证据当成自己的派生行删掉 —— 而它们来自另一套判断。
//
// 约束先 `DROP … IF EXISTS` 再 `ADD`：`ADD CONSTRAINT` 没有 `IF NOT EXISTS`，
// 而在账本缺失的历史库上 `ensureXqLearnerSchema` 仍会逐条重放，要能重跑。
//
// ★ 顺手修 v5 那条过严的边约束：v5 写的是「active 边必须有 strength」，
//   但 `contains`（单元包含成员）在三份源图里都是没有强弱之分的 —— 归属要么
//   成立要么不成立。基线 DDL 允许 `contains` 的 `strength` 为 NULL，v5 那条
//   约束把它判成非法，于是一条合法数据在 v5 之后写不进去了（判据
//   `tests/persistence/xq-concept-graph.test.ts` 里 `contains` + NULL 的那条
//   一直红着）。这里把 `relation = 'contains'` 放行，只对 `prereq` 要求强弱。
export const XQ_LEARNER_V6 = `
ALTER TABLE xq_concept_occurrence
  DROP CONSTRAINT IF EXISTS xq_concept_occurrence_source_check;

ALTER TABLE xq_concept_occurrence
  ADD CONSTRAINT xq_concept_occurrence_source_check
  CHECK (source IN ('keypoint', 'title', 'body', 'manual',
                    'foreign-keypoint', 'foreign-body', 'foreign-title'));

ALTER TABLE xq_concept_edge
  DROP CONSTRAINT IF EXISTS xq_concept_edge_active_needs_strength;

ALTER TABLE xq_concept_edge
  ADD CONSTRAINT xq_concept_edge_active_needs_strength
  CHECK (status <> 'active' OR relation = 'contains' OR strength IS NOT NULL);
`;

// ---------------------------------------------------------------------------
// 二十一、活跃概念的规范名不许重名
// ---------------------------------------------------------------------------
// ★ 为什么现在才加：`xq_concept` 从 baseline 起就没有名字唯一约束。当时的
//   理由是同形异义合法（一个名字可以指两个概念，靠 `xq_concept_alias.ambiguous`
//   记事实）—— 但那条理由说的是**别名**层面的多指，不是「两行 `active` 概念
//   都叫 Git」。后者只会让「按名字找概念」在每一处都变成二选一。
//
// ★ 为什么是**部分**唯一索引：`merged` / `retired` 的行必须允许与被重新引入
//   的同名新行共存 —— 一个概念退役、后来又被重新引入是正常路径，全表唯一
//   会把那条路堵死。`WHERE status = 'active'` 只约束「同一时刻最多一个活跃
//   说法」。
//
// ★ 加之前查过真库（2026-11-13，127.0.0.1:5433）：
//     SELECT canonical_name, count(*) FROM xq_concept
//      WHERE status = 'active' GROUP BY 1 HAVING count(*) > 1;   → 0 行
//   （大小写不敏感的那一版同样 0 行），所以这条索引建得起来。换一个库时
//   如果那里有重复，这条迁移会**失败** —— 那是想要的：重复要先人工归并，
//   不能让迁移替人删行。
//
// ★ 为什么仍保留 `promoteProposal` 里的显式判重：索引只挡得住「规范名」，
//   挡不住「这个名字是别人的**别名**」—— 那是 F5 的另一半，也是别名表存在的
//   意义。
export const XQ_LEARNER_V7 = `
CREATE UNIQUE INDEX IF NOT EXISTS xq_concept_active_name_key
  ON xq_concept (canonical_name)
  WHERE status = 'active';
`;

export const XQ_LEARNER_MIGRATIONS: SchemaMigrationSet = {
  store: 'xq-learner',
  migrations: [
    { version: 1, name: 'baseline', up: XQ_LEARNER_SCHEMA, transaction: false },
    { version: 2, name: 'session-and-persona', up: XQ_LEARNER_V2, transaction: false },
    { version: 3, name: 'graph-version', up: XQ_LEARNER_V3, transaction: false },
    { version: 4, name: 'concept-expand', up: XQ_LEARNER_V4 },
    { version: 5, name: 'import-batch', up: XQ_LEARNER_V5 },
    { version: 6, name: 'foreign-source', up: XQ_LEARNER_V6 },
    { version: 7, name: 'concept-name-unique', up: XQ_LEARNER_V7 },
  ],
};

/** 建这组表；幂等，重跑不丢数据。 */
export async function ensureXqLearnerSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, XQ_LEARNER_MIGRATIONS);
}
