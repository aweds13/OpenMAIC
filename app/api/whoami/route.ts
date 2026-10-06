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
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
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
      compactionEnabled: agentRuntimeConfig.compaction.enabled,
      compactionContextBudgetTokens: agentRuntimeConfig.compaction.contextBudgetTokens,
      learnerProfilePath: agentRuntimeConfig.learnerProfilePath ?? null,
      materialsDir: agentRuntimeConfig.materialsDir ?? null,
    };
    return Response.json(
      { ownerId, stageCount: stages.length, stages, error, runtime },
      { headers: responseHeaders },
    );
  });
}
