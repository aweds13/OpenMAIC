import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { DocumentWriteRefusedError, type RuntimeStore } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  createStorageHttpHandler,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  type AssetIndirectByteEgress,
} from '@openmaic/storage/server';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createLogger } from '@/lib/logger';
import { configuredAssetByteEgress } from '@/lib/persistence/asset-byte-egress';
import { resolveAssetCollectionGraceMs } from '@/lib/persistence/asset-collection-grace';
import {
  decideDocumentAccess,
  parseDocumentAction,
  type DocumentAccess,
} from '@/lib/persistence/document-access';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { assetPrincipalForOwner, createOwnerAssetStore } from '@/lib/persistence/owner-assets';
import {
  claimRefusalResponse,
  isSameOriginJsonRequest,
  runPendingClaim,
} from '@/lib/persistence/owner-claim-http';
import {
  isOwnerRetired,
  OWNER_RETIRED,
  OwnerBusyError,
  ownerRetiredResponse,
  retiredCredentialCookies,
} from '@/lib/persistence/owner-merges';
import { guardedServerRuntimeStore } from '@/lib/persistence/runtime-tombstone-guard';
import { withXqProbeRecording } from '@/lib/persistence/xq-probe-recorder';
import {
  recordXqEvent,
  XQ_END_REASONS,
  XQ_EVENT_KINDS,
  XQ_HINT_SUBTYPES,
} from '@/lib/persistence/xq-event-recorder';
import {
  recordXqReview,
  XqReviewRoundMissingError,
  XQ_REVIEW_OUTCOMES,
} from '@/lib/persistence/xq-review-recorder';
import {
  getServerPersistenceProvider,
  type PersistencePoolFactory,
} from '@/lib/persistence/server-provider';
import { readStageMeta } from '@/lib/persistence/stage-meta';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { getPersistenceHooks } from '@/lib/server/persistence-hooks/registry';

export const runtime = 'nodejs';

const ROUTE_PREFIX = '/api/persistence';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const log = createLogger('Persistence');

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function withHeaders(response: Response, headers: Headers): Response {
  for (const [name, value] of headers.entries()) response.headers.append(name, value);
  return response;
}

/**
 * `GET /api/persistence/learner-key`: the runtime learner key the server
 * derives for this request's owner, so the browser can address its own runtime
 * sessions (the runtime contract names the learner key in paths and bodies).
 * The key is the owner id, which owner-scoped responses already carry
 * (folders report it as `userKey`), so this discloses nothing new; it is
 * uncacheable because it is per owner.
 */
const LEARNER_KEY_PATH = '/learner-key';

/**
 * `POST /api/persistence/xq/events`: one learning event (page view, session
 * start/end, answer, review) appended to `xq_event` / `xq_session`.
 *
 * A dedicated route rather than a runtime record: turning a page writes no
 * runtime record at all (`lib/store/stage.ts` only touches the zustand store),
 * and the runtime payload validators have no `playback` shape to lend it one.
 * Events are facts the caller asserts — unlike probe evidence, a refusal here
 * is a real failure and answers non-2xx.
 */
const XQ_EVENTS_PATH = '/xq/events';

/**
 * `POST /api/persistence/xq/reviews`: one review round finished.
 *
 * Separate from `/xq/events` because it does more than append a fact: it also
 * closes (or, on a failure, re-arms) the row in `xq_review_schedule`. Routing
 * both through one endpoint keeps the order — fact first, schedule second — in
 * one place. A caller that wrote the event by itself and then failed to touch
 * the schedule would leave a round due forever, which is exactly the state the
 * app was in before this route existed.
 */
const XQ_REVIEWS_PATH = '/xq/reviews';

/**
 * The body of one learning event. Kept narrow on purpose: the writer's own
 * validation (kind against the DDL's CHECK list, `session_started` without a
 * session id) is the single source of truth, and this only rejects shapes it
 * could not carry at all.
 */
