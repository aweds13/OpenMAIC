import { describe, expect, it } from 'vitest';

import {
  quizQuestionsOf,
  sceneWriteDiagnostics,
} from '@/lib/server/agent-runtime/scene-diagnostics';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { Scene } from '@/lib/types/stage';

function quizScene(
  order: number,
  questions: { id: string; question: string; options?: unknown[]; analysis?: string }[],
): Scene {
  return {
    id: `scene-p${order}`,
    stageId: 'stage-a',
    title: '小测',
    order,
    type: 'quiz',
    content: { type: 'quiz', questions },
  } as unknown as Scene;
}

function slideScene(order: number, text: string): Scene {
  return {
    id: `scene-p${order}`,
    stageId: 'stage-a',
    title: `第 ${order} 页`,
    order,
    type: 'slide',
    content: { canvas: { elements: [{ type: 'text', content: `<p>${text}</p>` }] } },
  } as unknown as Scene;
}

function plan(entries: { order: number; type: string; title: string; description?: string }[]) {
  return { outlines: entries } as unknown as AppDocumentOutline;
}

describe('quizQuestionsOf', () => {
  it('keeps title-bearing questions and flattens option labels', () => {
    const scene = quizScene(1, [
      {
        id: 'q1',
        question: '哪个是封装？',
        options: [{ label: '隐藏数据', value: 'A' }, '裸字符串选项'],
        analysis: '因为封装把数据藏起来',
      },
      { id: 'q2', question: '缺题的' } as never,
    ]);
    const questions = quizQuestionsOf(scene);
    expect(questions).toHaveLength(2);
    expect(questions[0]?.options).toEqual(['隐藏数据', '裸字符串选项']);
    expect(questions[0]?.analysis).toBe('因为封装把数据藏起来');
  });

  it('returns nothing for a non-quiz page', () => {
    expect(quizQuestionsOf(slideScene(1, '类是模板'))).toEqual([]);
  });
});

describe('sceneWriteDiagnostics', () => {
  it('checks coverage only on quiz pages', () => {
    const slide = slideScene(1, '类是模板');
    const onSlide = sceneWriteDiagnostics({ scenes: [slide], scene: slide, outline: undefined });
    expect(onSlide.coverageGaps).toEqual([]);
    expect(onSlide.coverageText).toBe('');

    const quiz = quizScene(2, [{ id: 'q1', question: '考动态绑定和消息传递' }]);
    const onQuiz = sceneWriteDiagnostics({
      scenes: [slide, quiz],
      scene: quiz,
      outline: undefined,
    });
    expect(onQuiz.coverageGaps.length).toBeGreaterThan(0);
    expect(onQuiz.coverageText).toContain('Quiz coverage check');
  });

  it('renders the plan diagnostic when the plan has a forward reference', () => {
    // 自检在第 2 页，讲它的在第 3 页 ⇒ 超前引用。
    const quiz = quizScene(2, [{ id: 'q1', question: '考多态：父类引用' }]);
    const result = sceneWriteDiagnostics({
      scenes: [quiz],
      scene: quiz,
      outline: plan([
        { order: 2, type: 'quiz', title: '小测', description: '考多态：父类引用' },
        { order: 3, type: 'slide', title: '多态', description: '考多态：父类引用' },
      ]),
    });
    expect(result.planIssues.length).toBeGreaterThan(0);
    expect(result.planText).toContain('Plan dependency check');
  });

  it('★ says NOTHING about the plan when the plan is empty — T3 cannot audit an existing course', () => {
    // 这条钉的是一个**已知且刻意的性质**，也是回答用户那句
    // 「让 AI 在原来 Day 1 上修复，它能按着已有规则来吗」的核心：
    // 已有课程的计划是空的（实测 7 门课 0 条），所以计划检查**一句话都不说**。
    // 它审的是"正在排的计划"，不是"已有的课"。
    const quiz = quizScene(2, [{ id: 'q1', question: '考动态绑定' }]);
    const result = sceneWriteDiagnostics({
      scenes: [quiz],
      scene: quiz,
      outline: plan([]),
    });
    expect(result.planIssues).toEqual([]);
    expect(result.planText).toBe('');
    // 同一页的覆盖缺口**照样会报** —— 那是"查页面"的那一半，与计划无关。
    expect(result.coverageGaps.length).toBeGreaterThan(0);
  });

  it('tolerates a missing envelope entirely', () => {
    const quiz = quizScene(1, [{ id: 'q1', question: '考封装' }]);
    const result = sceneWriteDiagnostics({ scenes: [quiz], scene: quiz, outline: undefined });
    expect(result.planIssues).toEqual([]);
    expect(result.planText).toBe('');
  });
});
