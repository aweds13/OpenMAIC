#!/usr/bin/env node
/**
 * 把「题级挂载」灌进 `xq_question_concept`：一行 = 「这一道题 × 这一个概念」。
 *
 * ## 为什么要有这张表、为什么页级挂载不够
 *
 * `xq_concept_occurrence` 记的是「这一页提到了哪些概念」，由
 * `deriveOccurrencesFromOutlines()` 从大纲条目（keyPoint / 标题 / 正文）算出来。
 * 一页八道题共用一份页级概念集，等于判定每道题都「考了那八个概念」。
 * 实测 `stage--ShZtYAYOj/scene-p35` 挂了 10 个概念（9 条 `0.40 body`，含
 * 「远程仓库与 PR」「集合框架」这种正文顺带提的），拿它当题级概念，
 * 每道题的证据会被放大 8 倍。
 *
 * 所以题级挂载必须**按题面收窄**。推导规则在 `lib/concepts/question.ts`，
 * 那个模块是纯函数；本脚本只负责「读库 → 调它 → 写库」。
 *
 * ## 六步，顺序不能换
 *
 *   1. 读 `document_scenes` 里 `data->>'type' = 'quiz'` 的页，取
 *      `data->'content'->'questions'`。★ 题面在 `content.questions` 里，
 *      不在 `data.questions` —— 后者恒 0 行是路径写错，不是没题。
 *   2. 逐页调 `deriveQuestionConcepts()`。只取 `question` 字段，不取
 *      `options[].label` 与 `analysis`（选项是干扰项，它提到一个概念恰恰
 *      说明不该把它算成这题在考的东西）。
 *   3. 概念 key 换 `xq_concept.id`：查一次全表建 `canonical_name → id` 映射。
 *      ★ `xq_question_concept.concept` 存的是**概念名字符串**不是 id
 *      （`learner-state.ts:196` 直接 `SELECT concept` 当标签用）；id 只用于
 *      确认这个名字在库里确实存在、且 `status='active'`。
 *   4. 库里有、种子图里没有（或反过来）的，逐条报出来。**不猜**：种子图与
 *      `xq_concept` 应当是同一批 104 个，一旦分叉就得先修那个，不是在这里补。
 *   5. 写入用 `ON CONFLICT (stage_id, scene_id, question_id, concept, concept_kind)
 *      DO UPDATE`，刷 `link` / `confidence`。重跑幂等。
 *   6. `concept_kind` 一律 `'keypoint'`：表上只有 `keypoint` 与 `chapter-band`
 *      两个取值，后者是「拿章节名兜底、confidence 0.50」的语义；本脚本算的是
 *      「按题面命中」，落在前者。（`chapter-band` 兜底对 4 个零命中的页也没用：
 *      其中三门数学课的 `document_outlines` 是空数组，连章节名都没有。）
 *
 * ## 判据（怎么算做完）
 *
 * 真库读数（2026-11-09）：17 个 quiz 页 / 98 题 → **71 行 / 覆盖 13 页**。
 * 4 页题干零命中，是事实不是缺陷（HTTP 状态码不在种子图；三门数学课没有大纲）。
 * 任何「17 页都得有概念」的判据都不可能达到。
 *
 * ## 用法
 *
 *     npx tsx --conditions=import --env-file-if-exists=.env.local \
 *     scripts/backfill-question-concepts.ts [--dry-run] [--verbose]
 *
 * `--dry-run` 只读库、只打印，不写一行。默认**不** dry-run（与
 * `import-materials-directory.ts` 相反 —— 那个脚本面对的是磁盘目录，这个脚本
 * 写的是可整表重算的派生表，且 `ON CONFLICT` 幂等）。想先看就加 `--dry-run`。
 *
 * ## 为什么静态 import 只有 node 内建
 *
 * `@openmaic/storage` 只在 `import` 条件下发布子路径，所以脚本要跑
 * `tsx --conditions=import`；在那条件下 `pg` 的 CommonJS 入口会把自身的
 * `pg-pool` 依赖解析成 `pg-pool/esm/index.mjs`，随后 `pg/lib/index.js` 对
 * 模块命名空间对象做 `class BoundPool extends Pool`：
 *
 *     TypeError: Class extends value #<Object> is not a constructor or null
 *
 * 把 `pg-pool` 重定向回它的 CommonJS 入口就够了。钩子必须在 `pg` 第一次加载
 * 之前注册，所以下面没有一处是对 app 模块的静态 import —— 静态 import 会在
 * 本模块函数体执行前求值。同理 `lib/concepts` 也是动态 import：它间接依赖
 * `@openmaic/*` 的 import 条件。
 */

import * as nodeModule from 'node:module';

interface ResolveResult {
  url: string;
}
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => ResolveResult,
) => ResolveResult;
const registerModuleHooks = (
  nodeModule as unknown as {
    registerHooks: (hooks: { resolve: ResolveHook }) => void;
  }
).registerHooks;

registerModuleHooks({
  resolve(specifier, context, nextResolve) {
    const base = nextResolve(specifier, context);
    // `pg` requires `pg-pool`, whose ESM entry exports no constructor.
    if (specifier === 'pg-pool') {
      return { ...base, url: base.url.replace(/[\\/]esm[\\/]index\.mjs$/, '/index.js') };
    }
    return base;
  },
});

interface Options {
  dryRun: boolean;
  verbose: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { dryRun: false, verbose: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verbose') options.verbose = true;
    else throw new Error(`未知参数：${arg}（只认 --dry-run / --verbose）`);
  }
  return options;
}

