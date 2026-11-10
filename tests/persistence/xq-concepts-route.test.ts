import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({
  queryable: undefined as unknown,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: holder.queryable }),
}));

/**
 * `GET /api/persistence/xq/concepts` 的判据：图谱第一次有人读。
 *
 * 94 条 `prereq` 边从落库起零读方。规格里写死：在有人真的读这些边之前，
 * 任何「按图谱排序」的行为都不许上线。这条路由是「读」，不是「排序」：
 *
 *   - 不带 `id` ⇒ 只回图的形状（多少概念、多少边、按关系与强度怎么分）。
 *   - 带 `id` ⇒ 回这个概念的**直接**先修、闭包、深度、能不能学。
 *   - `mastered` 由调用方给 —— 服务端不判「他会不会」。
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

const COOKIE = 'anonymous_id=77777777-7777-4777-8777-777777777777';

const A = 'c_aaaaaaaaaaaa';
const B = 'c_bbbbbbbbbbbb';
const C = 'c_cccccccccccc';
const MISSING = 'c_999999999999';

function request(path: string, method = 'GET'): Request {
  return new Request(`http://localhost/api/persistence${path}`, {
    method,
    headers: { origin: 'http://localhost', cookie: COOKIE },
  });
}

async function bootRoute(): Promise<typeof import('@/app/api/persistence/[...path]/route')> {
  return await import('@/app/api/persistence/[...path]/route');
}

describe('GET /api/persistence/xq/concepts', () => {
  let db: PGlite;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://xq-concepts-route-test');
    db = new PGlite();
    await db.waitReady;
    await db.exec(DOCUMENT_SCENES_MIN);
    await db.exec(OWNER_MERGES_MIN);
    const { ensureXqLearnerSchema } = await import('@/lib/persistence/xq-learner');
    await ensureXqLearnerSchema(db);
    holder.queryable = db;

    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, status, created_in)
       VALUES ($1, 'Dart 变量', 'concept', 'active', 1),
              ($2, 'Dart 空安全', 'concept', 'active', 1),
              ($3, 'Dart 异步', 'concept', 'active', 1)`,
      [A, B, C],
    );
    await db.query(
      `INSERT INTO xq_concept_edge (from_id, to_id, relation, strength, reason, source)
       VALUES ($1, $2, 'prereq', 'strict', '空安全建立在变量与类型之上', 'cs2023'),
              ($2, $3, 'prereq', 'strict', '异步要先用熟空安全', 'cs2023'),
              ($1, $3, 'prereq', 'recommended', '异步也常直接用到变量', 'course-outline')`,
      [A, B, C],
    );
  });

  it('★ 不带 id 只回图的形状 —— 不给任何顺序建议', async () => {
    const route = await bootRoute();
    const response = await route.GET(request('/xq/concepts'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      concepts: 3,
      edges: 3,
      byRelation: { prereq: 3, contains: 0 },
      byStrength: { strict: 2, recommended: 1, helpful: 0 },
      retired: 0,
      strengths: ['strict'],
    });
    // 形状里不许出现任何「该学什么」的字段。
    expect(Object.keys(body).sort()).toEqual(
      ['byRelation', 'byStrength', 'concepts', 'edges', 'retired', 'strengths'].sort(),
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('★ 带 id 回直接先修与闭包（默认只认 strict）', async () => {
    const route = await bootRoute();
    const response = await route.GET(request(`/xq/concepts?id=${C}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: C,
      canonicalName: 'Dart 异步',
      kind: 'concept',
      status: 'active',
      prerequisites: [B],
      closure: [A, B],
      cycle: false,
      depth: 2,
      ready: false,
    });
  });

  it('★ 先修的「凭什么」也一起回 —— 来源与档位在边上，不在结论里', async () => {
    const route = await bootRoute();
    const response = await route.GET(request(`/xq/concepts?id=${C}`));
    const body = (await response.json()) as Record<string, unknown>;
    // 默认只认 strict ⇒ 只回 strict 那条依据，且带得出 source。
    const evidence = body.prerequisiteEvidence as Array<Record<string, unknown>>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ fromId: B, toId: C, strength: 'strict' });
    expect(typeof evidence[0]?.source).toBe('string');
    // ★ 结论与依据是两份数据：结论去重排序，依据一条边一行。
    expect(body.prerequisites).toEqual([B]);
  });

  it('★ 放宽到 recommended 时多出一条先修，但闭包不变', async () => {
    const route = await bootRoute();
    const response = await route.GET(request(`/xq/concepts?id=${C}&strengths=strict,recommended`));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.strengths).toEqual(['recommended', 'strict']);
    expect(body.prerequisites).toEqual([A, B]);
    expect(body.closure).toEqual([A, B]);
  });

  it('★ mastered 由调用方给 —— 全会了才 ready', async () => {
    const route = await bootRoute();
    const none = (await (await route.GET(request(`/xq/concepts?id=${C}`))).json()) as Record<
      string,
      unknown
    >;
    expect(none).toMatchObject({ ready: false, blockedBy: [A, B] });

    const all = (await (
      await route.GET(request(`/xq/concepts?id=${C}&mastered=${A},${B}`))
    ).json()) as Record<string, unknown>;
    expect(all).toMatchObject({ ready: true, blockedBy: [] });
  });

  it('★ 只掌握直接先修还不够 —— 判的是整个闭包', async () => {
    const route = await bootRoute();
    const body = (await (
      await route.GET(request(`/xq/concepts?id=${C}&mastered=${B}`))
    ).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ready: false, blockedBy: [A] });
  });

  it('★ 带 id 时一并回出现记录与页标题 —— 644 行出现记录第一次被读', async () => {
    await db.query(
      `INSERT INTO document_scenes (stage_id, id, scene_order, data)
       VALUES ('stage-q1', 'scene-p1', 1, '{"title":"变量知识检查"}'::jsonb),
              ('stage-q1', 'scene-p9', 9, '{}'::jsonb)`,
    );
    await db.query(
      `INSERT INTO xq_concept_occurrence (concept_id, stage_id, scene_id, weight, source)
       VALUES ($1, 'stage-q1', 'scene-p1', 1.00, 'keypoint'),
              ($1, 'stage-q1', 'scene-p9', 0.40, 'body')`,
      [A],
    );
    const route = await bootRoute();
    const response = await route.GET(request(`/xq/concepts?id=${A}`));
    const body = (await response.json()) as {
      occurrences: { sceneId: string; title: string | null; weight: number; source: string }[];
    };
    expect(body.occurrences).toHaveLength(2);
    expect(body.occurrences[0]).toEqual({
      stageId: 'stage-q1',
      sceneId: 'scene-p1',
      title: '变量知识检查',
      weight: 1,
      source: 'keypoint',
    });
    // 页没有标题 ⇒ null，不编空串。
    expect(body.occurrences[1]).toMatchObject({ sceneId: 'scene-p9', title: null, source: 'body' });
  });

  it('★ 没有任何页讲过的概念回空数组，而不是缺字段', async () => {
    const route = await bootRoute();
    const body = (await (await route.GET(request(`/xq/concepts?id=${B}`))).json()) as Record<
      string,
      unknown
    >;
    expect(body.occurrences).toEqual([]);
  });

  it('不存在的概念回 404 而不是空对象', async () => {
    const route = await bootRoute();
    const response = await route.GET(request(`/xq/concepts?id=${MISSING}`));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CONCEPT_NOT_FOUND');
  });

  it('★ 未知的强度档 400 —— 拼错的档位不许静默变成「没有先修」', async () => {
    const route = await bootRoute();
    const response = await route.GET(request(`/xq/concepts?id=${C}&strengths=strics`));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toContain('strics');
  });

  it('空的 strengths 参数 400 —— 空集等于「一条先修都不算」', async () => {
    const route = await bootRoute();
    const response = await route.GET(request(`/xq/concepts?id=${C}&strengths=,`));
    expect(response.status).toBe(400);
  });

  it('不是 GET 就 405', async () => {
    const route = await bootRoute();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await route[method as 'POST'](request('/xq/concepts', method));
      expect(response.status).toBe(405);
    }
  });

  it('★ 只读 —— 读三次之后概念与边都没变', async () => {
    const route = await bootRoute();
    await route.GET(request('/xq/concepts'));
    await route.GET(request(`/xq/concepts?id=${C}`));
    await route.GET(request(`/xq/concepts?id=${C}&mastered=${A}`));
    const concepts = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM xq_concept');
    const edges = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM xq_concept_edge');
    expect(concepts.rows[0]?.n).toBe(3);
    expect(edges.rows[0]?.n).toBe(3);
  });
});
