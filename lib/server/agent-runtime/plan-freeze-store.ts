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

import {
  normalizePlanFreeze,
  type PlanFreezeState,
} from '@/lib/server/agent-runtime/plan-freeze';

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
