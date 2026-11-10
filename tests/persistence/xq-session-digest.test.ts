import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import { recordXqEvent, type XqEventInput } from '@/lib/persistence/xq-event-recorder';
import {
  ACTIVE_GAP_CAP_MS_AFTER_PAGE,
  ACTIVE_GAP_CAP_MS_DEFAULT,
  digestSessions,
  SESSION_DIGEST_LIMIT,
} from '@/lib/persistence/xq-session-digest';

/**
 * 学情**事件读侧**的判据：只追加的事件流 → 「这次学了多久、今天学了什么」。
 *
 * 这一层最危险的失败方式不是报错，是**算出一个看起来合理的错数**：
 *
 * - 把「去吃饭的两小时」算进活跃时长 ⇒ 每天的「学了多久」全部虚高；
 * - 按「最后一条减第一条」算，而不是按相邻间隔求和 ⇒ 漏掉每一段；
 * - 上限按当前事件取而不是按**上一条**取 ⇒ 翻页之后的 60 分钟永远不生效；
 * - 把 instrumental 与 executive 加成「求过几次提示」⇒ 两种与成绩方向相反的
 *   信号合成一个，此后任何折扣都用不了；
 * - 把 `voided` 算进事件条数 ⇒ 撤销了一条事件反而让计数变大。
 *
 * 五条都在这里钉住，另加两条边界（会话没关时 `wallMs` 是 null、`day` 过滤）。
 */
