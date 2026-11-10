/**
 * 提案的**写入与裁决**：三段匹配判完之后，结果落在哪里；人批一次之后，库里发生什么。
 *
 * ## 为什么提案是另一张表，而不是概念的一种 status
 *
 * `xq_concept.status` 只有 `active` / `merged` / `retired` 三档，它们说的都是
 * 「这个概念**曾经**是什么」。而提案说的是「有人说图里该有这个词」——
 * 它**从来不是**概念，没有 `c_` 开头的 id，`id` 是 `bigserial`。
 *
 * 这个区别不是洁癖。混进去之后，「按概念统计覆盖率」「按概念排学习顺序」
 * 这些查询会天然把未确认的词算进去，而调用方**看不出**哪一行是待裁的
 * （`status='active'` 的孤儿概念看起来一模一样）。分成两张表，提案在**结构上**
 * 不可能出现在那些结果集里 —— 这比「记得过滤 status」强一档。
 *
 * ## 为什么晋升必须是显式动作（且只能有一种走法）
 *
 * 三段匹配器判出的 `hit` 可以自动归并 —— 那个概念我们已经有了，加一条出现
 * 记录不改变图谱的形状。`suspect` 与 `miss` 不行：它们要么同形异义、要么真新，
 * 机器分不出，只有人能分。自动建概念的错误模式很安静：图谱多出几个节点，
 * 学习顺序从第一页就排错，而没有任何一步报错。
 *
 * 所以这里只有两条路：`promoteProposal()`（人批了，建概念）与
 * `rejectProposal()`（人拒了，留痕）。**没有** `autoAccept()`。
 *
 * ## 为什么晋升是五步一个事务（而不是五条独立语句）
 *
 * 五步里任何一步失败，剩下的都必须不生效 —— 尤其是第 2 步（提案落定）与
 * 第 3 步（页证据展开成出现记录）之间：如果提案已经 `accepted` 而出现记录没写成，
 * 库里就有「一个已确认的新概念，但它没有任何一页在讲」，而这种孤儿概念
 * 与「合法的待覆盖概念」长得一模一样，事后无法区分。
 *
 * 因此调用方**必须**给 `withTransaction`。不给就抛 —— 不做「退化成串行执行」
 * 那种宽容，那会让一次失败留下半截状态，而半截状态比没做更糟。
 *
 * ## 为什么第 3 步是 `DO NOTHING` 而不是 `DO UPDATE`
 *
 * 晋升要写的权重是外来侧的上限 0.80。若那一页我们已经自己抽过同一个概念
 * （`weight` 可能是 1.0 的 keyPoint），覆盖会把更强的证据降成更弱的。
 * 宁可少写一条：出现记录是「这一页讲到它」的证据，不是「谁最后写的」。
 *
 * ## 为什么第 5 步的边只准 `proposed`
 *
 * 批概念 ≠ 批边。外部图带来的先修关系是**另一个断言**：它说「A 应该在 B 之前」，
 * 而人对提案的那一次点击只针对「这个词指的是不是这个概念」。把边跟着
 * 一起激活，等于用一个决定批准了两个不同的问题。
 */
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import { newConceptId } from '@/lib/concepts';

/** 三段判定的取值 —— 与 `xq_three_way_match.ts` 的 `MatchTri` 逐字一致。 */
export const PROPOSAL_TRI = ['hit', 'suspect', 'miss'] as const;
export type ProposalTri = (typeof PROPOSAL_TRI)[number];

