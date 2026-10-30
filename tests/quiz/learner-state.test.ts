import { describe, expect, it } from 'vitest';

import type { QuizFoldSkip, QuizQuestionState, QuizSceneState } from '@/lib/quiz/attempt-fold';
import { renderLearnerState, type LearnerStateSceneContent } from '@/lib/quiz/learner-state';

function question(
  questionId: string,
  status: 'correct' | 'incorrect',
  answer?: string,
): QuizQuestionState {
  return { questionId, status, earned: 0, ...(answer === undefined ? {} : { answer }) };
}

function scene(init: Partial<QuizSceneState> & { sceneId: string }): QuizSceneState {
  return {
    stageId: STAGE,
    records: 1,
    sessions: 1,
    attempts: 1,
    phase: 'reviewed',
    answers: {},
    questions: [],
    incorrectNow: [],
    everIncorrect: [],
    earned: 0,
    correctCount: 0,
    incorrectCount: 0,
    firstAt: null,
    lastAt: null,
    ...init,
  };
}

/** 默认 stage。页面 id 只在 stage 内唯一，所以内容也得带上课。 */
const STAGE = 'stage-a';

function content(
  sceneId: string,
  order: number,
  title: string,
  questions: { id: string; question: string }[],
  stageId: string = STAGE,
): LearnerStateSceneContent {
  return { stageId, sceneId, order, title, questions };
}

/**
 * 小节标题的**前缀**（含 `**`）。
 *
 * 断言必须钉在标题上，不能钉裸短语：这块文本的「读到这一块之后怎么做」里
 * **引用了某些标题的名字**（「有「现在还做错的」时…」），所以
 * `not.toContain('现在还做错的')` 会被自己的用法说明打穿。
 */
const RETRY_HEADER = '**现在还做错的（';
const DRAFT_HEADER = '**答过但没交卷（';
const CLEAN_HEADER = '**已经全对（';

