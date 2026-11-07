#!/usr/bin/env node
/**
 * Import the file-type materials library into PostgreSQL, once.
 *
 * `OPENMAIC_MATERIALS_DIR` used to be the library's only truth: a directory of
 * `<topic>.md` files plus an `INDEX.md`, read and written with `readFileSync`
 * (`lib/server/agent-runtime/materials-library.ts`). That directory is now a
 * drop folder -- something to import from, not a second truth. This script is
 * the import channel (`docs/research/材料统一/01-持久化层规格.md` §4.3, option
 * (a): one-way, by hand, idempotent).
 *
 * Seven steps, in this order:
 *
 *   1. List `<topic>.md` files whose slug matches `^[a-z0-9][a-z0-9-]{0,63}$`.
 *      Anything else is reported and skipped: the library addresses a topic by
 *      that slug.
 *   2. `INDEX.md` is NOT a material. It indexes materials; importing it would
 *      put the table of contents in the library next to the things it lists.
 *   3. Ensure the `材料库` folder exists (created if missing, found if present),
 *      so the import is one visible pile instead of N loose rows.
 *   4. One row per file: `kind='source'`, `mime='text/markdown'`, the display
 *      name from INDEX.md's row for the topic when there is one (else the
 *      slug), `bytes` = the file's length, `sha256` = its digest.
 *   5. Bytes go into the asset pool the way an upload does -- allocate a
 *      pending entry, then publish it with the row and its root in one
 *      transaction (`allocateOwnerMaterialBytes` + `publishOwnerMaterialUpload`).
 *   6. Idempotence is `(owner_id, sha256)`: a file whose content is already a
 *      ready source of this owner is skipped. Re-running after an edit imports
 *      the new content as a new material and leaves the old one in place.
 *   7. The directory is not modified. The library's read path still reads it,
 *      so a running process keeps seeing the same content until that path
 *      moves to PostgreSQL (a separate change).
 *
 * `--dry-run` reads the directory and writes nothing, so it needs no database.
 *
 * ## Why the app modules are imported dynamically, and why the hook exists
 *
 * `@openmaic/storage` publishes its subpaths under the `import` condition only,
 * so this script runs as `tsx --conditions=import`. Under that condition `pg`'s
 * CommonJS entry resolves its own `pg-pool` dependency to
 * `pg-pool/esm/index.mjs`, and `pg/lib/index.js` then does
 * `class BoundPool extends Pool` on a module namespace object:
 *
 *   TypeError: Class extends value #<Object> is not a constructor or null
 *
 * Redirecting `pg-pool` back to its CommonJS entry is enough; `pg`'s own ESM
 * wrapper is fine. The hook has to be registered before `pg` first loads, which
 * is why nothing below is a static import of an app module: static imports are
 * evaluated before this module's body runs.
 *
 *   npx tsx --conditions=import --env-file-if-exists=.env.local \
 *   scripts/import-materials-directory.ts \
 *     [--owner <id>] [--dir <path>] [--dry-run]
 *
 * `--env-file-if-exists` is Node's own flag, passed through by tsx; nothing in
 * this repo loads `.env*` for scripts, so without it the materials directory has
 * to be spelled out with `--dir` on every run. It is `-if-exists` so a machine
 * with no `.env.local` fails on the missing directory -- a clear message -- and
 * not on a missing file.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { basename, join, resolve } from 'node:path';

// `registerHooks` exists from Node 22.15 on (the repo requires >=22.19) but the
// installed @types/node predates it, so the member is read through a cast rather
// than imported by name: a named import would not type-check at all.
interface ResolveResult {
  url: string;
}
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => ResolveResult,
) => ResolveResult;
const registerModuleHooks = (
  nodeModule as unknown as {
    registerHooks: (hooks: { resolve: ResolveHook }) => void;
  }
).registerHooks;

registerModuleHooks({
  resolve(specifier, context, nextResolve) {
    const base = nextResolve(specifier, context);
    // `pg` requires `pg-pool`, whose ESM entry exports no constructor.
    if (specifier === 'pg-pool') {
      return { ...base, url: base.url.replace(/[\\/]esm[\\/]index\.mjs$/, '/index.js') };
    }
    return base;
  },
});

/** The slug the library addresses a topic by (`materials-library.ts`). */
const TOPIC_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const INDEX_FILE = 'INDEX.md';
const FOLDER_NAME = '材料库';
const MARKDOWN_MIME = 'text/markdown';

