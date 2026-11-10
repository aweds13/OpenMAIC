/**
 * 学情（xq）的**概念图读侧**：谁在它前面、它离根有多远、它现在能不能学。
 *
 * ## 为什么先做读侧，且只做读侧
 *
 * `xq_concept_edge` 有 94 条 `prereq` 边（2026-11-10 实测：`recommended` 88 /
 * `strict` 5 / `helpful` 1），从落库那天起**零读方**。规格里写死一句话：
 * 「在有人真的按 `prereq` 边排出顺序之前，任何『按图谱排序』的行为都不许上线。」
 *
 * 这一条卡住的不是查询，是**顺序**。而顺序是产品决策（先修 A 还是先修 B、
 * 一个概念要练到什么程度才算过），先修关系是图上的事实。两件事混在一个模块里，
 * 读的人就分不清「这是图说的」还是「这是我们决定的」。所以本文件只有前者：
 *
 *   - 不问「今天该学什么」——那是排序，本文件不产出任何顺序建议；
 *   - 不问「他会不会」——`mastered` 由调用方给（今天来自 `xq_cell_state.tri`，
 *     概念级的判定还不存在）；
 *   - 只回答图上可算的问题：直接先修有哪些、闭包有多大、最深要垫几层、
 *     有没有环、退役的先修挡住了谁。
 *
 * ## 为什么一次读整图，而不是写递归 CTE
 *
 * 104 个概念、105 条边（实测）。一次两条 SQL 全读进来，在 JS 里算 ——
 * 递归 CTE 写起来更「数据库」，但它的输出是**结果**，测的时候只能测「结果对不对」；
 * 而纯函数可以拿手搭的小图逐个断言（链、菱形、环、合并链、退役先修、缺节点）。
 * 图会涨到几千节点，但那时的瓶颈是「一次读太多」，不是「JS 算得慢」，
 * 那时再按 stage 分片读也不迟。可测性优先于提前优化。
 *
 * ## 三档强度是**证据强度**，不是重要程度
 *
 * `strict` 5 条、`recommended` 88 条、`helpful` 1 条。默认只认 `strict`：
 * 「能不能学」是一个**拦截**判断，认两档会让 104 个概念里 92 个都变成
 * 「还不许学」—— 那不是约束，那是把整张图锁死。想要更松的口径由调用方显式传。
 *
 * 也不能因为「strict 更硬所以更准」就默认信它：实测与页序的一致率
 * （`.tmp/_agree2.mjs`，按每门课里概念的首次出现比 `from ≤ to`）
 * 可测 112 对一致 89（**0.795**）；`strict` 只有 4 个可测对（一致 2），
 * `recommended` 108 对一致 87（0.806）。**样本量差 27 倍，不能拿 4 对说 strict 更准。**
 *
 * ## `contains` 不算先修
 *
 * 11 条 `contains` 是「域包含主题」。把它当先修会产出
 * 「学完整个知识域才能学其中一个主题」这种荒谬序列。本文件只走 `prereq`。
 *
 * ## 退役概念是**可检测的缺口**，不是静默跳过
 *
 * 读节点时不按 `status` 过滤：退役/合并的节点也要在图里。否则一条
 * 「A 的先修是 B，而 B 已退役」的边会变成「A 没有先修」—— 从「这里有坑」
 * 悄悄变成「这里没问题」，这是最坏的一种错。所以 `retired` 单独交出去，
 * 让调用方决定是提示、是补讲、还是干脆不让学。
 *
 * ## 两张表都要读：先修是骨架，出现记录才是「哪一页在讲它」
 *
 * `xq_concept_edge`（105 行）回答「先垫什么」，`xq_concept_occurrence`（644 行）
 * 回答「哪一页讲了它」。两张表都是**零生产读方**，而且它们的缺口是同一种：
 * 数据在库里躺着，没有任何一处代码拿它来回答人的问题。
 *
 * 放在同一个文件里，是因为它们回答的是同一个问题的两半 ——
 * 「这个概念是什么、要先垫什么、在哪些页里出现过」。分成两个模块，
 * 调用方每次都得自己把两半拼起来，而拼接点（`concept_id`）两边都可能标错。
 *
 * ★ 出现记录带 `weight`（0.40–1.00）与 `source`（keypoint / title / body）。
 * 读出来时按 `weight DESC, stage_id, scene_id` 排：同一页里一条概念可能同时
 * 因标题与正文命中，表上主键是 `(concept_id, stage_id, scene_id)` 所以只会有一条，
 * 取的是更高那一档 —— 排序要反映「这页有多像是在专门讲它」。
 *
 * ★ 29 个概念一条出现记录都没有（2026-11-10 实测 104 − 75）。这不是它们不存在，
 * 是「还没有任何一页讲过它」。读出来时**如实回空数组**，不回 `null`：
 * 空数组是「没有」，`null` 是「没查」。
 *
 * ## 合并链要防环，走不到头返回 `null`
 *
 * `merged_into` 是自引用外键，正常是一条链，但没有任何约束禁止 A→B→A。
 * 沿链走时必须带 `seen`；走到一个非 `merged` 的节点才算解析成功，
 * 走成环或走到 `null` 都返回 `null` —— **`null` 表示「这个 id 今天没有身份」**，
 * 不是「它自己」。
 */

