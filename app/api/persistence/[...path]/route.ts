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
import { refreshLearnerStateWithConnection } from '@/lib/server/agent-runtime/learner-state';
import { withXqProbeRecording } from '@/lib/persistence/xq-probe-recorder';
import {
  ANSWER_FIRST_CODE,
  hasPriorAnswerEvent,
  hintGateApplies,
  XqAnswerNotStartedError,
} from '@/lib/persistence/xq-hint-gate';
import {
  recordXqEvent,
  XQ_END_REASONS,
  XQ_EVENT_KINDS,
  XQ_HINT_SUBTYPES,
} from '@/lib/persistence/xq-event-recorder';
import { digestSessions, SESSION_DIGEST_LIMIT } from '@/lib/persistence/xq-session-digest';
import { sweepStaleSessions } from '@/lib/persistence/xq-session-sweeper';
import {
  recordXqReview,
  XqReviewRoundMissingError,
  XQ_REVIEW_OUTCOMES,
} from '@/lib/persistence/xq-review-recorder';
import { DUE_REVIEW_CARD_LIMIT, listDueReviewCards } from '@/lib/persistence/xq-review-queue';
import { readConceptMastery } from '@/lib/persistence/xq-concept-mastery';
import { AI_LOG_LIMIT, readAiLog } from '@/lib/persistence/xq-ai-log';
import {
  DEFAULT_PREREQ_STRENGTHS,
  PREREQ_STRENGTHS,
  conceptReadiness,
  directPrerequisites,
  prerequisiteClosure,
  prerequisiteDepth,
  prerequisiteEvidence,
  readConceptGraph,
  readConceptOccurrences,
  readPageTitles,
  resolveConcept,
  type PrereqStrength,
} from '@/lib/persistence/xq-concept-graph';
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
 * `GET /api/persistence/xq/sessions`: what the append-only event stream folds to.
 *
 * Read-only and deliberately separate from `/xq/events`: the writer never
 * computes aggregates (see the recorder's "why not judge here" header), so the
 * only way those numbers exist is somebody reading the stream and folding it.
 * This is that reader. It reads `xq_event` and never writes `xq_session` —
 * `active_ms` stays derived on demand because it changes with every new event.
 */
const XQ_SESSIONS_PATH = '/xq/sessions';
const XQ_AI_LOG_PATH = '/xq/ai-log';
const XQ_CONCEPTS_PATH = '/xq/concepts';

/**
 * A study day as `xq_session.local_day` stores it.
 *
 * Validated before it reaches SQL: `$1::date` on a garbage string is a driver
 * error (500), and the caller's mistake is a 400.
 */
const STUDY_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
  const sceneId = asOptionalString(body.sceneId);
  const questionId = asOptionalString(body.questionId);
  // ★ 形状先于闸。`hint_requested` 不带 `hintSubtype` 是**请求写错了**，
  // 该回 400；如果让它走到闸那里，闸会先跑、抛 `XqAnswerNotStartedError`，
  // 前端拿到的是 409「先答题」—— 而真正的问题是它少发了一个字段，
  // 学生按提示去答题、再点一次，仍然 409。这个错位是实测出来的：
  // 一次 `hint_requested` 漏了 `hintSubtype`，回来的是 409 而不是 400。
  if (kind === 'hint_requested' && hintSubtype === undefined) {
    return withHeaders(
      jsonError(
        400,
        'VALIDATION_FAILED',
        'xq: hint_requested needs a hintSubtype (instrumental or executive)',
      ),
      responseHeaders,
    );
  }
  try {
    // 提问闸：同一道题上没先动过手，`instrumental` 提问在落库之前就被挡掉。
    // 放在**写入侧**是刻意的 —— UI 侧挡不住直接调接口，而闸的意义是
    // 「这件事在系统里不允许发生」，不是「界面上不好点」。
    // `executive` 与页面级提问不受管（见 `hintGateApplies`）。
    if (hintGateApplies(kind, questionId, hintSubtype) && sceneId !== undefined) {
      const occurredDate = new Date(occurredAt);
      if (!Number.isNaN(occurredDate.getTime())) {
        const ready = await hasPriorAnswerEvent(queryable, {
          stageId,
          sceneId,
          questionId: questionId as string,
          occurredAt: occurredDate,
        });
        if (!ready) {
          throw new XqAnswerNotStartedError(stageId, sceneId, questionId as string);
        }
      }
    }
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
    if (error instanceof XqAnswerNotStartedError) {
      // 409 而不是 400：请求形状没错，是**顺序**不对。客户端据此把「问」
      // 按钮换成「先写下你的想法」，而不是提示「请求有误」。
      return withHeaders(
        jsonError(409, ANSWER_FIRST_CODE, 'answer the question before asking for a hint'),
        responseHeaders,
      );
    }
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
    // A closed round changes what is due, and "what is due" is rendered into the
    // status block. Same fire-and-forget reasoning as the probe path.
    if (result.recorded) {
      void refreshLearnerStateWithConnection(queryable);
    }
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

/**
 * `GET /api/persistence/xq/sessions`: the event stream folded into sessions.
 *
 * `day` is a **study day** (`yyyy-mm-dd`, 04:00 boundary), not a calendar date:
 * "what did I learn today" is answered against the same boundary the writer
 * used when it assigned `local_day`. Omitting it spans every day rather than
 * guessing the caller's timezone — a guess would silently answer a different
 * question than the one asked.
 *
 * `limit` is clamped like the review queue's: unbounded would read every
 * session ever recorded.
 */
/**
 * `GET /api/persistence/xq/ai-log`: what he asked the AI, and where those
 * conversations are.
 *
 * The two halves live apart on purpose (content in `runtime_records`, the fact
 * in `xq_event`), so this endpoint is the only place that joins them. Reading
 * either half alone answers a different question: the fact without the content
 * says "he asked something about q3" and cannot show what he said.
 *
 * `day` is a study day (`yyyy-mm-dd`, 04:00 boundary) and is validated rather
 * than ignored, for the same reason as the session digest: silently widening to
 * every day looks like a valid answer to a narrower question.
 */
async function handleXqAiLog(
  request: Request,
  queryable: Queryable,
  responseHeaders: Headers,
): Promise<Response> {
  const url = new URL(request.url);
  const rawDay = url.searchParams.get('day');
  const rawLimit = url.searchParams.get('limit');
  const parsed = rawLimit === null ? NaN : Number(rawLimit);
  const limit =
    Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), AI_LOG_LIMIT) : undefined;
  const day = rawDay === null || rawDay === '' ? undefined : rawDay;
  if (day !== undefined && !STUDY_DAY_PATTERN.test(day)) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', 'day must be a study day (yyyy-mm-dd)'),
      responseHeaders,
    );
  }
  try {
    const entries = await readAiLog(queryable, {
      ...(day === undefined ? {} : { day }),
      ...(limit === undefined ? {} : { limit }),
    });
    return withHeaders(
      Response.json(
        {
          entries: entries.map((entry) => ({
            eventId: entry.eventId,
            occurredAt: entry.occurredAt.toISOString(),
            stageId: entry.stageId,
            sceneId: entry.sceneId,
            questionId: entry.questionId,
            hintSubtype: entry.hintSubtype,
            stem: entry.stem,
            generations: entry.generations,
            turns: entry.turns.map((turn) => ({
              recordId: turn.recordId,
              runtimeSessionId: turn.runtimeSessionId,
              generation: turn.generation,
              createdAt: turn.createdAt.toISOString(),
              role: turn.role,
              text: turn.text,
              truncated: turn.truncated,
            })),
          })),
        },
        // Per-owner and time-dependent: a new ask appears immediately.
        { status: 200, headers: { 'cache-control': 'private, no-store' } },
      ),
      responseHeaders,
    );
  } catch (error) {
    log.error(`xq ai log read failed: ${error instanceof Error ? error.message : String(error)}`);
    return withHeaders(
      jsonError(500, 'XQ_AI_LOG_FAILED', 'failed to read the conversation log'),
      responseHeaders,
    );
  }
}

