import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import {
  CONCEPT_MASTERY_LIMIT,
  readConceptMastery,
  resolveConceptIds,
} from '@/lib/persistence/xq-concept-mastery';

const DOCUMENT_SCENES_MIN = `CREATE TABLE IF NOT EXISTS document_stages (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at double precision NOT NULL,
    updated_at double precision NOT NULL,
    data jsonb NOT NULL
  );
  
CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id text NOT NULL,
  id text NOT NULL,
  scene_order integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (stage_id, id)
);`;

const A = 'c_aaaaaaaaaaaa';
const B = 'c_bbbbbbbbbbbb';

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.waitReady;
  // `xq_concept_occurrence` 有复合外键指向 `document_scenes`，迁移前必须建它。
  await db.exec(DOCUMENT_SCENES_MIN);
  await ensureXqLearnerSchema(db);
});

async function concept(id: string, name: string, status = 'active'): Promise<void> {
  await db.query(
    `INSERT INTO xq_concept (id, canonical_name, kind, status, created_in)
     VALUES ($1, $2, 'concept', $3, 1)`,
    [id, name, status],
  );
}

async function alias(name: string, conceptId: string, ambiguous = false): Promise<void> {
  await db.query(
    `INSERT INTO xq_concept_alias (alias, kind, concept_id, source, confidence, ambiguous)
     VALUES ($1, 'concept', $2, 'test', 1.0, $3)`,
    [name, conceptId, ambiguous],
  );
}

async function quizScene(
  stageId: string,
  sceneId: string,
  questions: readonly { id: string; type: string }[],
): Promise<void> {
  const data = {
    type: 'quiz',
    title: sceneId,
    content: { questions: questions.map((q) => ({ ...q, question: '题', points: 1 })) },
  };
  await db.query(
    `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, 0, $3::jsonb)`,
    [stageId, sceneId, JSON.stringify(data)],
  );
}

async function mapping(
  stageId: string,
  sceneId: string,
  questionId: string,
  name: string,
  confidence: number,
): Promise<void> {
  await db.query(
    `INSERT INTO xq_question_concept
       (stage_id, scene_id, question_id, concept, concept_kind, link, confidence)
     VALUES ($1, $2, $3, $4, 'keypoint', 'exact', $5)`,
    [stageId, sceneId, questionId, name, confidence],
  );
}

