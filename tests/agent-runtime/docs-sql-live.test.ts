import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

/**
 * ★ 手册里给的**验证 SQL 必须真的能跑**。
 *
 * ── 为什么值得一条判据 ──────────────────────────────────────────
 * 2026-10-07 实测：§3.3 里那条"自检页真实题量"写着 `ORDER BY 1,2`，而它
 * **只 SELECT 了一列** ⇒ 直接
 *
 *     ERROR: ORDER BY position 2 is not in select list
 *
 * 而 §3.3 正是"**真话在数据库里**"那一节 —— 下一个窗口（或用户）被明确告知
 * "用这几条 SQL 下结论"。这条查询**一跑就报错**，等于那条验证路径是坏的；
 * 更糟的是这类错**不会有人替你发现**（文档不会自检，测试也不跑文档）。
 *
 * 判据的做法是**读 `AGENTS.md` 本身**再执行 —— 不是抄一份 SQL 进测试。
 * 那样文档里的 SQL 被改坏（列改名、语法错、聚合写错）就会**红**。
 *
 * 与仓库既有 live 测试同一个口径：默认跳过，要真库时一行环境变量。
 *     TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/agent-runtime/docs-sql-live.pg.test.ts
 */
const live = process.env.TEST_LOAD_LOCAL_ENV === '1' && Boolean(process.env.DATABASE_URL);

/** `LIKE` 片段那种"只是语法示例"的块要跳过 —— 它本身不是一条可执行的查询。 */
const RUNNABLE = /^(?:--[^\n]*\n|\s)*\s*(?:SELECT|WITH)\b/i;

const AGENTS = readFileSync(join(process.cwd(), 'AGENTS.md'), 'utf8');

function runnableSqlBlocks(): string[] {
  // ★ `\r?\n`：本仓库的 markdown 是 **CRLF**，只写 `\n` 会**一条都抽不到** ——
  //   而"一条都抽不到"会让这条判据**空过**。
  //   （第一次跑就是被下面那句 `expect(blocks.length)` 抓住的 —— 防空过的断言救了自己。）
  return [...AGENTS.matchAll(/```sql\r?\n([\s\S]*?)```/g)]
    .map((match) => match[1]!.trim())
    .filter((block) => RUNNABLE.test(block));
}

describe.skipIf(!live)('工作台手册里的验证 SQL', () => {
  it('每个可执行的 ```sql 块都能在真库上跑通', async () => {
    const blocks = runnableSqlBlocks();
    // 防"正则失效导致一条都没查"——那样这条判据会**空过**。
    expect(blocks.length, '从 AGENTS.md 里一条可执行 SQL 都没抽到').toBeGreaterThanOrEqual(2);

    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      for (const block of blocks) {
        const label = block.split('\n').slice(0, 2).join(' ').slice(0, 70);
        try {
          await client.query(block);
        } catch (cause) {
          throw new Error(
            `手册里的这条 SQL 跑不通：\n---\n${block}\n---\n` +
              `报错：${cause instanceof Error ? cause.message : String(cause)}\n` +
              `（前两行：${label}）`,
          );
        }
      }
    } finally {
      await client.end();
    }
  });
});