interface XqEventBody {
  kind?: unknown;
  stageId?: unknown;
  sceneId?: unknown;
  questionId?: unknown;
  occurredAt?: unknown;
  sessionId?: unknown;
  dedupeKey?: unknown;
  dwellMs?: unknown;
  payload?: unknown;
  source?: unknown;
  endReason?: unknown;
  hintSubtype?: unknown;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * `POST /xq/events` for this app: one event per request, 2xx with the ids the
 * browser needs to continue the session (`sessionId` for the first page view
 * that follows a `session_started`), and `duplicate` so a retry is visible
 * rather than silently doubled.
 *
 * Answering 500 on a write failure is deliberate. Probe recording swallows its
 * failures because it is a by-product of an answer already stored; an event is
 * the thing the caller asked for, and pretending it landed would make the
 * browser's session id diverge from the one in `xq_session`.
 */
async function handleXqEvent(
  request: Request,
  queryable: Queryable,
  responseHeaders: Headers,
): Promise<Response> {
  let body: XqEventBody;
  try {
    body = (await request.json()) as XqEventBody;
  } catch {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', 'request body must be JSON'),
      responseHeaders,
    );
  }
  if (typeof body !== 'object' || body === null) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', 'request body must be an object'),
      responseHeaders,
    );
  }
  const kind = asOptionalString(body.kind);
  const stageId = asOptionalString(body.stageId);
  const occurredAt = asOptionalString(body.occurredAt);
  if (kind === undefined || stageId === undefined || occurredAt === undefined) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', 'kind, stageId and occurredAt are required'),
      responseHeaders,
    );
  }
  if (!XQ_EVENT_KINDS.includes(kind as (typeof XQ_EVENT_KINDS)[number])) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', `unknown event kind: ${kind}`),
      responseHeaders,
    );
  }
  const endReason = asOptionalString(body.endReason);
  if (
    endReason !== undefined &&
    !XQ_END_REASONS.includes(endReason as (typeof XQ_END_REASONS)[number])
  ) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', `unknown end reason: ${endReason}`),
      responseHeaders,
    );
  }
  const hintSubtype = asOptionalString(body.hintSubtype);
  if (
    hintSubtype !== undefined &&
    !XQ_HINT_SUBTYPES.includes(hintSubtype as (typeof XQ_HINT_SUBTYPES)[number])
  ) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', `unknown hint subtype: ${hintSubtype}`),
      responseHeaders,
    );
  }
  try {
    const result = await recordXqEvent(queryable, {
      kind: kind as (typeof XQ_EVENT_KINDS)[number],
      stageId,
      occurredAt,
      ...(asOptionalString(body.sceneId) === undefined
        ? {}
        : { sceneId: asOptionalString(body.sceneId) as string }),
      ...(asOptionalString(body.questionId) === undefined
        ? {}
        : { questionId: asOptionalString(body.questionId) as string }),
      ...(asOptionalString(body.sessionId) === undefined
        ? {}
        : { sessionId: asOptionalString(body.sessionId) as string }),
      ...(asOptionalString(body.dedupeKey) === undefined
        ? {}
        : { dedupeKey: asOptionalString(body.dedupeKey) as string }),
      ...(typeof body.dwellMs === 'number' ? { dwellMs: body.dwellMs } : {}),
      ...(typeof body.payload === 'object' && body.payload !== null && !Array.isArray(body.payload)
        ? { payload: body.payload as Record<string, unknown> }
        : {}),
      ...(asOptionalString(body.source) === undefined
        ? {}
        : { source: asOptionalString(body.source) as 'self' | 'model' | 'system' | 'import' }),
      ...(endReason === undefined
        ? {}
        : { endReason: endReason as (typeof XQ_END_REASONS)[number] }),
      ...(hintSubtype === undefined
        ? {}
        : { hintSubtype: hintSubtype as (typeof XQ_HINT_SUBTYPES)[number] }),
    });
    return withHeaders(
      Response.json(
        { eventId: result.eventId, sessionId: result.sessionId, duplicate: result.duplicate },
        { status: result.duplicate ? 200 : 201 },
      ),
      responseHeaders,
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return withHeaders(jsonError(400, 'VALIDATION_FAILED', error.message), responseHeaders);
    }
    log.error(`xq event write failed: ${error instanceof Error ? error.message : String(error)}`);
    return withHeaders(
      jsonError(500, 'XQ_EVENT_WRITE_FAILED', 'learning event write failed'),
      responseHeaders,
    );
  }
}