async function probe(args: {
  stageId: string;
  sceneId: string;
  questionId: string;
  correct: boolean;
  askedAt: string;
  countedN?: number;
  taskId?: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO xq_probe_item
       (task_id, stage_id, scene_id, question_id, asked_at, correct, counted_n, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'existing')`,
    [
      args.taskId ?? `task-${args.questionId}-${args.askedAt}`,
      args.stageId,
      args.sceneId,
      args.questionId,
      args.askedAt,
      args.correct,
      args.countedN ?? 1,
    ],
  );
}

// 一个月前：全部落在延迟桶里（`DELAYED_BUCKET_DAYS = 3`）。
const LONG_AGO = '2026-09-01T02:00:00.000Z';

describe('resolveConceptIds', () => {
  it('canonical_name 精确优先', async () => {
    await concept(A, '空安全');
    const ids = await resolveConceptIds(db, ['空安全']);
    expect(ids.get('空安全')).toBe(A);
  });

  it('★ 名字映射不上时才用别名', async () => {
    await concept(A, '空安全');
    await alias('null safety', A);
    const ids = await resolveConceptIds(db, ['null safety']);
    expect(ids.get('null safety')).toBe(A);
  });

  it('★ 歧义别名不用 —— 那正是 ambiguous 的含义', async () => {
    await concept(A, '空安全');
    await alias('safe', A, true);
    const ids = await resolveConceptIds(db, ['safe']);
    expect(ids.has('safe')).toBe(false);
  });

  it('★ 合并过的概念不用：它的身份已经不在自己身上了', async () => {
    await concept(A, '旧名字');
    await concept(B, '新名字');
    // `xq_concept_check` 要求 status='merged' 时 merged_into 非空，所以两步。
    await db.query("UPDATE xq_concept SET status = 'merged', merged_into = $2 WHERE id = $1", [
      A,
      B,
    ]);
    const ids = await resolveConceptIds(db, ['旧名字']);
    expect(ids.has('旧名字')).toBe(false);
  });

  it('查不到的名字不出现在 Map 里，空输入回空 Map', async () => {
    const ids = await resolveConceptIds(db, ['没有这个概念']);
    expect(ids.size).toBe(0);
    expect((await resolveConceptIds(db, [])).size).toBe(0);
  });
});

describe('readConceptMastery', () => {
  it('★ 一道题的最高档唯一概念才把证据算给它', async () => {
    await concept(A, '空安全');
    await quizScene('stage-1', 'scene-p1', [{ id: 'q1', type: 'single' }]);
    await mapping('stage-1', 'scene-p1', 'q1', '空安全', 0.8);
    await mapping('stage-1', 'scene-p1', 'q1', '别的概念', 0.5); // 弱档，不该算
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: true,
      askedAt: LONG_AGO,
    });

    const rows = await readConceptMastery(db, { stageIds: ['stage-1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.concept).toBe('空安全');
    expect(rows[0]!.conceptId).toBe(A);
    expect(rows[0]!.questions).toBe(1);
  });

  it('★ 最高档并列时这条证据不算给任何一个 —— 挑一个就把 A 与 A∪B 混了', async () => {
    await concept(A, '空安全');
    await concept(B, '字符串');
    await quizScene('stage-1', 'scene-p1', [{ id: 'q1', type: 'single' }]);
    await mapping('stage-1', 'scene-p1', 'q1', '空安全', 0.8);
    await mapping('stage-1', 'scene-p1', 'q1', '字符串', 0.8);
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: true,
      askedAt: LONG_AGO,
    });

    const rows = await readConceptMastery(db, { stageIds: ['stage-1'] });
    expect(rows).toHaveLength(0);
  });

  it('★ 三门课五次观测合到一处，才第一次跨过「至少三题」的门槛', async () => {
    await concept(A, '空安全');
    const scenes = [
      { stageId: 'stage-1', sceneId: 'scene-p1' },
      { stageId: 'stage-2', sceneId: 'scene-p2' },
      { stageId: 'stage-3', sceneId: 'scene-p3' },
    ];
    for (const scene of scenes) {
      await quizScene(scene.stageId, scene.sceneId, [{ id: 'q1', type: 'single' }]);
      await mapping(scene.stageId, scene.sceneId, 'q1', '空安全', 0.8);
      await probe({ ...scene, questionId: 'q1', correct: true, askedAt: LONG_AGO });
    }

    const rows = await readConceptMastery(db, { stageIds: ['stage-1', 'stage-2', 'stage-3'] });
    expect(rows).toHaveLength(1);
    // 3 题全对且全在延迟桶里 ⇒ 判「会」。页级读数在每页只有 1 题时只能是 too-few-items。
    expect(rows[0]!.verdict.tri).toBe('known');
    expect(rows[0]!.verdict.n).toBe(3);
  });

  it('★ 同一道题答两次是两条证据，counted_n 各自算', async () => {
    await concept(A, '空安全');
    await quizScene('stage-1', 'scene-p1', [{ id: 'q1', type: 'single' }]);
    await mapping('stage-1', 'scene-p1', 'q1', '空安全', 0.8);
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: true,
      askedAt: LONG_AGO,
      countedN: 1,
    });
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: false,
      askedAt: '2026-09-01T03:00:00.000Z',
      countedN: 0.5,
    });

    const rows = await readConceptMastery(db, { stageIds: ['stage-1'] });
    expect(rows[0]!.verdict.n).toBe(1.5);
    expect(rows[0]!.verdict.k).toBe(1);
    // 去重后的题目个数是 1 —— 与 `n` 不是一回事。
    expect(rows[0]!.questions).toBe(1);
  });

  it('★ 多选题的盲猜率按 0.0638 算，不是 0.25', async () => {
    await concept(A, '空安全');
    await quizScene('stage-1', 'scene-p1', [{ id: 'q1', type: 'multiple' }]);
    await mapping('stage-1', 'scene-p1', 'q1', '空安全', 0.8);
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: true,
      askedAt: LONG_AGO,
    });

    const rows = await readConceptMastery(db, { stageIds: ['stage-1'] });
    // 单题不够判（too-few-items），但 lb5/ub95 是 null 而不是按 0.25 算出的数。
    expect(rows[0]!.verdict.tri).toBe('unknown');
    expect(rows[0]!.verdict.reason).toBe('too-few-items');
  });

  it('★ 别的课的证据不许混进来（question_id 只在页内唯一）', async () => {
    await concept(A, '空安全');
    await quizScene('stage-1', 'scene-p1', [{ id: 'q1', type: 'single' }]);
    await quizScene('stage-2', 'scene-p1', [{ id: 'q1', type: 'single' }]);
    await mapping('stage-1', 'scene-p1', 'q1', '空安全', 0.8);
    await mapping('stage-2', 'scene-p1', 'q1', '空安全', 0.8);
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: true,
      askedAt: LONG_AGO,
    });

    const rows = await readConceptMastery(db, { stageIds: ['stage-2'] });
    expect(rows).toHaveLength(0);
  });

  it('★ 映射不上 id 的概念照样出现，conceptId 是 null —— 不静默丢', async () => {
    await quizScene('stage-1', 'scene-p1', [{ id: 'q1', type: 'single' }]);
    await mapping('stage-1', 'scene-p1', 'q1', '图谱里没有的名字', 0.8);
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: true,
      askedAt: LONG_AGO,
    });

    const rows = await readConceptMastery(db, { stageIds: ['stage-1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.concept).toBe('图谱里没有的名字');
    expect(rows[0]!.conceptId).toBeNull();
  });

  it('没有证据的概念不出现（这里是「读数」，不是「概念表」）', async () => {
    await concept(A, '空安全');
    const rows = await readConceptMastery(db, { stageIds: ['stage-1'] });
    expect(rows).toHaveLength(0);
  });

  it('★ 不给 stageIds 就是所有课 —— 复习卡不许只数「今天恰好到期的那几门」', async () => {
    await concept(A, '空安全');
    // 三门课各考一次同一个概念；今天只有 stage-1 那一门有到期关。
    for (const stageId of ['stage-1', 'stage-2', 'stage-3']) {
      await quizScene(stageId, 'scene-p1', [{ id: 'q1', type: 'single' }]);
      await mapping(stageId, 'scene-p1', 'q1', '空安全', 0.8);
      await probe({
        stageId,
        sceneId: 'scene-p1',
        questionId: 'q1',
        correct: true,
        askedAt: LONG_AGO,
      });
    }

    const all = await readConceptMastery(db, { concepts: ['空安全'] });
    expect(all).toHaveLength(1);
    expect(all[0]!.verdict.n).toBe(3);
    expect(all[0]!.verdict.tri).toBe('known');

    // 只给 stage-1 时只看得到一题 —— 那才是「把证据悄悄排除掉」的样子。
    const narrowed = await readConceptMastery(db, { stageIds: ['stage-1'], concepts: ['空安全'] });
    expect(narrowed[0]!.verdict.n).toBe(1);
    expect(narrowed[0]!.verdict.tri).toBe('unknown');
  });

  it('★ 题目身份是 (课, 页, 题) 三元组 —— 三门课的 q1 是三道题，不是一道', async () => {
    await concept(A, '空安全');
    for (const stageId of ['stage-1', 'stage-2', 'stage-3']) {
      await quizScene(stageId, 'scene-p1', [{ id: 'q1', type: 'single' }]);
      await mapping(stageId, 'scene-p1', 'q1', '空安全', 0.8);
      await probe({
        stageId,
        sceneId: 'scene-p1',
        questionId: 'q1',
        correct: true,
        askedAt: LONG_AGO,
      });
    }

    const rows = await readConceptMastery(db, { concepts: ['空安全'] });
    // 每门课的 `q1` 都是一道**不同的**题：题号只在页内唯一。
    expect(rows[0]!.questions).toBe(3);
  });

  it('空 stageIds 与空 concepts 都直接回空，不查库', async () => {
    expect(await readConceptMastery(db, { stageIds: [] })).toHaveLength(0);
    expect(await readConceptMastery(db, { stageIds: ['stage-1'], concepts: [] })).toHaveLength(0);
  });

  it('只算点名的概念；limit 封顶且默认值固定', async () => {
    await concept(A, '空安全');
    await concept(B, '字符串');
    await quizScene('stage-1', 'scene-p1', [
      { id: 'q1', type: 'single' },
      { id: 'q2', type: 'single' },
    ]);
    await mapping('stage-1', 'scene-p1', 'q1', '空安全', 0.8);
    await mapping('stage-1', 'scene-p1', 'q2', '字符串', 0.8);
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: true,
      askedAt: LONG_AGO,
    });
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q2',
      correct: false,
      askedAt: LONG_AGO,
    });

    const only = await readConceptMastery(db, { stageIds: ['stage-1'], concepts: ['字符串'] });
    expect(only.map((row) => row.concept)).toEqual(['字符串']);

    const limited = await readConceptMastery(db, { stageIds: ['stage-1'], limit: 1 });
    expect(limited).toHaveLength(1);
    expect(CONCEPT_MASTERY_LIMIT).toBe(50);
  });

  it('★ 只读：算三次不改任何一张表', async () => {
    await concept(A, '空安全');
    await quizScene('stage-1', 'scene-p1', [{ id: 'q1', type: 'single' }]);
    await mapping('stage-1', 'scene-p1', 'q1', '空安全', 0.8);
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: true,
      askedAt: LONG_AGO,
    });

    const before = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_probe_item');
    await readConceptMastery(db, { stageIds: ['stage-1'] });
    await readConceptMastery(db, { stageIds: ['stage-1'] });
    await readConceptMastery(db, { stageIds: ['stage-1'] });
    const after = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM xq_probe_item');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('★ 结果按名字排序 —— 位置稳定，不随证据多少跳动', async () => {
    await concept(A, '空安全');
    await concept(B, '字符串');
    await quizScene('stage-1', 'scene-p1', [
      { id: 'q1', type: 'single' },
      { id: 'q2', type: 'single' },
    ]);
    await mapping('stage-1', 'scene-p1', 'q1', '空安全', 0.8);
    await mapping('stage-1', 'scene-p1', 'q2', '字符串', 0.8);
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q1',
      correct: true,
      askedAt: LONG_AGO,
    });
    await probe({
      stageId: 'stage-1',
      sceneId: 'scene-p1',
      questionId: 'q2',
      correct: true,
      askedAt: LONG_AGO,
    });

    const rows = await readConceptMastery(db, { stageIds: ['stage-1'] });
    const names = rows.map((row) => row.concept);
    expect(names).toEqual([...names].sort());
  });
});
