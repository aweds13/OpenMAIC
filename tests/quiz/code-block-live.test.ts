/**
 * 「存量 text 元素里哪些该转 `code` 元素」—— 对着**真课程**跑一遍，把两张单子打出来。
 *
 *   OPENMAIC_CODE_BLOCK_LIVE_TSV="D:/.../day02-fresh3.tsv" \
 *   TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/code-block-live.test.ts
 *
 * ── 为什么要有这个文件（2026-10-09）────────────────────────────
 *
 * 「Day02 有 26 个候选」这个数字，上一轮是**临时脚本**量出来的，跑完就没了 ——
 * 于是新窗口要复核只得从头再写一遍，还得重新决定"宽尺到底怎么写的"。
 * 这里把它固化成两步、两份判据：
 *
 * 1. **候选尺（宽）**：整体等宽 + 文本里有 `;` / `{}` / `=>`。
 *    它**故意宽** —— 只负责把 855 个 text 元素缩到几十个，"够人过一遍"即可。
 *    ★ 它**不要求关键词表**、**不因中文标点排除**（那两条实测各误杀过真代码）。
 * 2. **分流尺（严）**：`codeBlockVerdict()` —— 多行 + 结构**过半** ⇒ 转 `code` 元素；否则留在 text。
 *
 * ★ **两份判据都要在**：第 1 步宽了会把教学路线图算进来（`→` 串起来的章节名），
 *   第 2 步的"过半"就是为此存在的。少了任何一步，结论都不成立。
 *
 * 断言只钉**结构契约**（候选非空、两批互斥且并集相等、每批都能报出页码）。
 * 真正要看的是它打出来的两张单子 —— 那是给人过目的，不是给判据过的。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Check, Errors } from 'typebox/value';

import {
  codeBlockVerdict,
  codeElementFromText,
  type CodeBlockSource,
  type CodeBlockVerdict,
} from '@/lib/quiz/code-block';
import { SlideElementInputSchema } from '@/lib/server/agent-runtime/course-edit/element-schema';

const TSV = process.env.OPENMAIC_CODE_BLOCK_LIVE_TSV;

/** harness 产物一律落这里（§6.8：`个人数据\` 只放学习成长的东西）。 */
const DIAGNOSTICS = 'D:/文档/jelly_ware/_tools/openmaic/diagnostics';

interface SceneShape {
  id?: string;
  content?: { canvas?: { elements?: unknown[] } };
}