import type { Queryable } from '@openmaic/storage/document/pg';

/** 先修边的三档强度，从硬到软。 */
export const PREREQ_STRENGTHS = ['strict', 'recommended', 'helpful'] as const;

export type PrereqStrength = (typeof PREREQ_STRENGTHS)[number];

/**
 * 默认只认 `strict`。
 *
 * 理由见文件头「三档强度是证据强度」：认两档会把 92/104 个概念判成「不许学」。
 * 这是一个**拦截**口径，所以取最保守的一档，而不是取最全的一档。
 */
export const DEFAULT_PREREQ_STRENGTHS: readonly PrereqStrength[] = ['strict'];

const CONCEPT_ID_PATTERN = /^c_[0-9a-f]{12}$/u;

export function isConceptId(value: unknown): value is string {
  return typeof value === 'string' && CONCEPT_ID_PATTERN.test(value);
}

export type ConceptKind = 'concept' | 'topic' | 'tool';
export type ConceptStatus = 'active' | 'merged' | 'retired';
export type ConceptRelation = 'prereq' | 'contains';

export interface ConceptNode {
  readonly id: string;
  readonly canonicalName: string;
  readonly kind: ConceptKind;
  readonly status: ConceptStatus;
  /** `status === 'merged'` 时指向被并入的那个概念；其余为 `null`。 */
  readonly mergedInto: string | null;
  readonly createdIn: number | null;
  readonly retiredIn: number | null;
}

export interface ConceptEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly relation: ConceptRelation;
  readonly strength: PrereqStrength | null;
  /**
   * 这条边从哪来（`course-outline` / `cs2023` / `acm-graph` / `exercism-*` /
   * `cs-math-skill-tree`）。
   *
   * ★ SR-F11.3 的原话是「任何『A 应先于 B』的判断都必须带来源」。第一版读侧
   * 只取了四列、把 `source` 丢了，于是那条规格在**读得到图的人手里**根本没法核对 ——
   * 图上有 94 条先修边，谁也说不出哪几条是人写的、哪几条是从语料统计的。
   *
   * 收窄成 `string | null` 而不是白名单枚举：DDL 对 `source` **没有 CHECK**
   * （种子图侧有 `EdgeSource` 联合类型，但库里不保证）。白名单会把将来新加的
   * 来源读成 `null`，而 `null` 在这里的含义是「不知道谁写的」——两件事不能混。
   */
  readonly source: string | null;
  /** 人写的一句理由（DDL `CHECK length(btrim(reason)) > 0`，所以不会是空白串）。 */
  readonly reason: string | null;
}

export interface ConceptGraph {
  readonly nodes: ReadonlyMap<string, ConceptNode>;
  readonly edges: readonly ConceptEdge[];
}

const READ_NODES_SQL = `SELECT id, canonical_name, kind, status, merged_into, created_in, retired_in
  FROM xq_concept
 ORDER BY id`;

const READ_EDGES_SQL = `SELECT from_id, to_id, relation, strength, source, reason
  FROM xq_concept_edge
 ORDER BY from_id, to_id, relation`;

interface NodeRow extends Record<string, unknown> {
  id: unknown;
  canonical_name: unknown;
  kind: unknown;
  status: unknown;
  merged_into: unknown;
  created_in: unknown;
  retired_in: unknown;
}

