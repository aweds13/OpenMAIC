import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import {
  advanceGraphVersion,
  assignConceptsToVersion,
  openGraphVersion,
  readGraphVersions,
} from '@/lib/persistence/xq-graph-version';

/**
 * 这一组钉的是**推进流程的语义**，不是 SQL 的形状：
 *
 *   · 冻结与开新版必须是**一次**（不能有「冻结了但没开新的」窗口）
 *   · 比较并交换：`from` 不是当前开放版就整条不生效（否则中间版本一秒钟都没开放过）
 *   · 三种冲突分开报（num / 已冻结 / 不是当前）—— 合成一个就分不出该查什么
 *   · `created_in` 只写一次（重写它等于篡改历史）
 *   · 往已冻结的版本里塞新概念要拒（与「冻结」自相矛盾）
 */

const DOCUMENT_SCENES_MIN = `CREATE TABLE IF NOT EXISTS document_stages (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at double precision NOT NULL,
    updated_at double precision NOT NULL,
    data jsonb NOT NULL
  );
  
CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id text NOT NULL,
  id text NOT NULL,
  scene_order integer,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (stage_id, id)
)`;

beforeEach(async () => {
  // PGlite 实例由每个用例自己建（`ensureXqLearnerSchema` 会跑完整迁移，很重，
  // 共享一个实例会让用例之间互相污染版本表）。
});

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(DOCUMENT_SCENES_MIN);
  await ensureXqLearnerSchema(db);
  return db;
}

async function insertConcept(db: PGlite, id: string, name: string): Promise<void> {
  await db.query(`INSERT INTO xq_concept (id, canonical_name, kind) VALUES ($1, $2, 'concept')`, [
    id,
    name,
  ]);
}

const C1 = 'c_00000000aaaa';
const C2 = 'c_00000000bbbb';

describe('readGraphVersions / openGraphVersion', () => {
  it('迁移落地后正好一版 baseline 且它是开放的', async () => {
    const db = await freshDb();
    const versions = await readGraphVersions(db);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, label: 'baseline', frozenAt: null });
    expect(openGraphVersion(versions)?.version).toBe(1);
    await db.close();
  });

  it('★ 概念数按 created_in 数，不按行数瞎算', async () => {
    const db = await freshDb();
    await insertConcept(db, C1, '甲');
    await insertConcept(db, C2, '乙');
    // 迁移的回填只覆盖**它自己跑过时库里已有的行**；迁移之后新插的概念默认
    // `created_in IS NULL`（这正是「还没归属」的形态）。所以这里显式钉到第 1 版，
    // 再看 baseline 是不是数到 2 —— 数的是 `created_in`，不是表行数。
    await db.query(`UPDATE xq_concept SET created_in = 1`);
    const versions = await readGraphVersions(db);
    expect(versions[0]?.concepts).toBe(2);
    await db.close();
  });

  it('没有开放版本时 openGraphVersion 回 null（不抛）', async () => {
    const db = await freshDb();
    await db.query(`UPDATE xq_graph_version SET frozen_at = now() WHERE version = 1`);
    expect(openGraphVersion(await readGraphVersions(db))).toBeNull();
    await db.close();
  });
});

describe('advanceGraphVersion', () => {
  it('★ 冻结旧版与开新版是同一次：中间不存在「没有开放版本」的时刻', async () => {
    const db = await freshDb();
    const result = await advanceGraphVersion(db, { from: 1, label: 'v2' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.version).toMatchObject({ version: 2, label: 'v2', frozenAt: null });

    const versions = await readGraphVersions(db);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[0]?.frozenAt).not.toBeNull();
    expect(openGraphVersion(versions)?.version).toBe(2);
    await db.close();
  });

  it('★ 比较并交换：from 不是当前开放版就整条不生效', async () => {
    const db = await freshDb();
    // 第 1 版是否开放 —— 用 2 去推进，必须失败。
    const wrong = await advanceGraphVersion(db, { from: 2, label: 'v3' });
    expect(wrong).toMatchObject({ ok: false, reason: 'not-found' });

    await advanceGraphVersion(db, { from: 1, label: 'v2' });
    // 现在开放的是 2；再用 1 推进必须被「已冻结」拦住。
    const stale = await advanceGraphVersion(db, { from: 1, label: 'v2-again' });
    expect(stale).toMatchObject({ ok: false, reason: 'already-frozen' });

    const versions = await readGraphVersions(db);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    await db.close();
  });

  it('★ 中间版本不许被跳过（标了 v3 却只冻结了第 2 版那种）', async () => {
    const db = await freshDb();
    await advanceGraphVersion(db, { from: 1, label: 'v2' });
    // 手工把第 2 版冻结、塞进第 3 版，模拟另一个进程抢先推进。
    await db.query(`UPDATE xq_graph_version SET frozen_at = now() WHERE version = 2`);
    await db.query(`INSERT INTO xq_graph_version (version, label) VALUES (3, 'v3-theirs')`);

    const ours = await advanceGraphVersion(db, { from: 2, label: 'v3-ours' });
    expect(ours).toMatchObject({ ok: false, reason: 'already-frozen' });

    const versions = await readGraphVersions(db);
    expect(versions.map((version) => version.label)).toEqual(['baseline', 'v2', 'v3-theirs']);
    await db.close();
  });

  it('not-current 报出此刻真正的开放版本，调用方据此重读', async () => {
    const db = await freshDb();
    // 造一个「开放的不是最新」的脏状态：冻结第 1 版，插第 3 版开放，第 2 版不存在。
    await db.query(`UPDATE xq_graph_version SET frozen_at = now() WHERE version = 1`);
    await db.query(`INSERT INTO xq_graph_version (version, label) VALUES (3, 'v3')`);

    const result = await advanceGraphVersion(db, { from: 1, label: 'v2' });
    expect(result).toMatchObject({ ok: false, reason: 'already-frozen' });
    if (result.ok) throw new Error('expected refusal');
    expect(result.current?.version).toBe(3);
    await db.close();
  });

  it('空 label 直接抛 RangeError，不写库', async () => {
    const db = await freshDb();
    await expect(advanceGraphVersion(db, { from: 1, label: '   ' })).rejects.toThrow(RangeError);
    expect((await readGraphVersions(db)).map((version) => version.version)).toEqual([1]);
    await db.close();
  });

  it('from 不是正整数直接抛（传 0 或 1.5 都是写错行）', async () => {
    const db = await freshDb();
    await expect(advanceGraphVersion(db, { from: 0, label: 'v1' })).rejects.toThrow(RangeError);
    await expect(advanceGraphVersion(db, { from: 1.5, label: 'v2' })).rejects.toThrow(RangeError);
    await db.close();
  });

  it('label 重复被数据库挡住（UNIQUE 是最后一道闸）', async () => {
    const db = await freshDb();
    await expect(advanceGraphVersion(db, { from: 1, label: 'baseline' })).rejects.toThrow(
      /xq_graph_version_label_key/i,
    );
    await db.close();
  });
});