async function handleXqSessionDigest(
  request: Request,
  queryable: Queryable,
  responseHeaders: Headers,
): Promise<Response> {
  const url = new URL(request.url);
  const rawDay = url.searchParams.get('day');
  const rawLimit = url.searchParams.get('limit');
  const parsed = rawLimit === null ? NaN : Number(rawLimit);
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.trunc(parsed), SESSION_DIGEST_LIMIT)
      : undefined;
  // An empty `?day=` means "not given", not "the empty study day".
  const day = rawDay === null || rawDay === '' ? undefined : rawDay;
  // A malformed day is rejected rather than ignored. Ignoring it would widen the
  // answer to every day — the caller asked "what did I learn on this day" and
  // would have been handed "everything ever", which looks like an answer.
  if (day !== undefined && !STUDY_DAY_PATTERN.test(day)) {
    return withHeaders(
      jsonError(400, 'VALIDATION_FAILED', 'day must be a study day (yyyy-mm-dd)'),
      responseHeaders,
    );
  }
  try {
    // ★ 读之前先把**死会话**收掉。
    //
    // 这个视图正是被死会话弄坏的那一个：合计只累加已结束的会话（进行中那一个
    // 的活跃毫秒会越算越小，算进去会让合计倒退），而断电、浏览器崩溃、
    // `keepalive` 被中间层截掉这三种情况下客户端不会再跑一行代码 —— 会话在库里
    // 永远开着，那一次学习就被永久地从「今天学了多久」里抹掉。
    //
    // 让读顺手修，是因为**没有别的地方会来修**：这是唯一一个会被打开、
    // 且正好关心这件事的入口。操作本身是幂等的（幂等键用最后一条事件的时刻，
    // 不是 now()），失败也不影响读（下面 catch 到就当作没收）。
    try {
      await sweepStaleSessions(queryable);
    } catch (error) {
      log.warn({ error }, 'xq session sweep failed; reading anyway');
    }
    const sessions = await digestSessions(queryable, {
      ...(day === undefined ? {} : { day }),
      ...(limit === undefined ? {} : { limit }),
    });
    return withHeaders(
      Response.json(
        {
          sessions: sessions.map((session) => ({
            sessionId: session.sessionId,
            startedAt: session.startedAt.toISOString(),
            endedAt: session.endedAt === null ? null : session.endedAt.toISOString(),
            endReason: session.endReason,
            seqNo: session.seqNo,
            eventCount: session.eventCount,
            pageCount: session.pageCount,
            activeMs: session.activeMs,
            wallMs: session.wallMs,
            hints: session.hints,
            answers: session.answers,
          })),
        },
        // Time-dependent and per-owner: a new event changes `activeMs` at once.
        { status: 200, headers: { 'cache-control': 'private, no-store' } },
      ),
      responseHeaders,
    );
  } catch (error) {
    log.error(
      `xq session digest read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return withHeaders(
      jsonError(500, 'XQ_SESSION_DIGEST_FAILED', 'session digest read failed'),
      responseHeaders,
    );
  }
}

/**
 * `GET /api/persistence/xq/concepts`: what the concept graph says about one
 * concept, or about the graph as a whole.
 *
 * Before this existed, `xq_concept_edge` had 94 `prereq` rows and **zero
 * readers**. The spec freezes a line: no ordering may ship before somebody
 * actually reads these edges. This is the reading — deliberately not the
 * ordering. It answers "what has to come first", never "what should he learn
 * next": the second is a product decision and belongs above this layer.
 *
 * `strengths` picks which evidence tiers count. It defaults to `strict` only
 * because "can he learn this" is an interception test, and accepting
 * `recommended` too would mark 92 of 104 concepts as "not yet" — that is not a
 * constraint, that is a locked graph. Callers who want the looser reading ask
 * for it explicitly.
 *
 * `mastered` is supplied by the caller and never derived here: today "he knows
 * it" exists only at the page level (`xq_cell_state.tri`), and writing that
 * judgement into this module would turn a graph reader into a judge.
 */
async function handleXqConcepts(
  request: Request,
  queryable: Queryable,
  responseHeaders: Headers,
): Promise<Response> {
  const url = new URL(request.url);
  const rawId = url.searchParams.get('id');
  const rawStrengths = url.searchParams.get('strengths');
  const rawMastered = url.searchParams.get('mastered');

  const strengths = new Set<PrereqStrength>(DEFAULT_PREREQ_STRENGTHS);
  if (rawStrengths !== null && rawStrengths !== '') {
    strengths.clear();
    for (const part of rawStrengths.split(',')) {
      const trimmed = part.trim();
      if (!(PREREQ_STRENGTHS as readonly string[]).includes(trimmed)) {
        return withHeaders(
          jsonError(
            400,
            'VALIDATION_FAILED',
            `unknown prerequisite strength: ${trimmed} (expected ${PREREQ_STRENGTHS.join(', ')})`,
          ),
          responseHeaders,
        );
      }
      strengths.add(trimmed as PrereqStrength);
    }
    // An empty strength set means "no prerequisites count", which reads like a
    // graph with no edges. Refuse it rather than hand back a quietly empty answer.
    if (strengths.size === 0) {
      return withHeaders(
        jsonError(400, 'VALIDATION_FAILED', 'strengths must name at least one tier'),
        responseHeaders,
      );
    }
  }

  const mastered = new Set<string>();
  if (rawMastered !== null && rawMastered !== '') {
    for (const part of rawMastered.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '') mastered.add(trimmed);
    }
  }

  try {
    const graph = await readConceptGraph(queryable);
    const id = rawId === null || rawId === '' ? null : rawId;
    const activeStrengths = [...strengths].sort();

    if (id === null) {
      const byRelation = { prereq: 0, contains: 0 };
      const byStrength = { strict: 0, recommended: 0, helpful: 0 };
      for (const edge of graph.edges) {
        byRelation[edge.relation] += 1;
        if (edge.relation === 'prereq' && edge.strength !== null) byStrength[edge.strength] += 1;
      }
      return withHeaders(
        Response.json(
          {
            concepts: graph.nodes.size,
            edges: graph.edges.length,
            byRelation,
            byStrength,
            retired: [...graph.nodes.values()].filter((node) => node.status !== 'active').length,
            strengths: activeStrengths,
            // No ordering, no recommendation: the shape of the graph only.
          },
          { status: 200, headers: { 'cache-control': 'private, no-store' } },
        ),
        responseHeaders,
      );
    }

    const resolved = resolveConcept(graph, id);
    if (resolved === null) {
      return withHeaders(
        jsonError(404, 'CONCEPT_NOT_FOUND', `concept ${id} does not resolve to an active identity`),
        responseHeaders,
      );
    }
    const node = graph.nodes.get(resolved);
    const direct = directPrerequisites(graph, resolved, strengths);
    const closured = prerequisiteClosure(graph, resolved, strengths);
    const readiness = conceptReadiness(graph, resolved, mastered, strengths);
    // 出现记录与先修是同一张图的两半：`xq_concept_occurrence` 也有 644 行零读方。
    // 查不到就是空数组（「还没有哪一页讲过它」），不是 null。
    const occurrences = await readConceptOccurrences(queryable, [resolved]);
    const refs = (occurrences.get(resolved) ?? []).map((occurrence) => ({
      stageId: occurrence.stageId,
      sceneId: occurrence.sceneId,
      title: null,
    }));
    const titles = await readPageTitles(queryable, refs);

    return withHeaders(
      Response.json(
        {
          id: resolved,
          // A merged id still answers — but the caller must know the id it asked
          // for is not the one the answer is about.
          ...(resolved === id ? {} : { resolvedFrom: id }),
          canonicalName: node?.canonicalName ?? null,
          kind: node?.kind ?? null,
          status: node?.status ?? null,
          createdIn: node?.createdIn ?? null,
          retiredIn: node?.retiredIn ?? null,
          strengths: activeStrengths,
          prerequisites: direct.prerequisites,
          // ★ 依据与结论分开回：上面那行是「所以要先学这些」（去重、已解析合并），
          // 这一行是「凭什么这么说」（一条边一行，带来源与档位，重复保留）。
          // SR-F11.3 要的是后者能被核对 —— 只给结论的话，「来源不明」这个判断
          // 在调用方那里无从做出。
          prerequisiteEvidence: prerequisiteEvidence(graph, resolved, strengths),
          unresolvedPrerequisites: direct.unresolved,
          closure: closured.closure,
          retiredPrerequisites: closured.retired,
          cycle: closured.cycle,
          depth: prerequisiteDepth(graph, resolved, strengths),
          ready: readiness.ready,
          blockedBy: readiness.blockedBy,
          masteredCount: [...mastered].length,
          occurrences: (occurrences.get(resolved) ?? []).map((occurrence) => ({
            stageId: occurrence.stageId,
            sceneId: occurrence.sceneId,
            // 页被删/没标题时是 null —— 与「这页没有标题」分开说不了，
            // 但至少不编一个空串当标题。
            title: titles.get(`${occurrence.stageId}\u0000${occurrence.sceneId}`) ?? null,
            weight: occurrence.weight,
            source: occurrence.source,
          })),
        },
        { status: 200, headers: { 'cache-control': 'private, no-store' } },
      ),
      responseHeaders,
    );
  } catch (error) {
    log.error({ error }, 'xq concept graph read failed');
    return withHeaders(
      jsonError(500, 'XQ_CONCEPTS_FAILED', 'failed to read the concept graph'),
      responseHeaders,
    );
  }
}

/**
 * `GET /api/persistence/xq/reviews`: the rounds that are due right now, with
 * the page title and question stem already joined on.
 *
 * Same path as the write, different method. A client that can list what is due
 * and close a round is a review surface; both halves address one resource, so
 * they share one URL and differ by method — the same shape `learner-key` uses.
 *
 * `limit` is the only knob, and it is clamped rather than trusted: an
 * unbounded list is one `?limit=100000` away from reading every due row ever
 * scheduled. A malformed limit is not an error — it falls back to the default,
 * because the caller asked for a list and the list is still meaningful.
 */
async function handleXqReviewQueue(
  request: Request,
  queryable: Queryable,
  responseHeaders: Headers,
): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit');
  const parsed = rawLimit === null ? NaN : Number(rawLimit);
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.trunc(parsed), DUE_REVIEW_CARD_LIMIT)
      : undefined;
  try {
    const cards = await listDueReviewCards(queryable, limit === undefined ? {} : { limit });

    // ★ 每张卡顺带一句「这个概念他到底会不会」。
    //
    // 为什么不放在卡里算：`listDueReviewCards` 是**排期**的读侧（一张卡 = 一关），
    // 而「会不会」是**证据**的读侧（一个概念 = 跨课跨页的全部观测）。两件事的
    // 粒度不同 —— 同一道题的四关共享同一个概念判定，逐卡算会把同一份证据
    // 折四遍，而且四张卡之间可能给出不一致的答案（如果中间有新证据进来）。
    //
    // 所以：先按概念去重，一次算完，再把结果贴回每张卡。算失败不影响排期 ——
    // 「今天该复习什么」比「他大概会不会」重要，前者不该被后者拖垮。
    // ★ 不传 `stageIds`：一个概念可能在三门课的五个页面上各考过一道题，
    // 只统计「今天恰好有到期关的那几门课」会把别的课的证据悄悄排除掉 ——
    // 排除之后照样给出一个看着很确定的读数，比不给更坏。
    const concepts = [...new Set(cards.map((card) => card.concept).filter((name) => name !== ''))];
    let mastery = new Map<string, { tri: string; n: number; questions: number }>();
    if (concepts.length > 0) {
      try {
        const rows = await readConceptMastery(queryable, { concepts });
        mastery = new Map(
          rows.map((row) => [
            row.concept,
            { tri: row.verdict.tri, n: row.verdict.n, questions: row.questions },
          ]),
        );
      } catch (error) {
        log.warn({ error }, 'xq review queue: concept mastery read failed; serving cards alone');
      }
    }

    return withHeaders(
      Response.json(
        {
          reviews: cards.map((card) => ({
            stageId: card.stageId,
            sceneId: card.sceneId,
            sceneTitle: card.sceneTitle,
            questionId: card.questionId,
            questionStem: card.questionStem,
            concept: card.concept,
            round: card.round,
            dueAt: card.dueAt.toISOString(),
            // `null` 是「这个概念没有可判的证据」，不是「不会」——
            // 卡片上不许把这两件事画成同一句（同 `/sessions` 的 readFailed/empty）。
            mastery: mastery.get(card.concept) ?? null,
          })),
        },
        // Per-owner and time-dependent: the list changes as soon as a round is
        // closed, and a cached copy would keep offering work already done.
        { status: 200, headers: { 'cache-control': 'private, no-store' } },
      ),
      responseHeaders,
    );
  } catch (error) {
    log.error(
      `xq review queue read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return withHeaders(
      jsonError(500, 'XQ_REVIEW_QUEUE_FAILED', 'review queue read failed'),
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
  // The status block is a FILE and only refreshes when someone asks it to. Until
  // now the single caller was the agent runner's startup, so a learner who
  // answered a question and closed the tab left the file describing a previous
  // day (measured: 946 bytes on disk vs 1405 rendered from the same database).
  // Fire-and-forget on purpose: the write already succeeded, and the block is a
  // derived projection -- failing to refresh it must not fail the answer.
  const guardedRuntimeStore = mergeThroughClaim(
    withXqProbeRecording(guardedServerRuntimeStore(runtimeStore, pool), {
      queryable: pool,
      onRecorded: () => {
        void refreshLearnerStateWithConnection(pool as unknown as Queryable);
      },
    }),
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
      if (path === XQ_SESSIONS_PATH) {
        if (request.method !== 'GET') {
          return withHeaders(
            jsonError(405, 'METHOD_NOT_ALLOWED', 'xq/sessions accepts GET only'),
            responseHeaders,
          );
        }
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        return await handleXqSessionDigest(request, pool as unknown as Queryable, responseHeaders);
      }
      if (path === XQ_AI_LOG_PATH) {
        if (request.method !== 'GET') {
          return withHeaders(
            jsonError(405, 'METHOD_NOT_ALLOWED', 'xq/ai-log accepts GET only'),
            responseHeaders,
          );
        }
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        return await handleXqAiLog(request, pool as unknown as Queryable, responseHeaders);
      }
      if (path === XQ_CONCEPTS_PATH) {
        if (request.method !== 'GET') {
          return withHeaders(
            jsonError(405, 'METHOD_NOT_ALLOWED', 'xq/concepts accepts GET only'),
            responseHeaders,
          );
        }
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        return await handleXqConcepts(request, pool as unknown as Queryable, responseHeaders);
      }
      if (path === XQ_REVIEWS_PATH) {
        if (request.method === 'GET') {
          const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
          return await handleXqReviewQueue(request, pool as unknown as Queryable, responseHeaders);
        }
        if (request.method !== 'POST') {
          return withHeaders(
            jsonError(405, 'METHOD_NOT_ALLOWED', 'xq/reviews accepts GET or POST'),
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
