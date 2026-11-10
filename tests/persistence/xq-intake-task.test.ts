import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import {
  ALIGNMENT_TRI,
  BAND_ONLY_MIN_VOTE_RATIO,
  INTAKE_READ_LIMIT,
  PROBE_BACKED_MIN_UNITS,
  beginIntake,
  closeIntake,
  deriveIntakeConfidence,
  newIntakeTaskId,
  orderUnits,
  readIntake,
  readIntakes,
  unitsFromCellStates,
  type AlignmentUnitInput,
} from '@/lib/persistence/xq-intake-task';

/**
 * 这一组钉的是**一次任务怎么开、怎么收**，不是 SQL 的形状：
 *
 *   · 任务行与单元行一起出现或都不出现（同一个事务）
 *   · `confidence` 是纯规则算的，而 `proxy` 那一列必须真的挡住「按代理跳过」
 *   · 重放同一个 taskId 不会写出第二份对齐
 *   · 排序先排「不会的」—— 先塞「你已经会的」是所有教学系统最常见的浪费
 *   · `teaching` 不是结束（`closed_at` 要清回 NULL）
 */

const DOCUMENT_MIN = `CREATE TABLE IF NOT EXISTS document_stages (
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
);
CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
)`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(DOCUMENT_MIN);
  await ensureXqLearnerSchema(db);
  return db;
}

/**
 * PGlite 的 `transaction()` 形状与仓里的 `WithTransaction` 一致（收一个
 * `(tx) => Promise<T>`），只是 `tx` 的类型来自 PGlite 自己的声明 —— 这里只
 * 做一次类型对齐，不做任何包装（包装会引入第二个事务语义）。
 */
function withTx(db: PGlite): WithTransaction {
  return <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> =>
    db.transaction((tx) => body(tx as unknown as Queryable)) as Promise<T>;
}

function cellUnit(overrides: Partial<AlignmentUnitInput> = {}): AlignmentUnitInput {
  return {
    unitId: 'u1',
    label: '自检：八道题',
    unitKind: 'cell',
    stageId: 'stage-A',
    sceneId: 'scene-p1',
    tri: 'unknown',
    n: 0,
    k: 0,
    anchor: 'probe',
    proxy: false,
    ...overrides,
  };
}

async function counts(db: PGlite): Promise<{ tasks: number; units: number }> {
  const tasks = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_intake_task');
  const units = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_alignment_unit');
  return { tasks: Number(tasks.rows[0].n), units: Number(units.rows[0].n) };
}

describe('★ 任务 id：前缀让它在日志里能分辨', () => {
  it('是 t_ 加 12 位十六进制，不是 uuid 原样', () => {
    const id = newIntakeTaskId();
    expect(id).toMatch(/^t_[0-9a-f]{12}$/);
    // 与概念 id（c_ 前缀）不同 —— 两者会出现在同一份日志里。
    expect(id.startsWith('c_')).toBe(false);
    expect(newIntakeTaskId()).not.toBe(id);
  });
});

describe('★ confidence 是算出来的，不是谁说的', () => {
  it('两个独立实测单元才算 probe-backed；一个不算', () => {
    const one = [cellUnit({ tri: 'known', n: 8, k: 8, anchor: 'probe' })];
    expect(deriveIntakeConfidence(one)).toBe('guess');
    const two = [
      cellUnit({ unitId: 'u1', tri: 'known', n: 8, k: 8, anchor: 'probe' }),
      cellUnit({ unitId: 'u2', tri: 'not-learned', n: 4, k: 0, anchor: 'probe' }),
    ];
    expect(deriveIntakeConfidence(two)).toBe('probe-backed');
    expect(PROBE_BACKED_MIN_UNITS).toBe(2);
  });

  it('★ 代理证据不算实测 —— proxy 的 known 不进 probe-backed 的分子', () => {
    const proxied = [
      cellUnit({ unitId: 'u1', tri: 'half', proxy: true, anchor: 'course-band' }),
      cellUnit({ unitId: 'u2', tri: 'half', proxy: true, anchor: 'course-band' }),
    ];
    expect(deriveIntakeConfidence(proxied)).toBe('guess');
  });

  it('有 course-band 且票比过线 ⇒ band-only（但也只到 band-only）', () => {
    const banded = [
      cellUnit({
        unitId: 'u1',
        tri: 'unknown',
        proxy: true,
        anchor: 'course-band',
        chapterVoteRatio: BAND_ONLY_MIN_VOTE_RATIO,
      }),
    ];
    expect(deriveIntakeConfidence(banded)).toBe('band-only');
    const below = [
      cellUnit({
        unitId: 'u1',
        tri: 'unknown',
        proxy: true,
        anchor: 'course-band',
        chapterVoteRatio: BAND_ONLY_MIN_VOTE_RATIO - 0.01,
      }),
    ];
    expect(deriveIntakeConfidence(below)).toBe('guess');
  });
});

