import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { RUNTIME_PG_SCHEMA } from '@openmaic/storage/runtime/pg';

import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import { recordXqEvent } from '@/lib/persistence/xq-event-recorder';
import {
  AI_LOG_LIMIT,
  AI_LOG_PROXIMITY_MS,
  AI_LOG_TEXT_MAX_CHARS,
  readAiLog,
} from '@/lib/persistence/xq-ai-log';

/**
 * 学情**对话日志读侧**的判据：把「他在哪道题上问过 AI」从两个地方拼回来。
 *
 * 这一层最危险的失败方式不是报错，是**读少了却不报错**：
 *
 * - 一场逻辑对话在库里可能是多行 `runtime_sessions`（超过 256 条记录会
 *   开新一代）。按 `session_id` 读会读到半场而看不出来 —— 不抛异常、
 *   只是少一半。所以第一条判据钉住「跨代也读全」。
 * - 对话内容里有 `chat_session_state` 这类没有 `role` / `content` 的记录。
 *   混进轮次里会产出空壳，看起来像「AI 说了空话」。
 * - 时间窗宽了会把「问完又聊别的」并进来，窄了会把「问了、想了、接着说」
 *   切成两段。两边都要能看出来。
 * - `LEFT JOIN` 的「没配上」是**有意义的结果**（记了问，找不到那场对话），
 *   不许被 `INNER JOIN` 静默吃掉。
 */