/** The body of one review outcome. Same stance as {@link XqEventBody}: narrow. */
interface XqReviewBody {
  stageId?: unknown;
  sceneId?: unknown;
  questionId?: unknown;
  concept?: unknown;
  round?: unknown;
  outcome?: unknown;
  occurredAt?: unknown;
  sessionId?: unknown;
}

/**
 * `POST /xq/reviews` for this app: one review round answered.
 *
 * A missing round answers 404 rather than 400 — the request was well formed,
 * the thing it names is not there. That happens legitimately when a client
 * keeps a stale list: the learner answers a card on a round this device has
 * already reset. Answering 400 would tell it to stop retrying a shape that was
 * never wrong; 404 tells it to reload.
 */
async function handleXqReview(
  request: Request,
  queryable: Queryable,
  responseHeaders: Headers,
): Promise<Response> {
  let body: XqReviewBody;
  try {
    body = (await request.json()) as XqReviewBody;
  } catch {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', 'request body must be JSON'),
      responseHeaders,
    );
  }
  if (typeof body !== 'object' || body === null) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', 'request body must be an object'),
      responseHeaders,
    );
  }
  const stageId = asOptionalString(body.stageId);
  const sceneId = asOptionalString(body.sceneId);
  const questionId = asOptionalString(body.questionId);
  const occurredAt = asOptionalString(body.occurredAt);
  const sessionId = asOptionalString(body.sessionId);
  if (
    stageId === undefined ||
    sceneId === undefined ||
    questionId === undefined ||
    occurredAt === undefined ||
    sessionId === undefined
  ) {
    return withHeaders(
      jsonError(
        400,
        'VALIDATION_FAILED',
        'stageId, sceneId, questionId, occurredAt and sessionId are required',
      ),
      responseHeaders,
    );
  }
  const outcome = asOptionalString(body.outcome);
  if (outcome === undefined) {
    return withHeaders(jsonError(400, 'VALIDATION_FAILED', 'outcome is required'), responseHeaders);
  }
  if (!XQ_REVIEW_OUTCOMES.includes(outcome as (typeof XQ_REVIEW_OUTCOMES)[number])) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', `unknown review outcome: ${outcome}`),
      responseHeaders,
    );
  }
  const round = body.round;
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', 'round must be a positive integer'),
      responseHeaders,
    );
  }
  try {
    const result = await recordXqReview(queryable, {
      stageId,
      sceneId,
      questionId,
      // The concept is whatever the schedule row carries; an empty string is a
      // real value there (rounds are scheduled per question, the concept is an
      // annotation). Defaulting it to '' rather than rejecting keeps a client
      // that does not track concepts working.
      concept: asOptionalString(body.concept) ?? '',
      round,
      outcome: outcome as (typeof XQ_REVIEW_OUTCOMES)[number],
      occurredAt,
      sessionId,
    });
    return withHeaders(
      Response.json(
        { recorded: result.recorded, eventId: result.eventId, duplicate: result.duplicate },
        { status: result.duplicate ? 200 : 201 },
      ),
      responseHeaders,
    );
  } catch (error) {
    if (error instanceof XqReviewRoundMissingError) {
      return withHeaders(jsonError(404, 'REVIEW_ROUND_NOT_FOUND', error.message), responseHeaders);
    }
    if (error instanceof RangeError) {
      return withHeaders(jsonError(400, 'VALIDATION_FAILED', error.message), responseHeaders);
    }
    log.error(`xq review write failed: ${error instanceof Error ? error.message : String(error)}`);
    return withHeaders(
      jsonError(500, 'XQ_REVIEW_WRITE_FAILED', 'review write failed'),
      responseHeaders,
    );
  }
}