/** 从 dump 里取一页的 scene（写库那条路径要拿"库里那一份"来比对）。 */
function findScene(tsv: string, order: number): SceneShape {
  for (const line of readFileSync(tsv, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const fields = line.split('\t');
    if (fields.length < 4) continue;
    if (Number(fields[0]) !== order) continue;
    return JSON.parse(fields[3]) as SceneShape;
  }
  throw new Error(`TSV 里没有第 ${order} 页`);
}

interface Candidate {
  order: number;
  elementIndex: number;
  html: string;
  plain: string;
  verdict: CodeBlockVerdict;
}

/** ★ 候选尺（宽）：整体等宽 + 有结构。见文件头"两份判据"那条。 */
function isCandidate(element: { type?: unknown; content?: unknown }): boolean {
  if (element.type !== 'text') return false;
  const html = typeof element.content === 'string' ? element.content : '';
  if (html.length === 0 || !html.includes('<p')) return false;
  const paragraphs = html.split(/<p\b/i).slice(1);
  if (paragraphs.length === 0) return false;
  if (!paragraphs.every((part) => /monospace|Courier/i.test(part))) return false;
  const text = html.replace(/<[^>]+>/g, ' ');
  return /[;{}]|=>/.test(text);
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim();
}

function collect(tsv: string): Candidate[] {
  const found: Candidate[] = [];
  for (const line of readFileSync(tsv, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const fields = line.split('\t');
    if (fields.length < 4) continue;
    const scene = JSON.parse(fields[3]) as { content?: { canvas?: { elements?: unknown[] } } };
    const elements = scene.content?.canvas?.elements ?? [];
    elements.forEach((element, elementIndex) => {
      const candidate = element as { type?: unknown; content?: unknown };
      if (!isCandidate(candidate)) return;
      const html = candidate.content as string;
      found.push({
        order: Number(fields[0]),
        elementIndex,
        html,
        plain: plainText(html),
        verdict: codeBlockVerdict(candidate),
      });
    });
  }
  return found.sort(
    (left, right) => left.order - right.order || left.elementIndex - right.elementIndex,
  );
}

describe.skipIf(process.env.TEST_LOAD_LOCAL_ENV !== '1' || !TSV)(
  '存量代码块候选 → 两张单子（真课程）',
  () => {
    it('splits every candidate into "convert to a code element" and "leave in the body"', () => {
      const tsv = TSV as string;
      const candidates = collect(tsv);
      const convert = candidates.filter((item) => item.verdict === 'code-element');
      const leave = candidates.filter((item) => item.verdict === 'keep-inline');

      const show = (item: Candidate) =>
        `  p${String(item.order).padStart(2)} el${String(item.elementIndex).padStart(2)}  ` +
        `${item.plain.replace(/\s+/g, ' ').slice(0, 96)}`;

      console.log(`\n候选共 ${candidates.length} 个（宽尺）—— 两张单子：`);
      console.log(`\n【第一批 · 建议转 code 元素】${convert.length} 个`);
      for (const item of convert) console.log(show(item));
      console.log(`\n【第二批 · 建议留在 text 里】${leave.length} 个`);
      for (const item of leave) console.log(show(item));
      console.log('');

      // 结构契约：两批互斥、并集相等（防"分流时漏掉几条"这种静默）。
      expect(candidates.length).toBeGreaterThan(0);
      expect(convert.length + leave.length).toBe(candidates.length);
      expect(convert.every((item) => item.verdict === 'code-element')).toBe(true);
      expect(leave.every((item) => item.verdict === 'keep-inline')).toBe(true);
      // 两批都必须非空，否则"分两批"这个说法当场不成立。
      expect(convert.length).toBeGreaterThan(0);
      expect(leave.length).toBeGreaterThan(0);
    }, 60_000);
  },
);

/**
 * ★ **真的把一页转掉**（写库）—— 两道开关同时给才跑：
 *
 * ```bash
 * OPENMAIC_CODE_BLOCK_LIVE_TSV=<dump.tsv> \
 * OPENMAIC_CODE_BLOCK_APPLY=1 OPENMAIC_CODE_BLOCK_APPLY_TARGET=21:9 \
 * TEST_LOAD_LOCAL_ENV=1 npx vitest run tests/quiz/code-block-live.test.ts
 * ```
 *
 * 为什么写成用例而不是一段临时 SQL：**转换前的四道闸只有在这里才都在**。
 * 1. `codeBlockVerdict()` 必须先说 `code-element` —— 判据说该留在正文里的，这里**拒绝写**；
 * 2. 产物必须过仓库自己的元素合同（`SlideElementInputSchema`）；
 * 3. 写之前把**整行**备份到 `_tools/openmaic/diagnostics/`（含恢复用的 SQL）；
 * 4. `UPDATE ... WHERE` 里带着"目标位置上还是那个 text 元素、内容一字不差"的条件 ——
 *    期间有人改过这一页就**一行都不写**（乐观并发），而不是盖掉别人的改动。
 *
 * 写完立刻**读回来**比对：只看 UPDATE 的行数不算数（写进去的可能是别的东西）。
 */
describe.skipIf(
  process.env.TEST_LOAD_LOCAL_ENV !== '1' || process.env.OPENMAIC_CODE_BLOCK_APPLY !== '1' || !TSV,
)('★ 存量转换：真的写一页（text → code 元素）', () => {
  it('converts one element under four gates and verifies the stored result', async () => {
    const target = process.env.OPENMAIC_CODE_BLOCK_APPLY_TARGET ?? '';
    const [orderText, indexText] = target.split(':');
    const order = Number(orderText);
    const elementIndex = Number(indexText);
    if (!Number.isInteger(order) || !Number.isInteger(elementIndex)) {
      throw new Error(`OPENMAIC_CODE_BLOCK_APPLY_TARGET 要写成 "页码:元素下标"，收到 ${target}`);
    }
    const language = process.env.OPENMAIC_CODE_BLOCK_APPLY_LANGUAGE ?? 'java';
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL missing');

    const scene = findScene(TSV as string, order);
    const elements = scene.content?.canvas?.elements ?? [];
    const source = elements[elementIndex] as CodeBlockSource & { id?: string };
    if (!source) throw new Error(`第 ${order} 页没有下标 ${elementIndex} 的元素`);

    // 闸 ①：判据说该转，才允许动手。
    expect(
      codeBlockVerdict(source),
      `第 ${order} 页 el${elementIndex} 判据不认为该转，拒绝写入`,
    ).toBe('code-element');

    const draft = codeElementFromText(source, {
      id: source.id ?? `code_p${order}e${elementIndex}`,
      language,
    });
    // 闸 ②：合同。
    const { id: _id, ...contract } = draft;
    expect(
      Check(SlideElementInputSchema, contract),
      JSON.stringify(Errors(SlideElementInputSchema, contract)),
    ).toBe(true);

    const { Client } = await import('pg');
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const before = await client.query<{
        id: string;
        order: number;
        data: unknown;
        revision: string | null;
      }>(
        `SELECT s.id, s.scene_order AS order, s.data,
                (SELECT rev::text FROM document_scene_revision r WHERE r.stage_id = s.stage_id AND r.scene_id = s.id) AS revision
           FROM document_scenes s WHERE s.stage_id = $1 AND s.scene_order = $2`,
        [process.env.OPENMAIC_CODE_BLOCK_APPLY_STAGE, order],
      );
      const row = before.rows[0];
      if (!row) throw new Error(`库里没有第 ${order} 页`);

      // 闸 ③：先备份整行（含恢复 SQL），再写。
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${DIAGNOSTICS}/code-block-apply-p${order}-el${elementIndex}-${stamp}.json`;
      writeFileSync(
        backupPath,
        JSON.stringify(
          {
            note: '转换前整行备份。恢复见同目录的 .sql 文件（或把 data 原样 UPDATE 回去）。',
            stageId: process.env.OPENMAIC_CODE_BLOCK_APPLY_STAGE,
            sceneId: row.id,
            sceneOrder: row.order,
            elementIndex,
            sceneRevision: row.revision,
            data: row.data,
          },
          null,
          1,
        ),
        'utf8',
      );
      const sqlPath = backupPath.replace(/\.json$/, '.sql');
      writeFileSync(
        sqlPath,
        `-- 恢复第 ${order} 页 el${elementIndex}（把转换前的 data 原样写回）\n` +
          `-- 用法：psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -f "<本文件>"\n` +
          `UPDATE document_scenes SET data = $json$${JSON.stringify(row.data)}$json$::jsonb\n` +
          ` WHERE stage_id = '${process.env.OPENMAIC_CODE_BLOCK_APPLY_STAGE}' AND scene_order = ${order};\n`,
        'utf8',
      );

      // 闸 ④：乐观并发 —— 目标位置上必须还是那个 text 元素、内容一字不差。
      const updated = await client.query(
        `UPDATE document_scenes
            SET data = jsonb_set(data, ARRAY['content','canvas','elements', $3::text], $4::jsonb, false)
          WHERE stage_id = $1 AND scene_order = $2::float8
            AND data->'content'->'canvas'->'elements'->$3::int->>'type' = 'text'
            AND data->'content'->'canvas'->'elements'->$3::int->>'content' = $5
          RETURNING id`,
        [
          process.env.OPENMAIC_CODE_BLOCK_APPLY_STAGE,
          order,
          elementIndex,
          JSON.stringify(draft),
          source.content,
        ],
      );
      expect(
        updated.rowCount,
        '一行都没改 —— 目标位置已经不是那个 text 元素了（有人动过这一页）',
      ).toBe(1);

      // 写完读回来比对（不看 UPDATE 的行数就下结论是不算的）。
      const after = await client.query<{ element: unknown; revision: string | null }>(
        `SELECT s.data->'content'->'canvas'->'elements'->$3::int AS element,
                (SELECT rev::text FROM document_scene_revision r WHERE r.stage_id = s.stage_id AND r.scene_id = s.id) AS revision
           FROM document_scenes s WHERE s.stage_id = $1 AND s.scene_order = $2::float8`,
        [process.env.OPENMAIC_CODE_BLOCK_APPLY_STAGE, order, elementIndex],
      );
      expect(after.rows[0]?.element).toEqual(draft);
      // 版本号必须真的跳了 —— 它是给客户端失效缓存用的（触发器负责）。
      expect(after.rows[0]?.revision).not.toBe(row.revision);

      console.log(
        `\n已转换：第 ${order} 页 el${elementIndex} → code 元素（${draft.lines.length} 行，language=${draft.language}）` +
          `\n  备份：${backupPath}\n  恢复：${sqlPath}\n  版本：${row.revision} → ${after.rows[0]?.revision}\n`,
      );
    } finally {
      await client.end();
    }
  }, 120_000);
});
