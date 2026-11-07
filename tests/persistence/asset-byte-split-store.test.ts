import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PgAssetStore, ensureAssetSchema, type Queryable } from '@openmaic/storage/asset/pg';

import {
  ASSET_INLINE_BYTE_LIMIT,
  SplitAssetByteStore,
  assetLocalBytesRoot,
} from '@/lib/persistence/asset-byte-split-store';
import { lazyAssetByteStore } from '@/lib/persistence/asset-byte-store';

/**
 * The registry's own duck-type predicate (`packages/@openmaic/storage/src/asset/pg.ts`
 * `hasTransactionalWriter`), kept in sync so the wrapper is pinned to the check
 * the registry actually performs.
 */
function hasTransactionalMethods(store: object): boolean {
  return (
    'writeWith' in store &&
    typeof (store as { writeWith?: unknown }).writeWith === 'function' &&
    'readWith' in store &&
    typeof (store as { readWith?: unknown }).readWith === 'function' &&
    'deleteWith' in store &&
    typeof (store as { deleteWith?: unknown }).deleteWith === 'function'
  );
}

const PRINCIPAL = { key: 'split-asset-byte-store-test' } as const;

/** One byte over the threshold, so the routing branch is unambiguous. */
function oversizedBytes(): Uint8Array {
  const bytes = new Uint8Array(ASSET_INLINE_BYTE_LIMIT + 1);
  bytes[0] = 0x41;
  bytes[bytes.length - 1] = 0x5a;
  return bytes;
}

const blob = (bytes: Uint8Array): Blob => new Blob([bytes as BlobPart], { type: 'text/plain' });

describe('SplitAssetByteStore', () => {
  let directory: string;
  let previousRoot: string | undefined;

  beforeEach(async () => {
    previousRoot = process.env.ASSET_LOCAL_BYTES_DIR;
    directory = await mkdtemp(join(tmpdir(), 'openmaic-asset-split-'));
    process.env.ASSET_LOCAL_BYTES_DIR = directory;
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.ASSET_LOCAL_BYTES_DIR;
    else process.env.ASSET_LOCAL_BYTES_DIR = previousRoot;
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps a small blob in the PostgreSQL column and writes no file', async () => {
    const db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    const store = new SplitAssetByteStore(db as unknown as Queryable);
    const bytes = new TextEncoder().encode('small enough to inline');

    const hash = 'sha256-small' as Parameters<SplitAssetByteStore['write']>[0];
    await store.write(hash, bytes);

    const stored = await store.read(hash);
    expect(Buffer.from(stored ?? []).toString('utf8')).toBe('small enough to inline');
    const row = await db.query<{ bytes: Uint8Array | null }>(
      'SELECT bytes FROM asset_blobs WHERE content_hash = $1',
      [hash],
    );
    expect(row.rows[0]?.bytes).not.toBeNull();
    await expect(readFile(join(directory, hash))).rejects.toMatchObject({ code: 'ENOENT' });
    await db.close();
  });

  it('puts an oversized blob on disk and leaves the column NULL', async () => {
    const db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    const store = new SplitAssetByteStore(db as unknown as Queryable);
    const bytes = oversizedBytes();
    const hash = 'sha256-large' as Parameters<SplitAssetByteStore['write']>[0];

    await store.write(hash, bytes);

    const row = await db.query<{ bytes: Uint8Array | null; byte_size: string | number }>(
      'SELECT bytes, byte_size FROM asset_blobs WHERE content_hash = $1',
      [hash],
    );
    // A NULL column is the routing marker, not a missing blob: byte_size is
    // still maintained so quota and usage keep counting it.
    expect(row.rows[0]?.bytes).toBeNull();
    expect(Number(row.rows[0]?.byte_size)).toBe(ASSET_INLINE_BYTE_LIMIT + 1);
    const onDisk = await readFile(join(directory, hash));
    expect(onDisk.byteLength).toBe(ASSET_INLINE_BYTE_LIMIT + 1);
    expect(onDisk[0]).toBe(0x41);
    // `readFile` hands back a Buffer; compare the octets, not the buffer type.
    expect(Array.from((await store.read(hash)) ?? [])).toEqual(Array.from(bytes));
    await db.close();
  });

  it('reclaims the file together with the row through deleteWith', async () => {
    const db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    const store = new SplitAssetByteStore(db as unknown as Queryable);
    const hash = 'sha256-reclaimed' as Parameters<SplitAssetByteStore['write']>[0];
    await store.write(hash, oversizedBytes());
    expect((await readFile(join(directory, hash))).byteLength).toBe(ASSET_INLINE_BYTE_LIMIT + 1);

    await db.transaction((tx: Queryable) => store.deleteWith(tx, hash));

    await expect(readFile(join(directory, hash))).rejects.toMatchObject({ code: 'ENOENT' });
    const row = await db.query<{ bytes: Uint8Array | null }>(
      'SELECT bytes FROM asset_blobs WHERE content_hash = $1',
      [hash],
    );
    expect(row.rows[0]?.bytes ?? null).toBeNull();
    await db.close();
  });

  it('routes registry put() through the transaction for both sizes and reads both back', async () => {
    const db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    const store = new PgAssetStore(db as unknown as Queryable, {
      byteStore: lazyAssetByteStore(undefined, db as unknown as Queryable),
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });

    const small = await store.put(PRINCIPAL, blob(new TextEncoder().encode('tiny')));
    const large = await store.put(PRINCIPAL, blob(oversizedBytes()));

    const smallBytes = await store.resolve(PRINCIPAL, small);
    const largeBytes = await store.resolve(PRINCIPAL, large);
    expect(new TextDecoder().decode(smallBytes?.bytes)).toBe('tiny');
    expect(largeBytes?.bytes.byteLength).toBe(ASSET_INLINE_BYTE_LIMIT + 1);
    await db.close();
  });

  it('is still forwarded with all three hooks by the lazy no-bucket wrapper', async () => {
    const db = new PGlite();
    const wrapped = lazyAssetByteStore(undefined, db as unknown as Queryable);
    expect(hasTransactionalMethods(wrapped)).toBe(true);
    // Metadata lives in the registry's own database, so declaring the bytes
    // outside it would be a lie the collector would act on.
    expect('writesOutsideRegistryDatabase' in wrapped).toBe(false);
    await db.close();
  });

  it('defaults to <cwd>/data/asset-bytes and honours ASSET_LOCAL_BYTES_DIR', () => {
    expect(assetLocalBytesRoot()).toBe(directory);
    delete process.env.ASSET_LOCAL_BYTES_DIR;
    expect(assetLocalBytesRoot().endsWith(join('data', 'asset-bytes'))).toBe(true);
  });

  it('refuses a key that would escape the byte directory', async () => {
    const db = new PGlite();
    const store = new SplitAssetByteStore(db as unknown as Queryable);
    await expect(
      store.write('../escape' as Parameters<SplitAssetByteStore['write']>[0], oversizedBytes()),
    ).rejects.toThrow(/local asset byte path failed/);
    await db.close();
  });
});
