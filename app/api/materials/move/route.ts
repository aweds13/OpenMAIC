/**
 * POST /api/materials/move — move source materials, with their derivatives,
 * into a folder (`folderId: null` is Unfiled).
 *
 * Body `{ materialIds: string[], folderId: string | null }`. All or nothing:
 * 422 `not_movable` lists the ids that cannot move (missing, another owner's,
 * deleted, not ready, or a derivative), and nothing moves; 404 when the
 * folder is missing or another owner's. A thin adapter over the material
 * service (`lib/server/materials/material-service.ts`), which the agent's
 * `organize_materials` calls too.
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  jsonObjectBody,
  libraryNotFound,
  libraryPersistence,
  libraryRefusal,
  libraryWriteError,
} from '@/lib/server/materials/library-routes';
import { createMaterialAdminService } from '@/lib/server/materials/material-service';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  const body = await jsonObjectBody(req);
  const materialIds = body?.materialIds;
  const folderId = body?.folderId;
  if (
    !Array.isArray(materialIds) ||
    materialIds.length === 0 ||
    !materialIds.every((id) => typeof id === 'string' && id !== '') ||
    !(folderId === null || (typeof folderId === 'string' && folderId !== ''))
  ) {
    return libraryRefusal(
      400,
      'invalid_body',
      'materialIds (non-empty strings) and folderId (a string or null) are required',
      new Headers(),
    );
  }
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    try {
      const service = createMaterialAdminService(await libraryPersistence());
      const outcome = await service.moveMaterials({
        ownerId,
        materialIds: materialIds as string[],
        folderId: folderId as string | null,
        fence: 'request',
      });
      switch (outcome.status) {
        case 'folder_not_found':
          return libraryNotFound(headers);
        case 'too_many':
          return libraryRefusal(
            400,
            'too_many',
            `Move at most ${outcome.limit} at a time`,
            headers,
          );
        case 'not_movable':
          return libraryRefusal(422, 'not_movable', 'Some materials cannot be moved', headers, {
            materialIds: outcome.materialIds,
          });
        default:
          return ownerJson(outcome, 200, headers);
      }
    } catch (error) {
      return libraryWriteError(error, headers);
    }
  });
}
