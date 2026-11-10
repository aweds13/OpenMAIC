import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import { recordXqEvent } from '@/lib/persistence/xq-event-recorder';
import { XqLearnerStore } from '@/lib/persistence/xq-learner-store';
import {
  recordXqReview,
  XqReviewRoundMissingError,
  type XqReviewInput,
} from '@/lib/persistence/xq-review-recorder';

/**
 * 复习**结果**写入口的判据。
 *
 * 这个入口此前不存在，于是整条复习闭环只有入口没有出口：`xq_review_schedule`
 * 里排进去的关到期后会永远显示成「今天到期的复习」，谁也消不掉。它最危险的
 * 失败方式同样是「悄悄做错事」，而且比事件的错误更隐蔽：
 *
 * - 先改排期、后写事件，但事件失败了 ⇒ 排期关掉了、「他做错了」这个事实没了，
 *   而 P5 的四关重置降级规则正是靠 `review_failed` 的计数才算得出；
 * - `skip` 也写一条 `review_passed` ⇒ 状态层以为他答对了；
 * - `skip` 写 `review_failed` ⇒ 失败计数虚高，同一道题会被误判成「反复错」；
 * - 重试时重新取 `now()` ⇒ 同一关一条失败变两条，计数翻倍；
 * - 这一关根本不存在时照样写事件 ⇒ 库里留下指向空关卡的失败事实。
 *
 * 五条都在这里钉住。
 */
