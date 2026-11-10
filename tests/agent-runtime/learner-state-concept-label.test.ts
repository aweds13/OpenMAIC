import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { refreshLearnerStateFromRuntime } from '@/lib/server/agent-runtime/learner-state';
import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';

/**
 * 状态块里那一行「概念『…』」到底该写什么。
 *
 * ★ 这个判据是被真库读数逼出来的，不是设计出来的。`xq_question_concept` 一落库，
 *   `stage--ShZtYAYOj/scene-p18` 最高档上同时挂了三个概念（字符串 / 继承 /
 *   重写与 @Override），挑码点最小的那个当名字，这一格就被叫成「字符串」——
 *   因为 q8 的题干里贴了一段 `class Person { String name; … }` 代码。
 *   挑「被最多道题命中的」也不行：`stage-7tNoR37iqT/scene-p7` 的十道题讲的是
 *   git 整套工作流，会变成「提交」。
 *
 *   所以规则是：**最高档只有一个概念时，它才是这一格的名字**；否则退回页标题。
 *   一格挂八个概念时，其中任何一个都不能代表这一格。
 */

/** `document_scenes` 的最小版本 —— 上游表，只建本组判据要用的列。 */
const DOCUMENT_SCENES_MIN = `CREATE TABLE IF NOT EXISTS document_stages (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at double precision NOT NULL,
    updated_at double precision NOT NULL,
    data jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id    text NOT NULL,
  id          text NOT NULL,
  scene_order double precision,
  data        jsonb,
  PRIMARY KEY (stage_id, id)
);`;

let db: PGlite;
let root: string;

beforeEach(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(DOCUMENT_SCENES_MIN);
  // ★ 必须走 ensureXqLearnerSchema（v1 baseline + v2 迁移），不能只 exec(XQ_LEARNER_SCHEMA)：
  //   v1 的 xq_cell_state 没有 n_delayed / k_delayed，后者在 v2 里。
  await ensureXqLearnerSchema(db);
  root = mkdtempSync(join(tmpdir(), 'learner-label-'));
});

afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

/** 摆一页 + 一格（known），concept 行由调用方补。 */
async function seedPage(options: {
  stageId: string;
  sceneId: string;
  title: string;
  lb5: string;
  concepts: { concept: string; confidence: number; questionId: string }[];
}): Promise<void> {
  await db.query(
    `INSERT INTO document_scenes (stage_id, id, scene_order, data)
     VALUES ($1, $2, 1, $3::jsonb)`,
    [options.stageId, options.sceneId, JSON.stringify({ type: 'quiz', title: options.title })],
  );
  await db.query(
    `INSERT INTO xq_cell_state
       (stage_id, scene_id, tri, n, k, lb5, ub95, reason, n_delayed, k_delayed, updated_at)
     VALUES ($1, $2, 'known', 8, 8, $3::numeric, NULL, NULL, 8, 8, now())`,
    [options.stageId, options.sceneId, options.lb5],
  );
  for (const row of options.concepts) {
    await db.query(
      `INSERT INTO xq_question_concept
         (stage_id, scene_id, question_id, concept, concept_kind, link, confidence)
       VALUES ($1, $2, $3, $4, 'keypoint', 'exact', $5::numeric)`,
      [options.stageId, options.sceneId, row.questionId, row.concept, String(row.confidence)],
    );
  }
}

/** 跑一次刷新，返回写出来的文本。 */
async function refresh(): Promise<string> {
  const result = await refreshLearnerStateFromRuntime({
    path: join(root, '学习状态.md'),
    practiceRoot: join(root, '练习'),
    queryable: db as unknown as NonNullable<
      Parameters<typeof refreshLearnerStateFromRuntime>[0]['queryable']
    >,
    now: new Date(Date.UTC(2026, 10, 20)),
  });
  expect(result).not.toBeNull();
  return readFileSync(join(root, '学习状态.md'), 'utf8');
}

