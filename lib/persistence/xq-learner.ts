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
CREATE TABLE IF NOT EXISTS xq_concept_alias (
  alias      text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('concept', 'topic', 'tool')),
  concept_id text NOT NULL REFERENCES xq_concept(id) ON DELETE CASCADE,
  source     text NOT NULL,
  confidence numeric(3,2) NOT NULL DEFAULT 1.00,
  PRIMARY KEY (alias, kind)
);

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
CREATE TABLE IF NOT EXISTS xq_concept_occurrence (
  concept_id text NOT NULL REFERENCES xq_concept(id) ON DELETE CASCADE,
  stage_id   text NOT NULL,
  scene_id   text NOT NULL,
  weight     numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (weight > 0 AND weight <= 1),
  source     text NOT NULL CHECK (source IN ('keypoint', 'title', 'body', 'manual')),
  PRIMARY KEY (concept_id, stage_id, scene_id)
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

export const XQ_LEARNER_MIGRATIONS: SchemaMigrationSet = {
  store: 'xq-learner',
  migrations: [{ version: 1, name: 'baseline', up: XQ_LEARNER_SCHEMA, transaction: false }],
};

/** 建这组表；幂等，重跑不丢数据。 */
export async function ensureXqLearnerSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, XQ_LEARNER_MIGRATIONS);
}