/** 一页的原始输入，形状与 `QuizPageInput` 对得上。 */
interface QuizPageRow {
  stage_id: string;
  id: string;
  questions: unknown;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  // 必须是动态 import，见文件头最后一节。
  const { Pool } = await import('pg');
  const { buildSeedGraph, buildAliasIndex } = await import('../lib/concepts/index');
  const { deriveQuestionConcepts } = await import('../lib/concepts/question');

  const pool = new Pool({ connectionString });
  try {
    const graph = buildSeedGraph();
    const index = buildAliasIndex(graph);

    const pages = await pool.query<QuizPageRow>(
      `SELECT stage_id, id, data->'content'->'questions' AS questions
         FROM document_scenes
        WHERE data->>'type' = 'quiz'
        ORDER BY stage_id, scene_order, id`,
    );

    // `canonical_name → id`，只收 active 的。名字是落库列，id 用来核对存在性。
    const named = await pool.query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM xq_concept WHERE status = 'active'`,
    );
    const idByName = new Map(named.rows.map((row) => [row.canonical_name, row.id]));

    const graphNames = new Set(graph.concepts.map((concept) => concept.name));
    const dbNames = new Set(idByName.keys());
    const missingInDb = [...graphNames].filter((name) => !dbNames.has(name));
    const missingInGraph = [...dbNames].filter((name) => !graphNames.has(name));
    if (missingInDb.length > 0 || missingInGraph.length > 0) {
      console.error(
        `种子图与 xq_concept 分叉 —— 先修那个，别在这里补：\n` +
          `  种子有、库里没有 ${missingInDb.length} 个：${missingInDb.slice(0, 10).join(' / ')}\n` +
          `  库里有、种子没有 ${missingInGraph.length} 个：${missingInGraph.slice(0, 10).join(' / ')}`,
      );
      return 2;
    }

    const drafts: {
      stageId: string;
      sceneId: string;
      questionId: string;
      concept: string;
      conceptKind: 'keypoint';
      link: 'exact' | 'normalized';
      confidence: number;
    }[] = [];
    const touchedPages = new Set<string>();
    const strongPages = new Set<string>();
    const zeroPages: string[] = [];

    for (const page of pages.rows) {
      const questions = (page.questions ?? []) as { id?: string; question?: string }[];
      const hits = deriveQuestionConcepts(
        { stageId: page.stage_id, sceneId: page.id, questions },
        graph,
        { index },
      );
      if (hits.length === 0) {
        zeroPages.push(`${page.stage_id}/${page.id}`);
        continue;
      }
      touchedPages.add(`${page.stage_id}/${page.id}`);
      if (hits.some((hit) => hit.tier === 'strong')) strongPages.add(`${page.stage_id}/${page.id}`);
      for (const hit of hits) {
        const conceptId = idByName.get(hit.conceptName);
        if (!conceptId) throw new Error(`概念「${hit.conceptName}」在 xq_concept 里查不到`);
        drafts.push({
          stageId: page.stage_id,
          sceneId: page.id,
          questionId: hit.questionId,
          concept: hit.conceptName,
          conceptKind: 'keypoint',
          link: hit.link,
          confidence: hit.confidence,
        });
        if (options.verbose) {
          console.log(
            `  ${page.stage_id}/${page.id}/${hit.questionId}  ${hit.conceptName}` +
              `  ${hit.tier} ${hit.confidence.toFixed(2)} ${hit.link}  ←「${hit.matchedForm}」`,
          );
        }
      }
    }

    console.log(
      `页面 ${pages.rowCount} / 题目 ${pages.rows.reduce((sum, page) => sum + ((page.questions as unknown[] | null)?.length ?? 0), 0)}` +
        ` / 挂载 ${drafts.length} 行 / 覆盖 ${touchedPages.size} 页（强档 ${strongPages.size} 页）`,
    );
    if (zeroPages.length > 0) {
      console.log(`零命中的 ${zeroPages.length} 页（事实，不是缺陷）：`);
      for (const page of zeroPages) console.log(`  - ${page}`);
    }

    if (options.dryRun) {
      console.log('--dry-run：一行都没写。');
      return 0;
    }

    // 一次事务写完全部：半截的表比没写更糟（状态块的标签会一半新一半旧）。
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM xq_question_concept');
      const CHUNK = 500;
      const COLUMNS = 7;
      for (let offset = 0; offset < drafts.length; offset += CHUNK) {
        const chunk = drafts.slice(offset, offset + CHUNK);
        const values: unknown[] = [];
        const tuples = chunk.map((row, index) => {
          const base = index * COLUMNS;
          values.push(
            row.stageId,
            row.sceneId,
            row.questionId,
            row.concept,
            row.conceptKind,
            row.link,
            // confidence 走参数，不把浮点拼进 SQL 文本。
            row.confidence,
          );
          const slots = Array.from({ length: COLUMNS }, (_unused, n) => `$${base + n + 1}`);
          return `(${slots.join(', ')})`;
        });
        await client.query(
          `INSERT INTO xq_question_concept
             (stage_id, scene_id, question_id, concept, concept_kind, link, confidence)
           VALUES ${tuples.join(', ')}
           ON CONFLICT (stage_id, scene_id, question_id, concept, concept_kind)
           DO UPDATE SET link = EXCLUDED.link, confidence = EXCLUDED.confidence`,
          values,
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const after = await pool.query<{ rows: string; pages: string }>(
      `SELECT count(*) AS rows, count(DISTINCT (stage_id, scene_id)) AS pages FROM xq_question_concept`,
    );
    console.log(
      `写入完成：xq_question_concept ${after.rows[0].rows} 行 / ${after.rows[0].pages} 页。`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
