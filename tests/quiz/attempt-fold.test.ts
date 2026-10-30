import { describe, expect, it } from 'vitest';
import type { QuizAttemptPhase, RuntimePayload, RuntimeRecord } from '@openmaic/dsl';

import {
  foldQuizAttempts,
  sceneStateOf,
  type FoldQuizAttemptsInput,
  type QuizFoldSession,
} from '@/lib/quiz/attempt-fold';
import type { QuestionResult } from '@/lib/quiz/grading';

/** 默认 stage。页面 id 只在 stage 内唯一，所以测试也得带上课。 */
const STAGE = 'stage-a';

const T0 = '2026-10-07T02:00:00.000Z';
const T1 = '2026-10-07T03:00:00.000Z';
/** One second after T1 — the retry's first record. */
const T1B = '2026-10-07T03:00:01.000Z';
const T2 = '2026-10-07T04:00:00.000Z';

function record(init: {
  id: string;
  sessionId: string;
  seq: number;
  sceneId?: string;
  createdAt?: string;
  payload: RuntimePayload;
}): RuntimeRecord {
  return {
    id: init.id,
    sessionId: init.sessionId,
    seq: init.seq,
    ...(init.sceneId === undefined ? {} : { sceneId: init.sceneId }),
    createdAt: init.createdAt ?? T0,
    payload: init.payload,
  };
}

function session(
  id: string,
  createdAt: string,
  status: QuizFoldSession['status'] = 'completed',
  stageId: string = STAGE,
): QuizFoldSession {
  return { id, stageId, createdAt, status };
}

function phasePayload(
  phase: QuizAttemptPhase,
  answers: Record<string, string | string[]>,
  results?: QuestionResult[],
  payloadVersion = 1,
): RuntimePayload {
  return {
    payloadVersion,
    phase,
    answers,
    ...(results === undefined ? {} : { results }),
  };
}

function graded(questionId: string, correct: boolean, earned: number): QuestionResult {
  return {
    questionId,
    correct,
    status: correct ? 'correct' : 'incorrect',
    earned,
  };
}

function fold(input: Partial<FoldQuizAttemptsInput>) {
  return foldQuizAttempts({ sessions: input.sessions ?? [], records: input.records ?? [] });
}