describe('★ 排序：先排不会的，再排不知道的', () => {
  it('tri 决定主序，ord 与 idx 从 0 连续', () => {
    const ordered = orderUnits('t_x', [
      cellUnit({ unitId: 'known', tri: 'known', n: 6, k: 6 }),
      cellUnit({ unitId: 'not-learned', tri: 'not-learned', n: 4, k: 0 }),
      cellUnit({ unitId: 'unknown', tri: 'unknown' }),
      cellUnit({ unitId: 'half', tri: 'half', n: 4, k: 2 }),
    ]);
    expect(ordered.map((unit) => unit.unitId)).toEqual(['not-learned', 'unknown', 'half', 'known']);
    expect(ordered.map((unit) => unit.ord)).toEqual([0, 1, 2, 3]);
    expect(ordered.map((unit) => unit.idx)).toEqual([0, 1, 2, 3]);
    expect(ordered.every((unit) => unit.taskId === 't_x')).toBe(true);
  });

  it('同 tri 时按 priority 权重降序，再按 unitId 码点兜底', () => {
    const ordered = orderUnits('t_x', [
      cellUnit({ unitId: 'b', tri: 'unknown', priority: 'optional' }),
      cellUnit({ unitId: 'a', tri: 'unknown', priority: 'core' }),
      cellUnit({ unitId: 'c', tri: 'unknown', priority: 'core' }),
    ]);
    expect(ordered.map((unit) => unit.unitId)).toEqual(['a', 'c', 'b']);
  });
});

describe('★ 三态格子折成单元：没答过的格子是「推的」', () => {
  it('n=0 的格子 proxy=true，anchor 退到 keypoint-weak', () => {
    const units = unitsFromCellStates('t_x', [
      { stageId: 'stage-A', sceneId: 'scene-p1', tri: 'unknown', n: 0, k: 0, title: '自检' },
    ]);
    expect(units[0].proxy).toBe(true);
    expect(units[0].anchor).toBe('keypoint-weak');
    expect(units[0].evidence?.[0]).toContain('没有任何作答记录');
    expect(units[0].label).toBe('自检');
  });

  it('答过的格子 proxy=false，且不编一个没来源的标题', () => {
    const units = unitsFromCellStates('t_x', [
      { stageId: 'stage-A', sceneId: 'scene-p1', tri: 'known', n: 8, k: 8, lb5: 0.78 },
      { stageId: 'stage-A', sceneId: 'scene-p2', tri: 'unknown', n: 0, k: 0, title: '  ' },
    ]);
    expect(units[0].proxy).toBe(false);
    expect(units[0].anchor).toBe('probe');
    expect(units[0].lb5).toBe(0.78);
    expect(units[0].evidence?.[0]).toBe('probe: stage-A/scene-p1 8/8 correct');
    expect(units[1].label).toBe('stage-A/scene-p2');
  });
});