describe('assignConceptsToVersion', () => {
  it('★ 只写 created_in IS NULL 的行，已归属的一行不动', async () => {
    const db = await freshDb();
    await insertConcept(db, C1, '甲');
    await insertConcept(db, C2, '乙');
    // C1 已经归属第 1 版（历史事实），C2 还没归属 —— 推进只该动 C2。
    await db.query(`UPDATE xq_concept SET created_in = 1 WHERE id = $1`, [C1]);
    await advanceGraphVersion(db, { from: 1, label: 'v2' });

    const result = await assignConceptsToVersion(db, { version: 2, conceptIds: [C1, C2] });
    expect(result).toMatchObject({ assigned: 1, alreadyAssigned: 1, missing: [] });

    const rows = await db.query<{ id: string; created_in: number }>(
      `SELECT id, created_in FROM xq_concept ORDER BY id`,
    );
    // C1 留在第 1 版（历史事实），C2 落到第 2 版。
    expect(rows.rows).toEqual([
      { id: C1, created_in: 1 },
      { id: C2, created_in: 2 },
    ]);
    await db.close();
  });

  it('★ 幂等：同一批重跑写 0 行，全部进 alreadyAssigned', async () => {
    const db = await freshDb();
    await insertConcept(db, C1, '甲');
    await advanceGraphVersion(db, { from: 1, label: 'v2' });
    await db.query(`UPDATE xq_concept SET created_in = NULL WHERE id = $1`, [C1]);

    const first = await assignConceptsToVersion(db, { version: 2, conceptIds: [C1] });
    expect(first.assigned).toBe(1);
    const second = await assignConceptsToVersion(db, { version: 2, conceptIds: [C1] });
    expect(second).toMatchObject({ assigned: 0, alreadyAssigned: 1 });
    await db.close();
  });

  it('★ 库里不存在的概念如实报 missing，不静默丢', async () => {
    const db = await freshDb();
    await insertConcept(db, C1, '甲');
    await advanceGraphVersion(db, { from: 1, label: 'v2' });
    await db.query(`UPDATE xq_concept SET created_in = NULL`);
    const result = await assignConceptsToVersion(db, {
      version: 2,
      conceptIds: [C1, 'c_ffffffffffff'],
    });
    expect(result.missing).toEqual(['c_ffffffffffff']);
    expect(result.assigned).toBe(1);
    await db.close();
  });

  it('★ 往已冻结的版本里塞新概念要拒 —— 冻结了还长就不叫冻结', async () => {
    const db = await freshDb();
    await insertConcept(db, C1, '甲');
    await advanceGraphVersion(db, { from: 1, label: 'v2' });
    await expect(assignConceptsToVersion(db, { version: 1, conceptIds: [C1] })).rejects.toThrow(
      /frozen/i,
    );
    await db.close();
  });

  it('不存在的版本抛 RangeError（FK 之前给出人话）', async () => {
    const db = await freshDb();
    await expect(assignConceptsToVersion(db, { version: 9, conceptIds: [C1] })).rejects.toThrow(
      RangeError,
    );
    await db.close();
  });

  it('空输入回零，不查表', async () => {
    const db = await freshDb();
    expect(await assignConceptsToVersion(db, { version: 1, conceptIds: [] })).toEqual({
      assigned: 0,
      alreadyAssigned: 0,
      missing: [],
    });
    await db.close();
  });

  it('重复 id 与空串收拢后只算一次', async () => {
    const db = await freshDb();
    await insertConcept(db, C1, '甲');
    await advanceGraphVersion(db, { from: 1, label: 'v2' });
    await db.query(`UPDATE xq_concept SET created_in = NULL`);
    const result = await assignConceptsToVersion(db, {
      version: 2,
      conceptIds: [C1, C1, '', C1],
    });
    expect(result.assigned).toBe(1);
    await db.close();
  });
});
