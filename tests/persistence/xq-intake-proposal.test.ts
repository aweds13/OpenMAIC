import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ensureXqLearnerSchema } from '@/lib/persistence/xq-learner';
import {
  AUTO_HIT_DECIDER,
  promoteProposal,
  readProposals,
  recordProposal,
  rejectProposal,
  type ProposalSignal,
} from '@/lib/persistence/xq-intake-proposal';
import { syncSeedGraph } from '@/lib/persistence/xq-seed-sync';
import { buildSeedGraph } from '@/lib/concepts';

/**
 * 这一组钉的是**提案从进来到落定这条路**，不是 SQL 的形状：
 *
 *   · 提案不在 `xq_concept` 里 —— 未确认的词不许获得概念身份
 *   · `hit` 自动归并（我们已经有了那个概念），`suspect` / `miss` 只能人裁
 *   · 拒绝之后不再问：行还在、`seen_count` 会涨、状态不被新导入改写
 *   · 晋升是五步一个事务：任何一步失败都不许留下半截状态
 *   · 第 3 步 `DO NOTHING`（不覆盖我们自己抽的更高权重）
 *   · 第 5 步的边只准 `proposed`（批概念 ≠ 批边）
 *   · 证指向的页在库里不存在时跳过并如实报数，不让外键把整条事务打崩
 */

const DOCUMENT_MIN = `CREATE TABLE IF NOT EXISTS document_stages (
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
CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
)`;

const STAGE = 'stage-A';

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(DOCUMENT_MIN);
  await ensureXqLearnerSchema(db);
  await db.query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, data)
     VALUES ($1, 'A', 0, 0, '{}'::jsonb)`,
    [STAGE],
  );
  return db;
}

async function seedPages(
  db: PGlite,
  pages: readonly { sceneId: string; order: number }[],
): Promise<void> {
  for (const page of pages) {
    await db.query(
      `INSERT INTO document_scenes (stage_id, id, scene_order, data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        STAGE,
        page.sceneId,
        page.order,
        JSON.stringify({
          id: page.sceneId,
          stageId: STAGE,
          type: 'slide',
          title: page.sceneId,
          order: page.order,
          content: { canvas: { elements: [] } },
        }),
      ],
    );
  }
}

/** 走真同步器把种子图落库，这样概念 id 是 `c_` + 12hex。 */
async function seedConcepts(db: PGlite): Promise<void> {
  await syncSeedGraph(db, { graph: buildSeedGraph(), execute: true });
}

function signal(sceneId: string, pageHash?: string): ProposalSignal {
  return { stageId: STAGE, sceneId, pageHash: pageHash ?? null, quote: '构造题' };
}

function withTx(db: PGlite) {
  return <T>(body: (q: Parameters<Parameters<PGlite['transaction']>[0]>[0]) => Promise<T>) =>
    db.transaction(body) as Promise<T>;
}

async function counts(db: PGlite) {
  const { rows } = await db.query<{
    concepts: string;
    proposals: string;
    occurrences: string;
    edges: string;
  }>(`SELECT (SELECT count(*) FROM xq_concept) concepts,
             (SELECT count(*) FROM xq_intake_proposal) proposals,
             (SELECT count(*) FROM xq_concept_occurrence) occurrences,
             (SELECT count(*) FROM xq_concept_edge) edges`);
  const row = rows[0]!;
  return {
    concepts: Number(row.concepts),
    proposals: Number(row.proposals),
    occurrences: Number(row.occurrences),
    edges: Number(row.edges),
  };
}

