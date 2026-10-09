/**
 * 课程级审计 —— 对着**真课程**跑，看"这些页有没有连成一门课"。
 *
 *   TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/course-audit-live.test.ts
 *
 * 这个用例是**先量再建**的那一半：判据写出来了，先看它在真实课程上**报不报得出东西**。
 * 报不出来（全是 0 / 没有断裂）就说明判据没用，不该建。所以断言只钉结构契约，
 * **要看的是打出来的那份报告**。
 */
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { auditCourse, formatCourseAudit, practiceTaskCount, type AuditedPage } from '@/lib/quiz/course-audit';

const live = process.env.TEST_LOAD_LOCAL_ENV === '1' && !!process.env.DATABASE_URL;

interface SceneRow {
  id: string;
  scene_order: number;
  type: string | null;
  title: string | null;
  data: unknown;
}

async function loadPages(client: Client, stageId: string): Promise<AuditedPage[]> {
  const rows = await client.query<SceneRow>(
    `SELECT id, scene_order, data->>'type' AS type, data->>'title' AS title, data
       FROM document_scenes WHERE stage_id = $1 ORDER BY scene_order`,
    [stageId],
  );
  return rows.rows.map((row) => ({
    stageId,
    sceneId: row.id,
    order: row.scene_order,
    title: row.title ?? '',
    type: row.type ?? 'slide',
    content: row.data,
  }));
}

describe.skipIf(!live)('course audit against real courses', () => {
  it('audits Day 1 and every other course, and prints the readings', async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL missing');

    const client = new Client({ connectionString });
    await client.connect();
    try {
      const stages = await client.query<{ stage_id: string; title: string | null; pages: string }>(
        `SELECT s.id AS stage_id, s.data->>'title' AS title, count(sc.id)::text AS pages
           FROM document_stages s LEFT JOIN document_scenes sc ON sc.stage_id = s.id
          GROUP BY 1, 2 HAVING count(sc.id) > 0 ORDER BY count(sc.id) DESC`,
      );

      const summary: string[] = [];
      for (const stage of stages.rows) {
        const pages = await loadPages(client, stage.stage_id);
        const audit = auditCourse(pages);
        const pct = Math.round(audit.averageCarryRatio * 100);
        summary.push(
          `${stage.stage_id} 《${stage.title ?? '?'}》 ${pages.length} 页 → ` +
            `讲解页平均承接率 ${pct}% · 无承接 ${audit.unattachedPages.length} · ` +
            `超载 ${audit.overloadedPages.length} · 中位新块 ${audit.medianNovel}`,
        );

        // ★ 练习页的**任务数**（2026-10-09）：学习者第 3 轮吐槽「练习页难度离谱」，
        //   量下来根因是**粒度** —— 一页塞了好几个任务。规矩是**一页一个任务**。
        const practices = pages
          .map((page) => ({ page, shape: practiceTaskCount(page) }))
          .filter(({ page }) => page.type === 'quiz' || page.type === 'interactive');
        if (practices.length > 0) {
          const multi = practices.filter(({ shape }) => (shape.tasks ?? 1) > 1);
          const unknown = practices.filter(({ shape }) => shape.tasks === null);
          const offContract = practices.filter(({ shape }) => !shape.followsContract);
          summary.push(
            `    练习页 ${practices.length}：一页多任务 **${multi.length}** · ` +
              `数不出来 ${unknown.length} · 没带上游 widgetConfig ${offContract.length}`,
          );
          for (const { page, shape } of multi) {
            summary.push(
              `      · P${page.order} ${page.title.slice(0, 30)} → ${shape.tasks} 个任务` +
                (shape.testCases === undefined ? '' : `（查 ${shape.testCases} 件事）`),
            );
          }
        }

        // 结构契约：不管数据怎样，这些必须成立。
        expect(audit.pages).toHaveLength(pages.length);
        expect(audit.averageCarryRatio).toBeGreaterThanOrEqual(0);
        expect(audit.averageCarryRatio).toBeLessThanOrEqual(1);
        expect(audit.pages.every((page) => page.novel + page.carried === page.terms)).toBe(true);
      }

      console.log(`\n[课程审计] 全部课程读数：\n  ${summary.join('\n  ')}`);

      // ★ 标定：讲解页一次引入多少**新块**（novel）。这是 T3 的 conceptsPerPage
      //   一直缺的那个真实分布 —— 它当初被标成"默认关闭、无数据可标定"。
      const novelByTeachingPage: { label: string; novel: number; terms: number }[] = [];
      for (const stage of stages.rows) {
        const pages = await loadPages(client, stage.stage_id);
        for (const page of auditCourse(pages).pages) {
          if (page.type === 'quiz' || page.terms === 0) continue;
          novelByTeachingPage.push({
            label: `${stage.stage_id} P${page.order}《${page.title}》`,
            novel: page.novel,
            terms: page.terms,
          });
        }
      }
      const novels = novelByTeachingPage.map((row) => row.novel).sort((a, b) => a - b);
      const pick = (q: number): number => novels[Math.min(novels.length - 1, Math.floor(novels.length * q))] ?? 0;
      console.log(
        `[标定] 讲解页 novel 分布（n=${novels.length}）：` +
          `min=${novels[0]} p50=${pick(0.5)} p75=${pick(0.75)} p90=${pick(0.9)} max=${novels.at(-1)}`,
      );
      const top = novelByTeachingPage
        .sort((a, b) => b.novel - a.novel)
        .slice(0, 8)
        .map(
          (row) =>
            `  novel=${String(row.novel).padStart(3)} / terms=${String(row.terms).padStart(3)}  ${row.label}`,
        );
      console.log(`[标定] 引入最多的 8 页：\n${top.join('\n')}`);

      // ★ 详细看 Day 1（用户复盘的那门课）。
      const day1 = await loadPages(client, 'stage-7tNoR37iqT');
      if (day1.length > 0) {
        const audit = auditCourse(day1);
        console.log(`\n[课程审计] Day 1 逐页承接（novel/carried/terms）：`);
        for (const page of audit.pages) {
          console.log(
            `  第 ${String(page.order).padStart(2)} 页 [${page.type}] ` +
              `承接 ${page.carried}/${page.terms} ` +
              `(${Math.round(page.carryRatio * 100)}%) 《${page.title}》`,
          );
        }
        console.log(`\n${formatCourseAudit(audit, { maxItems: 6 })}`);
      }
      expect(summary.length).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  }, 60_000);
});
