import type { ConfidenceMap } from '@/lib/quiz/confidence';
import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';
import type { QuizAttemptState, QuizAttemptWriter, QuizDraftInput } from '@/lib/quiz/runtime';

export type QuizRuntimeGate =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; attemptId: string };

export interface QuizViewLifetime {
  capture(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export function createQuizViewLifetime(): QuizViewLifetime {
  let generation = 0;
  return {
    capture: () => generation,
    invalidate: () => {
      generation += 1;
    },
    isCurrent: (token) => token === generation,
  };
}

export async function runQuizPersistenceTransition(
  persist: () => Promise<void>,
  lifetime: QuizViewLifetime,
  onSuccess: () => void,
  onError: (error: unknown) => void,
): Promise<void> {
  const token = lifetime.capture();
  try {
    await persist();
  } catch (error) {
    if (lifetime.isCurrent(token)) onError(error);
    return;
  }
  if (lifetime.isCurrent(token)) onSuccess();
}

export function isQuizRuntimeReady(
  gate: QuizRuntimeGate,
): gate is Extract<QuizRuntimeGate, { status: 'ready' }> {
  return gate.status === 'ready';
}

export async function persistQuizRetry(
  input: { stageId: string; sceneId: string; attemptId: string },
  writer: Pick<QuizAttemptWriter, 'recordPhase'>,
): Promise<void> {
  await writer.recordPhase({
    ...input,
    phase: 'draft',
    answers: {},
    startNewAttempt: true,
  });
}

export async function persistQuizSubmission(
  input: QuizDraftInput,
  writer: Pick<QuizAttemptWriter, 'recordPhase'>,
): Promise<void> {
  await writer.recordPhase({ ...input, phase: 'submitted' });
}

export async function persistQuizReview(
  input: QuizDraftInput & { results: QuestionResult[] },
  writer: Pick<QuizAttemptWriter, 'recordPhase'>,
): Promise<void> {
  await writer.recordPhase({ ...input, phase: 'reviewed' });
}

export interface QuizViewHydratedState {
  phase: 'not_started' | 'answering' | 'reviewing';
  answers: QuizAnswers;
  results: QuestionResult[];
  /** 已落库的自评。换页签/刷新后要接着显示，不能只活在组件 state 里。 */
  confidence: ConfidenceMap;
}

export function quizViewStateFromAttempt(
  state: QuizAttemptState | undefined,
): QuizViewHydratedState {
  if (!state) {
    return { phase: 'not_started', answers: {}, results: [], confidence: {} };
  }
  const confidence = state.confidence ?? {};
  if (state.phase === 'reviewed') {
    return {
      phase: 'reviewing',
      answers: state.answers,
      results: state.results ?? [],
      confidence,
    };
  }
  if (state.phase === 'draft' && Object.keys(state.answers).length === 0) {
    return { phase: 'not_started', answers: {}, results: [], confidence };
  }
  return { phase: 'answering', answers: state.answers, results: [], confidence };
}