interface EdgeRow extends Record<string, unknown> {
  from_id: unknown;
  to_id: unknown;
  relation: unknown;
  strength: unknown;
  source: unknown;
  reason: unknown;
}

function asKind(value: unknown): ConceptKind | null {
  return value === 'concept' || value === 'topic' || value === 'tool' ? value : null;
}

function asStatus(value: unknown): ConceptStatus | null {
  return value === 'active' || value === 'merged' || value === 'retired' ? value : null;
}

function asRelation(value: unknown): ConceptRelation | null {
  return value === 'prereq' || value === 'contains' ? value : null;
}

function asStrength(value: unknown): PrereqStrength | null {
  return value === 'strict' || value === 'recommended' || value === 'helpful' ? value : null;
}

function asVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value);
  return null;
}

/** 码点序比较（不用 `localeCompare`，见 `prerequisiteEvidence` 的排序注释）。 */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function asNullableText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 把整张图读进来。
 *
 * ★ 节点**不按 `status` 过滤** —— 退役与合并的节点也要在图里，
 * 否则「A 的先修 B 已退役」会变成「A 没有先修」（见文件头最后一节）。
 */
export async function readConceptGraph(queryable: Queryable): Promise<ConceptGraph> {
  const [nodeResult, edgeResult] = await Promise.all([
    queryable.query<NodeRow>(READ_NODES_SQL),
    queryable.query<EdgeRow>(READ_EDGES_SQL),
  ]);

  const nodes = new Map<string, ConceptNode>();
  for (const row of nodeResult.rows) {
    const id = asNullableText(row.id);
    const canonicalName = asNullableText(row.canonical_name);
    const kind = asKind(row.kind);
    const status = asStatus(row.status);
    // 形状不对的节点整条丢：半条节点比没有更糟 —— 它会让依赖它的边
    // 变成「指向不存在」，也就是伪装成缺口。
    if (id === null || canonicalName === null || kind === null || status === null) continue;
    nodes.set(id, {
      id,
      canonicalName,
      kind,
      status,
      mergedInto: asNullableText(row.merged_into),
      createdIn: asVersion(row.created_in),
      retiredIn: asVersion(row.retired_in),
    });
  }

  const edges: ConceptEdge[] = [];
  for (const row of edgeResult.rows) {
    const fromId = asNullableText(row.from_id);
    const toId = asNullableText(row.to_id);
    const relation = asRelation(row.relation);
    if (fromId === null || toId === null || relation === null) continue;
    edges.push({
      fromId,
      toId,
      relation,
      strength: asStrength(row.strength),
      source: asNullableText(row.source),
      reason: asNullableText(row.reason),
    });
  }

  return { nodes, edges };
}

/**
 * 沿 `merged_into` 走到底。
 *
 * 走不到头（环、或指向不存在的行）返回 `null` —— 那是「这个 id 今天没有身份」，
 * 不是「它自己」。调用方拿到 `null` 应当把它当成缺口报出来，而不是继续用原 id。
 */
export function resolveConcept(graph: ConceptGraph, id: string): string | null {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return null; // 合并链成环 —— 没有终点
    seen.add(current);
    const node = graph.nodes.get(current);
    if (node === undefined) return null;
    if (node.status !== 'merged') return node.id;
    if (node.mergedInto === null) return null; // DDL 的 CHECK 会挡住，防御式收尾
    current = node.mergedInto;
  }
}

function prereqByTarget(
  graph: ConceptGraph,
  strengths: ReadonlySet<PrereqStrength>,
): Map<string, string[]> {
  const byTarget = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.relation !== 'prereq') continue;
    if (edge.strength === null || !strengths.has(edge.strength)) continue;
    const list = byTarget.get(edge.toId);
    if (list === undefined) byTarget.set(edge.toId, [edge.fromId]);
    else list.push(edge.fromId);
  }
  return byTarget;
}

export interface DirectPrerequisites {
  /** 直接先修（已解析合并链、已去重，按 id 码点序）。 */
  readonly prerequisites: readonly string[];
  /**
   * 指向「解析不出身份」的边的目标 id。
   *
   * 不猜、不跳过：一条「A 的先修是 B，而 B 的合并链断了」是**缺口**，
   * 静默丢掉它等于把图上的洞说成「没有先修」。
   */
  readonly unresolved: readonly string[];
}