export const PROPOSAL_STATUSES = ['proposed', 'accepted', 'rejected'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * `hit` 段自动归并时写进 `decided_by` 的名字。
 *
 * ★ 它不是某个人的 id，而是一句「这是三段匹配自动判的」。写成一个像人名的
 * 字符串（`'system'`）会让「谁批的」这个问题永远查不清 —— 而那条记录的全部
 * 意义就是「这一次没有人参与」。
 */
export const AUTO_HIT_DECIDER = 'auto:three-way-hit';

/** 一条页证据。`signals` 这个 jsonb 数组的元素形状。 */
export interface ProposalSignal {
  stageId: string;
  sceneId: string;
  /** 那一页的指纹；晋升时原样抄进出现记录。 */
  pageHash?: string | null;
  /** 外来侧给出的原文片段（人裁决时唯一能看的东西）。 */
  quote?: string;
  /** 那一刻命中的义项锚词，用于事后解释「凭什么」。 */
  anchorsHit?: readonly string[];
}

export interface RecordProposalInput {
  externalSource: string;
  externalName: string;
  externalKind?: string;
  tri: ProposalTri;
  /** `tri='hit'` 时必填 —— 库里那条 CHECK 会拦半截行。 */
  matchedConceptId?: string | null;
  confidence?: number | null;
  signals?: readonly ProposalSignal[];
  taskId?: string | null;
}

export interface RecordProposalResult {
  id: number;
  status: ProposalStatus;
  /** 这次调用是新建还是撞上了既有行。 */
  created: boolean;
  /** 撞上既有行时它当下的状态 —— `rejected` 说明人拒过，不该再进待裁队列。 */
  seenCount: number;
}

export interface ProposalRow {
  id: number;
  externalSource: string;
  externalName: string;
  externalKind: string;
  tri: ProposalTri;
  status: ProposalStatus;
  matchedConceptId: string | null;
  acceptedConceptId: string | null;
  confidence: number | null;
  signals: readonly ProposalSignal[];
  seenCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

/**
 * 写一条提案（幂等：同一 `(external_source, external_name, external_kind)` 只有一行）。
 *
 * 再来一次时只涨 `seen_count` 与 `last_seen_at`，**判定结果只在它仍 `proposed` 时更新** ——
 * 人已经批过或拒过的那一行不许被一次新的导入改写。这正是「拒绝之后不再问」
 * 能成立的地方：行还在，`status='rejected'`，下次导入只会让 `seen_count` 加一。
 */
export async function recordProposal(
  queryable: Queryable,
  input: RecordProposalInput,
): Promise<RecordProposalResult> {
  const externalName = input.externalName.trim();
  if (externalName === '') throw new RangeError('xq: proposal needs an external name');
  const externalSource = input.externalSource.trim();
  if (externalSource === '') throw new RangeError('xq: proposal needs an external source');
  if (input.tri === 'hit' && (input.matchedConceptId ?? '') === '') {
    throw new RangeError('xq: a hit proposal needs the concept it matched');
  }

  const decided = input.tri === 'hit';
  const { rows } = await queryable.query<{
    id: string | number;
    status: string;
    seen_count: string | number;
    created: boolean;
  }>(RECORD_PROPOSAL_SQL, [
    input.taskId ?? null,
    externalName,
    externalSource,
    input.externalKind ?? 'concept',
    input.tri,
    input.matchedConceptId ?? null,
    input.confidence ?? null,
    JSON.stringify(input.signals ?? []),
    decided ? 'accepted' : 'proposed',
    decided ? AUTO_HIT_DECIDER : null,
    // `hit` 段把 `accepted_concept_id` 也写上：那条 CHECK 要求
    // `status='accepted'` 时它非空，而「归并到既有概念」就是这个提案的结局。
    decided ? (input.matchedConceptId ?? null) : null,
  ]);
  const row = rows[0];
  if (!row) throw new Error('xq: recordProposal wrote nothing');
  return {
    id: Number(row.id),
    status: asStatus(row.status),
    seenCount: Number(row.seen_count),
    created: row.created === true,
  };
}

const RECORD_PROPOSAL_SQL = `
INSERT INTO xq_intake_proposal (
  task_id, external_name, external_source, external_kind, tri,
  matched_concept_id, confidence, signals,
  status, decided_by, decided_at, accepted_concept_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb,
        $9, $10::text, CASE WHEN $10::text IS NULL THEN NULL ELSE now() END, $11)
ON CONFLICT (external_source, external_name, external_kind) DO UPDATE SET
  seen_count = xq_intake_proposal.seen_count + 1,
  last_seen_at = now(),
  tri = CASE WHEN xq_intake_proposal.status = 'proposed'
             THEN EXCLUDED.tri ELSE xq_intake_proposal.tri END,
  matched_concept_id = CASE WHEN xq_intake_proposal.status = 'proposed'
             THEN EXCLUDED.matched_concept_id ELSE xq_intake_proposal.matched_concept_id END,
  confidence = CASE WHEN xq_intake_proposal.status = 'proposed'
             THEN EXCLUDED.confidence ELSE xq_intake_proposal.confidence END,
  signals = CASE WHEN xq_intake_proposal.status = 'proposed'
             THEN EXCLUDED.signals ELSE xq_intake_proposal.signals END
RETURNING id, status, seen_count, (xmax = 0) AS created`;

export interface PromoteProposalInput {
  proposalId: number;
  /** 谁批的。不许空 —— 「批了」这件事的三个必填之一。 */
  operator: string;
  /**
   * 新概念要不要带义项锚。今天锚是从我们自己的页算出来的，外来概念一个都没有
   * 页可算，所以通常留空；留空意味着它走「只靠字面 ⇒ 存疑」那条分支的**反面**：
   * 它是一个已被确认的概念，只是没有专属上下文。
   */
  anchors?: readonly string[];
  /** 页证据归属哪一批导入。 */
  batchId?: string | null;
  /** 同批同义的其它提案一并指向新概念（J §4.3 第 4 步）。 */
  sameBatchAliases?: readonly number[];
  /** 外部图带来的先修边。**只准 `proposed`**（见文件头最后一节）。 */
  prereqEdges?: readonly {
    fromId: string;
    reason: string;
    strength: 'strict' | 'recommended' | 'helpful';
    source: string;
  }[];
}

export type PromoteFailure =
  | 'not-found'
  | 'not-proposed'
  | 'no-open-version'
  | 'name-taken'
  | 'operator-missing';

export type PromoteProposalResult =
  | { ok: true; conceptId: string; occurrences: number; edges: number }
  | { ok: false; reason: PromoteFailure; detail?: string };

/**
 * 晋升：五步一个事务（J §4.3）。**必须**给 `withTransaction`。
 *
 * 顺序不能换：
 * 1. 插概念（拿到新 id）
 * 2. 提案落定 —— 带 `status='proposed'` 守卫，两个管理员同时点只有一个成功
 * 3. `signals` 展开成出现记录（`DO NOTHING`，不覆盖我们自己抽的更高权重）
 * 4. 同批同义提案一并指向
 * 5. 外来先修边落成 `status='proposed'`
 *
 * 第 2 步的行数为 0 就是「别人先批了」，整条回滚并回 `not-proposed` —— 不做
 * 「再插一个概念」那种补救，那会造出两个同义概念，而它们事后只能靠人工归并。
 */
export async function promoteProposal(
  transaction: WithTransaction,
  input: PromoteProposalInput,
): Promise<PromoteProposalResult> {
  const operator = input.operator.trim();
  if (operator === '') return { ok: false, reason: 'operator-missing' };

  return transaction(async (tx) => {
    const version = await openVersionOf(tx);
    if (version === null) return { ok: false, reason: 'no-open-version' };

    const target = await tx.query<{ external_name: string; status: string }>(
      `SELECT external_name, status FROM xq_intake_proposal WHERE id = $1`,
      [input.proposalId],
    );
    const row = target.rows[0];
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.status !== 'proposed') {
      return { ok: false, reason: 'not-proposed', detail: row.status };
    }

    // 同名的正式概念已经存在时不许再插一个。`xq_concept` 没有名字唯一约束
    // （同形异义是合法的：一个名字可以指两个概念，靠别名表的 `ambiguous` 记录），
    // 所以这里只能显式查一次 —— 而恰恰因为库里允许，漏查的后果是两行同名
    // `active` 概念，之后每次「按名字找概念」都变成二选一。
    const clash = await tx.query<{ id: string }>(
      `SELECT id FROM xq_concept WHERE canonical_name = $1 AND status = 'active' LIMIT 1`,
      [row.external_name],
    );
    if (clash.rows[0]) {
      return { ok: false, reason: 'name-taken', detail: clash.rows[0].id };
    }

    const conceptId = newConceptId();
    await tx.query(
      `INSERT INTO xq_concept (id, canonical_name, kind, anchors, status, created_in)
       VALUES ($1, $2, 'concept', $3::text[], 'active', $4)`,
      [conceptId, row.external_name, [...(input.anchors ?? [])], version],
    );

    const settled = await tx.query<{ id: string }>(
      `UPDATE xq_intake_proposal
          SET status = 'accepted', accepted_concept_id = $2,
              decided_at = now(), decided_by = $3
        WHERE id = $1 AND status = 'proposed'
        RETURNING id`,
      [input.proposalId, conceptId, operator],
    );
    if (settled.rows.length !== 1) {
      // 事务回滚，插进去的概念一起消失。
      throw new PromotionRaceError(input.proposalId);
    }

    const occurrences = await tx.query<{ n: string | number }>(EXPAND_SIGNALS_SQL, [
      conceptId,
      input.proposalId,
      input.batchId ?? null,
    ]);

    if (input.sameBatchAliases && input.sameBatchAliases.length > 0) {
      await tx.query(
        `UPDATE xq_intake_proposal
            SET status = 'accepted', accepted_concept_id = $2,
                decided_at = now(), decided_by = $3
          WHERE id = ANY($1::bigint[]) AND status = 'proposed'`,
        [[...input.sameBatchAliases], conceptId, operator],
      );
    }

    let edges = 0;
    for (const edge of input.prereqEdges ?? []) {
      const inserted = await tx.query<{ id: string }>(INSERT_PROPOSED_EDGE_SQL, [
        edge.fromId,
        conceptId,
        edge.strength,
        edge.reason,
        edge.source,
        version,
      ]);
      edges += inserted.rows.length;
    }

    return {
      ok: true as const,
      conceptId,
      occurrences: Number(occurrences.rows[0]?.n ?? 0),
      edges,
    };
  });
}

/** 第 2 步守卫失败（别人先批了）时抛出，好让整条事务回滚。 */
export class PromotionRaceError extends Error {
  constructor(readonly proposalId: number) {
    super(`xq: proposal ${proposalId} was decided by someone else`);
    this.name = 'PromotionRaceError';
  }
}

/**
 * 把 `signals` 里的页证据展开成出现记录。
 *
 * ★ 只写**页真的存在**的那些行：`xq_concept_occurrence` 有一条复合外键指回
 * `document_scenes`，而外来名单常常来自另一门课 —— 那门课还没导进来时，
 * 证据指向的页在库里不存在。让整个事务因为一条外键失败，等于「因为一门外来课
 * 还没导，连概念都不许建」；而静默插进去会直接报 23503。所以这里用 `WHERE EXISTS`
 * 过滤，并把实际写进去的条数报出来 —— 少几条是可以解释的，报不出来才是问题。
 *
 * ★ `ON CONFLICT DO NOTHING` 而不是 `DO UPDATE`：见文件头。
 */
const EXPAND_SIGNALS_SQL = `
WITH src AS (
  SELECT (s->>'stageId') AS stage_id,
         (s->>'sceneId') AS scene_id,
         NULLIF(s->>'pageHash', '') AS page_hash
    FROM xq_intake_proposal p,
         jsonb_array_elements(p.signals) AS s
   WHERE p.id = $2
),
touched AS (
  INSERT INTO xq_concept_occurrence
    (concept_id, stage_id, scene_id, weight, source, batch_id, page_hash,
     first_seen_at, last_seen_at)
  SELECT $1, src.stage_id, src.scene_id, 0.80, 'foreign-body', $3, src.page_hash,
         now(), now()
    FROM src
   WHERE src.stage_id IS NOT NULL AND src.scene_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM document_scenes d
                  WHERE d.stage_id = src.stage_id AND d.id = src.scene_id)
  ON CONFLICT (concept_id, stage_id, scene_id) DO NOTHING
  RETURNING 1
)
SELECT count(*)::text AS n FROM touched`;

const INSERT_PROPOSED_EDGE_SQL = `
INSERT INTO xq_concept_edge
  (from_id, to_id, relation, strength, reason, source, status, created_in)
VALUES ($1, $2, 'prereq', $3, $4, $5, 'proposed', $6)
ON CONFLICT (from_id, to_id, relation) DO NOTHING
RETURNING from_id`;

/** 拒绝：留痕、不删行、`signals` 保留（J §4.4）。 */
export async function rejectProposal(
  queryable: Queryable,
  input: { proposalId: number; operator: string; note?: string },
): Promise<{ ok: boolean; reason?: 'not-found' | 'not-proposed' | 'operator-missing' }> {
  const operator = input.operator.trim();
  if (operator === '') return { ok: false, reason: 'operator-missing' };
  const { rows } = await queryable.query<{ id: string }>(
    `UPDATE xq_intake_proposal
        SET status = 'rejected', decided_at = now(), decided_by = $2,
            decision_note = $3
      WHERE id = $1 AND status = 'proposed'
      RETURNING id`,
    [input.proposalId, operator, input.note ?? null],
  );
  if (rows.length === 1) return { ok: true };
  const existing = await queryable.query<{ status: string }>(
    `SELECT status FROM xq_intake_proposal WHERE id = $1`,
    [input.proposalId],
  );
  return {
    ok: false,
    reason: existing.rows[0] ? 'not-proposed' : 'not-found',
  };
}

export interface ReadProposalsOptions {
  status?: ProposalStatus;
  tri?: ProposalTri;
  limit?: number;
}

export const PROPOSAL_READ_LIMIT = 100;

/**
 * 读提案。默认只读 `proposed` —— 队列的意义是「还没裁的」，把已决的一起列出来
 * 会让它看起来永远清不完。要全量得显式给 `status`。
 */
export async function readProposals(
  queryable: Queryable,
  options: ReadProposalsOptions = {},
): Promise<ProposalRow[]> {
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(Math.trunc(options.limit as number), PROPOSAL_READ_LIMIT))
    : PROPOSAL_READ_LIMIT;
  if (limit === 0) return [];
  const { rows } = await queryable.query<Record<string, unknown>>(
    `SELECT id, external_source, external_name, external_kind, tri, status,
            matched_concept_id, accepted_concept_id, confidence, signals,
            seen_count, first_seen_at, last_seen_at, decided_at, decided_by,
            decision_note
       FROM xq_intake_proposal
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR tri = $2)
      ORDER BY last_seen_at DESC, id
      LIMIT $3`,
    [options.status ?? 'proposed', options.tri ?? null, limit],
  );
  return rows.map(asProposal).filter((row): row is ProposalRow => row !== null);
}