describe('recordProposal', () => {
  it('★ miss 进来是一行提案，概念表一行都不多 —— 未确认不等于已确认', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const before = await counts(db);
    const result = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '构造',
      tri: 'miss',
      signals: [signal('scene-p1')],
    });
    expect(result.created).toBe(true);
    expect(result.status).toBe('proposed');
    const after = await counts(db);
    expect(after.concepts).toBe(before.concepts);
    expect(after.proposals).toBe(1);
  });

  it('★ hit 自动归并并留痕 —— 但 decided_by 写的是「没人参与」而不是一个人名', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM xq_concept WHERE canonical_name = 'Git'`,
    );
    const git = rows[0]!.id;
    const result = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: 'Git',
      tri: 'hit',
      matchedConceptId: git,
    });
    expect(result.status).toBe('accepted');
    const stored = await db.query<{
      status: string;
      matched_concept_id: string;
      accepted_concept_id: string;
      decided_by: string;
      decided_at: Date | null;
    }>(
      `SELECT status, matched_concept_id, accepted_concept_id, decided_by, decided_at
          FROM xq_intake_proposal WHERE id = $1`,
      [result.id],
    );
    const row = stored.rows[0]!;
    expect(row.status).toBe('accepted');
    expect(row.matched_concept_id).toBe(git);
    expect(row.accepted_concept_id).toBe(git);
    expect(row.decided_by).toBe(AUTO_HIT_DECIDER);
    expect(row.decided_at).not.toBeNull();
  });

  it('★ hit 说中了但没说是哪个概念 ⇒ 发 SQL 之前就抛（库里那条 CHECK 会拦半截行）', async () => {
    const db = await freshDb();
    await expect(
      recordProposal(db, { externalSource: 'x', externalName: '构造', tri: 'hit' }),
    ).rejects.toThrow(/needs the concept it matched/);
    expect((await counts(db)).proposals).toBe(0);
  });

  it('空名字 / 空来源都不收', async () => {
    const db = await freshDb();
    await expect(
      recordProposal(db, { externalSource: 'x', externalName: '   ', tri: 'miss' }),
    ).rejects.toThrow(RangeError);
    await expect(
      recordProposal(db, { externalSource: '  ', externalName: '构造', tri: 'miss' }),
    ).rejects.toThrow(RangeError);
  });

  it('★ 提案挂得上任务 —— 「这批提案是为了什么导进来的」只有这一列能回答', async () => {
    const db = await freshDb();
    const withTask = await recordProposal(db, {
      taskId: 't_aaaaaaaaaaaa',
      externalSource: 'acm-graph',
      externalName: '构造',
      tri: 'miss',
    });
    expect(withTask.created).toBe(true);
    const stored = await db.query<{ task_id: string | null }>(
      `SELECT task_id FROM xq_intake_proposal WHERE id = $1`,
      [withTask.id],
    );
    expect(stored.rows[0]!.task_id).toBe('t_aaaaaaaaaaaa');

    // 不给就是 NULL，不是空串 —— 「没说要它来干什么」与「说了，内容是空」不同。
    const withoutTask = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '递推',
      tri: 'miss',
    });
    const bare = await db.query<{ task_id: string | null }>(
      `SELECT task_id FROM xq_intake_proposal WHERE id = $1`,
      [withoutTask.id],
    );
    expect(bare.rows[0]!.task_id).toBeNull();
  });

  it('★ 同一个词被第二次导入再看到时，任务留在第一次那条上 —— 唯一的行只能挂一个来历', async () => {
    const db = await freshDb();
    const first = await recordProposal(db, {
      taskId: 't_aaaaaaaaaaaa',
      externalSource: 'acm-graph',
      externalName: '构造',
      tri: 'miss',
    });
    await recordProposal(db, {
      taskId: 't_bbbbbbbbbbbb',
      externalSource: 'acm-graph',
      externalName: '构造',
      tri: 'suspect',
    });
    const rows = await db.query<{ task_id: string | null; tri: string; seen: string }>(
      `SELECT task_id, tri, seen_count::text AS seen FROM xq_intake_proposal`,
    );
    expect(rows.rows).toHaveLength(1);
    // ★ 两条都是真的：行还是那一行（唯一键不含 taskId），`tri` 被新证据改写，
    //   而 `task_id` 保留第一次那个 —— 它回答的是「第一次是为了什么收它」。
    expect(rows.rows[0]!.task_id).toBe('t_aaaaaaaaaaaa');
    expect(rows.rows[0]!.tri).toBe('suspect');
    expect(rows.rows[0]!.seen).toBe('2');
    expect(first.seenCount).toBe(1);
  });

  it('★ 同一份材料再来一次：还是一行，seen_count 涨到 2', async () => {
    const db = await freshDb();
    await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '构造',
      tri: 'miss',
    });
    const second = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '构造',
      tri: 'miss',
    });
    expect(second.created).toBe(false);
    expect(second.seenCount).toBe(2);
    expect((await counts(db)).proposals).toBe(1);
  });

  it('★ 拒绝之后再导入：人的决定冻住，证据继续更新（F7）', async () => {
    const db = await freshDb();
    const first = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '构造',
      tri: 'miss',
    });
    await rejectProposal(db, {
      proposalId: first.id,
      operator: 'owner',
      note: '这是算法竞赛里的「构造题」，不是构造方法',
    });
    const again = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '构造',
      tri: 'suspect',
      signals: [signal('scene-p2')],
    });
    expect(again.status).toBe('rejected');
    expect(again.seenCount).toBe(2);
    const stored = await db.query<{
      status: string;
      tri: string;
      decided_by: string;
      decided_at: Date | null;
      decision_note: string;
    }>(
      `SELECT status, tri, decided_by, decided_at, decision_note
         FROM xq_intake_proposal WHERE id = $1`,
      [first.id],
    );
    const row = stored.rows[0]!;
    // ★ F7 的判决：拒绝只冻结**人的决定**，不冻结**证据**。
    //
    // 这条判据 2026-11-13 从「证据冻结」改成「决定冻结、证据更新」，原因是
    // F7：审计发现拒绝后的行 tri 永远停在 miss，后来真的命中了人也看不见。
    // 判决是「拒绝冻结的是人的决定，不是证据」—— 所以 tri 变 suspect 是对的。
    // ⚠️ 放宽的只有 tri（以及 matched/confidence/signals）这三类**证据**，
    // status / decided_* / decision_note 一个字都不许动，下面逐条钉住。
    expect(row.tri).toBe('suspect');

    // 人的决定：状态、拒绝人、拒绝时刻、理由，全部原样。
    expect(row.status).toBe('rejected');
    expect(row.decided_by).toBe('owner');
    expect(row.decided_at).not.toBeNull();
    expect(row.decision_note).toContain('构造题');
  });

  it('★ F6：proposed 的行后来带着 matched 以 hit 再来一次 ⇒ 直接 accepted，不再等人批', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM xq_concept WHERE canonical_name = 'Git' AND status = 'active'`,
    );
    const matched = rows[0]!.id;
    const first = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '版本控制',
      tri: 'miss',
    });
    expect(first.status).toBe('proposed');
    const conceptsBefore = (await counts(db)).concepts;

    const second = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '版本控制',
      tri: 'hit',
      matchedConceptId: matched,
    });
    expect(second.created).toBe(false);

    const stored = await db.query<{
      status: string;
      tri: string;
      matched_concept_id: string;
      accepted_concept_id: string;
      decided_by: string;
      decided_at: Date | null;
    }>(
      `SELECT status, tri, matched_concept_id, accepted_concept_id, decided_by, decided_at
         FROM xq_intake_proposal WHERE id = $1`,
      [first.id],
    );
    const row = stored.rows[0]!;
    // 三样必须一起变，否则 V5 的三条 CHECK 会互相打架：
    // status=accepted ⇒ accepted_concept_id 非空；tri=hit ⇒ matched 非空；
    // status≠proposed ⇒ decided_at/decided_by 都非空。
    expect(row.status).toBe('accepted');
    expect(row.accepted_concept_id).toBe(matched);
    expect(row.matched_concept_id).toBe(matched);
    expect(row.decided_by).toBe(AUTO_HIT_DECIDER);
    expect(row.decided_at).not.toBeNull();
    // 已经自动归并，人再点 --accept 只能是 not-proposed —— 绝不许再建一个
    // 它自己都判定「已存在」的概念。
    expect(
      await promoteProposal(withTx(db), { proposalId: first.id, operator: 'owner' }),
    ).toMatchObject({ ok: false, reason: 'not-proposed' });
    expect((await counts(db)).concepts).toBe(conceptsBefore);
  });

  it('★ F6：已经 accepted 的行，证据不许被后续导入改写 —— 「已接受但匹配为空」是怪行', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM xq_concept WHERE canonical_name = 'Git' AND status = 'active'`,
    );
    const matched = rows[0]!.id;
    const created = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: 'Git 版本控制',
      tri: 'hit',
      matchedConceptId: matched,
    });
    expect(created.status).toBe('accepted');

    await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: 'Git 版本控制',
      tri: 'miss',
      signals: [{ stageId: '', sceneId: '', pageHash: null, quote: '后来又说没命中' }],
    });

    const stored = await db.query<{ status: string; tri: string; accepted_concept_id: string }>(
      `SELECT status, tri, accepted_concept_id FROM xq_intake_proposal WHERE id = $1`,
      [created.id],
    );
    expect(stored.rows[0]!.status).toBe('accepted');
    expect(stored.rows[0]!.tri).toBe('hit');
    expect(stored.rows[0]!.accepted_concept_id).toBe(matched);
  });

  it('★ F6/F7 交叉：被拒过的行后来真的命中了，也不自动接受 —— 拒绝优先，人得再拍一次', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM xq_concept WHERE canonical_name = 'Git' AND status = 'active'`,
    );
    const matched = rows[0]!.id;
    const first = await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '版本控制',
      tri: 'miss',
    });
    await rejectProposal(db, {
      proposalId: first.id,
      operator: 'owner',
      note: '当时觉得是另一件事',
    });

    await recordProposal(db, {
      externalSource: 'acm-graph',
      externalName: '版本控制',
      tri: 'hit',
      matchedConceptId: matched,
    });

    const stored = await db.query<{
      status: string;
      tri: string;
      matched_concept_id: string;
      accepted_concept_id: string | null;
      decided_by: string;
      decision_note: string;
    }>(
      `SELECT status, tri, matched_concept_id, accepted_concept_id, decided_by, decision_note
         FROM xq_intake_proposal WHERE id = $1`,
      [first.id],
    );
    const row = stored.rows[0]!;
    // 证据（tri / matched）更新了 —— 人下次能看到「它现在确实命中」。
    expect(row.tri).toBe('hit');
    expect(row.matched_concept_id).toBe(matched);
    // 但人的决定原封不动：还是 rejected、没有 accepted 目标、拒绝人还是 owner。
    expect(row.status).toBe('rejected');
    expect(row.accepted_concept_id).toBeNull();
    expect(row.decided_by).toBe('owner');
    expect(row.decision_note).toContain('另一件事');
  });
});

