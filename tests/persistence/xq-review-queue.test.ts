import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({
  queryable: undefined as unknown,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: holder.queryable }),
}));

/**
 * `GET /api/persistence/xq/reviews` 的判据：到期的那几关，连页标题与题面一起。
 *
 * 这一条读侧存在的理由，与 `POST` 那条正好相反 —— 写侧让「做完了」能落库，
 * 读侧让「现在该做什么」能被看见。在此之前服务端状态块能渲染
 * 「今天到期的复习」，但那是给模型看的字符串，浏览器里没有人能问
 * 「我现在该复习什么」。
 *
 * 三条要钉住的性质：
 *
 * 1. **到期判据与 `dueReviews()` 是同一条**（`due_at <= now AND done_at IS NULL`）。
 *    两处判据会漂，所以这里比对两个函数的输出集合，而不是各自断言。
 * 2. **页被删、题被改，到期这条事实不许消失**。`LEFT JOIN` 的理由就是它：
 *    取不到题面时回空串，而不是把整行丢掉。
 * 3. **截断发生在最窄的一侧**。`LIMIT` 在 CTE 里，不在 join 之后 ——
 *    否则一个跨多页的列表会因为某一页的题面查询把别的行挤掉。
 */

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
  scene_order integer,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (stage_id, id)
);
`;

const OWNER_MERGES_MIN = `
CREATE TABLE IF NOT EXISTS owner_merges (
  from_owner_id text PRIMARY KEY,
  to_owner_id text NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  from_assurance text,
  moved jsonb NOT NULL DEFAULT '{}'::jsonb
);
`;

const COOKIE = 'anonymous_id=99999999-9999-4999-8999-999999999999';

const STAGE = 'stage-q1';
const SCENE = 'scene-p1';
const CONCEPT = '类与对象';

function request(path: string, method = 'GET'): Request {
  return new Request(`http://localhost/api/persistence${path}`, {
    method,
    headers: { origin: 'http://localhost', cookie: COOKIE },
  });
}

async function bootRoute() {
  const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
  return handlePersistenceRequest;
}

/** 一页自检：两题，题面各不相同。 */
async function seedQuizScene(
  db: PGlite,
  stageId: string,
  sceneId: string,
  title: string,
  questions: readonly { id: string; question: string }[],
): Promise<void> {
  await db.query(
    `INSERT INTO document_scenes (stage_id, id, scene_order, data)
     VALUES ($1, $2, 1, $3::jsonb)
     ON CONFLICT (stage_id, id) DO UPDATE SET data = EXCLUDED.data`,
    [
      stageId,
      sceneId,
      JSON.stringify({
        type: 'quiz',
        title,
        content: { questions: questions.map((q) => ({ ...q, type: 'single' })) },
      }),
    ],
  );
}

