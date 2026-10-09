/**
 * 真跑一次「收尾审查」（live）—— **只在 `TEST_LOAD_LOCAL_ENV=1` 时跑**。
 *
 * ── 为什么这个文件必须常驻（2026-10-09 的教训）──────────────────
 *
 * 前两次真跑，我都是**临时写一个用例、跑完删掉**。结果是：报告留在磁盘上（`_tools/openmaic/`，
 * 按 §6.8 不放进仓库），但**跑它的方法没了** —— 下一个窗口要复跑得从头再写一遍，
 * 还得重新摸清"分界点本地能算、8 段可以并行"这类只有跑过才知道的事。
 *
 * ── 怎么用 ─────────────────────────────────────────────────────
 *
 * ```bash
 * # 1) 把真库的页面 dump 成 TSV：order \t type \t title \t scene-json（一行一页）
 * #    （SQL 见 AGENTS.md §3.3；中文一律走 psql 的 -At -F$'\t'）
 * # 2) 跑：
 * OPENMAIC_REVIEW_LIVE_TSV="D:/.../day02-fresh.tsv" \
 * OPENMAIC_REVIEW_LIVE_STAGE="stage-GYvpbYB_aN" \
 * TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/agent-runtime/review-course-live.test.ts
 * ```
 *
 * 产物落在 `OPENMAIC_REVIEW_LIVE_OUT`（默认 `_tools/openmaic/diagnostics/review-live.md`）。
 * **报告不进仓库**（harness 产物，§6.8）；要留的是**读数与结论**（写进 `复盘/`）。
 *
 * ── 两条性能事实（跑过一次才知道）──────────────────────────────
 *
 * 1. **分界点本地就能算** —— 按字符预算累加页面文本即可，不需要问模型；
 * 2. **各段互不依赖** ⇒ **并行发**。串行跑 8 段要 ~16 分钟，并行只要最慢那一段的时间。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import { createGenerationAiCallFactory } from '@/lib/server/agent-runtime/generation-ai-call';
import { buildCourseReviewTool } from '@/lib/server/agent-runtime/review-tools';
import { learnerVisibleText, type VisibleTextPage } from '@/lib/quiz/page-text';

const TSV = process.env.OPENMAIC_REVIEW_LIVE_TSV;
const STAGE = process.env.OPENMAIC_REVIEW_LIVE_STAGE;
/**
 * ★ **一份持续追加的报告**（`appendFileSync`），不是一次一份文件名 ——
 * 一次一份的话，历史要靠人记得"上一跑是哪个文件"，而我上一跑正是这么干的（`run.md` / `run2.md`），
 * 结果自己都差点说不清。追加式：每次一个带时间的段，旧读数永远在下面。
 */
const OUT =
  process.env.OPENMAIC_REVIEW_LIVE_OUT ??
  'D:/文档/jelly_ware/_tools/openmaic/diagnostics/review-day02.md';
const BUDGET = Number(process.env.OPENMAIC_REVIEW_LIVE_BUDGET ?? 120_000);
const MAX_ROUNDS = 12;

describe.skipIf(process.env.TEST_LOAD_LOCAL_ENV !== '1')('live: review_course on the real course', () => {
  it('whole course, chunk boundaries local, chunks in parallel', async () => {
    if (!TSV || !STAGE) throw new Error('需要 OPENMAIC_REVIEW_LIVE_TSV 与 OPENMAIC_REVIEW_LIVE_STAGE');
    const pages: VisibleTextPage[] = [];
    for (const line of readFileSync(TSV, 'utf8').split('\n')) {
      const fields = line.split('\t');
      if (fields.length < 4) continue;
      const data = JSON.parse(fields[3]) as { type?: string; title?: string; content?: unknown };
      pages.push({ order: Number(fields[0]), type: data.type, title: data.title, content: data.content });
    }
    if (pages.length === 0) throw new Error(`TSV 里没有页面：${TSV}`);
    pages.sort((left, right) => left.order - right.order);

    // ① 分界点：跟工具同一条预算规则，本地累加即可（不花模型）。
    const starts: number[] = [pages[0]!.order];
    let used = 0;
    for (const page of pages) {
      const text = await learnerVisibleText(page);
      if (used > 0 && used + text.text.length > BUDGET) {
        starts.push(page.order);
        used = 0;
      }
      used += text.text.length;
    }
    if (starts.length > MAX_ROUNDS) {
      throw new Error(`分界点算出 ${starts.length} 段（上限 ${MAX_ROUNDS}）—— 调大预算或调小范围`);
    }

    // ② 各段并行（互不依赖）。一段失败不影响别的段。
    const tool = buildCourseReviewTool({
      loadScenes: async () => pages,
      aiCall: createGenerationAiCallFactory()('course-review'),
      maxChars: BUDGET,
    });
    const startedAt = Date.now();
    const results = await Promise.all(
      starts.map(async (from, index) => {
        try {
          const result = (await tool.execute(`call-${index + 1}`, { stageId: STAGE, fromOrder: from })) as {
            content: { text: string }[];
            details: { pageCount: number; charsUsed: number; remainingPages: number; candidatePages: number };
          };
          return { from, text: result.content[0]?.text ?? '', details: result.details, error: '' };
        } catch (error) {
          return { from, text: '', details: null, error: String(error).slice(0, 300) };
        }
      }),
    );

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const lines = [
      existsSync(OUT) ? '' : '# 收尾审查实跑 · 持续追加',
      '',
      `## ${stamp} ｜ ${pages.length} 页 · ${starts.length} 段 · 并行 · ${Math.round((Date.now() - startedAt) / 1000)}s`,
      '',
      `stage=${STAGE}  tsv=${TSV}  预算=${BUDGET}`,
      '',
    ];
    for (const item of [...results].sort((left, right) => left.from - right.from)) {
      lines.push(
        `## fromOrder=${item.from}`,
        item.details
          ? `pageCount=${item.details.pageCount} chars=${item.details.charsUsed} candidatePages=${item.details.candidatePages} remaining=${item.details.remainingPages}`
          : `（这一段失败：${item.error}）`,
        '',
        item.text,
        '',
      );
    }
    appendFileSync(OUT, lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    console.log(`报告：${OUT}（${lines.length} 段）`);
  }, 1_800_000);
});