describe('foldQuizAttempts', () => {
  it('returns nothing for nothing, without inventing a scene', () => {
    expect(fold({})).toEqual({ scenes: [], skipped: [] });
  });

  it('accounts for every input record — folded or explicitly skipped', () => {
    const records = [
      record({
        id: 'ok',
        sessionId: 's1',
        seq: 0,
        sceneId: 'scene-p7',
        payload: phasePayload('draft', { q1: 'A' }),
      }),
      record({
        id: 'unanchored',
        sessionId: 's1',
        seq: 1,
        payload: phasePayload('draft', { q1: 'B' }),
      }),
      record({
        id: 'bad',
        sessionId: 's1',
        seq: 2,
        sceneId: 'scene-p7',
        payload: null,
      }),
      record({
        id: 'orphan',
        sessionId: 'gone',
        seq: 0,
        sceneId: 'scene-p7',
        payload: phasePayload('draft', { q1: 'C' }),
      }),
    ];

    const result = fold({ sessions: [session('s1', T0)], records });

    expect(
      result.scenes.reduce((total, scene) => total + scene.records, 0) + result.skipped.length,
    ).toBe(records.length);
    expect(result.scenes[0].records).toBe(1);
    expect(result.skipped.map((skip) => skip.reason).sort()).toEqual([
      'unanchored',
      'unknown-session',
      'unreadable-payload',
    ]);
  });

  it('folds a draft-only page without counting it as an attempt', () => {
    const result = fold({
      sessions: [session('s1', T0, 'active')],
      records: [
        record({
          id: 'r1',
          sessionId: 's1',
          seq: 0,
          sceneId: 'scene-p7',
          createdAt: T1,
          payload: phasePayload('draft', { q1: 'B' }),
        }),
      ],
    });

    expect(result.skipped).toEqual([]);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]).toMatchObject({
      sceneId: 'scene-p7',
      sessions: 1,
      attempts: 0,
      phase: 'draft',
      answers: { q1: 'B' },
      questions: [],
      incorrectNow: [],
      everIncorrect: [],
      earned: 0,
      firstAt: T1,
      lastAt: T1,
    });
  });

  it('folds a full lifecycle into per-question verdicts', () => {
    const result = fold({
      sessions: [session('s1', T0)],
      records: [
        record({
          id: 'r0',
          sessionId: 's1',
          seq: 0,
          sceneId: 'scene-p7',
          payload: phasePayload('draft', { q1: 'B' }),
        }),
        record({
          id: 'r1',
          sessionId: 's1',
          seq: 1,
          sceneId: 'scene-p7',
          createdAt: T1,
          payload: phasePayload('submitted', { q1: 'B', q2: 'C' }),
        }),
        record({
          id: 'r2',
          sessionId: 's1',
          seq: 2,
          sceneId: 'scene-p7',
          createdAt: T2,
          payload: phasePayload('reviewed', { q1: 'B', q2: 'C' }, [
            graded('q1', false, 0),
            graded('q2', true, 15),
          ]),
        }),
      ],
    });

    expect(result.scenes[0]).toMatchObject({
      attempts: 1,
      phase: 'reviewed',
      answers: { q1: 'B', q2: 'C' },
      incorrectNow: ['q1'],
      everIncorrect: ['q1'],
      earned: 15,
      correctCount: 1,
      incorrectCount: 1,
    });
    expect(result.scenes[0].questions).toEqual([
      { questionId: 'q1', status: 'incorrect', earned: 0, answer: 'B' },
      { questionId: 'q2', status: 'correct', earned: 15, answer: 'C' },
    ]);
  });

  it('keeps a corrected mistake in everIncorrect but clears incorrectNow', () => {
    const result = fold({
      sessions: [session('attempt-1', T0), session('attempt-1:retry:1', T1, 'active')],
      records: [
        record({
          id: 'a1',
          sessionId: 'attempt-1',
          seq: 0,
          sceneId: 'scene-p7',
          payload: phasePayload('submitted', { q1: 'B' }),
        }),
        record({
          id: 'a2',
          sessionId: 'attempt-1',
          seq: 1,
          sceneId: 'scene-p7',
          createdAt: T1,
          payload: phasePayload('reviewed', { q1: 'B' }, [graded('q1', false, 0)]),
        }),
        record({
          id: 'b1',
          sessionId: 'attempt-1:retry:1',
          seq: 0,
          sceneId: 'scene-p7',
          createdAt: T1B,
          payload: phasePayload('submitted', { q1: 'A' }),
        }),
        record({
          id: 'b2',
          sessionId: 'attempt-1:retry:1',
          seq: 1,
          sceneId: 'scene-p7',
          createdAt: T2,
          payload: phasePayload('reviewed', { q1: 'A' }, [graded('q1', true, 10)]),
        }),
      ],
    });

    expect(result.scenes[0]).toMatchObject({
      sessions: 2,
      attempts: 2,
      incorrectNow: [],
      everIncorrect: ['q1'],
      earned: 10,
      correctCount: 1,
      incorrectCount: 0,
    });
  });

  it('orders records by seq, never by timestamp', () => {
    const result = fold({
      sessions: [session('s1', T0)],
      records: [
        // Deliberately shuffled, and the highest seq carries the OLDEST timestamp.
        record({
          id: 'r2',
          sessionId: 's1',
          seq: 2,
          sceneId: 'scene-p7',
          createdAt: T0,
          payload: phasePayload('draft', { q1: 'D' }),
        }),
        record({
          id: 'r0',
          sessionId: 's1',
          seq: 0,
          sceneId: 'scene-p7',
          createdAt: T2,
          payload: phasePayload('submitted', { q1: 'B' }),
        }),
        record({
          id: 'r1',
          sessionId: 's1',
          seq: 1,
          sceneId: 'scene-p7',
          createdAt: T2,
          payload: phasePayload('reviewed', { q1: 'B' }, [graded('q1', false, 0)]),
        }),
      ],
    });

    expect(result.scenes[0]).toMatchObject({
      phase: 'draft',
      answers: { q1: 'D' },
      // The standing verdict still comes from the newest GRADED attempt, so an
      // in-flight retry draft must not erase it.
      incorrectNow: ['q1'],
      everIncorrect: ['q1'],
    });
    // The verdict stays paired with the answer it actually graded ('B'), not the
    // newer draft answer ('D').
    expect(result.scenes[0].questions).toEqual([
      { questionId: 'q1', status: 'incorrect', earned: 0, answer: 'B' },
    ]);
  });

  it('orders sessions by createdAt regardless of array order', () => {
    const result = fold({
      // Newest session first in the array on purpose.
      sessions: [session('later', T1), session('earlier', T0)],
      records: [
        record({
          id: 'old',
          sessionId: 'earlier',
          seq: 0,
          sceneId: 'scene-p7',
          payload: phasePayload('reviewed', { q1: 'B' }, [graded('q1', false, 0)]),
        }),
        record({
          id: 'new',
          sessionId: 'later',
          seq: 0,
          sceneId: 'scene-p7',
          createdAt: T2,
          payload: phasePayload('reviewed', { q1: 'A' }, [graded('q1', true, 10)]),
        }),
      ],
    });

    expect(result.scenes[0]).toMatchObject({
      answers: { q1: 'A' },
      incorrectNow: [],
      everIncorrect: ['q1'],
      earned: 10,
    });
  });

  it('skips unreadable payloads instead of failing the whole fold', () => {
    const result = fold({
      sessions: [session('s1', T0)],
      records: [
        record({
          id: 'bad-version',
          sessionId: 's1',
          seq: 0,
          sceneId: 'scene-p7',
          payload: phasePayload('draft', { q1: 'A' }, undefined, 2),
        }),
        record({
          id: 'bad-phase',
          sessionId: 's1',
          seq: 1,
          sceneId: 'scene-p7',
          payload: { payloadVersion: 1, phase: 'graded', answers: {} },
        }),
        record({ id: 'not-object', sessionId: 's1', seq: 2, sceneId: 'scene-p7', payload: null }),
        record({
          id: 'good',
          sessionId: 's1',
          seq: 3,
          sceneId: 'scene-p7',
          payload: phasePayload('draft', { q1: 'A' }),
        }),
      ],
    });

    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].phase).toBe('draft');
    expect(result.skipped).toEqual([
      { recordId: 'bad-version', sessionId: 's1', reason: 'unreadable-payload' },
      { recordId: 'bad-phase', sessionId: 's1', reason: 'unreadable-payload' },
      { recordId: 'not-object', sessionId: 's1', reason: 'unreadable-payload' },
    ]);
  });

  it('drops malformed question verdicts without losing the readable ones', () => {
    const result = fold({
      sessions: [session('s1', T0)],
      records: [
        record({
          id: 'r1',
          sessionId: 's1',
          seq: 0,
          sceneId: 'scene-p7',
          payload: phasePayload('reviewed', { q1: 'B' }, [
            graded('q1', false, 0),
            { status: 'correct' } as unknown as QuestionResult,
            { questionId: 'q3', status: 'maybe', earned: 5 } as unknown as QuestionResult,
            {
              questionId: 'q4',
              status: 'correct',
              earned: Number.NaN,
            } as unknown as QuestionResult,
          ]),
        }),
      ],
    });

    expect(result.scenes[0].questions).toEqual([
      { questionId: 'q1', status: 'incorrect', earned: 0, answer: 'B' },
      { questionId: 'q4', status: 'correct', earned: 0 },
    ]);
    expect(result.scenes[0].earned).toBe(0);
  });

  it('drops non-string answer values rather than passing them downstream', () => {
    const result = fold({
      sessions: [session('s1', T0)],
      records: [
        record({
          id: 'r1',
          sessionId: 's1',
          seq: 0,
          sceneId: 'scene-p7',
          payload: phasePayload('draft', {
            q1: 'A',
            q2: ['A', 'C'],
            q3: 7 as unknown as string,
            q4: ['A', 2] as unknown as string[],
          }),
        }),
      ],
    });

    expect(result.scenes[0].answers).toEqual({ q1: 'A', q2: ['A', 'C'] });
  });

  it('anchors each session to its first scene and skips a second one', () => {
    const result = fold({
      sessions: [session('s1', T0)],
      records: [
        record({
          id: 'r0',
          sessionId: 's1',
          seq: 0,
          sceneId: 'scene-p7',
          payload: phasePayload('draft', { q1: 'A' }),
        }),
        record({
          id: 'foreign',
          sessionId: 's1',
          seq: 1,
          sceneId: 'scene-p9',
          payload: phasePayload('draft', { q1: 'B' }),
        }),
      ],
    });

    expect(result.scenes.map((scene) => scene.sceneId)).toEqual(['scene-p7']);
    expect(result.skipped).toEqual([
      { recordId: 'foreign', sessionId: 's1', reason: 'mixed-anchor' },
    ]);
  });

  it('skips records with no scene anchor', () => {
    const result = fold({
      sessions: [session('s1', T0)],
      records: [
        record({ id: 'r0', sessionId: 's1', seq: 0, payload: phasePayload('draft', { q1: 'A' }) }),
      ],
    });

    expect(result.scenes).toEqual([]);
    expect(result.skipped).toEqual([{ recordId: 'r0', sessionId: 's1', reason: 'unanchored' }]);
  });

  it('reports records whose session is not in the input', () => {
    const result = fold({
      sessions: [session('s1', T0)],
      records: [
        record({
          id: 'orphan',
          sessionId: 's2',
          seq: 0,
          sceneId: 'scene-p7',
          payload: phasePayload('draft', { q1: 'A' }),
        }),
      ],
    });

    expect(result.scenes).toEqual([]);
    expect(result.skipped).toEqual([
      { recordId: 'orphan', sessionId: 's2', reason: 'unknown-session' },
    ]);
  });

  it('keeps pages independent and orders them by first appearance', () => {
    const result = fold({
      sessions: [session('s-p12', T0), session('s-p7', T1)],
      records: [
        record({
          id: 'p12',
          sessionId: 's-p12',
          seq: 0,
          sceneId: 'scene-p12',
          payload: phasePayload('reviewed', { q1: 'A' }, [graded('q1', true, 10)]),
        }),
        record({
          id: 'p7',
          sessionId: 's-p7',
          seq: 0,
          sceneId: 'scene-p7',
          createdAt: T2,
          payload: phasePayload('reviewed', { q1: 'B' }, [graded('q1', false, 0)]),
        }),
      ],
    });

    expect(result.scenes.map((scene) => scene.sceneId)).toEqual(['scene-p12', 'scene-p7']);
    expect(sceneStateOf(result, STAGE, 'scene-p7')?.incorrectNow).toEqual(['q1']);
    expect(sceneStateOf(result, STAGE, 'scene-p12')?.incorrectNow).toEqual([]);
    expect(sceneStateOf(result, STAGE, 'missing')).toBeUndefined();
  });

  it('keeps same-named pages in different courses apart', () => {
    // 回归 pin：`document_scenes` 的主键是 (stage_id, id)，所以 `scene-p9` 可以在
    // 多门课里同时存在（本部署实测 6 个 stage 在用）。只按 sceneId 做键会把两门课
    // 的同名页**合并成一页**，下游取题干时就会拿到另一门课的那道题。
    const result = fold({
      sessions: [
        session('s-a', T0, 'completed', 'stage-a'),
        session('s-b', T1, 'completed', 'stage-b'),
      ],
      records: [
        record({
          id: 'a1',
          sessionId: 's-a',
          seq: 0,
          sceneId: 'scene-p9',
          payload: phasePayload('reviewed', { q1: 'B' }, [graded('q1', false, 0)]),
        }),
        record({
          id: 'b1',
          sessionId: 's-b',
          seq: 0,
          sceneId: 'scene-p9',
          createdAt: T2,
          payload: phasePayload('reviewed', { q1: 'A' }, [graded('q1', true, 10)]),
        }),
      ],
    });

    expect(result.scenes).toHaveLength(2);
    expect(result.scenes.map((scene) => scene.stageId)).toEqual(['stage-a', 'stage-b']);
    expect(sceneStateOf(result, 'stage-a', 'scene-p9')?.incorrectNow).toEqual(['q1']);
    expect(sceneStateOf(result, 'stage-b', 'scene-p9')?.incorrectNow).toEqual([]);
  });
});