describe('promoteProposal', () => {
  it('★ 五步一个事务：概念进当前开放版、提案落定、页证据展开成出现记录', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedPages(db, [
      { sceneId: 'scene-p1', order: 1 },
      { sceneId: 'scene-p2', order: 2 },
      { sceneId: 'scene-p3', order: 3 },
    ]);
    const proposalId = (
      await recordProposal(db, {
        externalSource: 'acm-graph',
        externalName: '构造题',
        tri: 'miss',
        signals: [signal('scene-p1'), signal('scene-p2'), signal('scene-p3')],
      })
    ).id;
    const before = await counts(db);

    const result = await promoteProposal(withTx(db), {
      proposalId,
      operator: 'owner',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences).toBe(3);

    const concept = await db.query<{
      canonical_name: string;
      created_in: string;
      status: string;
      anchors: string[];
    }>(
      `SELECT canonical_name, created_in, status, anchors
          FROM xq_concept WHERE id = $1`,
      [result.conceptId],
    );
    const row = concept.rows[0]!;
    expect(row.canonical_name).toBe('构造题');
    expect(row.status).toBe('active');
    expect(Number(row.created_in)).toBe(1);
    expect(row.anchors).toEqual([]);

    const after = await counts(db);
    expect(after.concepts).toBe(before.concepts + 1);
    expect(after.occurrences).toBe(before.occurrences + 3);

    const occurrences = await db.query<{ source: string; weight: string }>(
      `SELECT source, weight FROM xq_concept_occurrence WHERE concept_id = $1
        ORDER BY scene_id`,
      [result.conceptId],
    );
    expect(occurrences.rows.map((r) => r.source)).toEqual([
      'foreign-body',
      'foreign-body',
      'foreign-body',
    ]);
    expect(occurrences.rows.map((r) => Number(r.weight))).toEqual([0.8, 0.8, 0.8]);
  });

  it('★ 页在库里不存在时跳过并如实报数 —— 外键不许把整条事务打崩', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedPages(db, [{ sceneId: 'scene-p1', order: 1 }]);
    const proposalId = (
      await recordProposal(db, {
        externalSource: 'acm-graph',
        externalName: '构造题',
        tri: 'miss',
        signals: [signal('scene-p1'), signal('scene-missing')],
      })
    ).id;
    const result = await promoteProposal(withTx(db), {
      proposalId,
      operator: 'owner',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences).toBe(1);
  });

  it('★ 同一页在证据里出现两次，只写一行 —— ON CONFLICT DO NOTHING 在这个事务里就生效', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedPages(db, [{ sceneId: 'scene-p1', order: 1 }]);
    const proposalId = (
      await recordProposal(db, {
        externalSource: 'acm-graph',
        externalName: '构造题',
        tri: 'miss',
        // 同一页重复出现：结果是 1 行，不是报错也不是 2 行。
        signals: [signal('scene-p1'), signal('scene-p1')],
      })
    ).id;
    const result = await promoteProposal(withTx(db), { proposalId, operator: 'owner' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrences).toBe(1);
    // ★ 那条 `DO NOTHING` 还挡着另一个方向：将来若有链路（比如外来回填）
    // 用**已有的** concept_id 来写同一页，我们 1.0 的证据不会被改写成 0.8。
    // 晋升本身每批都造新概念 id，所以在这一层到不了那种冲突。
    await db.query(
      `UPDATE xq_concept_occurrence SET weight = 1.0, source = 'keypoint'
        WHERE concept_id = $1`,
      [result.conceptId],
    );
    const kept = await db.query<{ weight: string; source: string }>(
      `SELECT weight, source FROM xq_concept_occurrence WHERE concept_id = $1`,
      [result.conceptId],
    );
    expect(Number(kept.rows[0]!.weight)).toBe(1);
    expect(kept.rows[0]!.source).toBe('keypoint');
  });

  it('★ 外来先修边只准 proposed —— 批概念不等于批边', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const git = (
      await db.query<{ id: string }>(`SELECT id FROM xq_concept WHERE canonical_name = 'Git'`)
    ).rows[0]!.id;
    // ★ 名字不能取种子图里已有的（`合并与冲突` 就在里面）—— 那会先撞
    // `name-taken`，测不到边这一层。
    const proposalId = (
      await recordProposal(db, {
        externalSource: 'acm-graph',
        externalName: '合并冲突的判定',
        tri: 'miss',
      })
    ).id;
    const result = await promoteProposal(withTx(db), {
      proposalId,
      operator: 'owner',
      prereqEdges: [
        {
          fromId: git,
          strength: 'recommended',
          reason: '外部图说先会 Git 再谈合并冲突',
          source: 'acm-graph',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edges).toBe(1);
    const edge = await db.query<{ status: string; created_in: string }>(
      `SELECT status, created_in FROM xq_concept_edge
        WHERE from_id = $1 AND to_id = $2 AND relation = 'prereq'`,
      [git, result.conceptId],
    );
    expect(edge.rows[0]!.status).toBe('proposed');
    expect(Number(edge.rows[0]!.created_in)).toBe(1);
  });

  it('★ 同名正式概念已存在时拒收 —— 不许插出第二个同名 active', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const proposalId = (
      await recordProposal(db, {
        externalSource: 'acm-graph',
        externalName: 'Git',
        tri: 'miss',
      })
    ).id;
    const result = await promoteProposal(withTx(db), {
      proposalId,
      operator: 'owner',
    });
    expect(result).toMatchObject({ ok: false, reason: 'name-taken' });
    const live = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM xq_concept
        WHERE canonical_name = 'Git' AND status = 'active'`,
    );
    expect(Number(live.rows[0]!.n)).toBe(1);
  });

  it('不存在的提案 / 已决的提案 / 空 operator 各自回不同的原因', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    expect(await promoteProposal(withTx(db), { proposalId: 9999, operator: 'o' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    const proposalId = (
      await recordProposal(db, {
        externalSource: 'x',
        externalName: '构造题',
        tri: 'miss',
      })
    ).id;
    await rejectProposal(db, { proposalId, operator: 'o' });
    expect(await promoteProposal(withTx(db), { proposalId, operator: 'o' })).toMatchObject({
      ok: false,
      reason: 'not-proposed',
      detail: 'rejected',
    });
    expect(await promoteProposal(withTx(db), { proposalId, operator: '  ' })).toEqual({
      ok: false,
      reason: 'operator-missing',
    });
  });

  it('★ 没有开放版本时拒收 —— created_in 不能凭空写一个不存在的版本', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const proposalId = (
      await recordProposal(db, {
        externalSource: 'x',
        externalName: '构造题',
        tri: 'miss',
      })
    ).id;
    await db.query(`UPDATE xq_graph_version SET frozen_at = now() WHERE version = 1`);
    expect(await promoteProposal(withTx(db), { proposalId, operator: 'o' })).toEqual({
      ok: false,
      reason: 'no-open-version',
    });
  });

  it('★ 中途失败整条回滚 —— 概念、提案状态、出现记录一样都不许留下半截', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    await seedPages(db, [{ sceneId: 'scene-p1', order: 1 }]);
    const proposalId = (
      await recordProposal(db, {
        externalSource: 'x',
        externalName: '构造题',
        tri: 'miss',
        signals: [signal('scene-p1')],
      })
    ).id;
    const before = await counts(db);

    // 第 ⑤ 步之后、第 ⑧ 步炸：`from_id` 指向一个不存在的概念，
    // `xq_concept_edge` 的外键会拒。此时概念已经插进去了、提案已经落定了、
    // 出现记录也写了 —— 全靠事务把它们一起收回去。
    await expect(
      promoteProposal(withTx(db), {
        proposalId,
        operator: 'o',
        prereqEdges: [
          {
            fromId: 'c_000000000000',
            strength: 'recommended',
            reason: '这条边的起点根本不存在',
            source: 'acm-graph',
          },
        ],
      }),
    ).rejects.toThrow(/foreign key|violates/i);

    const after = await counts(db);
    expect(after.concepts).toBe(before.concepts);
    expect(after.occurrences).toBe(before.occurrences);
    const stored = await db.query<{ status: string; accepted_concept_id: string | null }>(
      `SELECT status, accepted_concept_id FROM xq_intake_proposal WHERE id = $1`,
      [proposalId],
    );
    expect(stored.rows[0]!.status).toBe('proposed');
    expect(stored.rows[0]!.accepted_concept_id).toBeNull();
  });

  it('★ F5：外来名是某个活跃概念的**别名**时同样拒收，detail 报出概念名', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    // 从种子图里挑一个真实别名：它必须不是任何活跃概念的规范名，否则
    // 命中的是「同名」那条分支，钉不到别名这条。
    const { rows } = await db.query<{ alias: string; canonical_name: string; id: string }>(
      `SELECT a.alias, c.canonical_name, c.id
         FROM xq_concept_alias a
         JOIN xq_concept c ON c.id = a.concept_id
        WHERE c.status = 'active' AND a.ambiguous = false
          AND NOT EXISTS (SELECT 1 FROM xq_concept x
                           WHERE x.canonical_name = a.alias AND x.status = 'active')
        ORDER BY length(a.alias) DESC, a.alias
        LIMIT 1`,
    );
    const aliased = rows[0]!;
    expect(aliased).toBeTruthy();
    const before = await counts(db);

    const proposalId = (
      await recordProposal(db, {
        externalSource: 'acm-graph',
        externalName: aliased.alias,
        tri: 'miss',
      })
    ).id;
    const result = await promoteProposal(withTx(db), { proposalId, operator: 'owner' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('name-taken');
    expect(result.detail).toContain(aliased.canonical_name);
    expect(result.detail).toContain('别名');
    // 关键后果：概念表一行都不许多。旧实现会插出一个以别名当规范名的第二
    // 概念，而那之后每次按名字匹配这条别名都会变成 lexical-ambiguous。
    expect((await counts(db)).concepts).toBe(before.concepts);
  });

  it('★ F5：一个别名指向多个活跃概念时拒收，detail 列出全部候选', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, anchors, status, created_in) VALUES
         ('c_000000000001', '甲概念', 'concept', '{}'::text[], 'active', 1),
         ('c_000000000002', '乙概念', 'concept', '{}'::text[], 'active', 1)`,
    );
    await db.query(
      `INSERT INTO xq_concept_alias (alias, kind, concept_id, source, ambiguous) VALUES
         ('双指词', 'concept', 'c_000000000001', 'test', true),
         ('双指词', 'concept', 'c_000000000002', 'test', true)`,
    );
    const proposalId = (
      await recordProposal(db, { externalSource: 'x', externalName: '双指词', tri: 'miss' })
    ).id;
    const result = await promoteProposal(withTx(db), { proposalId, operator: 'owner' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('name-taken');
    // 两个概念名都要在 —— 归并到哪个不是脚本能决定的，摆给人看。
    expect(result.detail).toContain('甲概念');
    expect(result.detail).toContain('乙概念');
    expect(result.detail).toContain('2 个');
  });

  it('★ F5：退役的同名概念不挡路 —— 重新引入一个退役的名字是合法动作', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, anchors, status, created_in)
       VALUES ('c_000000000009', '退役词', 'concept', '{}'::text[], 'retired', 1)`,
    );
    const proposalId = (
      await recordProposal(db, { externalSource: 'x', externalName: '退役词', tri: 'miss' })
    ).id;
    const result = await promoteProposal(withTx(db), { proposalId, operator: 'owner' });
    expect(result.ok).toBe(true);
    const live = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM xq_concept
        WHERE canonical_name = '退役词' AND status = 'active'`,
    );
    expect(Number(live.rows[0]!.n)).toBe(1);
  });

  it('★ F5+V7：判重被绕过时撞唯一索引也回 name-taken，不抛 500', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    // 造一个「规范名、且不是任何别名」的概念：否则判重会先在别名那条分支
    // 拒收，根本走不到 INSERT，钉不到索引。
    const clashName = '独名甲';
    await db.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, anchors, status, created_in)
       VALUES ('c_000000000010', $1, 'concept', '{}'::text[], 'active', 1)`,
      [clashName],
    );
    const proposalId = (
      await recordProposal(db, { externalSource: 'x', externalName: clashName, tri: 'miss' })
    ).id;
    const before = await counts(db);

    // 模拟「判重查完、插入之前，并发请求先建了同名概念」：让规范名那一次
    // 查询看不见已有的 Git（真实 PG 里两个未提交的事务正是这样互相看不见），
    // 于是插入只能撞 V7 的部分唯一索引。
    const racingTx = (async (body: (q: unknown) => Promise<unknown>) =>
      db.transaction(async (tx) => {
        const query = async (sql: string, params?: unknown[]) => {
          if (/FROM xq_concept\s/.test(sql) && sql.includes('canonical_name = $1')) {
            return { rows: [] };
          }
          return tx.query(sql, params as never);
        };
        return body({ query });
      })) as never;

    const result = await promoteProposal(racingTx as never, {
      proposalId,
      operator: 'owner',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('name-taken');
    expect(result.detail).toContain('xq_concept_active_name_key');
    expect((await counts(db)).concepts).toBe(before.concepts);
  });

  it("★ F10a：无页的文字证据晋升时不写出现记录 —— 不许出现 stage_id='' 的行", async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const proposalId = (
      await recordProposal(db, {
        externalSource: 'probe:test',
        externalName: '构造',
        tri: 'miss',
        signals: [{ stageId: '', sceneId: '', pageHash: null, quote: '构造 → 构造方法' }],
      })
    ).id;
    const result = await promoteProposal(withTx(db), { proposalId, operator: 'owner' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.occurrences).toBe(0);
    const stray = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM xq_concept_occurrence
        WHERE stage_id = '' OR scene_id = ''`,
    );
    expect(Number(stray.rows[0]!.n)).toBe(0);
  });
});