/** 直接先修。只走 `prereq`，`contains` 一律不算（见文件头）。 */
export function directPrerequisites(
  graph: ConceptGraph,
  conceptId: string,
  strengths: ReadonlySet<PrereqStrength> = new Set(DEFAULT_PREREQ_STRENGTHS),
): DirectPrerequisites {
  const target = resolveConcept(graph, conceptId);
  if (target === null) return { prerequisites: [], unresolved: [] };

  const byTarget = prereqByTarget(graph, strengths);
  const prerequisites = new Set<string>();
  const unresolved = new Set<string>();
  for (const raw of byTarget.get(target) ?? []) {
    const resolved = resolveConcept(graph, raw);
    if (resolved === null) unresolved.add(raw);
    else if (resolved !== target) prerequisites.add(resolved);
  }

  return {
    prerequisites: [...prerequisites].sort(),
    unresolved: [...unresolved].sort(),
  };
}

/**
 * 「A 之所以要先学 B」的**证据边**本身，不是结论。
 *
 * ★ SR-F11.3 要求「任何『A 应先于 B』的判断都必须带三样：来源、置信度、
 * 覆盖到哪一级」。前两样就长在边上（`source` / `strength`），第一版读侧
 * 把它们丢了，于是 API 的调用方只能看到一串 id，看不到「凭什么」。
 *
 * 与 `directPrerequisites()` 的分工：那个给**结论**（去重、解析合并、排序），
 * 这个给**依据**（一条边一行，重复保留 —— 同一个先修由两张外部图各支持一次
 * 是两条证据，不是一条）。两者不合并：合并之后就没法回答「这条我信不信」。
 */
export interface PrerequisiteEvidence {
  readonly fromId: string;
  readonly toId: string;
  readonly strength: PrereqStrength;
  readonly source: string | null;
  readonly reason: string | null;
}

export function prerequisiteEvidence(
  graph: ConceptGraph,
  conceptId: string,
  strengths: ReadonlySet<PrereqStrength> = new Set(DEFAULT_PREREQ_STRENGTHS),
): readonly PrerequisiteEvidence[] {
  const target = resolveConcept(graph, conceptId);
  if (target === null) return [];
  const evidence: PrerequisiteEvidence[] = [];
  for (const edge of graph.edges) {
    if (edge.relation !== 'prereq') continue;
    if (edge.strength === null || !strengths.has(edge.strength)) continue;
    // 目标侧也过一遍合并链：`B 的先修` 写在一条指向已合并 id 的边上时，
    // 那条边仍然是在说 B。
    if (resolveConcept(graph, edge.toId) !== target) continue;
    if (edge.fromId === target) continue;
    evidence.push({
      fromId: edge.fromId,
      toId: edge.toId,
      strength: edge.strength,
      source: edge.source,
      reason: edge.reason,
    });
  }
  // 稳定排序：来源 → 档位 → 起点。同一张图两次读必须逐字节相同。
  // ★ 用码点比较而不是 `localeCompare`：后者随 ICU 版本与系统语言变，
  // 同一份数据在两台机器上会排出不同顺序（与 `learner-state-render` 第 5 条同一理由）。
  return evidence.sort(
    (a, b) =>
      compareText(a.source ?? '', b.source ?? '') ||
      compareText(a.strength, b.strength) ||
      compareText(a.fromId, b.fromId),
  );
}

export interface PrerequisiteClosure {
  readonly conceptId: string;
  /** 整个先修闭包（不含自己），按 id 码点序。 */
  readonly closure: readonly string[];
  /** 闭包里已经退役/合并的概念 —— 可检测的缺口。 */
  readonly retired: readonly string[];
  /** 闭包走回了起点：这张图上有一条环。 */
  readonly cycle: boolean;
}

/**
 * 整个先修闭包（传递闭包）。
 *
 * ★ 广度优先 + `visited`，**不用递归**：环会爆栈，而环在这张图上是
 * 可以被写进去的（没有约束禁止）。回到起点时 `cycle = true`。
 */