function learnerKeyResponse(ownerId: string, responseHeaders: Headers): Response {
  const response = Response.json(
    { learnerKey: ownerId },
    { status: 200, headers: { 'cache-control': 'private, no-store' } },
  );
  return withHeaders(response, responseHeaders);
}

/**
 * Redirect egress and the collection grace must agree: a signed URL that
 * outlives its object turns a valid read into an object-store error. The
 * handler enforces that invariant itself, on the grace passed here, and this
 * grace is resolved by the collector's own parser so both components run on one
 * number.
 *
 * A grace too short for the default lifetime degrades to direct egress with a
 * loud warning rather than failing initialization: the asset backend is
 * optional, and its misconfiguration must never take document and runtime
 * traffic down with it.
 */
function indirectEgressWithinGrace(
  egress: 'redirect' | undefined,
): AssetIndirectByteEgress | undefined {
  if (egress !== 'redirect') return undefined;
  const collectionGraceMs = resolveAssetCollectionGraceMs();
  if (collectionGraceMs < DEFAULT_SIGNED_URL_TTL_SECONDS * 1000 * 10) {
    console.warn(
      `ASSET_BYTE_EGRESS=redirect requires ASSET_COLLECTION_GRACE_MS to be at least ten times ` +
        `the signed URL lifetime (${DEFAULT_SIGNED_URL_TTL_SECONDS}s); got ${collectionGraceMs}ms. ` +
        `Falling back to direct byte egress.`,
    );
    return undefined;
  }
  return { mode: 'redirect', collectionGraceMs };
}

/**
 * The asset id of `PUT /assets/{id}/content`, decoded the way the storage
 * handler decodes the path it routes (a leading slash dropped, each segment
 * percent-decoded). The handler has already matched and decoded this path
 * before admission runs, so a failure here cannot happen in practice.
 */
function routedAssetId(url: string | undefined): string | undefined {
  const parts = (url ?? '/').split('#', 1)[0]!.split('/');
  if (parts[0] === '') parts.shift();
  try {
    return parts[1] === undefined ? undefined : decodeURIComponent(parts[1]);
  } catch {
    return undefined;
  }
}

/**
 * Where the upload-admission hook leaves the answer it wants sent. The package
 * handler can only answer its own `403` when admission is refused, so the
 * route substitutes the host's `Response` for it (see `handlePersistenceRequestInner`).
 */
interface AssetAdmission {
  refusal?: Response;
}

/** The runtime contract's learner merge route, as this route sees it. */
const LEARNER_MERGE_PATH = '/runtime/learners/merge';

/**
 * Whether `principal` may merge runtime learner `from` into `to`: only its own
 * pending claim into itself, from a non-anonymous principal, on a same-origin
 * JSON request (the merge acts on cookies; see `isSameOriginJsonRequest`).
 */
function mayMergeLearner(
  principal: OwnerPrincipal,
  request: Request,
  fromLearnerKey: string,
  toLearnerKey: string,
): boolean {
  return (
    principal.kind !== 'anonymous' &&
    principal.pendingClaim?.fromOwnerId === fromLearnerKey &&
    toLearnerKey === principal.ownerId &&
    isSameOriginJsonRequest(request)
  );
}

/**
 * The runtime store the handler gets, with its learner merge replaced by a
 * claim: a runtime-only re-key would move an owner's sessions and leave its
 * courses, folders and media behind under an id nothing retires. Reached only
 * after `authorizeMerge` allowed it; the canonical spelling of the route is
 * answered before the handler (`handleLearnerMerge`) so refusals get their own
 * status codes, and this covers any other spelling the handler routes.
 */
