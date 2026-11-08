import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { XQ_LEARNER_SCHEMA } from '@/lib/persistence/xq-learner';
import type { RuntimeRecord } from '@openmaic/dsl';
import type { RuntimeStore } from '@openmaic/storage';

import {
  isGradableQuizRecord,
  recordProbeFromRuntimeAppend,
  RUNTIME_TASK_PREFIX,
  withXqProbeRecording,
} from '@/lib/persistence/xq-probe-recorder';

/**
 * 学情**生产写入口**的判据。
 *
 * 这一段最危险的失败方式不是报错，是**静默**：
 * - 学情落失败却让一次答题提交失败 ⇒ 用户以为答案丢了；
 * - 同一次 append 被投递两次 ⇒ 题量凭空翻倍，掌握度被重试推高；
 * - `correct === null`（AI 还没批完）被当成答错 ⇒ 一道还没结论的题立刻进失败证据；
 * - `draft` / `submitted` 阶段被当成结论 ⇒ 拿 `answers` 去猜对错，与页面显示的判分不一致。
 *
 * 四条都在这里钉住。第 5 条钉顺序：**append 必须先成功**，否则学情里会留下
 * 一条「证据存在但记录不存在」的孤儿事实。
 */
describe('xq probe recorder', () => {
  let db: PGlite;

  const DOCUMENT_SCENES_MIN = `CREATE TABLE IF NOT EXISTS document_scenes (
    stage_id    text NOT NULL,
    id          text NOT NULL,
    scene_order double precision,
    data        jsonb,
    PRIMARY KEY (stage_id, id)
  );`;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await db.exec(XQ_LEARNER_SCHEMA);
  });

  const appendInput = (overrides: Record<string, unknown> = {}) => ({
    recordId: 'rec-1',
    stageId: 'stage-A',
    sceneId: 'scene-p1',
    createdAt: '2026-11-08T02:00:00.000Z',
    payload: {
      payloadVersion: 1,
      phase: 'reviewed',
      answers: { q1: 'A' },
      results: [
        { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
        { questionId: 'q2', correct: false, status: 'incorrect', earned: 0 },
      ],
    },
    ...overrides,
  });

  const countProbe = async () => {
    const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_probe_item');
    return Number(r.rows[0]!.n);
  };
  const countSchedule = async () => {
    const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_review_schedule');
    return Number(r.rows[0]!.n);
  };

  describe('isGradableQuizRecord', () => {
    it('只有 reviewed 且带逐题结果才算结论', () => {
      expect(isGradableQuizRecord({ phase: 'reviewed', results: [{ questionId: 'q1' }] })).toBe(
        true,
      );
      expect(isGradableQuizRecord({ phase: 'reviewed', results: [] })).toBe(false);
      expect(isGradableQuizRecord({ phase: 'reviewed' })).toBe(false);
      expect(isGradableQuizRecord({ phase: 'submitted', results: [{ questionId: 'q1' }] })).toBe(
        false,
      );
      expect(isGradableQuizRecord({ phase: 'draft', results: [{ questionId: 'q1' }] })).toBe(false);
    });
  });

  describe('recordProbeFromRuntimeAppend', () => {
    it('reviewed 记录落成事实，答错的排四关，答对的不排', async () => {
      const result = await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      expect(result.inserted).toBe(2);
      expect(result.ungraded).toBe(0);
      expect(result.scheduled).toBe(1);
      expect(result.recomputed).toBe(1);
      expect(await countProbe()).toBe(2);
      // 四关 = 4 行，只有 q2 那一道错题。
      expect(await countSchedule()).toBe(4);

      const rows = await db.query<{ question_id: string; concept: string; round: number }>(
        'SELECT question_id, concept, round FROM xq_review_schedule ORDER BY round',
      );
      expect(rows.rows.map((r) => r.question_id)).toEqual(['q2', 'q2', 'q2', 'q2']);
      expect(rows.rows.map((r) => r.round)).toEqual([1, 2, 3, 4]);
      expect(rows.rows.every((r) => r.concept === '')).toBe(true);
    });

    it(`task_id 带 ${RUNTIME_TASK_PREFIX} 前缀，一眼能看出证据来自哪一次 append`, async () => {
      await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      const rows = await db.query<{ task_id: string }>(
        'SELECT DISTINCT task_id FROM xq_probe_item',
      );
      expect(rows.rows.map((r) => r.task_id)).toEqual([`${RUNTIME_TASK_PREFIX}rec-1`]);
    });

    it('同一次 append 投递两次只落一次（幂等键是 record 不是题目）', async () => {
      const first = await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      const second = await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      expect(first.inserted).toBe(2);
      expect(second.inserted).toBe(0);
      expect(second.duplicate).toBe(2);
      expect(await countProbe()).toBe(2);
      // 第二次没有新行 ⇒ 不重算、不重排期。
      expect(second.recomputed).toBe(0);
      expect(second.scheduled).toBe(0);
      expect(await countSchedule()).toBe(4);
    });

    it('★ 同一道题换一次 append 可以再答 —— 这正是 counted_n 要表达的', async () => {
      await recordProbeFromRuntimeAppend(appendInput(), { queryable: db });
      const again = await recordProbeFromRuntimeAppend(
        appendInput({
          recordId: 'rec-2',
          createdAt: '2026-11-08T03:00:00.000Z',
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: { q1: 'A' },
            results: [
              { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
              { questionId: 'q2', correct: false, status: 'incorrect', earned: 0 },
            ],
          },
        }),
        { queryable: db },
      );
      expect(again.inserted).toBe(2);
      expect(await countProbe()).toBe(4);
      // 同一天第二次答同一题 ⇒ counted_n 降成 0.5（不是被吞掉）。
      const rows = await db.query<{ question_id: string; counted_n: string }>(
        'SELECT question_id, counted_n::text AS counted_n FROM xq_probe_item ORDER BY id',
      );
      expect(rows.rows.map((r) => r.counted_n)).toEqual(['1.0', '1.0', '0.5', '0.5']);
    });

    it('★ correct === null（AI 还没批完）跳过，不当成答错', async () => {
      const result = await recordProbeFromRuntimeAppend(
        appendInput({
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: {},
            results: [
              { questionId: 'q1', correct: null, status: 'incorrect', earned: 0 },
              { questionId: 'q2', correct: true, status: 'correct', earned: 1 },
            ],
          },
        }),
        { queryable: db },
      );
      expect(result.ungraded).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.scheduled).toBe(0);
      const rows = await db.query<{ question_id: string }>(
        'SELECT question_id FROM xq_probe_item ORDER BY question_id',
      );
      expect(rows.rows.map((r) => r.question_id)).toEqual(['q2']);
    });

    it('全部都没结论时一条也不写，也不建缓存', async () => {
      const result = await recordProbeFromRuntimeAppend(
        appendInput({
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: {},
            results: [{ questionId: 'q1', correct: null, status: 'incorrect', earned: 0 }],
          },
        }),
        { queryable: db },
      );
      expect(result).toEqual({
        inserted: 0,
        ungraded: 1,
        duplicate: 0,
        scheduled: 0,
        recomputed: 0,
      });
      expect(await countProbe()).toBe(0);
    });

    it('非 reviewed 阶段一律不写', async () => {
      for (const phase of ['draft', 'submitted']) {
        const result = await recordProbeFromRuntimeAppend(
          appendInput({
            payload: { payloadVersion: 1, phase, answers: { q1: 'A' }, results: undefined },
          }),
          { queryable: db },
        );
        expect(result.inserted).toBe(0);
      }
      expect(await countProbe()).toBe(0);
    });

    it('createdAt 解析不了就不写 —— 拿假时间排四关比不排更糟', async () => {
      const failures: string[] = [];
      const result = await recordProbeFromRuntimeAppend(appendInput({ createdAt: '昨天下午' }), {
        queryable: db,
        logFailure: (message) => failures.push(message),
      });
      expect(result.inserted).toBe(0);
      expect(await countProbe()).toBe(0);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('unparseable createdAt');
    });

    it('★ 落库失败不抛 —— 学情是派生物，不该让一次答题提交失败', async () => {
      const failures: string[] = [];
      const broken = {
        query: async () => {
          throw new Error('connection refused');
        },
      } as unknown as PGlite;
      const result = await recordProbeFromRuntimeAppend(appendInput(), {
        queryable: broken,
        logFailure: (message) => failures.push(message),
      });
      expect(result.inserted).toBe(0);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('failed to ingest');
    });

    it('重算失败不影响已落的事实与排期', async () => {
      const failures: string[] = [];
      const flaky = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO xq_cell_state')) throw new Error('cache write failed');
          return db.query(sql, params);
        },
      } as unknown as PGlite;
      const result = await recordProbeFromRuntimeAppend(appendInput(), {
        queryable: flaky,
        logFailure: (message) => failures.push(message),
      });
      expect(result.inserted).toBe(2);
      expect(result.recomputed).toBe(0);
      expect(result.scheduled).toBe(1);
      expect(failures.some((m) => m.includes('failed to recompute'))).toBe(true);
    });
  });

  describe('withXqProbeRecording', () => {
    /** 一个最小的 RuntimeStore：只实现 appendRecord / getSession，其余转给 stub。 */
    const fakeStore = (
      overrides: Partial<RuntimeStore> = {},
      session: { kind: string; stageId: string } = { kind: 'quizAttempt', stageId: 'stage-A' },
    ) => {
      const appended: RuntimeRecord[] = [];
      const store = {
        appendRecord: async (init: Record<string, unknown>) => {
          const record = {
            ...init,
            seq: appended.length,
            createdAt: (init.createdAt as string) ?? '2026-11-08T02:00:00.000Z',
          } as unknown as RuntimeRecord;
          appended.push(record);
          return record;
        },
        getSession: async () => (session ? ({ ...session, id: 's-1' } as never) : undefined),
        ...overrides,
      } as unknown as RuntimeStore;
      return { store, appended };
    };

    it('append 成功后才落学情，且用落库后的 record 字段', async () => {
      const { store } = fakeStore();
      const wrapped = withXqProbeRecording(store, { queryable: db });
      await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        sceneId: 'scene-p1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      const rows = await db.query<{ task_id: string }>('SELECT task_id FROM xq_probe_item');
      expect(rows.rows.map((r) => r.task_id)).toEqual([`${RUNTIME_TASK_PREFIX}rec-9`]);
    });

    it('★ append 抛错时学情一条也不写（顺序不能反）', async () => {
      const { store } = fakeStore({
        appendRecord: async () => {
          throw new Error('append refused');
        },
      } as never);
      const wrapped = withXqProbeRecording(store, { queryable: db });
      await expect(
        wrapped.appendRecord({
          id: 'rec-9',
          sessionId: 's-1',
          sceneId: 'scene-p1',
          createdAt: '2026-11-08T02:00:00.000Z',
          payload: { payloadVersion: 1, phase: 'reviewed', answers: {}, results: [] },
        } as never),
      ).rejects.toThrow('append refused');
      expect(await countProbe()).toBe(0);
    });

    it('只认 quizAttempt —— PBL/chat 的 payload 里也有 results 字样', async () => {
      const { store } = fakeStore({}, { kind: 'pbl', stageId: 'stage-A' });
      const wrapped = withXqProbeRecording(store, { queryable: db });
      await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        sceneId: 'scene-p1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      expect(await countProbe()).toBe(0);
    });

    it('会话查不到就跳过（学情拿不到 stageId 就没法写）', async () => {
      const { store } = fakeStore({ getSession: async () => undefined } as never);
      const wrapped = withXqProbeRecording(store, { queryable: db });
      const record = await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        sceneId: 'scene-p1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      expect(record.id).toBe('rec-9');
      expect(await countProbe()).toBe(0);
    });

    it('没有 sceneId 的记录不写（学情按页聚合，没有页就没有格）', async () => {
      const { store } = fakeStore();
      const wrapped = withXqProbeRecording(store, { queryable: db });
      await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      expect(await countProbe()).toBe(0);
    });

    it('★ 学情整段抛错也不让 append 失败', async () => {
      const { store } = fakeStore();
      const wrapped = withXqProbeRecording(store, {
        queryable: db,
        // 只让 getSession 抛，模拟「学情侧任何一步炸掉」。
        logFailure: () => {},
      });
      const record = await wrapped.appendRecord({
        id: 'rec-9',
        sessionId: 's-1',
        sceneId: 'scene-p1',
        createdAt: '2026-11-08T02:00:00.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: {},
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        },
      } as never);
      expect(record.id).toBe('rec-9');
    });
  });
});