/**
 * The `| \`topic.md\` | 方向 | 一句话 |` rows of INDEX.md. A topic's direction
 * is the best display name on disk ("Dart / Flutter" beats "dart-flutter").
 */
function displayNamesFromIndex(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('|').map((cell) => cell.trim());
    // A row is '| file | direction | summary |': the leading and trailing
    // pipes split off empty cells, so the file is cells[1] and the direction
    // cells[2]. Only a backticked cell is a file the table actually links.
    if (cells.length < 4 || !cells[1].startsWith('`')) continue;
    const file = cells[1].replace(/^`|`$/g, '');
    if (!file.endsWith('.md')) continue;
    const topic = file.slice(0, -'.md'.length);
    const direction = cells[2];
    if (!TOPIC_SLUG.test(topic) || direction === '' || direction === '方向') continue;
    names.set(topic, direction);
  }
  return names;
}

interface Options {
  ownerId: string;
  dir: string | undefined;
  dryRun: boolean;
}

function parseOptions(argv: readonly string[], defaultOwnerId: string): Options {
  const options: Options = {
    ownerId: process.env.OWNER_SINGLE_USER_ID?.trim() || defaultOwnerId,
    dir: process.env.OPENMAIC_MATERIALS_DIR?.trim() || undefined,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--owner' || arg === '--dir') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === '--owner') options.ownerId = value;
      else options.dir = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

interface Candidate {
  topic: string;
  fileName: string;
  bytes: Buffer;
  sha256: string;
  displayName: string;
}

function readCandidates(dir: string, skipped: string[]): Candidate[] {
  const displayNames = displayNamesFromIndex(
    existsSync(join(dir, INDEX_FILE)) ? readFileSync(join(dir, INDEX_FILE), 'utf8') : '',
  );
  const candidates: Candidate[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.md') || entry === INDEX_FILE) continue;
    const topic = entry.slice(0, -'.md'.length);
    if (!TOPIC_SLUG.test(topic)) {
      skipped.push(`${entry}: topic "${topic}" is not a lowercase slug`);
      continue;
    }
    const bytes = readFileSync(join(dir, entry));
    candidates.push({
      topic,
      fileName: basename(entry),
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      displayName: displayNames.get(topic) ?? topic,
    });
  }
  return candidates;
}

async function main(): Promise<number> {
  const { DEFAULT_SINGLE_USER_OWNER_ID } = await import('../lib/server/identity/single-user');
  const options = parseOptions(process.argv.slice(2), DEFAULT_SINGLE_USER_OWNER_ID);
  if (!options.dir) {
    throw new Error('no materials directory: pass --dir or set OPENMAIC_MATERIALS_DIR');
  }
  const dir = resolve(options.dir);
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`);

  const skipped: string[] = [];
  const candidates = readCandidates(dir, skipped);
  console.log(`owner:  ${options.ownerId}`);
  console.log(`dir:    ${dir}`);
  console.log(`mode:   ${options.dryRun ? 'DRY RUN (nothing is written)' : 'import'}`);
  console.log(`found:  ${candidates.length} topic file(s); INDEX.md is not a material`);
  for (const entry of skipped) console.log(`skipped: ${entry}`);

  if (options.dryRun) {
    for (const candidate of candidates) {
      console.log(
        `would import: ${candidate.topic} (${candidate.bytes.byteLength} B, ` +
          `sha256 ${candidate.sha256.slice(0, 12)}..., name "${candidate.displayName}")`,
      );
    }
    console.log(`summary: 0 imported, 0 already present, ${candidates.length} would be imported`);
    return 0;
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const [{ createMaterialId }, { getServerPersistenceProvider }, library, materials] =
    await Promise.all([
      import('@openmaic/storage'),
      import('../lib/persistence/server-provider'),
      import('../lib/persistence/material-library'),
      import('../lib/persistence/owner-materials'),
    ]);

  const persistence = await getServerPersistenceProvider(connectionString);
  const folder = await library.createMaterialFolder(persistence, {
    ownerId: options.ownerId,
    name: FOLDER_NAME,
    fence: 'background',
  });
  if (folder.status !== 'ok') {
    throw new Error(`cannot ensure the "${FOLDER_NAME}" folder: ${folder.status}`);
  }
  console.log(
    `folder: ${folder.created ? 'created' : 'reused'} "${FOLDER_NAME}" (${folder.folder.id})`,
  );

  // Step 6: `(owner_id, sha256)` among the owner's live sources.
  const present = await persistence.pool.query<{ sha256: string | null }>(
    `SELECT sha256 FROM owner_material
      WHERE owner_id = $1 AND kind = 'source' AND status = 'ready' AND deleted_at IS NULL
        AND sha256 IS NOT NULL`,
    [options.ownerId],
  );
  const alreadyPresent = new Set(present.rows.map((row) => row.sha256));

  let imported = 0;
  let existing = 0;
  for (const candidate of candidates) {
    if (alreadyPresent.has(candidate.sha256)) {
      existing += 1;
      console.log(
        `already present: ${candidate.topic} (sha256 ${candidate.sha256.slice(0, 12)}...)`,
      );
      continue;
    }
    // Step 4: a row reserved exactly as an upload reserves one, then published.
    const registered = await materials.registerOwnerMaterial(
      persistence.pool,
      {
        id: createMaterialId(),
        ownerId: options.ownerId,
        kind: 'source',
        mime: MARKDOWN_MIME,
        bytes: candidate.bytes.byteLength,
        originalName: candidate.fileName,
        ossKey: '',
      },
      { maxCount: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER },
    );
    // Step 5: bytes into the pool, then the row and its root in one transaction.
    const assetId = await materials.allocateOwnerMaterialBytes(
      persistence,
      options.ownerId,
      candidate.bytes,
      MARKDOWN_MIME,
    );
    const published = await materials.publishOwnerMaterialUpload(
      persistence,
      options.ownerId,
      registered.id,
      { assetId, bytes: candidate.bytes.byteLength, sha256: candidate.sha256 },
    );
    if (published === 'refused') throw new Error(`publication refused for ${candidate.topic}`);

    // Steps 3 and 4 for the presentation: the same calls the library page uses.
    const renamed = await library.renameMaterial(persistence, {
      ownerId: options.ownerId,
      materialId: registered.id,
      name: candidate.displayName,
      fence: 'background',
    });
    if (renamed.status !== 'renamed' && renamed.status !== 'unchanged') {
      throw new Error(`cannot name ${candidate.topic}: ${renamed.status}`);
    }
    const moved = await library.moveMaterials(persistence, {
      ownerId: options.ownerId,
      materialIds: [registered.id],
      folderId: folder.folder.id,
      fence: 'background',
    });
    if (moved.status !== 'moved' && moved.status !== 'unchanged') {
      throw new Error(`cannot file ${candidate.topic}: ${moved.status}`);
    }
    alreadyPresent.add(candidate.sha256);
    imported += 1;
    console.log(`imported: ${candidate.topic} (${candidate.bytes.byteLength} B, asset ${assetId})`);
  }

  console.log(
    `summary: ${imported} imported, ${existing} already present, ${skipped.length} skipped`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
