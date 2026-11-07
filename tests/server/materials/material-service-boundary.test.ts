/**
 * The material library's boundary: deletion lives on the admin service only.
 *
 * The guarantee we want to hold is structural, not a convention. Two
 * independent readings check it below:
 *
 * 1. the agent's tool sources name no admin service at all (text comparison,
 *    no mocks), and
 * 2. the object `createMaterialAgentService` returns carries no deletion —
 *    `'deleteMaterial' in service === false`, not merely `undefined` — while
 *    the admin object is a strict superset of it.
 *
 * No database is needed: the factories only close over their persistence, and
 * every assertion here is about shape. Calling a method would need a real
 * pool; we never call one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createMaterialAdminService,
  createMaterialAgentService,
  type MaterialServicePersistence,
} from '@/lib/server/materials/material-service';

/** Enough of a persistence provider to build the services; never called. */
function fakePersistence(): MaterialServicePersistence {
  return {
    pool: {} as MaterialServicePersistence['pool'],
    withTransaction: async () => {
      throw new Error('the boundary test never touches the database');
    },
  };
}

function sourceOf(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

/**
 * The one module that builds the agent's material tools. `material-library-tools.ts`
 * used to sit here too; the five-tool surface folded its operations into
 * `organize_materials`, and the file is gone.
 */
const AGENT_TOOL_SOURCES = ['lib/server/agent-runtime/material-tools.ts'];

const MATERIAL_ROUTES = [
  'app/api/materials/route.ts',
  'app/api/materials/[id]/route.ts',
  'app/api/materials/folders/route.ts',
  'app/api/materials/folders/[id]/route.ts',
  'app/api/materials/library/route.ts',
  'app/api/materials/move/route.ts',
];

describe('the agent side of the material library', () => {
  it('names no admin service in its tool sources, so deletion cannot even be spelled', () => {
    for (const path of AGENT_TOOL_SOURCES) {
      const source = sourceOf(path);
      expect(source, path).not.toContain('MaterialAdminService');
      expect(source, path).not.toContain('createMaterialAdminService');
    }
  });

  it('returns an object that does not have the deletion methods at all', () => {
    const service = createMaterialAgentService(fakePersistence());
    // `in` proves the key is absent, not merely undefined: a future
    // `deleteMaterial: undefined` would satisfy the typeof check and fail this.
    expect('deleteMaterial' in service).toBe(false);
    expect('deleteMaterialFolder' in service).toBe(false);
    expect(typeof (service as { deleteMaterialFolder?: unknown }).deleteMaterialFolder).toBe(
      'undefined',
    );
  });
});

describe('the admin side of the material library', () => {
  it('has both deletions and every agent operation', () => {
    const admin = createMaterialAdminService(fakePersistence());
    const agent = createMaterialAgentService(fakePersistence());
    expect(typeof admin.deleteMaterial).toBe('function');
    expect(typeof admin.deleteMaterialFolder).toBe('function');
    // A superset, method for method: admin widens the agent service rather
    // than being an incompatible parallel object.
    for (const key of Object.keys(agent)) {
      expect(Object.keys(admin), key).toContain(key);
      expect(admin[key as keyof typeof admin]).toBeTypeOf('function');
    }
  });
});

describe('the material routes', () => {
  it('reach the library through the service, never through the persistence module', () => {
    for (const path of MATERIAL_ROUTES) {
      expect(sourceOf(path), path).not.toContain('@/lib/persistence/material-library');
    }
  });
});
