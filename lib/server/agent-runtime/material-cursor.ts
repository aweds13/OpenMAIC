/**
 * Opaque listing cursors for the material tools (07 §4 公共约定 #4).
 *
 * A cursor is not an id the model may interpret: it is an encoded pair of the
 * filters it was minted under and the last row it returned. Passing it back
 * under different filters is refused as a stale cursor (an empty page plus
 * `details.staleCursor: true`) rather than silently paging a different list,
 * which is the failure mode a bare id cursor has.
 *
 * The encoding is base64url JSON so it survives a provider round-trip
 * unchanged (no `+`, `/`, `=`).
 */

/** Bumped when the payload shape changes; older cursors then read as stale. */
const CURSOR_VERSION = 1;

interface CursorPayload {
  v: number;
  f: string;
  id: string;
}

/**
 * A short, stable fingerprint of the filters a cursor belongs to. Any filter
 * that changes the row set must be included by the caller.
 */
export function materialCursorFingerprint(
  parts: readonly (string | number | boolean | null | undefined)[],
): string {
  const material = parts.map((part) => (part === undefined ? '' : String(part))).join('\u0000');
  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function encodeMaterialCursor(fingerprint: string, lastId: string): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, f: fingerprint, id: lastId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** `null` when the cursor is not one of ours: the caller answers with a stale page. */
export function decodeMaterialCursor(
  cursor: string,
): { fingerprint: string; lastId: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { v, f, id } = decoded as Partial<CursorPayload>;
    if (v !== CURSOR_VERSION) return null;
    if (typeof f !== 'string' || !f) return null;
    if (typeof id !== 'string' || !id) return null;
    return { fingerprint: f, lastId: id };
  } catch {
    return null;
  }
}