describe('xq ai log', () => {
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
    await db.exec(RUNTIME_PG_SCHEMA);
    await ensureXqLearnerSchema(db);
  });

  const T0 = '2026-11-08T02:00:00.000Z';

  const session = (occurredAt = T0): Promise<string> =>
    recordXqEvent(db, {
      kind: 'session_started',
      stageId: 'stage-A',
      occurredAt,
    }).then((r) => r.sessionId);

  /** 建一行 chat 运行时会话。`generation` 用来模拟滚动。 */
  const chatRuntimeSession = async (
    id: string,
    stageId = 'stage-A',
    kind = 'chat',
  ): Promise<void> => {
    await db.query(
      `INSERT INTO runtime_sessions (id, stage_id, learner_key, kind, status, created_at, updated_at, data)
       VALUES ($1, $2, 'learner-1', $3, 'active', $4, $4, '{}'::jsonb)`,
      [id, stageId, kind, T0],
    );
  };

  let seq = 0;

  /** 一条对话消息记录。 */
  const chatRecord = async (input: {
    runtimeSessionId: string;
    sceneId?: string;
    createdAt: string;
    role: 'user' | 'assistant';
    content: string;
    subAnchor?: string;
    kind?: string;
  }): Promise<string> => {
    const recordId = `rec-${seq++}`;
    const payload: Record<string, unknown> = {
      kind: input.kind ?? 'chat_message',
      role: input.role,
      content: input.content,
    };
    await db.query(
      `INSERT INTO runtime_records (id, session_id, seq, scene_id, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        recordId,
        input.runtimeSessionId,
        seq,
        input.sceneId ?? null,
        input.createdAt,
        JSON.stringify({ payload, ...(input.subAnchor ? { subAnchor: input.subAnchor } : {}) }),
      ],
    );
    return recordId;
  };

  /** 一条「问过 AI」的事实。 */
  const ask = async (input: {
    sessionId: string;
    sceneId?: string;
    questionId: string;
    occurredAt?: string;
    subtype?: 'instrumental' | 'executive';
    stem?: string;
    stageId?: string;
  }) =>
    recordXqEvent(db, {
      kind: 'hint_requested',
      stageId: input.stageId ?? 'stage-A',
      sceneId: input.sceneId ?? 'scene-p1',
      questionId: input.questionId,
      occurredAt: input.occurredAt ?? T0,
      sessionId: input.sessionId,
      hintSubtype: input.subtype ?? 'instrumental',
      payload: { stem: input.stem ?? '下面哪个说法是对的？' },
    });

  const plus = (base: string, ms: number): string => new Date(Date.parse(base) + ms).toISOString();

  it('★ 一条提问配到它的对话轮次 —— 按题号与时间，不按页', async () => {
    const sid = await session();
    await chatRuntimeSession('chat:stage-A:l:s1');
    await ask({ sessionId: sid, questionId: 'q3', occurredAt: plus(T0, 1000) });
    // 同一页上的另一道题 —— 它也有对话，但配不到这条提问。
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 2000),
      role: 'user',
      content: 'q3 这句里的 final 是什么意思？',
      subAnchor: 'q3',
    });
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 2500),
      role: 'assistant',
      content: 'final 表示只能赋值一次。',
      subAnchor: 'q3',
    });
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 3000),
      role: 'user',
      content: '那 q1 呢？',
      subAnchor: 'q1',
    });

    const [entry] = await readAiLog(db);
    expect(entry.questionId).toBe('q3');
    expect(entry.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(entry.turns[0].text).toContain('final');
    expect(entry.generations).toBe(1);
  });

  it('★ 跨代也要读全 —— 按 session_id 死读会静默读到半场', async () => {
    const sid = await session();
    // 一场对话被滚动成两代：同一个 base，两个不同 session_id。
    await chatRuntimeSession('chat:stage-A:l:s1:generation:1');
    await chatRuntimeSession('chat:stage-A:l:s1:generation:2');
    await ask({ sessionId: sid, questionId: 'q1', occurredAt: plus(T0, 1000) });
    // 前半句在第 1 代，后半句在第 2 代 —— 都在 5 分钟窗内。
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1:generation:1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 2000),
      role: 'user',
      content: '第一代里的话',
      subAnchor: 'q1',
    });
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1:generation:2',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 4000),
      role: 'assistant',
      content: '第二代里的回答',
      subAnchor: 'q1',
    });

    const [entry] = await readAiLog(db);
    // ★ 两代都在：按 base 归并过了。少一条就是静默截断。
    expect(entry.turns).toHaveLength(2);
    expect(entry.turns.map((turn) => turn.generation)).toEqual([1, 2]);
    expect(entry.generations).toBe(2);
  });

  it('★ 状态记录不算一轮对话 —— 它没有 role，混进来就是空壳', async () => {
    const sid = await session();
    await chatRuntimeSession('chat:stage-A:l:s1');
    await ask({ sessionId: sid, questionId: 'q2', occurredAt: plus(T0, 1000) });
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 2000),
      role: 'user',
      content: '真的问题',
      subAnchor: 'q2',
    });
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 2100),
      role: 'assistant',
      content: '',
      subAnchor: 'q2',
      kind: 'chat_session_state',
    });

    const [entry] = await readAiLog(db);
    expect(entry.turns).toHaveLength(1);
    expect(entry.turns[0].role).toBe('user');
  });

  it('★ 记了问但找不到对话 —— 回空数组，不是把这条提问丢掉', async () => {
    const sid = await session();
    await ask({ sessionId: sid, questionId: 'q7', occurredAt: plus(T0, 1000) });

    const entries = await readAiLog(db);
    expect(entries).toHaveLength(1);
    expect(entries[0].questionId).toBe('q7');
    expect(entries[0].turns).toEqual([]);
    expect(entries[0].generations).toBe(0);
  });

  it('★ 超出时间窗的对话不并进来 —— 5 分钟是默认值，不是随便', async () => {
    const sid = await session();
    await chatRuntimeSession('chat:stage-A:l:s1');
    await ask({ sessionId: sid, questionId: 'q1', occurredAt: plus(T0, 1000) });
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 1000 + AI_LOG_PROXIMITY_MS + 60_000),
      role: 'user',
      content: '六分钟之后才说的话',
      subAnchor: 'q1',
    });

    const [entry] = await readAiLog(db);
    expect(entry.turns).toEqual([]);

    // 窗内（差一秒）就算 —— 边界不是「大约」。
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 1000 + AI_LOG_PROXIMITY_MS),
      role: 'user',
      content: '窗内的最后一秒',
      subAnchor: 'q1',
    });
    const [again] = await readAiLog(db);
    expect(again.turns.map((turn) => turn.text)).toEqual(['窗内的最后一秒']);
  });

  it('★ 提问之前的对话不算 —— 时间窗只有一个方向', async () => {
    const sid = await session();
    await chatRuntimeSession('chat:stage-A:l:s1');
    await ask({ sessionId: sid, questionId: 'q1', occurredAt: plus(T0, 60_000) });
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 30_000),
      role: 'user',
      content: '问之前说的话',
      subAnchor: 'q1',
    });

    const [entry] = await readAiLog(db);
    expect(entry.turns).toEqual([]);
  });

  it('★ 别的课同一个题号不许串 —— scene id 跨课复用，题号也会', async () => {
    const sidA = await session();
    await chatRuntimeSession('chat:stage-A:l:s1', 'stage-A');
    await chatRuntimeSession('chat:stage-B:l:s1', 'stage-B');
    await ask({
      sessionId: sidA,
      questionId: 'q1',
      stageId: 'stage-A',
      occurredAt: plus(T0, 1000),
    });
    // 另一门课、同一页、同一题号。
    await chatRecord({
      runtimeSessionId: 'chat:stage-B:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 2000),
      role: 'user',
      content: 'B 课里的话',
      subAnchor: 'q1',
    });

    const [entry] = await readAiLog(db);
    expect(entry.turns).toEqual([]);
  });

  it('★ 长正文按码点截断 —— 数学符号不许被切成孤立代理项', async () => {
    const sid = await session();
    await chatRuntimeSession('chat:stage-A:l:s1');
    await ask({ sessionId: sid, questionId: 'q1', occurredAt: plus(T0, 1000) });
    // 𝔸 是代理对。按 UTF-16 码元切会切出半个。
    const long = '𝔸'.repeat(AI_LOG_TEXT_MAX_CHARS + 10);
    await chatRecord({
      runtimeSessionId: 'chat:stage-A:l:s1',
      sceneId: 'scene-p1',
      createdAt: plus(T0, 2000),
      role: 'user',
      content: long,
      subAnchor: 'q1',
    });

    const [entry] = await readAiLog(db);
    expect(entry.turns[0].truncated).toBe(true);
    expect(entry.turns[0].text).not.toContain('\uFFFD');
    // 截断到上限个码点 + 一个省略号。
    expect(Array.from(entry.turns[0].text).length).toBe(AI_LOG_TEXT_MAX_CHARS + 1);
  });

  it('★ 两种分型分开交出去 —— 它们与成绩的方向相反', async () => {
    const sid = await session();
    await ask({
      sessionId: sid,
      questionId: 'q1',
      subtype: 'instrumental',
      occurredAt: plus(T0, 1000),
    });
    await ask({
      sessionId: sid,
      questionId: 'q2',
      subtype: 'executive',
      occurredAt: plus(T0, 2000),
    });

    const entries = await readAiLog(db);
    expect(entries.map((entry) => entry.hintSubtype)).toEqual(['executive', 'instrumental']);
  });

  it('★ 没说题号的提问不进日志 —— 页面级提问对不上任何一道题', async () => {
    const sid = await session();
    await recordXqEvent(db, {
      kind: 'hint_requested',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      occurredAt: plus(T0, 1000),
      sessionId: sid,
      hintSubtype: 'executive',
      payload: { stem: '整页都看不懂' },
    });

    expect(await readAiLog(db)).toEqual([]);
  });

  it('★ 最近的在前，且 limit 生效', async () => {
    const sid = await session();
    for (let n = 0; n < 3; n += 1) {
      await ask({
        sessionId: sid,
        questionId: `q${n + 1}`,
        occurredAt: plus(T0, (n + 1) * 1000),
      });
    }
    const all = await readAiLog(db);
    expect(all.map((entry) => entry.questionId)).toEqual(['q3', 'q2', 'q1']);
    expect(await readAiLog(db, { limit: 2 })).toHaveLength(2);
  });

  it('★ day 是**学习日**（04:00 边界），与 /xq/sessions 同一个口径', async () => {
    // 凌晨 02:30（上海）= 前一天的学习日。两处端点必须给同一个答案：
    // `/xq/sessions` 读 `xq_session.local_day`（`localDayOf()` 算好落库的），
    // 这里若按日历日现算，同一条提问会在会话摘要里属昨天、在对话日志里属今天。
    const sessionId = await session('2026-11-08T18:30:00.000Z');
    const runtimeId = 'chat:late';
    await chatRuntimeSession(runtimeId, 'stage-A');
    await recordXqEvent(db, {
      kind: 'hint_requested',
      stageId: 'stage-A',
      sceneId: 'scene-p1',
      questionId: 'q1',
      hintSubtype: 'instrumental',
      sessionId,
      occurredAt: '2026-11-08T18:30:00.000Z',
      payload: { stem: '凌晨两点还在做题' },
    });
    await chatRecord({
      runtimeSessionId: runtimeId,
      sceneId: 'scene-p1',
      createdAt: '2026-11-08T18:30:01.000Z',
      role: 'user',
      content: '这题怎么做',
      subAnchor: 'q1',
    });

    // 学习日是 11-08（04:00 边界），日历日是 11-09。
    const studyDay = await readAiLog(db, { day: '2026-11-08' });
    expect(studyDay).toHaveLength(1);
    const calendarDay = await readAiLog(db, { day: '2026-11-09' });
    expect(calendarDay).toHaveLength(0);
  });

  it('常量固定 —— 时间窗 5 分钟、上限 100 条、正文 400 字', () => {
    expect(AI_LOG_PROXIMITY_MS).toBe(5 * 60 * 1000);
    expect(AI_LOG_LIMIT).toBe(100);
    expect(AI_LOG_TEXT_MAX_CHARS).toBe(400);
  });
});
