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

/**
 * 一条页证据。`signals` 这个 jsonb 数组的元素形状。
 *
 * ★ `stageId` / `sceneId` 允许是**空串**：外来清单里常常只有名字、没有页
 *   （`scripts/match-external-names.ts --enqueue` 就是这种），此时只有
 *   `quote` / `anchorsHit` 是证据本体。带 `pageHash` 的才必须有页
 *   （见 `asSignals`，F10a）。
 */
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
 * ## 一行被重新看到时，哪些列会变、哪些列永不自动变
 *
 * 判决：**拒绝只冻结「人的决定」，不冻结「证据」**（F7）。
 *
 * - `status / decided_at / decided_by / decision_note`：**永不**被导入改写。
 *   人说过「不收」，那就只有人在裁决台再拍一次才能改回来 —— 一次新的导入
 *   不是人。
 * - `tri / matched_concept_id / confidence / signals`：只要这一行还没被
 *   **接受**就继续更新。拒绝之后证据还会变（上次是 `miss`，这次三段匹配
 *   命中了），人下次打开裁决台应该看到**最新的**证据，而不是被冻结在
 *   拒绝那一刻的旧结论。
 * - `seen_count / last_seen_at`：恒更新（「又见过一次」本身就是事实）。
 *
 * ★ `rejected` 的行即使新证据是 `hit` 也**不**被自动接受：人的拒绝优先，
 *   自动接受只对仍 `proposed` 的行生效（F6 第 2 条）。
 *
 * 为什么 `accepted` 的行连证据也不改：那一行已经归并到某个概念，
 * `accepted_concept_id` 是**那一次归并**的凭据。若允许后来的 `suspect` 把
 * `tri` 改掉，库里就会出现「已接受、但匹配概念为空」的怪行，而它看起来
 * 与「人工接受了一条 miss 提案」一模一样，事后分不出哪条是坏数据。
 *
 * ## 为什么 `hit` 会把一条 `proposed` 行直接落成 `accepted`（F6）
 *
 * 三段匹配判 `hit` 就是「这个概念我们已经有了」。旧实现只改 `tri` / 不改
 * `status`，于是行变成「`tri='hit'`、`matched_concept_id` 有值、`status` 仍是
 * `proposed`」；人再点「接受」时走 `promoteProposal` 建新概念，而它自己刚
 * 判定「已存在」—— 库里多一个重复概念。所以这里对**仍 `proposed`** 的行
 * 就地落定：`status='accepted'`、`accepted_concept_id = matched_concept_id`、
 * `decided_by='auto:three-way-hit'`。
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

  -- 证据四列：还没「接受」的行都继续更新（F7 的关键判决 —— 拒绝冻结的是
  -- 人的决定，不是证据）。DO UPDATE 里的 xq_intake_proposal.status 读的
  -- 是**旧行**，所以下面四条与 status 的 CASE 互不看彼此的新值。
  tri = CASE WHEN xq_intake_proposal.status IN ('proposed', 'rejected')
             THEN EXCLUDED.tri ELSE xq_intake_proposal.tri END,
  matched_concept_id = CASE WHEN xq_intake_proposal.status IN ('proposed', 'rejected')
             THEN EXCLUDED.matched_concept_id ELSE xq_intake_proposal.matched_concept_id END,
  confidence = CASE WHEN xq_intake_proposal.status IN ('proposed', 'rejected')
             THEN EXCLUDED.confidence ELSE xq_intake_proposal.confidence END,
  signals = CASE WHEN xq_intake_proposal.status IN ('proposed', 'rejected')
             THEN EXCLUDED.signals ELSE xq_intake_proposal.signals END,

  -- 自动归并只对「仍然待裁」且「这次是 hit」的行生效（F6）。三个条件都是必要的：
  --   · 旧行必须 proposed —— rejected 绝不自动接受（人的拒绝优先），
  --     accepted 已经在别处落定；
  --   · 这一次必须是 hit —— 插入路径只有 hit 才带 status='accepted'
  --     （recordProposal 对 hit 缺 matchedConceptId 直接抛，库里另有 CHECK）；
  --   · matched 非空 —— 与 xq_intake_proposal_hit_target 同一条要求。
  -- decided_at 用 now() 而不是 EXCLUDED 的：EXCLUDED 只在 hit 时非空，
  -- 但这里要的是「这次归并发生的时刻」，与插入路径同一口径。
  status = CASE WHEN xq_intake_proposal.status = 'proposed'
                  AND EXCLUDED.status = 'accepted'
                THEN 'accepted' ELSE xq_intake_proposal.status END,
  accepted_concept_id = CASE WHEN xq_intake_proposal.status = 'proposed'
                  AND EXCLUDED.status = 'accepted'
                THEN EXCLUDED.accepted_concept_id ELSE xq_intake_proposal.accepted_concept_id END,
  decided_at = CASE WHEN xq_intake_proposal.status = 'proposed'
                  AND EXCLUDED.status = 'accepted'
                THEN now() ELSE xq_intake_proposal.decided_at END,
  decided_by = CASE WHEN xq_intake_proposal.status = 'proposed'
                  AND EXCLUDED.status = 'accepted'
                THEN EXCLUDED.decided_by ELSE xq_intake_proposal.decided_by END
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

  try {
    return await transaction(async (tx) => {
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
      // 所以判重必须显式查 —— 而且要查**两处**（F5）：
      //
      //   ① 规范名命中：直接重名；
      //   ② **别名**命中：外来名「版本控制」其实是我们既有概念「Git」的另一种
      //      叫法。只查①时这一条漏过去，于是会新建一个以「版本控制」为规范名的
      //      第二概念，而别名行还挂在 Git 上 —— 实测：晋升后
      //      `lexicalIndex.get('版本控制')` 从 `['c_74699c4830c4']` 变成
      //      `['c_02da8ba4b59d','c_74699c4830c4']`，之后每次按名字匹配这条别名
      //      都变成 `suspect lexical-ambiguous`。一次误晋升把别名永久钉成存疑。
      //
      // ★ 只认 `status='active'`：`retired` / `merged` 的同名概念不挡路 ——
      //   重新引入一个退役的名字是合法动作（V7 那条部分唯一索引同样只覆盖
      //   `active`）。
      const clash = await findNameClash(tx, row.external_name);
      if (clash !== null) {
        // detail 是**给人看的一句话**，不只是 id：裁决台会把它原样打在
        // 「没有晋升」后面，用户看到 `Git` 才知道「该把它当 hit 归并」。
        return { ok: false, reason: 'name-taken', detail: clash };
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
  } catch (error) {
    // V7 的部分唯一索引兜住「判重查完、插入之前，别人抢先建了同名概念」
    // 这种竞态（以及任何绕过显式判重的写路径）。对一个 500 来说，调用方
    // 分不清「名字撞了」和「库坏了」；而对裁决台，这两者的动作完全不同：
    // 名字撞了要归并，库坏了要停机。所以把 23505 翻译回同一种可读拒绝。
    //
    // 事务适配器已经因为抛出回滚了整条事务，这里只是换一个返回值。
    if (isActiveNameConflict(error)) {
      return {
        ok: false,
        reason: 'name-taken',
        detail:
          '与活跃概念的规范名同名（并发写入撞上唯一索引 xq_concept_active_name_key）' +
          ' —— 该把它当 hit 归并，而不是新建',
      };
    }
    throw error;
  }
}

/**
 * 这条 23505 是不是「活跃概念重名」那条索引？
 *
 * 只认约束/索引名，不把**任何**唯一冲突都翻译成 name-taken —— 别名表、
 * 边表都有各自的唯一约束，那些撞了是真 bug，该原样抛。
 */
function isActiveNameConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (record.code !== '23505') return false;
  const where = String(record.constraint ?? '');
  if (where === 'xq_concept_active_name_key') return true;
  return /xq_concept_active_name_key/.test(String(record.message ?? ''));
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
 *
 * ★ 空 `stageId`/`sceneId` 的**纯文字证据**（F10a 之后会保留在 `signals` 里）
 *   在这里天然写不出行：下面显式要求两列非空串，再叠一层 `EXISTS`。
 *   不然「只有名字没有页」的提案晋升后会多出一行 stage_id='' 的出现记录 ——
 *   它指不到任何页，却会被算进覆盖率。
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
   WHERE src.stage_id IS NOT NULL AND btrim(src.stage_id) <> ''
     AND src.scene_id IS NOT NULL AND btrim(src.scene_id) <> ''
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

/**
 * 判重：这个名字**是**某个活跃概念的规范名，**或者是**它的别名？
 *
 * 返回 `null`（没人用这个名字）或一句给人看的 detail。
 *
 * 为什么 detail 要带概念名而不只是 id：裁决台把它原样打在「没有晋升」后面，
 * 用户需要看到的是「它其实就是 Git」；只给 `c_74699c4830c4` 还得再查一次库。
 *
 * 为什么别名要比较 `lower()`：别名表是人工/导入填的，大小写不统一（`Git` /
 * `git` 都出现过）。规范名仍按原样精确比较 —— 那是「这个名字本身」，大小写
 * 不同在今天就是另一个名字，改这个口径要单独决定。
 *
 * 为什么别名命中要**报出全部**概念：别名的唯一索引只覆盖 `ambiguous = false`，
 * 一个别名可以合法地指向多个概念。这时「该归并到哪一个」不是脚本能决定的，
 * 所以只能拒绝，并把所有候选名字摆给人看。
 */
async function findNameClash(queryable: Queryable, externalName: string): Promise<string | null> {
  const canonical = await queryable.query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name FROM xq_concept
      WHERE canonical_name = $1 AND status = 'active'
      ORDER BY canonical_name, id`,
    [externalName],
  );
  if (canonical.rows.length > 0) {
    const names = canonical.rows.map((r) => `${r.canonical_name}（${r.id}）`).join(' / ');
    return `与活跃概念的规范名同名：${names} —— 该把它当 hit 归并，而不是新建`;
  }

  const aliases = await queryable.query<{
    id: string;
    canonical_name: string;
    kind: string;
    ambiguous: boolean;
  }>(
    `SELECT c.id, c.canonical_name, a.kind, a.ambiguous
       FROM xq_concept_alias a
       JOIN xq_concept c ON c.id = a.concept_id
      WHERE lower(a.alias) = lower($1) AND c.status = 'active'
      ORDER BY c.canonical_name, c.id, a.kind`,
    [externalName],
  );
  if (aliases.rows.length === 0) return null;

  // 同一个概念可能有多行同类别名（kind 不同），按概念合并 —— 否则
  // 「一个别名指 N 个概念」会按**行数**报，而人关心的是概念数。
  const byConcept = new Map<string, { name: string; kinds: string[]; ambiguous: boolean }>();
  for (const row of aliases.rows) {
    const current = byConcept.get(row.id) ?? {
      name: row.canonical_name,
      kinds: [],
      ambiguous: false,
    };
    if (!current.kinds.includes(row.kind)) current.kinds.push(row.kind);
    current.ambiguous = current.ambiguous || row.ambiguous === true;
    byConcept.set(row.id, current);
  }

  const described = [...byConcept.entries()]
    .map(
      ([id, hit]) =>
        `${hit.name}（${id}，别名 kind=${hit.kinds.join('/')}${hit.ambiguous ? '，ambiguous' : ''}）`,
    )
    .join(' / ');
  if (byConcept.size === 1) {
    return `是活跃概念 ${described} 的别名「${externalName}」—— 该把它当 hit 归并，而不是新建`;
  }
  return (
    `「${externalName}」是 ${byConcept.size} 个活跃概念共用的别名：${described}` +
    ' —— 一个别名多指，先把它们归并（或给人裁），不许拿它当新概念的规范名'
  );
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

/**
 * 把 jsonb 里的信号读成 `ProposalSignal`（F10a）。
 *
 * 旧实现无条件要求 `stageId` 与 `sceneId` 都非空，否则 `continue`。而
 * `scripts/match-external-names.ts --enqueue` 写的证据恰恰是
 * `{ stageId: '', sceneId: '', quote: '版本控制 → Git', anchorsHit: [...] }` ——
 * 外来清单里只有名字、没有页。结果它写进去的 `quote` 100% 被这里吃掉，
 * 人在裁决台看到的是「0 页证据」，等于裁决台只能看见名字。
 *
 * 所以判据改成「**这条证据需不需要页定位**」：
 * - 带 `pageHash` 的（能对到具体某一页）才要求 `stageId`/`sceneId` ——
 *   没有页的话它在晋升时写不进 `xq_concept_occurrence`（那里有复合外键），
 *   留着只会让人以为有页证据；
 * - 纯文字证据（`quote` / `anchorsHit`）即使没有页也保留 —— 它本来就是
 *   「外来侧这么说的」原文，人裁决时唯一能看的东西。
 * - 两者都没有的空壳丢弃（那不是证据）。
 *
 * 保留时 `stageId`/`sceneId` 仍原样给空串而不是 `null`：`ProposalSignal` 的
 * 形状不变，打印方（`scripts/review-intake-proposals.ts`）按空串判断「无页」。
 */
function asSignals(value: unknown): ProposalSignal[] {
  if (!Array.isArray(value)) return [];
  const out: ProposalSignal[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const stageId = asText(record.stageId ?? record.stage_id);
    const sceneId = asText(record.sceneId ?? record.scene_id);
    const pageHash = asText(record.pageHash ?? record.page_hash) || null;
    const anchorsHit = Array.isArray(record.anchorsHit ?? record.anchors_hit)
      ? ((record.anchorsHit ?? record.anchors_hit) as unknown[])
      : [];
    const quote = asText(record.quote);
    const hasPage = stageId !== '' && sceneId !== '';
    if (pageHash !== null && !hasPage) continue;
    if (!hasPage && quote === '' && anchorsHit.length === 0) continue;
    out.push({
      stageId,
      sceneId,
      pageHash,
      quote,
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
