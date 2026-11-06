/**
 * The backstop of the token-chained owner extraction: a claim whose worker
 * died leaves its source `running` with a lease nothing renews.
 * `claimNextOwnerMaterialExtraction` takes such a row over while the claim
 * budget allows, so a stuck row is normally self-healing. What it cannot fix
 * is a row no runner will ever look at again -- an owner already at its
 * concurrency limit, or an instance that no longer runs the runner at all.
 * That row is what {@link sweepExpiredExtractions} settles.
 *
 * The rows are written directly rather than through a claim: this suite tests
 * the sweep's condition, not the runner, and a real claim would need an asset
 * pool to publish into.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_OWNER_EXTRACTION_LEASE_TTL_MS,
  sweepExpiredExtractions,
} from '@/lib/persistence/owner-material-extraction';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';

const TTL = DEFAULT_OWNER_EXTRACTION_LEASE_TTL_MS;
const NOW = 1_000_000;
/** Older than two lease periods: the row has missed a renewal and gone quiet. */
const ABANDONED = NOW - 2 * TTL - 1;
/** One period old: a live worker's lease, renewed but not due yet. */
const FRESH = NOW - TTL / 2;

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.waitReady;
  await ensureOwnerMaterialSchema(db);
});

afterEach(async () => {
  await db?.close();
});

interface Row {
  status: string;
  reason_code: string | null;
  extraction_token: string | null;
  extraction_lease_at: string | number | null;
  extraction_error: string | null;
}

async function seed(id: string, extraction: object, leaseAt: number | null, token?: string) {
  await db.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, bytes, oss_key, status, extraction, created_at,
        extraction_token, extraction_claims, extraction_lease_at)
     VALUES ($1, 'owner', 'source', 1, $1, 'ready', $2::jsonb, 1, $3, 1, $4)`,
    [id, JSON.stringify(extraction), token ?? null, leaseAt],
  );
}

async function rowOf(id: string): Promise<Row> {
  const result = await db.query<Row>(
    `SELECT (extraction->>'status') AS status, (extraction->>'reasonCode') AS reason_code,
            extraction_token, extraction_lease_at, extraction_error
       FROM owner_material WHERE id = $1`,
    [id],
  );
  return result.rows[0]!;
}

describe('sweepExpiredExtractions', () => {
  it('settles a running row whose lease expired more than two periods ago', async () => {
    await seed('abandoned', { status: 'running' }, ABANDONED, 'token-abandoned');

    expect(await sweepExpiredExtractions(db, { now: NOW, leaseTtlMs: TTL })).toEqual({ swept: 1 });

    const row = await rowOf('abandoned');
    expect(row.status).toBe('failed');
    expect(row.reason_code).toBe('processing_interrupted');
    // The claim is gone: nothing may publish under a token that no longer runs.
    expect(row.extraction_token).toBeNull();
    expect(row.extraction_lease_at).toBeNull();
    expect(row.extraction_error).not.toBeNull();
  });

  it('leaves a running row with a fresh lease alone', async () => {
    await seed('live', { status: 'running' }, FRESH, 'token-live');

    expect(await sweepExpiredExtractions(db, { now: NOW, leaseTtlMs: TTL })).toEqual({ swept: 0 });

    const row = await rowOf('live');
    expect(row.status).toBe('running');
    expect(row.reason_code).toBeNull();
    expect(row.extraction_token).toBe('token-live');
    expect(Number(row.extraction_lease_at)).toBe(FRESH);
  });

  it('leaves pending, done and failed rows alone', async () => {
    await seed('queued', { status: 'pending' }, null);
    await seed('finished', { status: 'done' }, null);
    await seed('broken', { status: 'failed', reasonCode: 'no_text_extracted' }, null);

    expect(await sweepExpiredExtractions(db, { now: NOW, leaseTtlMs: TTL })).toEqual({ swept: 0 });

    expect(await rowOf('queued')).toMatchObject({ status: 'pending', reason_code: null });
    expect(await rowOf('finished')).toMatchObject({ status: 'done', reason_code: null });
    expect(await rowOf('broken')).toMatchObject({
      status: 'failed',
      reason_code: 'no_text_extracted',
    });
  });

  it('counts only the rows it settled', async () => {
    await seed('gone-1', { status: 'running' }, ABANDONED, 'token-1');
    await seed('gone-2', { status: 'running' }, ABANDONED, 'token-2');
    await seed('live', { status: 'running' }, FRESH, 'token-3');
    await seed('queued', { status: 'pending' }, null);

    expect(await sweepExpiredExtractions(db, { now: NOW, leaseTtlMs: TTL })).toEqual({ swept: 2 });
    expect(await rowOf('gone-1')).toMatchObject({
      status: 'failed',
      reason_code: 'processing_interrupted',
    });
    expect(await rowOf('gone-2')).toMatchObject({
      status: 'failed',
      reason_code: 'processing_interrupted',
    });
    expect(await rowOf('live')).toMatchObject({ status: 'running' });

    // Idempotent: nothing is left to settle.
    expect(await sweepExpiredExtractions(db, { now: NOW, leaseTtlMs: TTL })).toEqual({ swept: 0 });
  });
});
