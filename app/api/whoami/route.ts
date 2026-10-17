/**
 * GET /api/whoami — one-shot diagnostics for the local single-owner setup.
 *
 * Answers "why is my course list empty?" without guesswork: it reports the
 * owner id THIS browser's request resolves to, next to the course documents
 * that owner can see. When the list in the UI is empty but this route names a
 * different owner than the courses were written under, the cookie partition —
 * not the data — is the cause.
 *
 * It also echoes the agent-runtime knobs that are read **once at module load**,
 * so "I changed .env.local but nothing happened" has an answer that is not a
 * guess: a load-time value cannot change without a server restart, and this
 * route shows what the running process actually holds.
 *
 * Read-only: it resolves the owner and lists that owner's stages through the
 * same store the workbench uses, and mints a cookie on the way out exactly as
 * every other owner-scoped route does, so visiting it never changes what the
 * caller can see.
 */
import type { NextRequest } from 'next/server';

import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { planGateEnabled } from '@/lib/server/agent-runtime/plan-freeze';
import { planFreezeDir } from '@/lib/server/agent-runtime/plan-freeze-store';
import { scratchpadDir } from '@/lib/server/agent-runtime/scratch-tools';
import { practiceRoot } from '@/lib/server/agent-runtime/practice-tools';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // 上游 1.2.0 把匿名 owner 这套换成了统一的 identity 层（OwnerPrincipal +
  // withRequestOwner）：拿到的不是裸 ownerId，而是带 kind / roles 的 principal。
  // 这里只用它的 ownerId（作用域键），语义与合前的 resolveRequestOwnerId 一致。
  return withRequestOwner(req, async (principal, responseHeaders) => {
    const ownerId = principal.ownerId;
    let stages: { id: string; name: string; sceneCount: number }[] = [];
    let error: string | null = null;
    try {
      const store = await getOwnerScopedDocumentStore(ownerId);
      stages = (await store.listDocuments()).map((item) => ({
        id: item.id,
        name: item.name,
        sceneCount: item.sceneCount,
      }));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const runtime = {
      /** true = generate_scene writes no narration. Set by OPENMAIC_SELF_STUDY. */
      selfStudyDefault: agentRuntimeConfig.selfStudyDefault,
      // ★ 阶段冻结的门槛是**可选**的（默认关）。关着就意味着 generate_scene 不拦 ——
      //   那是"静默失效"最典型的形态，所以必须能从第一站诊断里看见它当前是什么值。
      //   （`static` = 进程启动时读，中途改 .env.local 不生效 —— 与其它 runtime 开关一致。）
      planGate: planGateEnabled(),
      courseAuditTool: true,
      compactionEnabled: agentRuntimeConfig.compaction.enabled,
      compactionContextBudgetTokens: agentRuntimeConfig.compaction.contextBudgetTokens,
      learnerProfilePath: agentRuntimeConfig.learnerProfilePath ?? null,
      materialsDir: agentRuntimeConfig.materialsDir ?? null,
      // 草稿纸与阶段冻结落在应用数据目录（不是 个人数据\、也不是 harness 诊断）——
      // 回显路径是为了"东西到底写到哪去了"永远能在第一站查到。
      scratchpadDir: scratchpadDir(),
      planFreezeDir: planFreezeDir(),
      // ★ 练习文件夹落在哪 —— 原来**没有回显**（2026-10-07 对账四个数据目录时发现的）。
      //   而 `practice_scaffold` 会把文件写到 `课程与学习\练习\<stageId>\<NN-标题>\`，
      //   不回显就等于"我生成的练习去哪了"没有地方能查 —— 正是 §6.8 要避免的那种静默。
      practiceDir: practiceRoot(),
      // ★ 同时能跑几场会话（本部署 `.env.local` 刻意设 1）。为什么回显它：
      //   "为什么两门课在同时生成"只能从这里查 —— 原来**没有任何地方回显它**，
      //   于是改了 `.env.local` 之后没有任何办法证实改动生效了（手册 §6.3 里
      //   连这个机制的结构名都写错了，一并修正）。
      maxConcurrent: agentRuntimeConfig.maxConcurrent,
    };
    return Response.json(
      { ownerId, stageCount: stages.length, stages, error, runtime },
      { headers: responseHeaders },
    );
  });
}