describe('★ 写之前就拦住：代理证据不许说「会」', () => {
  it('proxy + known 直接被拒', async () => {
    const db = await freshDb();
    await expect(
      beginIntake(withTx(db), {
        goal: '学 Dart',
        kind: 'course',
        sourceRefs: { stageId: 'stage-A' },
        units: [cellUnit({ tri: 'known', proxy: true, anchor: 'course-band' })],
      }),
    ).rejects.toThrow(/proxy can only say half\/unknown/i);
    expect(await counts(db)).toEqual({ tasks: 0, units: 0 });
  });

  it('空 goal / 空 unitId / 未知 tri / k>n 都被拒，且一行不写', async () => {
    const db = await freshDb();
    const tx = withTx(db);
    const base = { goal: '学 Dart', kind: 'course' as const, sourceRefs: {} };

    await expect(beginIntake(tx, { ...base, goal: '   ', units: [cellUnit()] })).rejects.toThrow(
      /needs a goal/i,
    );
    await expect(beginIntake(tx, { ...base, units: [cellUnit({ unitId: ' ' })] })).rejects.toThrow(
      /empty unitId/i,
    );
    await expect(
      beginIntake(tx, {
        ...base,
        units: [cellUnit({ tri: 'probably' as unknown as AlignmentUnitInput['tri'] })],
      }),
    ).rejects.toThrow(/unknown tri/i);
    await expect(beginIntake(tx, { ...base, units: [cellUnit({ n: 2, k: 5 })] })).rejects.toThrow(
      /k > n/i,
    );
    await expect(
      beginIntake(tx, { ...base, units: [cellUnit({ unitKind: 'chapter', chapterId: null })] }),
    ).rejects.toThrow(/no chapterId/i);

    expect(await counts(db)).toEqual({ tasks: 0, units: 0 });
    expect(ALIGNMENT_TRI.every((tri) => typeof tri === 'string')).toBe(true);
  });
});

describe('★ 开一次任务：任务行与单元行一起出现', () => {
  it('写进去，读回来时顺序与 confidence 都是算出来的', async () => {
    const db = await freshDb();
    const result = await beginIntake(withTx(db), {
      goal: '我要学 Dart 的空安全',
      kind: 'utterance',
      sourceRefs: { text: '我要学 Dart 的空安全' },
      units: [
        cellUnit({ unitId: 'scene-p1', sceneId: 'scene-p1', tri: 'known', n: 8, k: 8 }),
        cellUnit({ unitId: 'scene-p2', sceneId: 'scene-p2', tri: 'not-learned', n: 4, k: 0 }),
        cellUnit({ unitId: 'scene-p3', sceneId: 'scene-p3', tri: 'unknown' }),
      ],
    });

    expect(result.created).toBe(true);
    expect(result.task.confidence).toBe('probe-backed');
    expect(result.task.status).toBe('open');
    expect(result.task.goal).toBe('我要学 Dart 的空安全');
    expect(result.units).toHaveLength(3);
    // 排序：not-learned 在最前，unknown 中间，known 最后。
    expect(result.units.map((unit) => unit.unitId)).toEqual(['scene-p2', 'scene-p3', 'scene-p1']);
    expect(await counts(db)).toEqual({ tasks: 1, units: 3 });

    const reloaded = await readIntake(db, result.task.taskId);
    expect(reloaded?.task.confidence).toBe('probe-backed');
    expect(reloaded?.units.map((unit) => unit.ord)).toEqual([0, 1, 2]);
    expect(reloaded?.units[0].tri).toBe('not-learned');
    expect(reloaded?.units[0].sceneId).toBe('scene-p2');
    // ★ 直接构造的单元没写 evidence ⇒ 读回来是空数组，不是「编一条证据」。
    expect(reloaded?.units[0].evidence).toEqual([]);
  });

  it('★ 重放同一个 taskId 不写第二份对齐', async () => {
    const db = await freshDb();
    const input = {
      goal: '学 Dart',
      kind: 'course' as const,
      sourceRefs: { stageId: 'stage-A' },
      taskId: 't_replay000001',
      units: [cellUnit({ tri: 'known', n: 8, k: 8 })],
    };
    const first = await beginIntake(withTx(db), input);
    expect(first.created).toBe(true);

    const second = await beginIntake(withTx(db), {
      ...input,
      // 第二次给的单元不同 —— 也不许塞进去（重放不是改计划）。
      units: [cellUnit({ unitId: 'u9', tri: 'unknown' })],
    });
    expect(second.created).toBe(false);
    expect(second.task.taskId).toBe('t_replay000001');
    expect(second.units.map((unit) => unit.unitId)).toEqual(['u1']);
    expect(await counts(db)).toEqual({ tasks: 1, units: 1 });
  });

  it('★ 中途失败整条回滚 —— 任务行不许单独留下', async () => {
    const db = await freshDb();
    // 第二个单元故意让库拒绝：`n` 是 `numeric(4,1)`，上限 999.9 ——
    // 应用层校验只看非负，所以 10000 会在这里被库挡下。
    const bad = cellUnit({ unitId: 'u2', n: 10000, k: 0 });
    await expect(
      beginIntake(withTx(db), {
        goal: '学 Dart',
        kind: 'course',
        sourceRefs: {},
        units: [cellUnit({ unitId: 'u1' }), bad],
      }),
    ).rejects.toThrow(/numeric|overflow|out of range/i);
    expect(await counts(db)).toEqual({ tasks: 0, units: 0 });
  });
});