export function prerequisiteClosure(
  graph: ConceptGraph,
  conceptId: string,
  strengths: ReadonlySet<PrereqStrength> = new Set(DEFAULT_PREREQ_STRENGTHS),
): PrerequisiteClosure {
  const target = resolveConcept(graph, conceptId);
  if (target === null) return { conceptId, closure: [], retired: [], cycle: false };

  const byTarget = prereqByTarget(graph, strengths);
  const visited = new Set<string>();
  const retired = new Set<string>();
  const queue: string[] = [target];
  let cycle = false;

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const raw of byTarget.get(current) ?? []) {
      const resolved = resolveConcept(graph, raw);
      if (resolved === null) continue;
      if (resolved === target) {
        cycle = true;
        continue;
      }
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      const node = graph.nodes.get(resolved);
      if (node !== undefined && node.status !== 'active') retired.add(resolved);
      queue.push(resolved);
    }
  }

  return {
    conceptId: target,
    closure: [...visited].sort(),
    retired: [...retired].sort(),
    cycle,
  };
}

/**
 * 从根到它的**最长**先修链长度（根 = 没有先修的概念，深度 0）。
 *
 * ★ 取最长不取最短：最短会让「垫了五层才讲得到」看起来一步就到，
 * 而这张长度的全部用途就是「他要先垫多少」。
 *
 * 有环返回 `null` —— 环上的最长路径没有定义，给一个数就是编的。
 */
export function prerequisiteDepth(
  graph: ConceptGraph,
  conceptId: string,
  strengths: ReadonlySet<PrereqStrength> = new Set(DEFAULT_PREREQ_STRENGTHS),
): number | null {
  const target = resolveConcept(graph, conceptId);
  if (target === null) return null;

  const byTarget = prereqByTarget(graph, strengths);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  let cycle = false;

  // 迭代式后序：显式栈，避免长链爆栈。
  const stack: { id: string; expanded: boolean }[] = [{ id: target, expanded: false }];
  while (stack.length > 0) {
    const frame = stack.pop() as { id: string; expanded: boolean };
    if (frame.expanded) {
      visiting.delete(frame.id);
      let best = 0;
      for (const raw of byTarget.get(frame.id) ?? []) {
        const resolved = resolveConcept(graph, raw);
        if (resolved === null || resolved === frame.id) continue;
        const child = depth.get(resolved);
        if (child === undefined) continue;
        if (child + 1 > best) best = child + 1;
      }
      depth.set(frame.id, best);
      continue;
    }
    if (depth.has(frame.id)) continue;
    if (visiting.has(frame.id)) {
      cycle = true;
      continue;
    }
    visiting.add(frame.id);
    stack.push({ id: frame.id, expanded: true });
    for (const raw of byTarget.get(frame.id) ?? []) {
      const resolved = resolveConcept(graph, raw);
      if (resolved === null || resolved === frame.id) continue;
      if (depth.has(resolved)) continue;
      if (visiting.has(resolved)) {
        cycle = true;
        continue;
      }
      stack.push({ id: resolved, expanded: false });
    }
  }

  if (cycle) return null;
  return depth.get(target) ?? 0;
}

/**
 * 这张图上（按给定强度）有哪些环。
 *
 * DFS 三色：0 = 未访问，1 = 在栈上，2 = 已完成。回到「在栈上」的节点即成环。
 *
 * ★ 走的是**边的方向**（`from_id → to_id`，即「先修 → 依赖它的」），
 * 不是「往回找先修」。两个方向都能找出同一批环，但输出读起来完全不同：
 * `A→B→C→A` 应当回 `[A, B, C]`，而不是把链倒过来写成 `[A, C, B]`。
 *
 * 返回的每一项是环上的 id 列表（从环里最小的 id 起，便于比较与去重）。
 */
