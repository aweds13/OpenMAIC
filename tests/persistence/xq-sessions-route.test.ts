import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({
  queryable: undefined as unknown,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: holder.queryable }),
}));

/**
 * `GET /api/persistence/xq/sessions` 的判据：事件流折成「这次学了多久」。
 *
 * 这条读侧存在的理由是写入侧的一句拒绝：`xq-event-recorder.ts` 的文件头写着
 * 「不补算派生量」——`active_ms` 要跨事件配对，挂在「记一条事实」上就得为每条
 * 事件重扫全表。所以 `xq_session` 上那两列从建表起一直是空的，
 * 而**空着不等于该空**：没有这一层，「今天学了多久」永远没有答案。
 *
 * 四条要钉住的性质：
 *
 * 1. **`day` 是学习日不是日历日**（04:00 边界），与写入侧用的是同一个函数。
 *    给了 `day` 就只回那一天的；不给就跨全部日期，而不是猜调用方时区。
 * 2. **`activeMs` 会把超时截断**，`wallMs` 不会 —— 两个都给是因为
 *    「3 小时里活跃 25 分钟」与「25 分钟」对「今天学了没」是一回事，
 *    对「是不是开着页面走了」不是。
 * 3. **`limit` 被夹住**，不是被信任。乱写回默认而不是报错：调用方要的是列表，
 *    列表依然有意义。
 * 4. **只读**。它不许写 `xq_session`，否则每次读都改库，`active_ms` 会变成
 *    一个「上次有人读时是多少」的数。
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

const COOKIE = 'anonymous_id=88888888-8888-4888-8888-888888888888';
const STAGE = 'stage-q1';
const SCENE = 'scene-p1';

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

interface SessionPayload {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  seqNo: number;
  eventCount: number;
  pageCount: number;
  activeMs: number;
  wallMs: number | null;
  hints: { instrumental: number; executive: number };
  answers: { attempted: number; submitted: number };
}

const sessionsOf = async (response: Response): Promise<SessionPayload[]> => {
  const body = (await response.json()) as { sessions: SessionPayload[] };
  return body.sessions;
};

describe('GET /api/persistence/xq/sessions', () => {
  let db: PGlite;
  let record: typeof import('@/lib/persistence/xq-event-recorder').recordXqEvent;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', 'postgres://xq-session-digest-route-test');
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await db.exec(OWNER_MERGES_MIN);
    const learner = await import('@/lib/persistence/xq-learner');
    await learner.ensureXqLearnerSchema(db);
    const recorder = await import('@/lib/persistence/xq-event-recorder');
    record = recorder.recordXqEvent;
    holder.queryable = db;
  });

  const BASE = Date.parse('2026-11-08T02:00:00.000Z');
  const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();

  /** 一次干净的学习：翻两页、答一题，6 分钟后结束。 */
  const seedSession = async (startAt = at(0)): Promise<string> => {
    const { sessionId } = await record(db, {
      kind: 'session_started',
      stageId: STAGE,
      occurredAt: startAt,
    });
    const base = Date.parse(startAt);
    const minute = (m: number) => new Date(base + m * 60_000).toISOString();
    await record(db, {
      kind: 'page_viewed',
      stageId: STAGE,
      sceneId: SCENE,
      sessionId,
      occurredAt: minute(2),
    });
    await record(db, {
      kind: 'page_viewed',
      stageId: STAGE,
      sceneId: 'scene-p2',
      sessionId,
      occurredAt: minute(4),
    });
    await record(db, {
      kind: 'session_ended',
      stageId: STAGE,
      sessionId,
      endReason: 'terminated',
      occurredAt: minute(6),
    });
    return sessionId;
  };

  it('★ 一次学习折成一行 —— 6 分钟、2 页、4 条事件', async () => {
    await seedSession();
    const handle = await bootRoute();
    const response = await handle(request('/xq/sessions'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    const [session] = await sessionsOf(response);
    expect(session).toBeDefined();
    expect(session!.activeMs).toBe(6 * 60_000);
    expect(session!.wallMs).toBe(6 * 60_000);
    expect(session!.pageCount).toBe(2);
    expect(session!.eventCount).toBe(4);
    expect(session!.endReason).toBe('terminated');
    expect(session!.seqNo).toBe(1);
  });

  it('★ 去吃饭的两小时不算学习 —— activeMs 截断，wallMs 不截断', async () => {
    // ★ 这条用**相对现在**的时刻，不能用测试文件里那个固定的历史基准：
    // `GET /xq/sessions` 会顺手把静默太久的会话收掉（死会话会让合计永远
    // 少一次），而一条 2026-11-08 的会话在真实钟表下当然算静默太久 ——
    // 那时被收掉是对的，但这条判据要问的是「没被收掉时墙钟怎么算」。
    const base = Date.now() - 90 * 60_000;
    const { sessionId } = await record(db, {
      kind: 'session_started',
      stageId: STAGE,
      occurredAt: new Date(base).toISOString(),
    });
    // 一小时后才翻页：超出 30 分钟默认上限，但墙钟照实记。
    await record(db, {
      kind: 'page_viewed',
      stageId: STAGE,
      sceneId: SCENE,
      sessionId,
      occurredAt: new Date(base + 60 * 60_000).toISOString(),
    });

    const handle = await bootRoute();
    const [session] = await sessionsOf(await handle(request('/xq/sessions')));
    expect(session!.activeMs).toBe(30 * 60_000);
    // 没关会话，所以没有墙钟。
    expect(session!.wallMs).toBeNull();
    expect(session!.endedAt).toBeNull();
  });

  it('★ day 是学习日 —— 凌晨两点那次属于前一天', async () => {
    // +08 时区下 2026-11-09 02:00 本地 = 2026-11-08 18:00Z，学习日应是 11-08。
    const localTwoAm = new Date('2026-11-08T18:00:00.000Z');
    await record(db, {
      kind: 'session_started',
      stageId: STAGE,
      occurredAt: localTwoAm.toISOString(),
    });

    const handle = await bootRoute();

    // 写入侧算出的 local_day。PGlite 把 `date` 解析成 Date（不是字符串），
    // 所以取 `::text` 才是那个 yyyy-mm-dd —— 直接拼 Date 会带上时分秒。
    const stored = await db.query<{ local_day: string }>(
      'SELECT local_day::text AS local_day FROM xq_session',
    );
    const studyDay = stored.rows[0]!.local_day;
    expect(studyDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 用那个学习日能查到；用日历日（次日本地日期）查不到。
    const hit = await sessionsOf(await handle(request(`/xq/sessions?day=${studyDay}`)));
    expect(hit).toHaveLength(1);

    const miss = await sessionsOf(await handle(request('/xq/sessions?day=2026-11-10')));
    expect(miss).toHaveLength(0);
  });

  it('★ 不给 day 就跨全部日期 —— 不猜调用方时区', async () => {
    await seedSession();
    await seedSession('2026-11-12T02:00:00.000Z');

    const handle = await bootRoute();
    const all = await sessionsOf(await handle(request('/xq/sessions')));
    expect(all).toHaveLength(2);
  });

  it('★ limit 乱写回默认而不是报错 —— 调用方要的是列表', async () => {
    await seedSession();
    const handle = await bootRoute();

    for (const bad of ['abc', '0', '-3']) {
      const response = await handle(request(`/xq/sessions?limit=${bad}`));
      expect(response.status).toBe(200);
      expect(await sessionsOf(response)).toHaveLength(1);
    }

    // 空的 day= 当作没给，不是「空的学习日」。
    const emptyDay = await handle(request('/xq/sessions?day='));
    expect(await sessionsOf(emptyDay)).toHaveLength(1);
  });

  it('★ 只读 —— 读一百次也不许改 xq_session', async () => {
    await seedSession();
    // `event_n` 在会话关闭时由 `CLOSE_SESSION_SQL` 写好（那是写入侧的事，
    // 关会话时数一次），这里只钉住 `active_ms` 一直是 null —— 它本该现算。
    const before = await db.query<{ active_ms: number | null; event_n: number | null }>(
      'SELECT active_ms, event_n FROM xq_session',
    );
    expect(before.rows[0]!.active_ms).toBeNull();

    const handle = await bootRoute();
    for (let i = 0; i < 3; i += 1) {
      await handle(request('/xq/sessions'));
    }

    const after = await db.query<{ active_ms: number | null; event_n: number | null }>(
      'SELECT active_ms, event_n FROM xq_session',
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('★ day 写得不成形就 400 —— 忽略它会悄悄把答案放大成「全部」', async () => {
    await seedSession();
    const handle = await bootRoute();
    for (const bad of ['2026/11/08', 'yesterday', '2026-11-8', '20261108']) {
      const response = await handle(request(`/xq/sessions?day=${encodeURIComponent(bad)}`));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('★ 不是 GET 就 405', async () => {
    const handle = await bootRoute();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await handle(request('/xq/sessions', method));
      expect(response.status).toBe(405);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
    }
  });

  it('★ 两种提示分开数 —— 合成一个数就再也折不开方向', async () => {
    const { sessionId } = await record(db, {
      kind: 'session_started',
      stageId: STAGE,
      occurredAt: at(0),
    });
    for (const [m, subtype] of [
      [1, 'instrumental'],
      [2, 'instrumental'],
      [3, 'executive'],
    ] as const) {
      await record(db, {
        kind: 'hint_requested',
        stageId: STAGE,
        sessionId,
        questionId: 'q1',
        hintSubtype: subtype,
        occurredAt: at(m),
      });
    }

    const handle = await bootRoute();
    const [session] = await sessionsOf(await handle(request('/xq/sessions')));
    expect(session!.hints).toEqual({ instrumental: 2, executive: 1 });
  });
});
