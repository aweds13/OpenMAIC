import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { ensureXqLearnerSchema, XQ_LEARNER_SCHEMA } from '@/lib/persistence/xq-learner';

/**
 * 这组判据钉的是「数据库自己会不会拒绝错误的行」。
 *
 * 为什么必须在真 SQL 上验而不能只读代码：这个 schema 的价值全在约束上 ——
 * `reason` 不许空、`merged` 必须指目标、`from_id <> to_id`、`confidence_pre`
 * 只能是四个值之一。任何一条被删掉，应用层的 bug 就不再是「报错」而是
 * 「静默写进一行脏数据」，而脏数据在掌握度上会直接变成错判。
 *
 * ★ 一条最容易搞错、所以专门钉住的：`(stage_id, scene_id)` 才是主键。
 * 实测 234 页里有 35 个 `scene_id` 跨课复用、34 个连页类型都不同
 * ⇒ 只按 `scene_id` 建唯一约束会让两门课的同一个页号互相覆盖。
 */
describe('xq 学情 schema', () => {
  /**
   * xq_concept_occurrence 有一条复合外键指回 document_scenes(stage_id, id) ——
   * 那是上游 document store 的表，不属这组 DDL。这里建一个最小版本，
   * 只为让外键能落地；列与真实表一致（真实表还有 scene_order / data）。
   */
  const DOCUMENT_SCENES_MIN = `CREATE TABLE IF NOT EXISTS document_scenes (
    stage_id    text NOT NULL,
    id          text NOT NULL,
    scene_order double precision,
    data        jsonb,
    PRIMARY KEY (stage_id, id)
  );`;

  /**
   * 只跑版本 1 的 baseline —— 大多数判据钉的是 v1 的约束，不该被 v2 的表拖慢。
   * 需要 v2 的用例自己再调一次 `ensureXqLearnerSchema(db)`。
   */
  async function freshDb(): Promise<PGlite> {
    const db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await db.exec(XQ_LEARNER_SCHEMA);
    return db;
  }

  it('建出 15 张表且幂等', async () => {
    const db = await freshDb();
    await ensureXqLearnerSchema(db);
    // 再跑一遍不该抛
    await ensureXqLearnerSchema(db);

    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'xq\_%'
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'xq_alignment_unit',
      'xq_cell_state',
      'xq_concept',
      'xq_concept_alias',
      'xq_concept_edge',
      'xq_concept_external_ref',
      'xq_concept_occurrence',
      'xq_event',
      'xq_intake_proposal',
      'xq_intake_task',
      'xq_learner_persona',
      'xq_probe_item',
      'xq_question_concept',
      'xq_review_schedule',
      'xq_session',
    ]);
    await db.close();
  });

  it('同一个 scene_id 在不同 stage 下可以共存（主键必须带 stage_id）', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_probe_item
         (task_id, stage_id, scene_id, question_id, asked_at, correct, source)
       VALUES ('t', 'stage-A', 'scene-p1', 'q1', now(), true, 'existing'),
              ('t', 'stage-B', 'scene-p1', 'q1', now(), true, 'existing')`,
    );
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM xq_probe_item`,
    );
    expect(rows[0]!.count).toBe('2');
    await db.close();
  });

  it('同一条证据重复写入被唯一约束挡住', async () => {
    const db = await freshDb();
    const insert = () =>
      db.query(
        `INSERT INTO xq_probe_item
           (task_id, stage_id, scene_id, question_id, asked_at, correct, source)
         VALUES ('t', 'stage-A', 'scene-p1', 'q1', '2026-11-08T10:00:00Z', true, 'existing')`,
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i);
    await db.close();
  });

  it('概念边不许没有理由', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind)
       VALUES ('c_a', 'A', 'concept'), ('c_b', 'B', 'concept')`,
    );
    // 空串
    await expect(
      db.query(
        `INSERT INTO xq_concept_edge (from_id, to_id, relation, reason, source)
         VALUES ('c_a', 'c_b', 'prereq', '', 'test')`,
      ),
    ).rejects.toThrow(/reason_check/i);
    // 纯空白（这就是为什么约束写的是 btrim）
    await expect(
      db.query(
        `INSERT INTO xq_concept_edge (from_id, to_id, relation, reason, source)
         VALUES ('c_a', 'c_b', 'prereq', '    ', 'test')`,
      ),
    ).rejects.toThrow(/reason_check/i);
    // 有理由就过
    await db.query(
      `INSERT INTO xq_concept_edge (from_id, to_id, relation, reason, source)
       VALUES ('c_a', 'c_b', 'prereq', '循环结构要先会分支，否则没有终止条件可写', 'test')`,
    );
    await db.close();
  });

  it('概念不许自环', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind) VALUES ('c_a', 'A', 'concept')`,
    );
    await expect(
      db.query(
        `INSERT INTO xq_concept_edge (from_id, to_id, relation, reason, source)
         VALUES ('c_a', 'c_a', 'prereq', '自己先于自己', 'test')`,
      ),
    ).rejects.toThrow(/xq_concept_edge_check/i);
    await db.close();
  });

  it('merged 状态必须指向归并目标', async () => {
    const db = await freshDb();
    await expect(
      db.query(
        `INSERT INTO xq_concept (id, canonical_name, kind, status)
         VALUES ('c_m', 'M', 'concept', 'merged')`,
      ),
    ).rejects.toThrow(/xq_concept_check/i);
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind) VALUES ('c_t', 'T', 'concept')`,
    );
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, status, merged_into)
       VALUES ('c_m', 'M', 'concept', 'merged', 'c_t')`,
    );
    await db.close();
  });

  it('confidence_pre 只接受 25/50/75/95', async () => {
    const db = await freshDb();
    for (const bad of [0, 60, 100]) {
      await expect(
        db.query(
          `INSERT INTO xq_probe_item
             (task_id, stage_id, scene_id, question_id, asked_at, correct, confidence_pre, source)
           VALUES ('t', 'stage-A', 'scene-p1', 'q1', now(), true, $1, 'existing')`,
          [bad],
        ),
      ).rejects.toThrow(/confidence_pre_check/i);
    }
    for (const good of [25, 50, 75, 95]) {
      await db.query(
        `INSERT INTO xq_probe_item
           (task_id, stage_id, scene_id, question_id, asked_at, correct, confidence_pre, source)
         VALUES ('t', 'stage-A', 'scene-p1', $1, now(), true, $2, 'existing')`,
        [`q${good}`, good],
      );
    }
    await db.close();
  });

  it('occurrence 的权重必须在 (0, 1]', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind) VALUES ('c_a', 'A', 'concept')`,
    );
    await db.query(
      `INSERT INTO document_scenes (stage_id, id) VALUES ('stage-A', 'scene-p1')`,
    );
    for (const bad of [0, 1.5]) {
      await expect(
        db.query(
          `INSERT INTO xq_concept_occurrence (concept_id, stage_id, scene_id, weight, source)
           VALUES ('c_a', 'stage-A', 'scene-p1', $1, 'keypoint')`,
          [bad],
        ),
      ).rejects.toThrow(/weight_check/i);
    }
    await db.query(
      `INSERT INTO xq_concept_occurrence (concept_id, stage_id, scene_id, weight, source)
       VALUES ('c_a', 'stage-A', 'scene-p1', 1.0, 'keypoint')`,
    );
    await db.close();
  });

  it('错题四关只接受第 1..4 关', async () => {
    const db = await freshDb();
    for (const bad of [0, 5]) {
      await expect(
        db.query(
          `INSERT INTO xq_review_schedule
             (stage_id, scene_id, question_id, concept, round, due_at)
           VALUES ('stage-A', 'scene-p1', 'q1', 'concept-x', $1, now())`,
          [bad],
        ),
      ).rejects.toThrow(/round_check/i);
    }
    for (const good of [1, 2, 3, 4]) {
      await db.query(
        `INSERT INTO xq_review_schedule
           (stage_id, scene_id, question_id, concept, round, due_at)
         VALUES ('stage-A', 'scene-p1', 'q1', 'concept-x', $1, now())`,
        [good],
      );
    }
    await db.close();
  });

  it('删掉归并目标时 merged_into 会挡住（外键默认行为）', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind) VALUES ('c_t', 'T', 'concept')`,
    );
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, status, merged_into)
       VALUES ('c_m', 'M', 'concept', 'merged', 'c_t')`,
    );
    await expect(db.query(`DELETE FROM xq_concept WHERE id = 'c_t'`)).rejects.toThrow(
      /foreign key|violates/i,
    );
    await db.close();
  });

  it('外部 id 是多对一：两个来源可以指向同一概念，同一来源同一 id 只能一条', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind) VALUES ('c_a', '循环结构', 'concept')`,
    );
    await db.query(
      `INSERT INTO xq_concept_external_ref (source_graph, external_id, concept_id)
       VALUES ('acm-graph', '循环结构', 'c_a'), ('cs2023', 'SDF-Fundamentals/loops', 'c_a')`,
    );
    await expect(
      db.query(
        `INSERT INTO xq_concept_external_ref (source_graph, external_id, concept_id)
         VALUES ('acm-graph', '循环结构', 'c_a')`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
    await db.close();
  });

  /**
   * ★ P0：同形异义必须写得进去。
   *
   * 实测依据：「构造」在算法竞赛图里指构造题、在 Java 课里指构造方法，
   * 全库 25 页命中。主键若只到 (alias, kind)，给第二个概念写同一个别名会
   * 直接 duplicate key ⇒ 同形异义**写不进去**，只能把两个概念合成一个。
   */
  it('同一个别名可以挂给两个概念（同形异义），但必须显式标 ambiguous', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind)
       VALUES ('c_ctor', '构造方法', 'concept'), ('c_problem', '构造题', 'concept')`,
    );

    // 第一行：不含糊
    await db.query(
      `INSERT INTO xq_concept_alias (alias, kind, concept_id, source)
       VALUES ('构造', 'concept', 'c_ctor', 'java-course')`,
    );

    // 第二行同 alias 但不标 ambiguous ⇒ 被部分唯一索引挡住
    await expect(
      db.query(
        `INSERT INTO xq_concept_alias (alias, kind, concept_id, source)
         VALUES ('构造', 'concept', 'c_problem', 'acm-graph')`,
      ),
    ).rejects.toThrow(/xq_concept_alias_unambiguous_idx|duplicate key/i);

    // 把第一行标成含糊，再插第二行 —— 这样「含糊」是一条可查的事实，不是静默覆盖
    await db.query(
      `UPDATE xq_concept_alias SET ambiguous = true
        WHERE alias = '构造' AND concept_id = 'c_ctor'`,
    );
    await db.query(
      `INSERT INTO xq_concept_alias (alias, kind, concept_id, source, ambiguous)
       VALUES ('构造', 'concept', 'c_problem', 'acm-graph', true)`,
    );

    const { rows } = await db.query<{ n: string; amb: string }>(
      `SELECT count(*)::text AS n, count(*) FILTER (WHERE ambiguous)::text AS amb
         FROM xq_concept_alias WHERE alias = '构造'`,
    );
    expect(rows[0]!.n).toBe('2');
    expect(rows[0]!.amb).toBe('2');
    await db.close();
  });

  /**
   * ★ P0：出现记录不许指向不存在的页。
   *
   * 没有这条复合外键时，能插进 stage-DOES-NOT-EXIST/scene-p999 并且成功 ——
   * 一条永远指不到页的记录会静默污染覆盖率（「挂了 3 页」其实是 1 页 + 2 条幻影）。
   */
  it('出现记录不许指向不存在的页', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind) VALUES ('c_a', 'A', 'concept')`,
    );
    await expect(
      db.query(
        `INSERT INTO xq_concept_occurrence (concept_id, stage_id, scene_id, weight, source)
         VALUES ('c_a', 'stage-DOES-NOT-EXIST', 'scene-p999', 1.0, 'keypoint')`,
      ),
    ).rejects.toThrow(/xq_concept_occurrence_stage_id_scene_id_fkey|foreign key/i);
    await db.close();
  });

  it('页被删时它的出现记录一起消失（ON DELETE CASCADE）', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind) VALUES ('c_a', 'A', 'concept')`,
    );
    await db.query(`INSERT INTO document_scenes (stage_id, id) VALUES ('stage-A', 'scene-p1')`);
    await db.query(
      `INSERT INTO xq_concept_occurrence (concept_id, stage_id, scene_id, weight, source)
       VALUES ('c_a', 'stage-A', 'scene-p1', 1.0, 'keypoint')`,
    );
    await db.query(`DELETE FROM document_scenes WHERE stage_id = 'stage-A' AND id = 'scene-p1'`);
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM xq_concept_occurrence`,
    );
    expect(rows[0]!.count).toBe('0');
    await db.close();
  });

  it('删概念会连带删掉它的别名与出现记录（ON DELETE CASCADE）', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind) VALUES ('c_a', 'A', 'concept')`,
    );
    await db.query(
      `INSERT INTO xq_concept_alias (alias, kind, concept_id, source) VALUES ('a-alias', 'concept', 'c_a', 'test')`,
    );
    await db.query(
      `INSERT INTO document_scenes (stage_id, id) VALUES ('stage-A', 'scene-p1')`,
    );
    await db.query(
      `INSERT INTO xq_concept_occurrence (concept_id, stage_id, scene_id, weight, source)
       VALUES ('c_a', 'stage-A', 'scene-p1', 1.0, 'keypoint')`,
    );
    await db.query(`DELETE FROM xq_concept WHERE id = 'c_a'`);
    const alias = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM xq_concept_alias`,
    );
    const occ = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM xq_concept_occurrence`,
    );
    expect(alias.rows[0]!.count).toBe('0');
    expect(occ.rows[0]!.count).toBe('0');
    await db.close();
  });

  /**
   * ★ 版本 2：迁移账本必须记两行，且重跑幂等。
   *
   * 判据不写在代码里也不写在文档里 —— 只信 `openmaic_schema_migrations`
   * 这张表。一个「代码里有 v2、库里没记」的数据库，下次启动会再跑一遍
   * v2，而 v2 的每条语句都是 IF NOT EXISTS ⇒ 表面无害，实际掩盖了
   * 「这条迁移从来没成功过」这种事。
   */
  it('版本 2 记进迁移账本，且重跑不重复记账', async () => {
    const db = await freshDb();
    await ensureXqLearnerSchema(db);
    await ensureXqLearnerSchema(db);
    const { rows } = await db.query<{ version: number; name: string }>(
      `SELECT version, name FROM openmaic_schema_migrations
        WHERE store = 'xq-learner' ORDER BY version`,
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[1]!.name).toBe('session-and-persona');
    await db.close();
  });

  /**
   * ★ 会话必须有「第几次」的分母：`seq_no` 与 `local_day` 一起唯一。
   *
   * 没有这条唯一约束时，同一天两个并发标签页各自算「今天是第 1 次」
   * 都会成功，于是「今天学了两次」变成两次「第 1 次」—— 序数就不再是序数。
   */
  it('同一本地日期的会话序号不许重号', async () => {
    const db = await freshDb();
    await ensureXqLearnerSchema(db);
    const insert = (id: string) =>
      db.query(
        `INSERT INTO xq_session (session_id, started_at, seq_no, local_day)
         VALUES ($1, now(), 1, DATE '2026-11-09')`,
        [id],
      );
    await insert('11111111-1111-1111-1111-111111111111');
    await expect(insert('22222222-2222-2222-2222-222222222222')).rejects.toThrow(
      /duplicate key|unique/i,
    );
    await db.close();
  });

  /**
   * ★ 事件的两种「说不通」必须被数据库挡住，而不是靠调用方自觉：
   * ① 说了「要提示」却没说哪一类 —— 两类的折扣不同，缺了就折不出来；
   * ② 时长为负 —— 负的停留时长会让「是不是猜的」这个诊断反过来。
   */
  it('提事件的提示类型与停留时长由 CHECK 兜住', async () => {
    const db = await freshDb();
    await ensureXqLearnerSchema(db);
    await db.query(
      `INSERT INTO xq_session (session_id, started_at, seq_no, local_day)
       VALUES ('33333333-3333-3333-3333-333333333333', now(), 1, DATE '2026-11-09')`,
    );
    const event = (kind: string, extra: string) =>
      db.query(
        `INSERT INTO xq_event (event_id, session_id, occurred_at, kind, stage_id, scene_id${extra})
         VALUES (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', now(), $1, 'stage-A', 'scene-p1'${extra.includes('hint_subtype') ? ", 'instrumental'" : extra.includes('dwell_ms') ? ', -1' : ''})`,
        [kind],
      );
    await expect(event('hint_requested', '')).rejects.toThrow(/xq_event_hint_subtype_chk/i);
    await expect(event('page_viewed', ', dwell_ms')).rejects.toThrow(/xq_event_dwell_chk/i);
    await db.close();
  });

  /**
   * ★ 事件不许写一个不存在的会话：会话是事件的容器，孤儿事件
   * 在「今天学了什么」这个查询里既数不到会话里、也解释不了自己为什么存在。
   */
  it('事件必须挂在存在的会话上', async () => {
    const db = await freshDb();
    await ensureXqLearnerSchema(db);
    await expect(
      db.query(
        `INSERT INTO xq_event (event_id, session_id, occurred_at, kind)
         VALUES (gen_random_uuid(), '99999999-9999-9999-9999-999999999999', now(), 'page_viewed')`,
      ),
    ).rejects.toThrow(/xq_event_session_id_fkey|foreign key/i);
    await db.close();
  });

  /**
   * ★ 版本 2 加的四列必须真的在，而且默认值要能表达「没有证据」。
   *
   * `n_delayed`/`k_delayed` 默认为 0 而不是 NULL，是刻意的：0 表示
   * 「延迟分层下一条证据也没有」，NULL 会被读成「这个量不适用」，
   * 两者在掌握度公式里的行为完全不同（前者让 `n_delayed >= 3` 不成立）。
   */
  it('版本 2 的四列都在，且延迟分层默认 0 而不是 NULL', async () => {
    const db = await freshDb();
    await ensureXqLearnerSchema(db);
    const cols = async (table: string) => {
      const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      return new Map(rows.map((r) => [r.column_name, r.is_nullable]));
    };
    expect((await cols('xq_probe_item')).get('confidence_post')).toBe('YES');
    expect((await cols('xq_review_schedule')).get('is_variant')).toBe('NO');
    const cells = await cols('xq_cell_state');
    expect(cells.get('n_delayed')).toBe('NO');
    expect(cells.get('k_delayed')).toBe('NO');

    await db.query(
      `INSERT INTO xq_cell_state (stage_id, scene_id, tri) VALUES ('stage-A', 'scene-p1', 'unknown')`,
    );
    const { rows } = await db.query<{ n: string; k: string; iv: string }>(
      `SELECT n_delayed::text AS n, k_delayed::text AS k,
              (SELECT is_variant::text FROM xq_review_schedule LIMIT 1) AS iv
         FROM xq_cell_state WHERE stage_id = 'stage-A'`,
    );
    expect(rows[0]!.n).toBe('0.0');
    expect(rows[0]!.k).toBe('0.0');
    await db.close();
  });

  it('confidence_post 也只接受 25/50/75/95', async () => {
    const db = await freshDb();
    await ensureXqLearnerSchema(db);
    await expect(
      db.query(
        `INSERT INTO xq_probe_item
           (task_id, stage_id, scene_id, question_id, asked_at, correct, confidence_post, source)
         VALUES ('t', 'stage-A', 'scene-p1', 'q1', now(), true, 60, 'existing')`,
      ),
    ).rejects.toThrow(/confidence_post_check/i);
    await db.close();
  });
});