async function openVersionOf(queryable: Queryable): Promise<number | null> {
  const { rows } = await queryable.query<{ version: string | number }>(
    `SELECT version FROM xq_graph_version WHERE frozen_at IS NULL
      ORDER BY version DESC LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  const version = Number(row.version);
  return Number.isFinite(version) && version > 0 ? version : null;
}

function asStatus(value: unknown): ProposalStatus {
  return PROPOSAL_STATUSES.includes(value as ProposalStatus)
    ? (value as ProposalStatus)
    : 'proposed';
}

function asProposal(row: Record<string, unknown>): ProposalRow | null {
  const id = Number(row.id);
  if (!Number.isFinite(id)) return null;
  const name = typeof row.external_name === 'string' ? row.external_name : '';
  if (name === '') return null;
  return {
    id,
    externalSource: asText(row.external_source),
    externalName: name,
    externalKind: asText(row.external_kind) || 'concept',
    tri: PROPOSAL_TRI.includes(row.tri as ProposalTri) ? (row.tri as ProposalTri) : 'suspect',
    status: asStatus(row.status),
    matchedConceptId: asText(row.matched_concept_id) || null,
    acceptedConceptId: asText(row.accepted_concept_id) || null,
    confidence:
      row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    signals: asSignals(row.signals),
    seenCount: Number(row.seen_count ?? 1),
    firstSeenAt: asDate(row.first_seen_at) ?? new Date(0),
    lastSeenAt: asDate(row.last_seen_at) ?? new Date(0),
    decidedAt: asDate(row.decided_at),
    decidedBy: asText(row.decided_by) || null,
    decisionNote: asText(row.decision_note) || null,
  };
}

function asSignals(value: unknown): ProposalSignal[] {
  if (!Array.isArray(value)) return [];
  const out: ProposalSignal[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const stageId = asText(record.stageId ?? record.stage_id);
    const sceneId = asText(record.sceneId ?? record.scene_id);
    if (stageId === '' || sceneId === '') continue;
    const anchorsHit = Array.isArray(record.anchorsHit ?? record.anchors_hit)
      ? ((record.anchorsHit ?? record.anchors_hit) as unknown[])
      : [];
    out.push({
      stageId,
      sceneId,
      pageHash: asText(record.pageHash ?? record.page_hash) || null,
      quote: asText(record.quote),
      anchorsHit: anchorsHit.filter((w): w is string => typeof w === 'string'),
    });
  }
  return out;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