describe('renderLearnerState', () => {
  it('says nothing when there is nothing to say', () => {
    expect(renderLearnerState({ scenes: [], contents: [] })).toBe('');
  });

  it('renders the wrong questions with their text, not just their ids', () => {
    const text = renderLearnerState({
      scenes: [
        scene({
          sceneId: 'scene-p9',
          answers: { q8: 'B' },
          questions: [question('q8', 'incorrect', 'B')],
          incorrectNow: ['q8'],
          everIncorrect: ['q8'],
          incorrectCount: 1,
        }),
      ],
      contents: [
        content('scene-p9', 9, '多态', [{ id: 'q8', question: '下面哪一段体现了多态？' }]),
      ],
    });

    expect(text).toContain('「下面哪一段体现了多态？」');
    expect(text).toContain('第 9 页《多态》');
    expect(text).toContain('题号 q8');
    expect(text).toContain('答 B');
    expect(text).toContain(RETRY_HEADER);
    expect(text).not.toContain('已经全对');
  });

  it('explains a question id that no longer exists on the page', () => {
    const text = renderLearnerState({
      scenes: [
        scene({
          sceneId: 'scene-p9',
          questions: [question('q8', 'incorrect')],
          incorrectNow: ['q8'],
        }),
      ],
      contents: [content('scene-p9', 9, '多态', [{ id: 'q1', question: '新的一题' }])],
    });

    expect(text).toContain('原题已不在这一页');
    expect(text).toContain('题号 q8');
    // Must not silently borrow the text of a different question.
    expect(text).not.toContain('新的一题');
  });

  it('separates "answered but never submitted" from "never studied"', () => {
    const text = renderLearnerState({
      scenes: [
        scene({
          sceneId: 'scene-p7',
          phase: 'draft',
          attempts: 0,
          answers: { q1: 'B', q2: 'C' },
        }),
      ],
      contents: [content('scene-p7', 7, '命令侦探', [{ id: 'q1', question: '哪一行错了？' }])],
    });

    expect(text).toContain(DRAFT_HEADER);
    expect(text).toContain('第 7 页《命令侦探》');
    expect(text).toContain('已作答 2 题');
    expect(text).not.toContain(RETRY_HEADER);
  });

  it('lists all-correct pages so the budget is not spent re-testing them', () => {
    const text = renderLearnerState({
      scenes: [
        scene({
          sceneId: 'scene-p12',
          questions: [question('q1', 'correct'), question('q2', 'correct')],
          correctCount: 2,
        }),
      ],
      contents: [content('scene-p12', 12, 'HTTP 基础', [{ id: 'q1', question: 'A' }])],
    });

    expect(text).toContain(CLEAN_HEADER);
    expect(text).toContain('第 12 页《HTTP 基础》：2/2');
    expect(text).not.toContain(RETRY_HEADER);
  });

  it('counts corrected mistakes without putting them in the retry list', () => {
    const text = renderLearnerState({
      scenes: [
        scene({
          sceneId: 'scene-p7',
          questions: [question('q1', 'correct', 'A')],
          correctCount: 1,
          everIncorrect: ['q1'],
          // incorrectNow is empty: the newest attempt got it right.
        }),
      ],
      contents: [content('scene-p7', 7, '命令侦探', [{ id: 'q1', question: '哪一行错了？' }])],
    });

    expect(text).toContain('曾经做错、后来改对的共 1 道');
    expect(text).not.toContain(RETRY_HEADER);
    // Both facts stay visible: it IS all-correct now.
    expect(text).toContain(CLEAN_HEADER);
  });

  it('caps the retry list and says how many are left', () => {
    const ids = Array.from({ length: 5 }, (_, index) => `q${index + 1}`);
    const text = renderLearnerState({
      maxQuestions: 2,
      scenes: [
        scene({
          sceneId: 'scene-p9',
          answers: Object.fromEntries(ids.map((id) => [id, 'B'])),
          questions: ids.map((id) => question(id, 'incorrect', 'B')),
          incorrectNow: ids,
          incorrectCount: 5,
        }),
      ],
      contents: [
        content(
          'scene-p9',
          9,
          '多态',
          ids.map((id) => ({ id, question: `第 ${id} 题` })),
        ),
      ],
    });

    expect(text).toContain('第 q1 题');
    expect(text).toContain('第 q2 题');
    expect(text).not.toContain('第 q3 题');
    expect(text).toContain('…还有 3 道');
  });

  it('warns when records were dropped, so "missing" is not read as "never done"', () => {
    const skipped: QuizFoldSkip[] = [
      { recordId: 'r1', sessionId: 's1', reason: 'unreadable-payload' },
      { recordId: 'r2', sessionId: 's1', reason: 'unreadable-payload' },
      { recordId: 'r3', sessionId: 's2', reason: 'unanchored' },
    ];
    const text = renderLearnerState({ scenes: [], contents: [], skipped });

    expect(text).toBeTruthy();
    expect(text).toContain('有 3 条记录读不出来');
    expect(text).toContain('unreadable-payload、unanchored');
    expect(text).toContain('可能不完整');
  });

  it('always carries its own usage rules and the do-not-recite warning', () => {
    const text = renderLearnerState({
      scenes: [
        scene({
          sceneId: 'scene-p9',
          questions: [question('q8', 'incorrect')],
          incorrectNow: ['q8'],
        }),
      ],
      contents: [content('scene-p9', 9, '多态', [{ id: 'q8', question: '哪一段是多态？' }])],
    });

    expect(text).toContain('不要念给学习者听');
    expect(text).toContain('读到这一块之后怎么做');
    expect(text).toContain('不许出新题把它们绕过去');
  });

  it('flattens multi-line question text so the list stays a list', () => {
    const text = renderLearnerState({
      scenes: [
        scene({
          sceneId: 'scene-p9',
          questions: [question('q8', 'incorrect')],
          incorrectNow: ['q8'],
        }),
      ],
      contents: [
        content('scene-p9', 9, '多态', [{ id: 'q8', question: '第一行\n第二行\n第三行' }]),
      ],
    });

    expect(text).toContain('「第一行 第二行 第三行」');
    expect(text).not.toContain('第一行\n第二行');
  });

  it("does not borrow another course's question text for the same scene id", () => {
    // 回归 pin：`scene-p9` 这种 id 在多门课里都存在。内容属于**别的 stage** 时，
    // 绝不能拿来当这一页的题干 —— 实测踩过：Dart 的题干差点注进 Git/OOP 课的状态里。
    const text = renderLearnerState({
      scenes: [
        scene({
          sceneId: 'scene-p9',
          questions: [question('q8', 'incorrect')],
          incorrectNow: ['q8'],
        }),
      ],
      contents: [
        content(
          'scene-p9',
          9,
          '别的课：Dart 语法',
          [{ id: 'q8', question: 'Dart 的 async / await 哪种说法正确？' }],
          'stage-other',
        ),
      ],
    });

    expect(text).toContain('原题已不在这一页');
    expect(text).not.toContain('Dart');
  });
});