describe('readProposals', () => {
  it('默认只读待裁队列 —— 已经裁过的不在队列里', async () => {
    const db = await freshDb();
    await seedConcepts(db);
    const loose = await recordProposal(db, {
      externalSource: 'x',
      externalName: '构造',
      tri: 'miss',
    });
    await recordProposal(db, { externalSource: 'x', externalName: '排序', tri: 'suspect' });
    await rejectProposal(db, { proposalId: loose.id, operator: 'o' });
    const queue = await readProposals(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.externalName).toBe('排序');
    const all = await readProposals(db, { status: 'rejected' });
    expect(all.map((p) => p.externalName)).toEqual(['构造']);
  });

  it('可以按 tri 筛；limit 非正回空而不是回全部', async () => {
    const db = await freshDb();
    await recordProposal(db, { externalSource: 'x', externalName: '构造', tri: 'miss' });
    await recordProposal(db, { externalSource: 'x', externalName: '排序', tri: 'suspect' });
    expect((await readProposals(db, { tri: 'miss' })).map((p) => p.externalName)).toEqual(['构造']);
    expect(await readProposals(db, { limit: 0 })).toEqual([]);
    expect(await readProposals(db, { limit: -3 })).toEqual([]);
  });

  it('页证据读得回来（人裁决时唯一能看的东西）', async () => {
    const db = await freshDb();
    const created = await recordProposal(db, {
      externalSource: 'x',
      externalName: '构造',
      tri: 'miss',
      signals: [{ ...signal('scene-p1', 'a'.repeat(64)), anchorsHit: ['构造题'] }],
    });
    const [row] = await readProposals(db);
    expect(row!.id).toBe(created.id);
    expect(row!.signals).toHaveLength(1);
    expect(row!.signals[0]!.sceneId).toBe('scene-p1');
    expect(row!.signals[0]!.pageHash).toHaveLength(64);
    expect(row!.signals[0]!.anchorsHit).toEqual(['构造题']);
  });

  it('★ F10a：只有名字没有页的 quote 证据必须保留 —— --enqueue 写的就是这种', async () => {
    const db = await freshDb();
    const created = await recordProposal(db, {
      externalSource: 'probe:test',
      externalName: '版本控制',
      tri: 'suspect',
      signals: [
        {
          stageId: '',
          sceneId: '',
          pageHash: null,
          quote: '版本控制 → Git',
          anchorsHit: ['版本控制'],
        },
      ],
    });
    const [row] = await readProposals(db);
    expect(row!.id).toBe(created.id);
    // 旧实现无条件要求页，结果 CLI 写进来的 quote 100% 被吃掉，裁决台只看到
    // 「0 页证据」—— 人根本没有可裁决的原文。
    expect(row!.signals).toHaveLength(1);
    expect(row!.signals[0]!.quote).toBe('版本控制 → Git');
    expect(row!.signals[0]!.stageId).toBe('');
    expect(row!.signals[0]!.sceneId).toBe('');
    expect(row!.signals[0]!.anchorsHit).toEqual(['版本控制']);
  });

  it('★ F10a：带 pageHash 却没有页的证据丢掉 —— 它没有页可落', async () => {
    const db = await freshDb();
    await recordProposal(db, {
      externalSource: 'x',
      externalName: '构造',
      tri: 'miss',
      signals: [
        { stageId: '', sceneId: '', pageHash: 'a'.repeat(64), quote: '有指纹没页' },
        // 只有 stage、没有 scene、也没有 pageHash 的纯文字证据**不丢**（F10a
        // 的判决只要求「需要页定位」的那种有页），所以它留成一条无页证据。
        { stageId: STAGE, sceneId: '', pageHash: null, quote: '只有 stage 没 page' },
      ],
    });
    const [row] = await readProposals(db);
    expect(row!.signals).toHaveLength(1);
    expect(row!.signals[0]!.quote).toBe('只有 stage 没 page');
  });

  it('★ F10a：空壳（没页、没 quote、没锚词）丢掉；纯锚词留下', async () => {
    const db = await freshDb();
    await recordProposal(db, {
      externalSource: 'x',
      externalName: '构造',
      tri: 'miss',
      signals: [
        { stageId: '', sceneId: '', pageHash: null, quote: '', anchorsHit: [] },
        { stageId: '', sceneId: '', pageHash: null, quote: '', anchorsHit: ['构造方法'] },
      ],
    });
    const [row] = await readProposals(db);
    expect(row!.signals).toHaveLength(1);
    expect(row!.signals[0]!.anchorsHit).toEqual(['构造方法']);
  });
});