describe('状态块的概念标签', () => {
  it('★ 最高档只有一个概念时，它才是这一格的名字', async () => {
    await seedPage({
      stageId: 'stage-a',
      sceneId: 'scene-p9',
      title: 'OOP 自检：八道判断',
      lb5: '0.603',
      concepts: [
        { concept: '类与对象', confidence: 0.8, questionId: 'q1' },
        // 弱档的存在不影响力：最高档仍只有「类与对象」一个。
        { concept: 'this 关键字', confidence: 0.5, questionId: 'q2' },
      ],
    });
    const text = await refresh();
    expect(text).toContain('概念「类与对象」');
    expect(text).not.toContain('标题「OOP 自检：八道判断」');
  });

  it('★ 最高档挂了两个概念时退回页标题 —— 挑哪个都是错的', async () => {
    await seedPage({
      stageId: 'stage--ShZtYAYOj',
      sceneId: 'scene-p18',
      title: '自检：Dart 语法八道题',
      lb5: '0.603',
      concepts: [
        // 真库里这三个都是 0.80：q8 那段代码同时命中了「字符串」「继承」「重写」。
        { concept: '字符串', confidence: 0.8, questionId: 'q8' },
        { concept: '继承', confidence: 0.8, questionId: 'q8' },
        { concept: '重写与 @Override', confidence: 0.8, questionId: 'q8' },
        { concept: 'Dart 变量 var / final / const', confidence: 0.5, questionId: 'q1' },
      ],
    });
    const text = await refresh();
    expect(text).toContain('标题「自检：Dart 语法八道题」');
    // 三个 0.80 里的任何一个都不许被当成这一格的名字。
    expect(text).not.toContain('概念「字符串」');
    expect(text).not.toContain('概念「继承」');
    expect(text).not.toContain('概念「重写与 @Override」');
  });

  it('只有一个弱档概念时，它仍然是名字 —— 判据只看最高档有几个，不看档位', async () => {
    await seedPage({
      stageId: 'stage-qgvTKiESij',
      sceneId: 'scene-p3',
      title: '变量自检',
      lb5: '0.603',
      concepts: [{ concept: 'Dart 变量 var / final / const', confidence: 0.5, questionId: 'q1' }],
    });
    // 最高档只有一个 —— 所以按上一条规则它会被当成名字。这里钉住的是
    // 「这一条确实会被用上」，与上一条一起说明判据只看「最高档有几个」，
    // 不额外看档位本身。
    const text = await refresh();
    expect(text).toContain('概念「Dart 变量 var / final / const」');
  });

  it('一个概念都没有时也退回页标题（`xq_question_concept` 还是空表的那天）', async () => {
    await seedPage({
      stageId: 'stage-b',
      sceneId: 'scene-p1',
      title: '整页都没挂上概念',
      lb5: '0.603',
      concepts: [],
    });
    const text = await refresh();
    expect(text).toContain('标题「整页都没挂上概念」');
    expect(text).not.toContain('概念「');
  });

  it('跨课同名的 scene id 互不干扰 —— 标签按 (stage, scene) 取，不按 scene 取', async () => {
    // 真库里 35 个 scene id 跨课复用，34 个连类型都不同。
    await seedPage({
      stageId: 'stage-one',
      sceneId: 'scene-p9',
      title: 'A 课的第九页',
      lb5: '0.700',
      concepts: [{ concept: '类与对象', confidence: 0.8, questionId: 'q1' }],
    });
    await seedPage({
      stageId: 'stage-two',
      sceneId: 'scene-p9',
      title: 'B 课的第九页',
      lb5: '0.650',
      concepts: [{ concept: '继承', confidence: 0.8, questionId: 'q1' }],
    });
    const text = await refresh();
    const one = text.split('\n').find((line) => line.includes('stage-one'));
    const two = text.split('\n').find((line) => line.includes('stage-two'));
    expect(one).toContain('概念「类与对象」');
    expect(two).toContain('概念「继承」');
  });
});