function mergeThroughClaim(store: RuntimeStore, principal: OwnerPrincipal): RuntimeStore {
  return {
    ...store,
    mergeLearner: async () => {
      const outcome = await runPendingClaim(principal);
      if (!outcome.ok) {
        // Typed, so the handler answers them as the claim endpoint does
        // (`503` for a busy claim, `403` with the refusal's code otherwise)
        // rather than as an internal error.
        if (outcome.refusal === 'OWNER_BUSY') throw new OwnerBusyError();
        throw new DocumentWriteRefusedError('', outcome.refusal, outcome.message);
      }
      return outcome.result.status === 'claimed' ? (outcome.result.moved.runtime ?? 0) : 0;
    },
  };
}

/**
 * `POST /runtime/learners/merge` for this app: the runtime contract's shape
 * (`{ fromLearnerKey, toLearnerKey }` in, `{ moved }` out), performed as a
 * claim, with the claim endpoint's refusals and cookie handling.
 */
async function handleLearnerMerge(
  request: Request,
  principal: OwnerPrincipal,
  responseHeaders: Headers,
): Promise<Response> {
  let body: { fromLearnerKey?: unknown; toLearnerKey?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', 'request body must be JSON'),
      responseHeaders,
    );
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof body.fromLearnerKey !== 'string' ||
    typeof body.toLearnerKey !== 'string' ||
    !mayMergeLearner(principal, request, body.fromLearnerKey, body.toLearnerKey)
  ) {
    return withHeaders(
      jsonError(403, 'FORBIDDEN_LEARNER', 'only your own pending claim can be merged'),
      responseHeaders,
    );
  }
  const outcome = await runPendingClaim(principal);
  for (const cookie of outcome.setCookies) responseHeaders.append('Set-Cookie', cookie);
  if (!outcome.ok) return claimRefusalResponse(outcome, responseHeaders);
  const moved = outcome.result.status === 'claimed' ? (outcome.result.moved.runtime ?? 0) : 0;
  return withHeaders(Response.json({ moved }, { status: 200 }), responseHeaders);
}