describe('★ 收口：teaching 不是结束', () => {
  it('teaching 清空 closed_at，done 才写时间', async () => {
    const db = await freshDb();
    const begun = await beginIntake(withTx(db), {
      goal: '学 Dart',
      kind: 'course',
      sourceRefs: {},
      units: [cellUnit()],
    });
    const taskId = begun.task.taskId;

    const teaching = await closeIntake(db, { taskId, status: 'teaching' });
    expect(teaching.ok).toBe(true);
    expect(teaching.task?.status).toBe('teaching');
    expect(teaching.task?.closedAt).toBeNull();

    const done = await closeIntake(db, { taskId, status: 'done' });
    expect(done.ok).toBe(true);
    expect(done.task?.status).toBe('done');
    expect(done.task?.closedAt).not.toBeNull();
  });

  it('已经结束的任务再收一次如实说 already-closed，不存在说 not-found', async () => {
    const db = await freshDb();
    const begun = await beginIntake(withTx(db), {
      goal: '学 Dart',
      kind: 'course',
      sourceRefs: {},
      units: [cellUnit()],
    });
    await closeIntake(db, { taskId: begun.task.taskId, status: 'abandoned' });

    const again = await closeIntake(db, { taskId: begun.task.taskId, status: 'done' });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('already-closed');
    // ★ 状态不许被这次调用改掉。
    expect(again.task?.status).toBe('abandoned');

    const missing = await closeIntake(db, { taskId: 't_nope', status: 'done' });
    expect(missing).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('open 不是可写的收口状态', async () => {
    const db = await freshDb();
    await expect(
      closeIntake(db, { taskId: 't_x', status: 'open' as unknown as 'done' }),
    ).rejects.toThrow(/not a closable/i);
  });
});

describe('★ 列任务：默认只看还没结束的', () => {
  it('默认 active（open/teaching），可按 status 筛，limit 非正回空', async () => {
    const db = await freshDb();
    const tx = withTx(db);
    const a = await beginIntake(tx, {
      goal: 'A',
      kind: 'course',
      sourceRefs: {},
      taskId: 't_aaaaaaaaaaaa',
      units: [cellUnit()],
    });
    await beginIntake(tx, {
      goal: 'B',
      kind: 'outline',
      sourceRefs: {},
      taskId: 't_bbbbbbbbbbbb',
      units: [cellUnit()],
    });
    await closeIntake(db, { taskId: a.task.taskId, status: 'done' });

    const active = await readIntakes(db);
    expect(active.map((task) => task.taskId)).toEqual(['t_bbbbbbbbbbbb']);

    const done = await readIntakes(db, { status: 'done' });
    expect(done.map((task) => task.taskId)).toEqual(['t_aaaaaaaaaaaa']);

    expect(await readIntakes(db, { limit: 0 })).toEqual([]);
    expect(await readIntakes(db, { limit: -3 })).toEqual([]);
    expect(INTAKE_READ_LIMIT).toBe(100);
  });
});