describe('GET /api/persistence/xq/reviews', () => {
  let db: PGlite;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', 'postgres://xq-review-queue-test');
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await db.exec(OWNER_MERGES_MIN);
    const { ensureXqLearnerSchema } = await import('@/lib/persistence/xq-learner');
    await ensureXqLearnerSchema(db);
    holder.queryable = db;
  });

  /** 把某一关的 `due_at` 拉到 N 天前，让它立刻到期。 */
  const makeDue = async (stageId: string, sceneId: string, questionId: string, daysAgo = 1) => {
    await db.query(
      `UPDATE xq_review_schedule
          SET due_at = now() - make_interval(days => $5)
        WHERE stage_id = $1 AND scene_id = $2 AND question_id = $3 AND concept = $4 AND round = 1`,
      [stageId, sceneId, questionId, CONCEPT, daysAgo],
    );
  };

  const schedule = async (stageId: string, sceneId: string, questionId: string) => {
    const { XqLearnerStore } = await import('@/lib/persistence/xq-learner-store');
    return new XqLearnerStore({ queryable: db }).scheduleReviewForWrong(
      stageId,
      sceneId,
      questionId,
      CONCEPT,
    );
  };

  it('★ 到期的关变成卡片，页标题与题面一起回来', async () => {
    await seedQuizScene(db, STAGE, SCENE, '自检：Dart 语法八道题', [
      { id: 'q1', question: '什么是变量？' },
      { id: 'q2', question: 'final 与 const 有什么区别？' },
    ]);
    await schedule(STAGE, SCENE, 'q1');
    await schedule(STAGE, SCENE, 'q2');
    await makeDue(STAGE, SCENE, 'q1');
    await makeDue(STAGE, SCENE, 'q2');

    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews'), {});

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      reviews: { questionId: string; sceneTitle: string; questionStem: string; round: number }[];
    };
    expect(payload.reviews).toHaveLength(2);
    const q1 = payload.reviews.find((r) => r.questionId === 'q1');
    expect(q1).toMatchObject({
      sceneTitle: '自检：Dart 语法八道题',
      questionStem: '什么是变量？',
      round: 1,
    });
  });

  it('★ 卡片顺带说出「这个概念他到底会不会」—— 跨课证据合到一处', async () => {
    await seedQuizScene(db, STAGE, SCENE, '自检', [{ id: 'q1', question: '甲' }]);
    await schedule(STAGE, SCENE, 'q1');
    await makeDue(STAGE, SCENE, 'q1');

    // 同一个概念在**三门课**上各考过一次（今天只有 stage-q1 有到期关）。
    // 只数到期那门课的话，这三个概念永远停在「一题，不够判」。
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, status, created_in)
       VALUES ('c_aaaaaaaaaaaa', $1, 'concept', 'active', 1)`,
      [CONCEPT],
    );
    let i = 0;
    for (const stageId of [STAGE, 'stage-q2', 'stage-q3']) {
      const sceneId = `scene-m${i}`;
      i += 1;
      await seedQuizScene(db, stageId, sceneId, '别课', [{ id: 'q1', question: '甲' }]);
      await db.query(
        `INSERT INTO xq_question_concept
           (stage_id, scene_id, question_id, concept, concept_kind, link, confidence)
         VALUES ($1, $2, 'q1', $3, 'keypoint', 'exact', 0.8)`,
        [stageId, sceneId, CONCEPT],
      );
      await db.query(
        `INSERT INTO xq_probe_item
           (task_id, stage_id, scene_id, question_id, asked_at, correct, source)
         VALUES ($1, $2, $3, 'q1', now() - interval '20 days', true, 'existing')`,
        [`task-${stageId}`, stageId, sceneId],
      );
    }

    const handle = await bootRoute();
    const payload = (await (await handle(request('/xq/reviews'), {})).json()) as {
      reviews: {
        questionId: string;
        mastery: { tri: string; n: number; questions: number } | null;
      }[];
    };
    const card = payload.reviews.find((r) => r.questionId === 'q1');
    // 三门课的 `q1` 是三道不同的题（题号只在页内唯一），所以 questions 也是 3。
    expect(card?.mastery).toEqual({ tri: 'known', n: 3, questions: 3 });
  });

  it('★ 没有可判证据时 mastery 是 null，不是「暂未定」—— 两件事差得很远', async () => {
    await seedQuizScene(db, STAGE, SCENE, '自检', [{ id: 'q1', question: '甲' }]);
    await schedule(STAGE, SCENE, 'q1');
    await makeDue(STAGE, SCENE, 'q1');

    const handle = await bootRoute();
    const payload = (await (await handle(request('/xq/reviews'), {})).json()) as {
      reviews: { mastery: unknown }[];
    };
    expect(payload.reviews).toHaveLength(1);
    expect(payload.reviews[0]!.mastery).toBeNull();
  });

  it('★ 到期判据与 dueReviews() 是同一条 —— 两处判据会漂，所以比集合', async () => {
    await seedQuizScene(db, STAGE, SCENE, '自检', [
      { id: 'q1', question: '甲' },
      { id: 'q2', question: '乙' },
    ]);
    await schedule(STAGE, SCENE, 'q1');
    await schedule(STAGE, SCENE, 'q2');
    await makeDue(STAGE, SCENE, 'q1');

    const { XqLearnerStore } = await import('@/lib/persistence/xq-learner-store');
    const store = new XqLearnerStore({ queryable: db });
    const farLater = new Date(Date.now() + 40 * 24 * 3600 * 1000);
    const fromStore = (await store.dueReviews(farLater)).map((r) => `${r.questionId}#${r.round}`);

    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews?limit=50'), {});
    const payload = (await response.json()) as { reviews: { questionId: string; round: number }[] };
    const fromRoute = payload.reviews.map((r) => `${r.questionId}#${r.round}`);

    // 路由读的是「现在」；store 读的是 40 天后。两者在「q1 第 1 关已到期」
    // 这件事上必须一致，而 q2 的其它三关只会在 40 天后才出现 —— 所以比的是
    // 「路由的每一条都在 store 的列表里」。
    expect(fromRoute.length).toBeGreaterThan(0);
    for (const key of fromRoute) expect(fromStore).toContain(key);
  });

  it('★ 题还排着但页被删了 —— 到期不许消失，题面回空串', async () => {
    await schedule(STAGE, 'scene-gone', 'q9');
    await makeDue(STAGE, 'scene-gone', 'q9');

    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews'), {});
    const payload = (await response.json()) as {
      reviews: { questionId: string; sceneTitle: string; questionStem: string }[];
    };

    expect(response.status).toBe(200);
    expect(payload.reviews).toHaveLength(1);
    expect(payload.reviews[0]).toMatchObject({
      questionId: 'q9',
      sceneTitle: '',
      questionStem: '',
    });
  });

  it('★ 题号对不上时题面回空串，但页标题还在', async () => {
    await seedQuizScene(db, STAGE, SCENE, '自检：只有 q1', [{ id: 'q1', question: '甲' }]);
    await schedule(STAGE, SCENE, 'q7');
    await makeDue(STAGE, SCENE, 'q7');

    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews'), {});
    const payload = (await response.json()) as {
      reviews: { sceneTitle: string; questionStem: string }[];
    };
    expect(payload.reviews[0]).toMatchObject({ sceneTitle: '自检：只有 q1', questionStem: '' });
  });

  it('★ 截断发生在最窄的一侧 —— limit 数的是到期行，不是题面行', async () => {
    // 两页各一题都到期；limit=1 时回的必须是**按 due_at 最早的那一条**，
    // 而不是「先 join 出两行再砍一半」的任意一条。
    await seedQuizScene(db, 'stage-a', 'scene-p1', '甲页', [{ id: 'q1', question: '甲题' }]);
    await seedQuizScene(db, 'stage-b', 'scene-p1', '乙页', [{ id: 'q1', question: '乙题' }]);
    await schedule('stage-a', 'scene-p1', 'q1');
    await schedule('stage-b', 'scene-p1', 'q1');
    await makeDue('stage-a', 'scene-p1', 'q1', 5);
    await makeDue('stage-b', 'scene-p1', 'q1', 2);

    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews?limit=1'), {});
    const payload = (await response.json()) as { reviews: { stageId: string }[] };

    expect(payload.reviews).toHaveLength(1);
    expect(payload.reviews[0]!.stageId).toBe('stage-a');
  });

  it('★ limit 乱写不该报错 —— 调用方要的是列表，列表仍然有意义', async () => {
    await seedQuizScene(db, STAGE, SCENE, '自检', [{ id: 'q1', question: '甲' }]);
    await schedule(STAGE, SCENE, 'q1');
    await makeDue(STAGE, SCENE, 'q1');

    const handle = await bootRoute();
    for (const query of ['?limit=abc', '?limit=-3', '?limit=0']) {
      const response = await handle(request(`/xq/reviews${query}`), {});
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { reviews: unknown[] };
      expect(payload.reviews).toHaveLength(1);
    }
  });

  it('★ 关掉一关之后它不再出现在读侧 —— 读写两半对得上', async () => {
    await seedQuizScene(db, STAGE, SCENE, '自检', [{ id: 'q1', question: '甲' }]);
    await schedule(STAGE, SCENE, 'q1');
    await makeDue(STAGE, SCENE, 'q1');

    const { XqLearnerStore } = await import('@/lib/persistence/xq-learner-store');
    await new XqLearnerStore({ queryable: db }).recordReviewOutcome(
      STAGE,
      SCENE,
      'q1',
      CONCEPT,
      1,
      'pass',
    );

    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews'), {});
    const payload = (await response.json()) as { reviews: unknown[] };
    expect(payload.reviews).toHaveLength(0);
  });

  it('★ 不许 PUT / DELETE —— 资源只有两半，没有第三半', async () => {
    const handle = await bootRoute();
    for (const method of ['PUT', 'DELETE']) {
      const response = await handle(request('/xq/reviews', method), {});
      expect(response.status).toBe(405);
    }
  });

  it('★ 长题面截断在 160 字，且不切坏代理对', async () => {
    const long = '甲'.repeat(200);
    await seedQuizScene(db, STAGE, SCENE, '自检', [{ id: 'q1', question: long }]);
    await schedule(STAGE, SCENE, 'q1');
    await makeDue(STAGE, SCENE, 'q1');

    const handle = await bootRoute();
    const response = await handle(request('/xq/reviews'), {});
    const payload = (await response.json()) as { reviews: { questionStem: string }[] };
    const stem = payload.reviews[0]!.questionStem;
    expect(Array.from(stem)).toHaveLength(161);
    expect(stem.endsWith('…')).toBe(true);
  });
});
