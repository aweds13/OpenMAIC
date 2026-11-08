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
  async function freshDb(): Promise<PGlite> {
    const db = new PGlite();
    await db.waitReady;
    await db.exec(XQ_LEARNER_SCHEMA);
    return db;
  }

  it('建出 12 张表且幂等', async () => {
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
      'xq_intake_proposal',
      'xq_intake_task',
      'xq_probe_item',
      'xq_question_concept',
      'xq_review_schedule',
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

  it('删概念会连带删掉它的别名与出现记录（ON DELETE CASCADE）', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind) VALUES ('c_a', 'A', 'concept')`,
    );
    await db.query(
      `INSERT INTO xq_concept_alias (alias, kind, concept_id, source) VALUES ('a-alias', 'concept', 'c_a', 'test')`,
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
});
