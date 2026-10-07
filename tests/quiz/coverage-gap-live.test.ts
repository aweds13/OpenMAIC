/**
 * 覆盖缺口检查 —— 对着**真课程**跑一遍，把报告打出来。
 *
 *   TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/coverage-gap-live.test.ts
 *
 * 断言是这个模块在真数据上的**结构契约**（无重复、不报单字、来源非空）；
 * **真正要看的是它打出来的那份报告** —— "哪些题在考没讲过的东西"只有人读了才知道
 * 是不是误报。这也是这个检查存在的形式：它交证据，不判对错。
 */
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';

import {
  findCourseCoverageGaps,
  formatCoverageGaps,
  type CoveragePage,
} from '@/lib/quiz/coverage-gap';
import { buildQuizGrounding } from '@/lib/quiz/quiz-grounding';

const live = process.env.TEST_LOAD_LOCAL_ENV === '1' && !!process.env.DATABASE_URL;

interface QuestionRow {
  id?: string;
  question?: string;
  options?: unknown;
  analysis?: string;
}

function optionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) =>
      typeof option === 'string'
        ? option
        : typeof (option as { label?: unknown })?.label === 'string'
          ? (option as { label: string }).label
          : undefined,
    )
    .filter((label): label is string => typeof label === 'string');
}

describe.skipIf(!live)('coverage gaps against a real course', () => {
  it('reports what a course\'s self-checks ask about that earlier pages never taught', async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL missing');

    const client = new Client({ connectionString });
    await client.connect();
    try {
      // 挑「自检页最多的那门课」而不是写死 id。
      const stageRows = await client.query<{ stage_id: string }>(
        `SELECT stage_id FROM document_scenes
          WHERE data->>'type' = 'quiz'
          GROUP BY stage_id ORDER BY count(*) DESC LIMIT 1`,
      );
      const stageId = stageRows.rows[0]?.stage_id;
      expect(stageId, 'no stage with quiz scenes').toBeTruthy();
      if (!stageId) return;

      const sceneRows = await client.query<{
        id: string;
        scene_order: number;
        data: { title?: string; type?: string; content?: { questions?: QuestionRow[] } };
      }>(
        `SELECT id, scene_order, data FROM document_scenes
          WHERE stage_id = $1 ORDER BY scene_order`,
        [stageId],
      );
      const scenes = sceneRows.rows;

      // ★ 传**全部页面**：讲解页也要进去贡献"已教文本"，只是不会被报告。
      const pages: CoveragePage[] = [];
      for (const scene of scenes) {
        const sceneQuestions = (scene.data.type === 'quiz' ? scene.data.content?.questions ?? [] : [])
          .filter(
            (question): question is QuestionRow & { id: string; question: string } =>
              typeof question.id === 'string' && typeof question.question === 'string',
          )
          .map((question) => ({
            id: question.id,
            question: question.question,
            options: optionLabels(question.options),
            ...(question.analysis ? { analysis: question.analysis } : {}),
          }));
        pages.push({
          sceneId: scene.id,
          order: scene.scene_order,
          title: scene.data.title ?? scene.id,
          questions: sceneQuestions,
          content: scene.data.content,
        });
      }

      const reports: string[] = [];
      let totalGaps = 0;

      for (const { page, taughtChars, gaps } of findCourseCoverageGaps(pages)) {
        const questions = page.questions;
        if (questions.length === 0) continue;
        totalGaps += gaps.length;

        // ── 结构契约（在真数据上也要成立）────────────────────────────
        const terms = gaps.map((gap) => gap.term);
        expect(new Set(terms).size).toBe(terms.length);
        expect(gaps.every((gap) => gap.term.length >= 2)).toBe(true);
        expect(gaps.every((gap) => gap.sources.length > 0)).toBe(true);

        const block = formatCoverageGaps(gaps, { maxTerms: 12 });
        reports.push(
          `\n── 第 ${page.order} 页《${page.title}》` +
            `（${questions.length} 题，已教 ${taughtChars} 字）—— 缺口 ${gaps.length} 段\n` +
            (block || '  （没有缺口）'),
        );
      }

      console.log(
        `\nstage ${stageId}：${reports.length} 个自检页，合计缺口 ${totalGaps} 段` +
          reports.join('\n'),
      );

      // 出题**前**注入的那一块有多大 / 长什么样 —— 注入是"拦"，缺口报告是"查"。
      const firstQuiz = pages.find((page) => page.questions.length > 0);
      if (firstQuiz) {
        const grounding = buildQuizGrounding({
          scenes: pages.map((page) => ({
            order: page.order,
            title: page.title,
            content: page.content,
          })),
          beforeOrder: firstQuiz.order,
        });
        const terms = (grounding.split('allowed terms) ---')[1] ?? '')
          .split('=== END QUIZ')[0]
          .trim()
          .split('\n')
          .filter(Boolean);
        console.log(
          `\n[注入] 第 ${firstQuiz.order} 页《${firstQuiz.title}》：` +
            `块 ${grounding.length} 字，词表 ${terms.length} 个，前 12 个：\n  ` +
            terms.slice(0, 12).join(' / '),
        );
      }

      expect(reports.length).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  }, 30_000);
});
