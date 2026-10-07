/**
 * 学习状态刷新器 —— 对着**真库**跑一遍：查记录 → 折叠 → 渲染 → 写文件。
 *
 * 默认不跑（`tests/setup-env.ts` 刻意不加载 `.env.local`）：
 *
 *   TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/learner-state-live.test.ts
 *
 * ── 它做的两件事，分开 ─────────────────────────────────────────────
 *
 * 1. **写进临时路径**，断言写出来的东西成立（内容不变式 + 确实是原子写）。
 *    绝不往学习者的数据目录里写 —— 测试不该有那种副作用。
 * 2. **打印真正会被注入的那段文本**（用配置里的真实路径算出来，但不写）。
 *    因为"单元测试绿"不说明"注入给模型的话是对的"，那段话必须被人看一眼。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { Client } from 'pg';

import {
  learnerStatePath,
  learnerStatePromptBlock,
  refreshLearnerStateFromRuntime,
} from '@/lib/server/agent-runtime/learner-state';

const live = process.env.TEST_LOAD_LOCAL_ENV === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!live)('refreshLearnerStateFromRuntime against the live runtime store', () => {
  it('folds real records into a state file and shows what would be injected', async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL missing');

    const client = new Client({ connectionString });
    await client.connect();
    const dir = await mkdtemp(join(tmpdir(), 'maic-learner-state-'));
    try {
      // 挑「有答题记录的 owner」而不是写死一个 id。
      const ownerRows = await client.query<{ owner_id: string }>(
        `SELECT m.owner_id
           FROM stage_meta AS m
           JOIN runtime_sessions AS s ON s.stage_id = m.stage_id
          WHERE s.kind = 'quizAttempt' AND m.deleted_at IS NULL
          GROUP BY m.owner_id
          ORDER BY count(*) DESC
          LIMIT 1`,
      );
      const ownerId = ownerRows.rows[0]?.owner_id;
      expect(ownerId, 'no owner with quizAttempt sessions').toBeTruthy();
      if (!ownerId) return;

      const tempPath = join(dir, '学习状态.md');
      const result = await refreshLearnerStateFromRuntime({
        ownerId,
        path: tempPath,
      });

      expect(result, 'refresher returned nothing for an owner that has quiz records').toBeTruthy();
      if (!result) return;

      // 写下去的字节必须等于返回的文本（原子写的可见结果）。
      expect(await readFile(tempPath, 'utf8')).toBe(`${result.text}\n`);
      expect(result.records).toBeGreaterThan(0);
      expect(result.scenes).toBeGreaterThan(0);
      expect(result.text).toContain('机器写入');

      // 注入的框定语必须把"缺省 ≠ 没学过"这条说清楚 —— 这是整块最容易被误读的地方。
      const block = learnerStatePromptBlock(result.text);
      expect(block).toContain('not** that the learner never studied it');
      expect(block).toContain(result.text);

      console.log(
        `\nowner ${ownerId}\n` +
          `  records=${result.records} scenes=${result.scenes} ` +
          `learnerKeys=${result.learnerKeys.length}\n` +
          `  实际注入路径: ${learnerStatePath() ?? '(未配置)'}\n` +
          `  本次写入(临时): ${tempPath}\n\n` +
          '===== 会被注入的那段文本 =====\n' +
          `${result.text}\n` +
          '=============================',
      );
    } finally {
      await client.end();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * 强制刷新**真实**的状态文件。
   *
   * 平时不需要跑 —— runner 每次运行开头自己会刷（`refreshLearnerStateBestEffort`）。
   * 这条存在的理由是：独立脚本被 `@openmaic/dsl` 的 exports 问题挡着（见
   * `AGENTS.md` §6.5），所以"手动强制刷一次"的可复现入口只能是用例。
   *
   *   TEST_LOAD_LOCAL_ENV=1 OPENMAIC_LEARNER_STATE_WRITE=1 \
   *     npx vitest run tests/quiz/learner-state-live.test.ts
   */
  it.skipIf(process.env.OPENMAIC_LEARNER_STATE_WRITE !== '1')(
    'force-refreshes the deployed state file',
    async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL missing');
      const client = new Client({ connectionString });
      await client.connect();
      try {
        const ownerRows = await client.query<{ owner_id: string }>(
          `SELECT m.owner_id
             FROM stage_meta AS m
             JOIN runtime_sessions AS s ON s.stage_id = m.stage_id
            WHERE s.kind = 'quizAttempt' AND m.deleted_at IS NULL
            GROUP BY m.owner_id ORDER BY count(*) DESC LIMIT 1`,
        );
        const ownerId = ownerRows.rows[0]?.owner_id;
        if (!ownerId) throw new Error('no owner with quizAttempt sessions');
        const result = await refreshLearnerStateFromRuntime({ ownerId });
        expect(result?.path).toBe(learnerStatePath());
        console.log(`\n已刷新: ${result?.path}\n${result?.text ?? ''}`);
      } finally {
        await client.end();
      }
    },
    30_000,
  );
});