export function cyclesIn(
  graph: ConceptGraph,
  strengths: ReadonlySet<PrereqStrength> = new Set(DEFAULT_PREREQ_STRENGTHS),
): readonly (readonly string[])[] {
  const bySource = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.relation !== 'prereq') continue;
    if (edge.strength === null || !strengths.has(edge.strength)) continue;
    const list = bySource.get(edge.fromId);
    if (list === undefined) bySource.set(edge.fromId, [edge.toId]);
    else list.push(edge.toId);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const found = new Map<string, readonly string[]>();

  const visit = (start: string): void => {
    const path: string[] = [];
    const stack: { id: string; index: number }[] = [{ id: start, index: 0 }];
    color.set(start, 1);
    path.push(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = bySource.get(frame.id) ?? [];
      if (frame.index >= next.length) {
        color.set(frame.id, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const raw = next[frame.index];
      frame.index += 1;
      const resolved = resolveConcept(graph, raw);
      if (resolved === null) continue;
      const state = color.get(resolved) ?? 0;
      if (state === 0) {
        color.set(resolved, 1);
        path.push(resolved);
        stack.push({ id: resolved, index: 0 });
        continue;
      }
      if (state === 1) {
        const at = path.indexOf(resolved);
        if (at === -1) continue;
        const ring = path.slice(at);
        const pivot = [...ring].sort()[0];
        const rotateAt = ring.indexOf(pivot);
        const canonical = [...ring.slice(rotateAt), ...ring.slice(0, rotateAt)];
        found.set(canonical.join('\u0000'), canonical);
      }
    }
  };

  for (const node of [...graph.nodes.keys()].sort()) {
    if ((color.get(node) ?? 0) !== 0) continue;
    visit(node);
  }

  return [...found.values()];
}

export interface ConceptReadiness {
  readonly conceptId: string;
  /**
   * 闭包里的每一个先修都在 `mastered` 里。
   *
   * ★ 判的是**整个闭包**，不是直接先修：直接先修都「会了」但它的先修不会，
   * 说明那次「会了」本身不可信。
   * ★ 空闭包（没有先修）⇒ `ready = true`，没有要先垫的东西。
   */
  readonly ready: boolean;
  /** 闭包里没掌握的（按 id 码点序）。`ready` 为真时为空。 */
  readonly blockedBy: readonly string[];
  /** 闭包里已退役/合并的 —— 挡住它的那个概念本身可能已经不存在了。 */
  readonly retired: readonly string[];
  /** 闭包里有环：`ready` 恒为 `false`，且无法给出可靠的 `blockedBy` 语义。 */
  readonly cycle: boolean;
}

/**
 * 他现在能不能学这个概念。
 *
 * ★ **本函数不判谁掌握了** —— `mastered` 由调用方给。今天它的来源只有
 * `xq_cell_state.tri = 'known'` 那一层（页级），概念级的三态判定还不存在；
 * 把「谁算会了」写进这里，等于把这个模块变成判定器，而它只该是图的读侧。
 */
export function conceptReadiness(
  graph: ConceptGraph,
  conceptId: string,
  mastered: ReadonlySet<string>,
  strengths: ReadonlySet<PrereqStrength> = new Set(DEFAULT_PREREQ_STRENGTHS),
): ConceptReadiness {
  const target = resolveConcept(graph, conceptId);
  if (target === null) {
    return { conceptId, ready: false, blockedBy: [], retired: [], cycle: false };
  }

  const closured = prerequisiteClosure(graph, target, strengths);
  const blockedBy = closured.closure.filter((id) => !mastered.has(id));

  return {
    conceptId: target,
    ready: !closured.cycle && blockedBy.length === 0,
    blockedBy,
    retired: closured.retired,
    cycle: closured.cycle,
  };
}

/**
 * `xq_concept_occurrence.source` 的七种取值（与迁移 v6 的 CHECK 逐字一致）。
 *
 * 前四档是我们自己算的（大纲要点 / 页标题 / 页正文 / 人工挂），后三档是
 * **外来课程**带进来的页证据。分档不是因为读方要区分，是因为「撤掉那一门外来
 * 课带来的挂载」要能一句 SQL 做完而不误伤自己抽的行。
 */
export const OCCURRENCE_SOURCES = [
  'keypoint',
  'title',
  'body',
  'manual',
  'foreign-keypoint',
  'foreign-body',
  'foreign-title',
] as const;

export type OccurrenceSource = (typeof OCCURRENCE_SOURCES)[number];

/** 一处出现记录：这个概念在这一页上被提到，`weight` 表示有多像是在专门讲它。 */
export interface ConceptOccurrence {
  readonly conceptId: string;
  readonly stageId: string;
  readonly sceneId: string;
  readonly weight: number;
  readonly source: OccurrenceSource;
}

const READ_OCCURRENCES_SQL = `SELECT concept_id, stage_id, scene_id, weight, source
  FROM xq_concept_occurrence
 WHERE concept_id = ANY($1::text[])
 ORDER BY weight DESC, stage_id, scene_id`;

interface OccurrenceRow extends Record<string, unknown> {
  concept_id: unknown;
  stage_id: unknown;
  scene_id: unknown;
  weight: unknown;
  source: unknown;
}

function asWeight(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  // `numeric(3,2)` 在两个驱动上都会回字符串。范围由 DDL 的 CHECK 保证，
  // 这里只挡 NaN —— 一个 NaN 权重会让排序静默错位。
  return Number.isFinite(parsed) ? parsed : null;
}

function asSource(value: unknown): OccurrenceSource | null {
  return typeof value === 'string' && (OCCURRENCE_SOURCES as readonly string[]).includes(value)
    ? (value as OccurrenceSource)
    : null;
}

/**
 * 这些概念各自出现在哪些页上。
 *
 * ★ 返回的 Map **一定包含每一个被问到的 id**（没出现过的是空数组）。
 * 少一个键会让调用方以为「查漏了」，而它其实只是「没有」。
 */
export async function readConceptOccurrences(
  queryable: Queryable,
  conceptIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ConceptOccurrence[]>> {
  const result = new Map<string, ConceptOccurrence[]>();
  const unique = [...new Set(conceptIds)].filter((id) => id !== '');
  for (const id of unique) result.set(id, []);
  if (unique.length === 0) return result;

  const { rows } = await queryable.query<OccurrenceRow>(READ_OCCURRENCES_SQL, [unique]);
  for (const row of rows) {
    const conceptId = typeof row.concept_id === 'string' ? row.concept_id : null;
    const stageId = typeof row.stage_id === 'string' ? row.stage_id : null;
    const sceneId = typeof row.scene_id === 'string' ? row.scene_id : null;
    const weight = asWeight(row.weight);
    const source = asSource(row.source);
    // 形状不对的整条丢 —— 同 `readConceptGraph` 的节点：半条记录会让排序不可信。
    if (conceptId === null || stageId === null || sceneId === null) continue;
    if (weight === null || source === null) continue;
    const list = result.get(conceptId);
    if (list === undefined) continue;
    list.push({ conceptId, stageId, sceneId, weight, source });
  }

  return result;
}

export interface ConceptPageRef {
  readonly stageId: string;
  readonly sceneId: string;
  readonly title: string | null;
}

const READ_PAGE_TITLES_SQL = `SELECT s.stage_id, s.id, s.data->>'title' AS title
  FROM unnest($1::text[], $2::text[]) AS k(stage_id, id)
  JOIN document_scenes s ON s.stage_id = k.stage_id AND s.id = k.id`;

interface PageTitleRow extends Record<string, unknown> {
  stage_id: unknown;
  id: unknown;
  title: unknown;
}

/**
 * 给一批 `(stageId, sceneId)` 补页标题。
 *
 * 单独一个函数而不是并进 `readConceptOccurrences`：标题来自 `document_scenes`，
 * 与概念无关；把它合进去会让「读概念」这条路径也依赖文档表，而概念图本身
 * 在文档表为空时仍然是对的。
 *
 * ★ 查不到的页**不出现在结果里**，不补空标题：页被删了与页没标题是两件事，
 * 调用方看到「没有这一项」才知道该去查页，而不是把空标题当成页的真实状态。
 */
export async function readPageTitles(
  queryable: Queryable,
  refs: readonly ConceptPageRef[],
): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  const unique = new Map<string, ConceptPageRef>();
  for (const ref of refs) unique.set(`${ref.stageId}\u0000${ref.sceneId}`, ref);
  if (unique.size === 0) return result;

  const entries = [...unique.values()];
  const { rows } = await queryable.query<PageTitleRow>(READ_PAGE_TITLES_SQL, [
    entries.map((ref) => ref.stageId),
    entries.map((ref) => ref.sceneId),
  ]);
  for (const row of rows) {
    const stageId = typeof row.stage_id === 'string' ? row.stage_id : null;
    const sceneId = typeof row.id === 'string' ? row.id : null;
    const title = typeof row.title === 'string' && row.title !== '' ? row.title : null;
    if (stageId === null || sceneId === null || title === null) continue;
    result.set(`${stageId}\u0000${sceneId}`, title);
  }
  return result;
}
