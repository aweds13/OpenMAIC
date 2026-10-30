/**
 * 阶段冻结状态的**文件层** —— 读 / 写 / 落盘。
 *
 * ── 为什么是独立文件，不进计划信封 ────────────────────────────────
 *
 * 计划信封（`document_outlines.data`）技术上能加字段（存盘只做 `assertJsonValue`，
 * **没有 schema 校验**）。但**不放那儿**：万一某条存/取路径把字段丢掉，门槛就会
 * **静默失效**（该拦不拦）或**永久卡死**（永远说"没冻结"），而我没有真实写入能验证
 * 那条路径。放独立文件风险为零，而且出问题时能直接打开看、直接删。
 *
 * ── 放哪：`data/plan-freeze/` ────────────────────────────────────
 *
 * `data/` 是这个应用的**数据目录**（已有 `classrooms` / `materials` / `usage` /
 * `classroom-jobs`）。冻结状态属于**应用数据**，所以：
 *   · **不是** `个人数据\`（那里只放学习成长的东西 —— 用户明确纠正过，见 AGENTS.md §6.8）
 *   · **不是** `_tools\openmaic\diagnostics\`（那里放 harness 的调试产物）
 *
 * 可用 `OPENMAIC_PLAN_FREEZE_DIR` 覆盖目录（测试用 `/tmp` 之类）。
 *
 * ── 写盘方式：照 `learner-state.ts` ──────────────────────────────
 *
 * `mkdir -p` → 写 `<file>.tmp` → `rename`。同目录 rename 在 Windows 上也是原子的，
 * 所以不会读到半截 JSON。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { normalizePlanFreeze, type PlanFreezeState } from '@/lib/server/agent-runtime/plan-freeze';

export function planFreezeDir(): string {
  return process.env.OPENMAIC_PLAN_FREEZE_DIR ?? join(process.cwd(), 'data', 'plan-freeze');
}

/**
 * 一门的冻结状态文件。
 *
 * ★ `stageId` 只用来拼**文件名**，而 stageId 是 `stage-<nanoid>` 形态的安全字符集，
 *   但**不能假设**：这里做一次白名单替换，免得一个奇怪的 id 把路径带出去。
 */
export function planFreezeFile(stageId: string): string {
  const safe = stageId.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(planFreezeDir(), `${safe}.json`);
}

/** 读。文件没有 / 坏了 / 字段缺 ⇒ 归一化成一个"未冻结"的状态，**不抛**。 */
export async function readPlanFreeze(stageId: string): Promise<PlanFreezeState> {
  try {
    const text = await readFile(planFreezeFile(stageId), 'utf8');
    return normalizePlanFreeze(stageId, JSON.parse(text));
  } catch {
    return normalizePlanFreeze(stageId, null);
  }
}

/** 原子写。失败不抛给调用方 —— 冻结失败就不该把生成流程一起炸掉。 */
export async function writePlanFreeze(state: PlanFreezeState): Promise<boolean> {
  const path = planFreezeFile(state.stageId);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * ★ 门槛要用的那口数据：**当前计划有几条** + **冻结状态**。
 *
 * 单独抽出来是因为 `generate_scene` 与（将来的）其它写入点都要它，
 * 而"计划条目"的真身在文档存储里、冻结状态在文件里 —— 两个来源拼一次就好。
 */
/**
 * 审查凭据 —— **与冻结状态同一个目录**，靠文件名后缀区分。
 *
 * 为什么要落盘（2026-10-08 用户定的口径：**收尾时审一次**）：
 * 既然审查发生在**课程收尾**，那"以后再来修这门课"就是**另一次运行** ——
 * 如果凭据只在一次运行内有效，每次修老课都会被迫再审一遍整门课（一次长上下文调用）。
 * 所以审完写一份小凭据，`patch_stage` 的审查闸认它。
 *
 * 与冻结状态**同目录**是刻意的：那边已经解决过同一类问题（独立小文件、可打开看、
 * 可随手删、`OPENMAIC_PLAN_FREEZE_DIR` 会覆盖、whoami 会回显目录），
 * 再造一个目录等于再造一份要同步的清单。
 */
export const REVIEW_RECEIPT_SUFFIX = '.review.json';

export interface ReviewReceipt {
  stageId: string;
  /** ISO 时间戳。 */
  reviewedAt: string;
  /** 审查时这门课有几页（页数变了不代表凭据失效，只是留个读数）。 */
  pageCount: number;
  reportChars: number;
}

function reviewReceiptFile(stageId: string): string {
  return join(planFreezeDir(), `${stageId}${REVIEW_RECEIPT_SUFFIX}`);
}

/** 读凭据；没有或读不动都返回 null（**读不动不能让改页卡死**）。 */
export async function readReviewReceipt(stageId: string): Promise<ReviewReceipt | null> {
  try {
    const raw = await readFile(reviewReceiptFile(stageId), 'utf8');
    const parsed = JSON.parse(raw) as ReviewReceipt;
    return typeof parsed?.reviewedAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** 写凭据；写不进去返回 false（**审查的结论该给还是要给**）。 */
export async function writeReviewReceipt(receipt: ReviewReceipt): Promise<boolean> {
  try {
    const file = reviewReceiptFile(receipt.stageId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(receipt, null, 2), 'utf8');
    await rename(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 已接受的读数 —— **无状态审计的唯一解药**。
 *
 * `course_audit` 是无状态的：一门课有几页超线，它每次都报同样的数字。而"拆页"这条修法
 * 有时**不可用**（学习者明确不再插页）或**不该用**（读数是"要照抄的字符串"而不是"要学的知识"
 * —— 同 PBL 脚手架那条）。
 *
 * 没有这张凭据，后果不是"多看一眼"，而是：**每个新窗口都会为同一批页再吵一次**，
 * 或者有人为了消掉一条读数去动页面。所以"接受"必须能被机器记住。
 */
export const ACCEPTED_READINGS_SUFFIX = '.accepted.json';

export interface AcceptedReadings {
  stageId: string;
  /** 页码 → 接受时的读数（novel）与理由。 */
  pages: Record<string, { novel?: number; reason: string }>;
  updatedAt: string;
}

function acceptedReadingsFile(stageId: string): string {
  return join(planFreezeDir(), `${stageId}${ACCEPTED_READINGS_SUFFIX}`);
}

export async function readAcceptedReadings(stageId: string): Promise<AcceptedReadings | null> {
  try {
    const parsed = JSON.parse(
      await readFile(acceptedReadingsFile(stageId), 'utf8'),
    ) as AcceptedReadings;
    return parsed && typeof parsed.pages === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeAcceptedReadings(readings: AcceptedReadings): Promise<boolean> {
  try {
    const file = acceptedReadingsFile(readings.stageId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(readings, null, 2), 'utf8');
    await rename(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

export interface PlanFreezeSnapshot {
  state: PlanFreezeState;
  entryCount: number;
}

export async function loadPlanFreezeSnapshot(
  stageId: string,
  entries: readonly unknown[],
): Promise<PlanFreezeSnapshot> {
  return { state: await readPlanFreeze(stageId), entryCount: entries.length };
}