describe('xq review recorder', () => {
  let db: PGlite;
  let sessionId: string;

  /** `xq_concept_occurrence` 有复合外键指向文档库的 `document_scenes`，给最小形状。 */
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

  const STAGE = 'stage-A';
  const SCENE = 'scene-p1';
  const QUESTION = 'q1';
  const CONCEPT = '类与对象';

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await ensureXqLearnerSchema(db);

    // 事件表对 `xq_session` 有外键，所以每次都得真的开一个会话。
    const started = await recordXqEvent(db, {
      kind: 'session_started',
      stageId: STAGE,
      occurredAt: '2026-11-08T02:00:00.000Z',
    });
    sessionId = started.sessionId;
  });

  const store = () => new XqLearnerStore({ queryable: db });

  const seedRounds = async () => {
    await store().scheduleReviewForWrong(STAGE, SCENE, QUESTION, CONCEPT);
  };

  const reviewInput = (overrides: Partial<XqReviewInput> = {}): XqReviewInput => ({
    stageId: STAGE,
    sceneId: SCENE,
    questionId: QUESTION,
    concept: CONCEPT,
    round: 1,
    outcome: 'pass',
    occurredAt: '2026-11-09T02:00:00.000Z',
    sessionId,
    ...overrides,
  });

  const events = async () => {
    const r = await db.query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM xq_event
        WHERE kind IN ('review_passed','review_failed') GROUP BY kind ORDER BY kind`,
    );
    return Object.fromEntries(r.rows.map((row) => [row.kind, Number(row.n)]));
  };

  const rounds = async () => {
    const r = await db.query<{ round: number; done_at: Date | null; outcome: string | null }>(
      `SELECT round, done_at, outcome FROM xq_review_schedule
        WHERE stage_id = $1 AND scene_id = $2 AND question_id = $3 AND concept = $4
        ORDER BY round`,
      [STAGE, SCENE, QUESTION, CONCEPT],
    );
    return r.rows.map((row) => ({
      round: Number(row.round),
      done: row.done_at != null,
      outcome: row.outcome,
    }));
  };

  it('★ 同一时刻关不同关 —— 四关各记一条，不许互相吃掉', async () => {
    // 真机撞到过：四关的按钮可以一次点完（或客户端把回调一起发出去），
    // 于是四条请求的 `occurredAt` 完全相同。而幂等键按默认派生**不含 round**，
    // 第 2/3/4 关被当成「第 1 关的重复投递」丢掉 —— 事件只有一条，
    // 排期却四行全关。库里说他复习了 1 次，界面说四关都过了。
    await seedRounds();
    const at = '2026-11-09T02:00:00.000Z';
    for (const round of [1, 2, 3, 4]) {
      await recordXqReview(db, reviewInput({ round, occurredAt: at }));
    }
    expect(await events()).toEqual({ review_passed: 4 });
    expect((await rounds()).every((row) => row.done)).toBe(true);
  });

  it('★ 同一关重投仍然只记一条 —— 键里有 round，但同一关同一个时刻是同一件事', async () => {
    await seedRounds();
    const at = '2026-11-09T02:00:00.000Z';
    const first = await recordXqReview(db, reviewInput({ occurredAt: at }));
    const again = await recordXqReview(db, reviewInput({ occurredAt: at }));
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.eventId).toBe(first.eventId);
    expect(await events()).toEqual({ review_passed: 1 });
  });

  it('★ 同一瞬间换个写法仍然是同一件事 —— 幂等键吃归一化后的时刻', async () => {
    await seedRounds();
    const first = await recordXqReview(
      db,
      reviewInput({ occurredAt: '2026-11-09T10:00:00+08:00' }),
    );
    const again = await recordXqReview(db, reviewInput({ occurredAt: '2026-11-09T02:00:00Z' }));
    expect(again.duplicate).toBe(true);
    expect(again.eventId).toBe(first.eventId);
    expect(await events()).toEqual({ review_passed: 1 });
  });

  it('★ 答对：写一条 review_passed，只关掉这一关，后三关不动', async () => {
    await seedRounds();
    const result = await recordXqReview(db, reviewInput());

    expect(result.recorded).toBe(true);
    expect(result.eventId).not.toBeNull();
    expect(result.duplicate).toBe(false);
    expect(await events()).toEqual({ review_passed: 1 });

    const rows = await rounds();
    expect(rows[0]).toMatchObject({ round: 1, done: true, outcome: 'pass' });
    expect(rows.slice(1).every((row) => !row.done)).toBe(true);
  });

  it('★ 做错：写一条 review_failed，四关全部重排回未完成', async () => {
    await seedRounds();
    const result = await recordXqReview(db, reviewInput({ outcome: 'fail' }));

    expect(result.recorded).toBe(true);
    expect(await events()).toEqual({ review_failed: 1 });

    const rows = await rounds();
    // `fail` 的语义是「四关重来」，不是「只把这一关标错」。
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => !row.done && row.outcome === null)).toBe(true);
  });

  it('★ 跳过：不写任何事件，只把这一关标掉 —— 跳过不是行为事实', async () => {
    await seedRounds();
    const result = await recordXqReview(db, reviewInput({ outcome: 'skip' }));

    expect(result.recorded).toBe(true);
    expect(result.eventId).toBeNull();
    expect(await events()).toEqual({});

    const rows = await rounds();
    expect(rows[0]).toMatchObject({ round: 1, done: true, outcome: 'skip' });
  });

  it('★ 这一关不存在时直接报，不写假事实', async () => {
    await seedRounds();
    await expect(
      recordXqReview(db, reviewInput({ round: 3, concept: '根本没挂的概念' })),
    ).rejects.toBeInstanceOf(XqReviewRoundMissingError);
    expect(await events()).toEqual({});
  });

  it('★ 同一时刻重投两次只留一条事件 —— 计数不能因为重试翻倍', async () => {
    await seedRounds();
    const input = reviewInput({ outcome: 'fail' });

    const first = await recordXqReview(db, input);
    const second = await recordXqReview(db, input);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect(await events()).toEqual({ review_failed: 1 });
  });

  it('★ 真的又错一次（时刻不同）就该是第二条 —— 这正是 P5 要数的', async () => {
    await seedRounds();
    await recordXqReview(db, reviewInput({ outcome: 'fail' }));
    await recordXqReview(
      db,
      reviewInput({ outcome: 'fail', occurredAt: '2026-11-11T02:00:00.000Z' }),
    );

    expect(await events()).toEqual({ review_failed: 2 });
  });

  it('★ 事件里带着 round 与 outcome —— 光看 kind 分不出是第几关', async () => {
    await seedRounds();
    await recordXqReview(db, reviewInput({ round: 2, outcome: 'pass' }));

    const r = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM xq_event WHERE kind = 'review_passed'`,
    );
    expect(r.rows[0]!.payload).toMatchObject({
      round: 2,
      outcome: 'pass',
      concept: CONCEPT,
    });
  });

  it('★ 记完之后不再出现在「今天到期的复习」里 —— 闭环真的闭上了', async () => {
    await seedRounds();
    // 排期的锚点是**真实现在**（SQL 里就是 `now()`），不是测试里的假时间，
    // 所以「四关全都到期」要挑一个足够晚的时刻才看得见 —— 15 天后再看。
    const farLater = new Date(Date.now() + 40 * 24 * 3600 * 1000);
    expect((await store().dueReviews(farLater)).some((r) => r.round === 1)).toBe(true);

    await recordXqReview(db, reviewInput());
    expect((await store().dueReviews(farLater)).some((r) => r.round === 1)).toBe(false);
  });
});