/** Methods that only read; every other method may write under the owner. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function createPersistenceHandler(
  connectionString: string,
  principal: OwnerPrincipal,
  access: DocumentAccess,
  request: Request,
  admission: AssetAdmission,
  poolFactory?: PersistencePoolFactory,
): Promise<RequestListener> {
  const { ownerId } = principal;
  const { pool, runtimeStore, assetStore, withTransaction, assetStoreIn } =
    await getServerPersistenceProvider(connectionString, poolFactory);
  const hooks = getPersistenceHooks();
  const documentStore = createOwnerBoundDocumentStore({
    pool,
    ownerId,
    principal,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
  const beforeAssetAllocate = hooks.beforeAssetAllocate;
  // One identity for all three contracts, resolved server-side by the owner
  // identity seam (lib/server/identity/) for this request:
  //
  // - Documents act as the owner.
  // - Runtime sessions are partitioned by learner key, and the learner key IS
  //   the owner id. Nothing the client sends chooses it: a request that names
  //   another learner's partition in its path or body answers 403
  //   FORBIDDEN_LEARNER from the handler, and a session another learner holds
  //   answers 404. The browser learns its key from GET /api/persistence/learner-key.
  // - Assets are partitioned per owner (lib/persistence/owner-assets.ts), so
  //   quota is per owner and replace/delete reach only the owner's own entries
  //   (plus legacy shared entries only their courses reference). Reads stay
  //   capability-by-id for committed media a live course references, so
  //   viewers of a course keep loading its media.
  //
  // Reclamation is not scheduled from here, and must not be: a route module
  // has no once-per-process guarantee and no shutdown hook. AssetCollector
  // runs from instrumentation.ts instead, over the byte store this same
  // lib/persistence/asset-byte-store selection produces, so the collector
  // always deletes through the layer the request path wrote through. The
  // document store this handler mounts is the other half of that mechanism:
  // createOwnerBoundDocumentStore builds it with reference tracking on, which
  // is what gives the entry pass something to read.
  const assetPrincipal = assetPrincipalForOwner(ownerId);
  const byteEgress = indirectEgressWithinGrace(
    configuredAssetByteEgress(process.env.ASSET_BYTE_EGRESS),
  );
  // Order matters: the xq probe recorder is wrapped INSIDE the tombstone guard
  // so a refused write (deleted course) never leaves a probe fact behind, and
  // OUTSIDE it so it sees the record the guard actually allowed through.
  // `mergeThroughClaim` stays outermost: it replaces `mergeLearner`, which
  // neither of the two appendRecord decorators touches.
  const guardedRuntimeStore = mergeThroughClaim(
    withXqProbeRecording(guardedServerRuntimeStore(runtimeStore, pool), { queryable: pool }),
    principal,
  );
  return createStorageHttpHandler(guardedRuntimeStore, documentStore, {
    authenticate: async (request) => {
      if (request.url?.startsWith('/assets')) return assetPrincipal;
      return { learnerKey: ownerId };
    },
    // Upload admission. The package calls this after it has matched the asset
    // route and method and before it reads the body. POST is accepted only on
    // the collection route and PUT only on the content route, so the method
    // alone says which byte-storing operation this is -- by the package's own
    // routing, whatever spelling the path used -- and nothing has been stored
    // or counted against the quota yet.
    ...(beforeAssetAllocate === undefined
      ? {}
      : {
          authorizeAssets: async (_assetPrincipal: unknown, req: IncomingMessage) => {
            const operation =
              req.method === 'POST' ? 'create' : req.method === 'PUT' ? 'replace' : undefined;
            if (operation === undefined) return true;
            const assetId = operation === 'replace' ? routedAssetId(req.url) : undefined;
            const refusal: unknown = await beforeAssetAllocate(principal, {
              operation,
              ...(assetId === undefined ? {} : { assetId }),
              method: request.method,
              url: request.url,
              headers: request.headers,
            });
            if (refusal === undefined) return true;
            if (!(refusal instanceof Response)) {
              throw new Error(
                `Persistence hooks ${hooks.name}: beforeAssetAllocate must resolve undefined or a Response`,
              );
            }
            admission.refusal = refusal;
            return false;
          },
        }),
    // The runtime contract's learner merge is a claim: it is allowed only
    // from the anonymous owner this request presents beside a non-anonymous
    // one (its pendingClaim) into that owner, and it moves everything the
    // anonymous owner holds, not only runtime sessions (see
    // `mergeThroughClaim` below and lib/persistence/owner-claims.ts).
    authorizeMerge: async (_runtimePrincipal, fromLearnerKey, toLearnerKey) =>
      mayMergeLearner(principal, request, fromLearnerKey, toLearnerKey),
    authorizeAdmin: async () => false,
    authorizeDocuments: async () => access === 'allow',
    validateScene: validateAppScene,
    validateStage: validateAppStage,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    assetStore: createOwnerAssetStore(assetStore, {
      ownerId,
      queryable: pool,
      transactions: { withTransaction, storeIn: assetStoreIn },
    }),
    ...(byteEgress === undefined ? {} : { byteEgress }),
  });
}

function routeRelativePath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) || '/' : pathname;
}

function nodeRequest(request: Request): IncomingMessage {
  const url = new URL(request.url);
  const pathname = url.pathname.startsWith(ROUTE_PREFIX)
    ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
    : url.pathname;
  const body = request.body
    ? Readable.fromWeb(
        request.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
      )
    : Readable.from([]);
  return Object.assign(body, {
    method: request.method,
    url: `${pathname}${url.search}`,
    headers: Object.fromEntries(request.headers.entries()),
  }) as IncomingMessage;
}

function setHeaders(target: Headers, source: Record<string, string | number | string[]>): void {
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) target.append(name, item);
    } else {
      target.set(name, String(value));
    }
  }
}

type ResponseCallback = () => void;

function responseEncoding(encodingOrCallback?: BufferEncoding | ResponseCallback): BufferEncoding {
  const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
  if (!Buffer.isEncoding(encoding)) {
    // Let Buffer produce Node's ERR_UNKNOWN_ENCODING TypeError.
    Buffer.from('', encoding);
  }
  return encoding;
}

function responseCallback(
  encodingOrCallback?: BufferEncoding | ResponseCallback,
  callback?: ResponseCallback,
): ResponseCallback | undefined {
  return typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
}

function suppressesResponseBody(request: Request, status: number): boolean {
  return request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
}

function runNodeHandler(handler: RequestListener, request: Request): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let status = 200;
    const headers = new Headers();
    let headersSent = false;
    // Buffered as bytes rather than as a string. A handler may end with a
    // `Uint8Array`, which `ServerResponse.end` accepts and which is not
    // necessarily valid UTF-8; decoding it would replace every unpaired byte
    // with U+FFFD and silently corrupt the response.
    const body: Buffer[] = [];

    const appendChunk = (chunk: string | Uint8Array, encoding: BufferEncoding) => {
      body.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    };

    const response = {
      get headersSent() {
        return headersSent;
      },
      writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | Record<string, string | number | string[]>,
        outgoingHeaders?: Record<string, string | number | string[]>,
      ) {
        status = statusCode;
        headersSent = true;
        const values =
          typeof statusMessageOrHeaders === 'string' ? outgoingHeaders : statusMessageOrHeaders;
        if (values) setHeaders(headers, values);
        return this;
      },
      write(
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ResponseCallback,
        callback?: ResponseCallback,
      ) {
        // `write` is part of the `ServerResponse` surface this object claims to
        // implement. Omitting it made any chunked handler a runtime TypeError
        // that the `as unknown as ServerResponse` cast hid from the compiler.
        headersSent = true;
        appendChunk(chunk, responseEncoding(encodingOrCallback));
        const done = responseCallback(encodingOrCallback, callback);
        if (done) process.nextTick(done);
        return true;
      },
      end(
        chunkOrCallback?: string | Uint8Array | ResponseCallback,
        encodingOrCallback?: BufferEncoding | ResponseCallback,
        callback?: ResponseCallback,
      ) {
        headersSent = true;
        const chunk = typeof chunkOrCallback === 'function' ? undefined : chunkOrCallback;
        const done =
          typeof chunkOrCallback === 'function'
            ? chunkOrCallback
            : responseCallback(encodingOrCallback, callback);
        if (chunk !== undefined) appendChunk(chunk, responseEncoding(encodingOrCallback));
        resolve(
          new Response(
            suppressesResponseBody(request, status) || body.length === 0
              ? undefined
              : Buffer.concat(body),
            {
              status,
              headers,
            },
          ),
        );
        if (done) process.nextTick(done);
        return this;
      },
      destroy(error?: Error) {
        reject(error ?? new Error('Persistence HTTP handler destroyed the response'));
        return this;
      },
    } as unknown as ServerResponse;

    try {
      handler(nodeRequest(request), response);
    } catch (error) {
      reject(error);
    }
  });
}

interface PersistenceRequestDeps {
  poolFactory?: PersistencePoolFactory;
}

function persistenceRequestId(request: Request): string {
  const upstream = request.headers.get('x-request-id')?.trim();
  return upstream && REQUEST_ID_PATTERN.test(upstream) ? upstream : randomUUID();
}

async function responseErrorCode(response: Response): Promise<string> {
  if (!response.headers.get('content-type')?.includes('application/json')) return '-';
  const payload = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { error?: { code?: unknown } } | undefined;
  return typeof payload?.error?.code === 'string' ? payload.error.code : '-';
}

export async function handlePersistenceRequest(
  request: Request,
  deps: PersistenceRequestDeps = {},
): Promise<Response> {
  const requestId = persistenceRequestId(request);
  const response = await handlePersistenceRequestInner(request, deps);
  if (response.status >= 500) {
    const path = new URL(request.url).pathname;
    const code = await responseErrorCode(response);
    log.error(`${request.method} ${path} -> ${response.status} ${code} (requestId=${requestId})`);
  }
  response.headers.set('x-request-id', requestId);
  return response;
}

async function handlePersistenceRequestInner(
  request: Request,
  deps: PersistenceRequestDeps,
): Promise<Response> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return jsonError(404, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');
  }

  return withRequestOwner(request, async (principal, responseHeaders) => {
    const { ownerId } = principal;
    try {
      const path = routeRelativePath(request);
      if (path === LEARNER_KEY_PATH) {
        return request.method === 'GET'
          ? learnerKeyResponse(ownerId, responseHeaders)
          : withHeaders(
              jsonError(405, 'METHOD_NOT_ALLOWED', 'learner-key accepts GET only'),
              responseHeaders,
            );
      }
      if (path === LEARNER_MERGE_PATH && request.method === 'POST') {
        return await handleLearnerMerge(request, principal, responseHeaders);
      }
      // A request that still presents an identity a claim retired writes
      // nothing: its work lives in the account now. What makes that exact is
      // the fence inside every create transaction (documents, folders, asset
      // allocations, runtime sessions), which answers `403 OWNER_RETIRED`
      // itself. This check only answers the common case up front with the
      // same status for every write, including writes by id to rows that
      // moved (which would otherwise read as not found). It costs nothing for
      // an owner that cannot be retired (see `isOwnerRetired`).
      if (!READ_METHODS.has(request.method)) {
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        if (await isOwnerRetired(pool as unknown as Queryable, ownerId)) {
          return withHeaders(ownerRetiredResponse(), responseHeaders);
        }
      }
      // Placed after the retirement fence on purpose: an identity a claim
      // retired appends no learning events either, for the same reason it
      // writes no runtime record.
      if (path === XQ_EVENTS_PATH) {
        if (request.method !== 'POST') {
          return withHeaders(
            jsonError(405, 'METHOD_NOT_ALLOWED', 'xq/events accepts POST only'),
            responseHeaders,
          );
        }
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        return await handleXqEvent(request, pool as unknown as Queryable, responseHeaders);
      }
      if (path === XQ_REVIEWS_PATH) {
        if (request.method !== 'POST') {
          return withHeaders(
            jsonError(405, 'METHOD_NOT_ALLOWED', 'xq/reviews accepts POST only'),
            responseHeaders,
          );
        }
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        return await handleXqReview(request, pool as unknown as Queryable, responseHeaders);
      }
      const action = parseDocumentAction(request.method, path);
      let access: DocumentAccess = 'allow';
      if (path === '/documents' || path.startsWith('/documents/')) {
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        const queryable = pool;
        access = await decideDocumentAccess(
          action,
          ownerId,
          (stageId) => readStageMeta(queryable, stageId),
          (stageId) =>
            pool
              .query('SELECT 1 FROM document_stages WHERE id = $1', [stageId])
              .then((result) => result.rows.length > 0),
          (stageId) => readStageMeta(queryable, stageId),
        );
      }

      const admission: AssetAdmission = {};
      const handled =
        access === 'not-found'
          ? jsonError(404, 'DOCUMENT_NOT_FOUND', '@openmaic/storage: document not found')
          : await runNodeHandler(
              await createPersistenceHandler(
                connectionString,
                principal,
                access,
                request,
                admission,
                deps.poolFactory,
              ),
              request,
            );
      const answered = admission.refusal ?? handled;
      // A write the fence refused inside its transaction: drop the retired
      // credential, as the up-front answer above does.
      if (answered.status === 403 && (await responseErrorCode(answered)) === OWNER_RETIRED) {
        for (const cookie of retiredCredentialCookies())
          responseHeaders.append('Set-Cookie', cookie);
      }
      return withHeaders(answered, responseHeaders);
    } catch (error) {
      console.error('Embedded persistence route initialization failed', error);
      return withHeaders(
        jsonError(500, 'PERSISTENCE_INIT_FAILED', 'server persistence initialization failed'),
        responseHeaders,
      );
    }
  });
}

export const GET = (request: Request) => handlePersistenceRequest(request);
export const POST = (request: Request) => handlePersistenceRequest(request);
export const PUT = (request: Request) => handlePersistenceRequest(request);
export const PATCH = (request: Request) => handlePersistenceRequest(request);
export const DELETE = (request: Request) => handlePersistenceRequest(request);
