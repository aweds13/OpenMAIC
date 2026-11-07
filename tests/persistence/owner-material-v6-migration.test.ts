import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it } from 'vitest';
import { applySchemaMigrations } from '@openmaic/storage/pg-migrations';
import {
  OWNER_MATERIAL_MIGRATIONS,
  ensureOwnerMaterialSchema,
  getOwnerMaterial,
} from '@/lib/persistence/owner-materials';

let db: PGlite;
afterEach(async () => {
  await db?.close();
});

/** A database that ran every owner-material migration up to and including `version`. */
async function atVersion(version: number): Promise<PGlite> {
  const instance = new PGlite();
  await instance.waitReady;
  await applySchemaMigrations(instance, {
    ...OWNER_MATERIAL_MIGRATIONS,
    migrations: OWNER_MATERIAL_MIGRATIONS.migrations.filter((m) => m.version <= version),
  });
  return instance;
}

async function ownerMaterialColumns(instance: PGlite): Promise<string[]> {
  const result = await instance.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'owner_material'
      ORDER BY column_name`,
  );
  return result.rows.map((row) => row.column_name);
}

async function constraintNames(instance: PGlite): Promise<string[]> {
  const result = await instance.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'owner_material'::regclass AND contype = 'c'
      ORDER BY conname`,
  );
  return result.rows.map((row) => row.conname);
}

/** The five-column classic upload v5 could hold: bytes behind `oss_key`, no pool pointer. */
async function seedClassicRow(instance: PGlite): Promise<void> {
  await instance.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256, status, extraction,
        created_at, extraction_result, retention)
     VALUES ('classic', 'owner', 'source', 'text/markdown', 42, 'classic.md', 'original-key',
             'digest', 'ready', '{"status":"ready","resultKey":"parsed-key"}', 1,
             '{"version":1,"text":"already parsed"}'::jsonb, 'library')`,
  );
}

it('renames extraction_result to result and keeps the row it held', async () => {
  db = await atVersion(5);
  await seedClassicRow(db);
  expect(await ownerMaterialColumns(db)).toContain('extraction_result');

  await ensureOwnerMaterialSchema(db);

  const columns = await ownerMaterialColumns(db);
  expect(columns).not.toContain('extraction_result');
  expect(columns).toContain('result');

  const row = await db.query(
    `SELECT result, extraction, oss_key, status FROM owner_material WHERE id = 'classic'`,
  );
  expect(row.rows).toEqual([
    {
      result: { version: 1, text: 'already parsed' },
      extraction: { status: 'ready', resultKey: 'parsed-key' },
      oss_key: 'original-key',
      status: 'ready',
    },
  ]);
  expect(await getOwnerMaterial(db, 'owner', 'classic')).toMatchObject({
    extractionResult: { version: 1, text: 'already parsed' },
    status: 'ready',
  });
});

it('drops the dead retention column', async () => {
  db = await atVersion(5);
  expect(await ownerMaterialColumns(db)).toContain('retention');

  await ensureOwnerMaterialSchema(db);

  expect(await ownerMaterialColumns(db)).not.toContain('retention');
});

it('rejects an image with no source', async () => {
  db = await atVersion(5);
  await ensureOwnerMaterialSchema(db);
  await db.query(
    `INSERT INTO owner_material (id, owner_id, kind, bytes, oss_key, status, created_at)
     VALUES ('src', 'owner', 'source', 1, 'key', 'ready', 1)`,
  );

  await expect(
    db.query(
      `INSERT INTO owner_material (id, owner_id, kind, derived_from, bytes, oss_key, status, created_at)
       VALUES ('orphan-image', 'owner', 'image', NULL, 1, 'key', 'ready', 1)`,
    ),
  ).rejects.toThrow(/owner_material_image_derived_from_check/);

  await db.query(
    `INSERT INTO owner_material (id, owner_id, kind, derived_from, bytes, oss_key, status, created_at)
     VALUES ('derived-image', 'owner', 'image', 'src', 1, 'key', 'ready', 1)`,
  );
  expect(await ownerMaterialColumns(db)).toContain('asset_id');
});

it('rejects a third status value', async () => {
  db = await atVersion(5);
  await ensureOwnerMaterialSchema(db);

  await expect(
    db.query(
      `INSERT INTO owner_material (id, owner_id, kind, bytes, oss_key, status, created_at)
       VALUES ('uploaded', 'owner', 'source', 1, 'key', 'extracting', 1)`,
    ),
  ).rejects.toThrow(/owner_material_status_check/);
});

it('leaves the ready-implies-bytes invariant to v6b, so classic rows still insert', async () => {
  db = await atVersion(5);
  await ensureOwnerMaterialSchema(db);

  // Deliberately not a constraint yet: the backfill has not run, so a classic
  // row is ready with its bytes behind `oss_key` and no pool pointer at all.
  expect(await constraintNames(db)).not.toContain('owner_material_ready_bytes_check');
  await db.query(
    `INSERT INTO owner_material (id, owner_id, kind, bytes, oss_key, sha256, status, created_at)
     VALUES ('classic', 'owner', 'source', 1, 'objects/classic', 'digest', 'ready', 1)`,
  );

  // The two rows the invariant would have to exempt, kept here as the record of
  // what v6b must not break: a reservation with no bytes, and a tombstone whose
  // bytes the sweep already reclaimed.
  await db.query(
    `INSERT INTO owner_material (id, owner_id, kind, bytes, oss_key, status, created_at)
     VALUES ('reserved', 'owner', 'source', 1, '', 'uploading', 1)`,
  );
  await db.query(
    `INSERT INTO owner_material (id, owner_id, kind, bytes, oss_key, sha256, status, created_at, deleted_at)
     VALUES ('tombstone', 'owner', 'source', 1, '', 'digest', 'ready', 1, 2)`,
  );
});

it('is idempotent: a second run changes nothing and adds no constraint twice', async () => {
  db = await atVersion(5);
  await seedClassicRow(db);
  await ensureOwnerMaterialSchema(db);
  const columns = await ownerMaterialColumns(db);
  const constraints = await constraintNames(db);

  await ensureOwnerMaterialSchema(db);

  expect(await ownerMaterialColumns(db)).toEqual(columns);
  expect(await constraintNames(db)).toEqual(constraints);
  const recorded = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM openmaic_schema_migrations WHERE store = 'owner-material'`,
  );
  expect(recorded.rows).toEqual([{ n: 6 }]);
  expect(await getOwnerMaterial(db, 'owner', 'classic')).toMatchObject({ bytes: 42 });
});

it('reaches the same column set from a database that never ran v2 or v5', async () => {
  db = new PGlite();
  await db.waitReady;
  await applySchemaMigrations(db, {
    ...OWNER_MATERIAL_MIGRATIONS,
    migrations: OWNER_MATERIAL_MIGRATIONS.migrations.filter((m) => m.version === 1),
  });
  await db.query(
    `INSERT INTO owner_material (id, owner_id, kind, bytes, oss_key, sha256, status, extraction, created_at)
     VALUES ('v1', 'owner', 'source', 7, 'v1-key', 'digest', 'ready', '{"status":"idle"}', 1)`,
  );

  await ensureOwnerMaterialSchema(db);

  const columns = await ownerMaterialColumns(db);
  expect(columns).toContain('result');
  expect(columns).not.toContain('extraction_result');
  expect(columns).not.toContain('retention');
});