describe('xq session digest', () => {
  let db: PGlite;

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

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await ensureXqLearnerSchema(db);
  });

  const start = (occurredAt = '2026-11-08T02:00:00.000Z'): Promise<string> =>
    recordXqEvent(db, {
      kind: 'session_started',
      stageId: 'stage-A',
      occurredAt,
    }).then((r) => r.sessionId);

  const at = (sessionId: string, minutes: number): string =>
    new Date(Date.parse('2026-11-08T02:00:00.000Z') + minutes * 60_000).toISOString();

  const page = (sessionId: string, minutes: number, sceneId = 'scene-p1'): XqEventInput => ({
    kind: 'page_viewed',
    stageId: 'stage-A',
    sceneId,
    sessionId,
    occurredAt: at(sessionId, minutes),
  });

  it('★ 一次干净的学习：翻两页就结束，活跃时长按相邻间隔求和', async () => {
    const sessionId = await start();
    await recordXqEvent(db, page(sessionId, 2));
    await recordXqEvent(db, page(sessionId, 5, 'scene-p2'));
    await recordXqEvent(db, {
      kind: 'session_ended',
      stageId: 'stage-A',
      sessionId,
      occurredAt: at(sessionId, 6),
      endReason: 'terminated',
    });

    const [digest] = await digestSessions(db);
    expect(digest).toBeDefined();
    // 起点 → 2 分 → 5 分 → 6 分，三段各 2/3/1 分钟，合计 6 分钟。
    expect(digest!.activeMs).toBe(6 * 60_000);
    expect(digest!.eventCount).toBe(4);
    expect(digest!.pageCount).toBe(2);
    expect(digest!.endedAt).not.toBeNull();
    expect(digest!.endReason).toBe('terminated');
    expect(digest!.wallMs).toBe(6 * 60_000);
  });

  it('★ 去吃饭的两小时不算学习 —— 超时截断到默认上限', async () => {
    const sessionId = await start();
    // 答完题就去吃饭，两小时后回来翻页。
    await recordXqEvent(db, {
      kind: 'answer_submitted',
      stageId: 'stage-A',
      sessionId,
      questionId: 'q1',
      occurredAt: at(sessionId, 1),
    });
    await recordXqEvent(db, page(sessionId, 121));

    const [digest] = await digestSessions(db);
    // 1 分钟（起点→答题）+ 30 分钟（截断），不是 121 分钟。
    expect(digest!.activeMs).toBe(60_000 + ACTIVE_GAP_CAP_MS_DEFAULT);
    expect(digest!.wallMs).toBeNull(); // 还没关
  });

  it('★ 翻页之后的上限是 60 分钟 —— 按上一条事件取，不是按当前这条', async () => {
    const sessionId = await start();
    await recordXqEvent(db, page(sessionId, 1));
    // 读完这一页花了 45 分钟：翻页之后的间隔能吃满 60 分钟，不该被砍到 30。
    await recordXqEvent(db, page(sessionId, 46, 'scene-p2'));

    const [digest] = await digestSessions(db);
    expect(digest!.activeMs).toBe(60_000 + 45 * 60_000);
    expect(digest!.activeMs).toBeLessThan(ACTIVE_GAP_CAP_MS_AFTER_PAGE + 60_000);
  });

  it('★ 两种提示分开数 —— 合成一个数就让方向相反的两个信号再也分不开', async () => {
    const sessionId = await start();
    const hint = (minutes: number, subtype: 'instrumental' | 'executive'): XqEventInput => ({
      kind: 'hint_requested',
      stageId: 'stage-A',
      sessionId,
      questionId: 'q1',
      hintSubtype: subtype,
      occurredAt: at(sessionId, minutes),
    });
    await recordXqEvent(db, hint(1, 'instrumental'));
    await recordXqEvent(db, hint(2, 'instrumental'));
    await recordXqEvent(db, hint(3, 'executive'));

    const [digest] = await digestSessions(db);
    expect(digest!.hints.instrumental).toBe(2);
    expect(digest!.hints.executive).toBe(1);
  });

  it('★ 撤销掉的事件不进计数 —— 否则撤销反而让「做了多少」变大', async () => {
    const sessionId = await start();
    await recordXqEvent(db, page(sessionId, 1));
    const second = await recordXqEvent(db, page(sessionId, 2, 'scene-p2'));

    // 撤销第二条：再写一条 kind='voided'（撤销本身也是一条事件，不改任何旧行）。
    const voided = await recordXqEvent(db, {
      kind: 'voided',
      stageId: 'stage-A',
      sessionId,
      occurredAt: at(sessionId, 3),
      payload: { voided: second.eventId },
    });

    // ★ 今天**没有任何代码写 `voided_by`**（DDL 有这一列，写入方还没有）。
    // 这条线用 SQL 直接补上，把读侧对它的处理钉住：等真的有人写撤销时，
    // 本文件不需要跟着改。
    await db.query('UPDATE xq_event SET voided_by = $1 WHERE event_id = $2', [
      voided.eventId,
      second.eventId,
    ]);

    const [digest] = await digestSessions(db);
    // started + 第一条 page_viewed 留下；第二条被撤销、voided 自己是痕迹不算。
    expect(digest!.eventCount).toBe(2);
    expect(digest!.pageCount).toBe(1);
  });

  it('★ 答过与交卷分开数 —— 只写一半就卡住的人在这两列之间', async () => {
    const sessionId = await start();
    await recordXqEvent(db, {
      kind: 'answer_attempted',
      stageId: 'stage-A',
      sessionId,
      questionId: 'q1',
      occurredAt: at(sessionId, 1),
    });
    await recordXqEvent(db, {
      kind: 'answer_submitted',
      stageId: 'stage-A',
      sessionId,
      questionId: 'q1',
      occurredAt: at(sessionId, 2),
    });

    const [digest] = await digestSessions(db);
    expect(digest!.answers.attempted).toBe(1);
    expect(digest!.answers.submitted).toBe(1);
  });

  it('★ 按学习日筛 —— 04:00 之前的会话属于前一天', async () => {
    // 2026-11-08 02:00Z 在 +08 时区是 10:00，属于 2026-11-08 这个学习日。
    await start();
    // 换个日子再开一个会话。
    await recordXqEvent(db, {
      kind: 'session_started',
      stageId: 'stage-A',
      occurredAt: '2026-11-10T02:00:00.000Z',
    });

    const all = await digestSessions(db);
    expect(all).toHaveLength(2);

    const onlyFirst = await digestSessions(db, { day: '2026-11-08' });
    expect(onlyFirst).toHaveLength(1);
    expect(onlyFirst[0]!.startedAt.toISOString()).toBe('2026-11-08T02:00:00.000Z');

    const none = await digestSessions(db, { day: '2026-11-09' });
    expect(none).toHaveLength(0);
  });

  it('★ 一个事件都没有的会话也回一行（活跃 0），不是消失', async () => {
    const sessionId = await start();
    // 只留 session_started 自个儿。
    const [digest] = await digestSessions(db);
    expect(digest!.sessionId).toBe(sessionId);
    expect(digest!.eventCount).toBe(1);
    expect(digest!.activeMs).toBe(0);
    expect(digest!.pageCount).toBe(0);
  });

  it('最近的在最前 —— 排序按 seq_no 倒序', async () => {
    await recordXqEvent(db, {
      kind: 'session_started',
      stageId: 'stage-A',
      occurredAt: '2026-11-08T02:00:00.000Z',
    });
    await recordXqEvent(db, {
      kind: 'session_started',
      stageId: 'stage-A',
      occurredAt: '2026-11-08T05:00:00.000Z',
    });

    const digests = await digestSessions(db);
    expect(digests.map((d) => d.seqNo)).toEqual([2, 1]);
  });

  it('★ 上限是确定的常量，别把「今天最该学什么」偷偷做成翻页', async () => {
    expect(SESSION_DIGEST_LIMIT).toBe(50);
    expect(ACTIVE_GAP_CAP_MS_AFTER_PAGE).toBe(60 * 60 * 1000);
    expect(ACTIVE_GAP_CAP_MS_DEFAULT).toBe(30 * 60 * 1000);
  });
});
