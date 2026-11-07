/**
 * Byte storage split by size (decision D1 of the materials program).
 *
 * Metadata never moves: the `asset_blobs` row, `asset_entries`, roots and the
 * collector's reclamation all stay in the registry's PostgreSQL. Only the bytes
 * take one of two paths:
 *
 * - at or under {@link ASSET_INLINE_BYTE_LIMIT} they are written to the
 *   registry's own `asset_blobs.bytes` column, exactly as `PgAssetByteStore`
 *   does;
 * - above it they are written to a local content-addressed directory and the
 *   column is left NULL. `byte_size` is still maintained, so quota, usage and
 *   the collector keep counting the blob without reading it.
 *
 * `asset_blobs.bytes` is nullable by design (`PgAssetByteStore.deleteWith`
 * clears it), so a NULL column is not a missing blob: it is the marker that
 * these bytes went to disk. Reads try the column first and fall back to the
 * directory, one extra lookup, and need no routing column to tell them apart.
 *
 * The three transaction-pinned methods (`writeWith` / `readWith` /
 * `deleteWith`) are the reason this store is forwardable at all. The registry
 * refuses a byte layer that writes to its own PostgreSQL without joining the
 * registry transaction, and the collector refuses one that deletes without
 * joining its transaction: a write on a second pooled connection blocks forever
 * on the blob-row lock the transaction already holds (a self-deadlock
 * PostgreSQL cannot detect). This store joins both, so it must NOT declare
 * `writesOutsideRegistryDatabase` -- its metadata lives inside the registry's
 * database.
 *
 * File writes are not transactional. A file that lands before its transaction
 * rolls back is an orphan keyed by content hash, and therefore harmless: the
 * collector's `deleteWith` removes it together with the blob row. Repeating a
 * write is safe for the same reason the registry requires every byte store to
 * be idempotent.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import type { AssetByteStore, Queryable } from '@openmaic/storage/asset/pg';

/** `sha256-<hex>`, as the registry brands it (`asset/blob.ts`). */
type ContentHash = Parameters<AssetByteStore['write']>[0];

/**
 * 2 MiB / 1 GiB 是 06 号规格的业界读数（`docs/research/材料统一/06-业界最佳实践.md:58`），
 * 不是本仓实测值。单文件超过 2 MiB 就走文件系统；PostgreSQL 核心开发者对 BYTEA 的建议
 * 区间是「平均 1–2 MB、上限 100 MB」，再大就把 WAL、备份和 TOAST 读写一起放大。
 */
export const ASSET_INLINE_BYTE_LIMIT = 2 * 1024 * 1024;
export const ASSET_OWNER_TOTAL_BYTE_LIMIT = 1024 * 1024 * 1024;

/**
 * Where the large-blob directory lives. Read per call so a changed value is
 * observed, the rule `builtInBucketSetting()` follows for `ASSET_S3_BUCKET`.
 */
export function assetLocalBytesRoot(): string {
  const configured = process.env.ASSET_LOCAL_BYTES_DIR?.trim();
  return configured ? resolve(configured) : resolve(process.cwd(), 'data', 'asset-bytes');
}

/** The key is a hash; anything that could step out of the directory is refused. */
function isSafeFileKey(hash: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(hash) && !hash.includes('..');
}

function byteStoreFailure(operation: string): Error {
  return new Error(`@openmaic/storage: local asset byte ${operation} failed`);
}

export class SplitAssetByteStore implements AssetByteStore {
  private readonly inline: PgAssetByteStore;

  constructor(private readonly queryable: Queryable) {
    this.inline = new PgAssetByteStore(queryable);
  }

  private filePath(hash: ContentHash): string {
    const root = assetLocalBytesRoot();
    const path = resolve(root, hash);
    if (!isSafeFileKey(hash) || !path.startsWith(root + sep)) {
      throw byteStoreFailure('path');
    }
    return path;
  }

  /** Temp file plus rename: a crash mid-write cannot publish a torn blob. */
  private async storeOnDisk(hash: ContentHash, bytes: Uint8Array): Promise<void> {
    const path = this.filePath(hash);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, path);
  }

  private async loadFromDisk(hash: ContentHash): Promise<Uint8Array | null> {
    try {
      return await readFile(this.filePath(hash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw byteStoreFailure('read');
    }
  }

  /** Inline write, for callers that are not inside a registry transaction. */
  async write(hash: ContentHash, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength <= ASSET_INLINE_BYTE_LIMIT) {
      await this.inline.write(hash, bytes);
      return;
    }
    await this.storeOnDisk(hash, bytes);
    await this.queryable.query(
      `INSERT INTO asset_blobs (content_hash, byte_size, bytes, unreferenced_at)
       VALUES ($1, $2, NULL, now())
       ON CONFLICT (content_hash) DO UPDATE
         SET byte_size = EXCLUDED.byte_size,
             bytes = NULL,
             unreferenced_at = now()`,
      [hash, bytes.byteLength],
    );
  }

  /** The registry's transaction-pinned byte write. */
  async writeWith(queryable: Queryable, hash: ContentHash, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength <= ASSET_INLINE_BYTE_LIMIT) {
      await this.inline.writeWith(queryable, hash, bytes);
      return;
    }
    // The file first: if it fails, the statement below never runs and the
    // transaction rolls back with the column untouched.
    await this.storeOnDisk(hash, bytes);
    await queryable.query(
      'UPDATE asset_blobs SET byte_size = $2, bytes = NULL WHERE content_hash = $1',
      [hash, bytes.byteLength],
    );
  }

  async read(hash: ContentHash): Promise<Uint8Array | null> {
    return this.readWith(this.queryable, hash);
  }

  /** The registry's transaction-pinned byte read. */
  async readWith(queryable: Queryable, hash: ContentHash): Promise<Uint8Array | null> {
    const inline = await this.inline.readWith(queryable, hash);
    if (inline) return inline;
    return this.loadFromDisk(hash);
  }

  async delete(hash: ContentHash): Promise<void> {
    await this.deleteWith(this.queryable, hash);
  }

  /** The collector's transaction-pinned byte clearing. */
  async deleteWith(queryable: Queryable, hash: ContentHash): Promise<void> {
    await this.inline.deleteWith(queryable, hash);
    await rm(this.filePath(hash), { force: true });
  }
}

/**
 * The owner-total arm of the same rule is deliberately not enforced here.
 *
 * `AssetByteStore` sees one write at a time and never learns the principal, so
 * "this owner is past 1 GiB, move their bytes to disk" cannot be decided at this
 * seam without changing the interface. That budget already exists one layer up
 * as the per-principal quota (`lib/persistence/asset-quota.ts`,
 * `DEFAULT_ASSET_QUOTA_BYTES = 10 GiB`); per-file routing is the part a byte
 * store can honestly own. The constant is exported so the number has one home
 * when that decision moves.
 */
void ASSET_OWNER_TOTAL_BYTE_LIMIT;
