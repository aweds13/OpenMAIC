/**
 * 对着**真记录**跑一遍折叠。
 *
 * 默认不跑 —— `tests/setup-env.ts` 刻意不加载 `.env.local`（hermetic）。要跑
 * 真库就显式开：
 *
 *   TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/attempt-fold-live.test.ts
 *
 * ── 它为什么存在 ───────────────────────────────────────────────────
 *
 * 纯函数单测只证明「按写的方式跑」，不证明「对着真记录做对了事」。真记录里
 * 有折叠器自己想不到的形状（重复作答、只写草稿就走的会话、批改结果缺字段），
 * 所以这里喂真数据，并断言几条**在任何部署上都必须成立**的不变式：
 *
 *   · 每条输入记录要么进了某页、要么在 skipped 里带原因 —— 没有第三条路；
 *   · `incorrectNow ⊆ everIncorrect`（现在的错必然是历史错过的子集）；
 *   · 尝试数不超过会话数；逐题计数之和等于题数。
 *
 * 具体读数（哪一页错了几题）是本部署的数据，不在这里断言，只打印出来看。
 */
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { RuntimeRecord } from '@openmaic/dsl';

import { foldQuizAttempts, type QuizFoldSession } from '@/lib/quiz/attempt-fold';

const live = process.env.TEST_LOAD_LOCAL_ENV === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!live)('foldQuizAttempts against the live runtime store', () => {
  it('folds a real course and accounts for every record', async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL missing');

    const client = new Client({ connectionString });
    await client.connect();
    try {
      // 挑「答题记录最多的那门课」而不是写死某个 id —— 本部署的 stage id 不是仓库数据。
      const stageRows = await client.query<{ stage_id: string }>(
        `SELECT stage_id FROM runtime_sessions
          WHERE kind = 'quizAttempt'
          GROUP BY stage_id ORDER BY count(*) DESC LIMIT 1`,
      );
      const stageId = stageRows.rows[0]?.stage_id;
      expect(stageId, 'no quizAttempt sessions in this database').toBeTruthy();
      if (!stageId) return;

      const sessionRows = await client.query<{
        id: string;
        stage_id: string;
        status: QuizFoldSession['status'];
        created_at: Date | string;
      }>(
        `SELECT id, stage_id, status, created_at FROM runtime_sessions
          WHERE stage_id = $1 AND kind = 'quizAttempt' ORDER BY created_at`,
        [stageId],
      );
      const sessions: QuizFoldSession[] = sessionRows.rows.map((row) => ({
        id: row.id,
        stageId: row.stage_id,
        status: row.status,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      }));

      const recordRows = await client.query<{ data: RuntimeRecord }>(
        `SELECT data FROM runtime_records WHERE session_id = ANY($1::text[]) ORDER BY session_id, seq`,
        [sessions.map((session) => session.id)],
      );
      const records = recordRows.rows.map((row) => row.data);

      const fold = foldQuizAttempts({ sessions, records });

      console.log(
        `\n${stageId}: ${sessions.length} session(s), ${records.length} record(s)` +
          ` → ${fold.scenes.length} page(s), ${fold.skipped.length} skipped\n` +
          fold.scenes
            .map(
              (scene) =>
                `  ${scene.sceneId} phase=${scene.phase} attempts=${scene.attempts}` +
                ` records=${scene.records} score=${scene.earned}` +
                ` now=[${scene.incorrectNow.join(',')}] ever=[${scene.everIncorrect.join(',')}]`,
            )
            .join('\n'),
      );

      // ── 不变式 ────────────────────────────────────────────────────
      const folded = fold.scenes.reduce((total, scene) => total + scene.records, 0);
      expect(folded + fold.skipped.length).toBe(records.length);

      for (const scene of fold.scenes) {
        expect(scene.incorrectNow.every((id) => scene.everIncorrect.includes(id))).toBe(true);
        expect(scene.attempts).toBeLessThanOrEqual(scene.sessions);
        expect(scene.correctCount + scene.incorrectCount).toBe(scene.questions.length);
        expect(scene.records).toBeGreaterThan(0);
      }

      // 真库里有 quiz 记录，就必然折叠出至少一页 —— 折叠出 0 页说明锚定或
      // payload 判据和写入端漂了，那是要立刻知道的。
      if (records.length > 0) expect(fold.scenes.length).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  }, 30_000);
});
