/**
 * 答题状态折叠器 —— 把 quiz 的 runtime 记录折叠成「这一页他学成什么样」。
 *
 * ── 为什么需要（本部署实测，2026-10）────────────────────────────────
 *
 * 作答**已经在记了**。`runtime_records` 里 33 条 quiz 记录，覆盖
 * 草稿 27 / 交卷 3 / 批改 3，每条带 `sceneId`、`seq` 与 owner 分区。
 *
 * 但**没有任何东西把它折叠成状态**：库里只有「某次作答的草稿」，没有
 * 「这个考点学没学会」。于是页面生成时看不到它，题目照旧从零出 ——
 * 这就是「没讲就考」「错过的再也不考」的来源。
 *
 * ── 为什么是纯函数，不是新表 ──────────────────────────────────────
 *
 * 记录走的是通用 `runtime_records`（库里没有 quiz 表），所以折叠这层
 * **存储零改动**：记录进、状态出。形状照 `lib/pbl/v2/runtime/fold.ts`
 * —— PBL 页的状态机已经是「designTemplate + records → learnerState +
 * diagnostics.gaps」，普通课程没有理由再造一套。PBL 与普通课程共用同一种
 * 状态语义，是这里刻意选的，不是巧合。
 *
 * ── 判据：哪条比哪条新 ────────────────────────────────────────────
 *
 *   · **会话之间**：`createdAt`，相同再比 id —— 与 `lib/quiz/runtime.ts` 的
 *     `compareSessionCreationOrder` 同一口径（重试是 `:retry:N` 子会话）。
 *   · **会话内部**：`seq`（store 赋的单调序号）。**绝不按时间戳排** ——
 *     DSL 明说 seq 才是唯一的重放序。
 *
 * ── 输出的两种「错」，别混 ─────────────────────────────────────────
 *
 *   · `incorrectNow` —— 最近一次批改里错的：**现在就不稳**，该马上补。
 *   · `everIncorrect` —— 历史上错过（含已经改对的）：**间隔重考**的候选。
 *
 * 两个都留，是因为它们服务两件不同的事。折叠器不替调用方猜该用哪个。
 *
 * ── 丢掉的记录要说话 ───────────────────────────────────────────────
 *
 * 读不懂的 payload、锚不到页面的记录、会话列表里没有的会话 —— 一律进
 * `skipped` 并带原因，**不静默丢弃**。一份悄悄变少的输入会让下游把
 * 「没记录」误读成「没答过」。
 */
import {
  isQuizAttemptSkeleton,
  type QuizAttemptPhase,
  type RuntimeRecord,
} from '@openmaic/dsl';

import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';

/** 本应用拥有的 payload 版本。DSL 的 skeleton 校验不含它。 */
const PAYLOAD_VERSION = 1;

/** 折叠需要知道的会话字段 —— `RuntimeSession` 的子集，好让本模块不依赖存储层。 */
export interface QuizFoldSession {
  id: string;
  /**
   * 这一场答题会话属于哪门课。
   *
   * ★ **必须有** —— `document_scenes` 的主键是 `(stage_id, id)`，也就是
   * `scene-p9` 这种 id **只在 stage 内唯一**（本部署实测：`scene-p7`/`p9`/`p12`
   * 各有 6 个 stage 在用）。只按 `sceneId` 做键会把两门课的同名页面
   * **合并成一页**，而下游（把题号还原成题干）会取到**另一门课的题干**。
   */
  stageId: string;
  status: 'active' | 'completed';
  createdAt: string;
}

/** 一条被跳过的记录，与它为什么被跳过。 */
export interface QuizFoldSkip {
  recordId: string;
  sessionId: string;
  reason: 'unreadable-payload' | 'unanchored' | 'mixed-anchor' | 'unknown-session';
}

/** 一道题的最新判定。 */
export interface QuizQuestionState {
  questionId: string;
  status: 'correct' | 'incorrect';
  earned: number;
  /** 学习者最新的作答；记录里没有这个题号时缺省。 */
  answer?: string | string[];
}

/** 一页自检折叠出来的状态。 */
export interface QuizSceneState {
  /** 这一页属于哪门课 —— 与 `sceneId` 一起才唯一（见 `QuizFoldSession.stageId`）。 */
  stageId: string;
  sceneId: string;
  /**
   * 折进这一页的**可读记录条数**。
   *
   * 存在的理由是一个不变式：`Σ scenes[].records + skipped.length` 必须等于
   * 输入记录总数。少了这一列，「记录被悄悄吃掉」就没有任何判据。
   */
  records: number;
  /** 折进这一页的会话数（含只写了草稿的）。 */
  sessions: number;
  /** 走到「交卷」及以后的会话数。只写草稿不算一次尝试。 */
  attempts: number;
  /** 最新一条可读记录的阶段；这一页从没有过可读记录时为 null。 */
  phase: QuizAttemptPhase | null;
  /** 最新的作答（不论最新那条是草稿、交卷还是批改）。 */
  answers: QuizAnswers;
  /** 最新一次批改的逐题判定；还没批改过时为空。 */
  questions: QuizQuestionState[];
  /** 最新一次批改里判错的题号 —— 现在就不稳。 */
  incorrectNow: string[];
  /** 历史上被判错过的题号（含已经改对的）—— 重考候选。 */
  everIncorrect: string[];
  /**
   * 最新一次批改的得分原值。
   *
   * 是**原值不是百分比**：满分不在记录流里（`QuestionResult` 只有 `earned`），
   * 所以这里不编一个分母出来。要百分比得回去读题目的 `points`。
   */
  earned: number;
  correctCount: number;
  incorrectCount: number;
  /** 最早 / 最新一条被折进来的记录的 createdAt。 */
  firstAt: string | null;
  lastAt: string | null;
}

export interface QuizAttemptFold {
  /** 按页面首次出现（= 首次作答）的先后排序。 */
  scenes: QuizSceneState[];
  skipped: QuizFoldSkip[];
}

export interface FoldQuizAttemptsInput {
  /** 同一 stage、同一 learner 的会话；顺序无所谓，本函数自己排。 */
  sessions: readonly QuizFoldSession[];
  /** 该会话集合的记录；`sessionId` 对不上的会进 `skipped`。 */
  records: readonly RuntimeRecord[];
}

interface SceneAccumulator {
  stageId: string;
  sceneId: string;
  records: { payload: { phase: QuizAttemptPhase; answers: QuizAnswers; results?: QuestionResult[] }; at: string }[];
  sessionIds: Set<string>;
  attemptSessions: number;
}

/**
 * 页面身份 = `(stageId, sceneId)`。
 *
 * 分隔符用 NUL：stageId 是 `stage-xxxx` 形态，sceneId 是 `scene-pN`，都不会含它，
 * 所以不存在两个不同身份拼出同一个键的可能。
 */
export function sceneKey(stageId: string, sceneId: string): string {
  return `${stageId}\u0000${sceneId}`;
}

/** 会话排序 —— 与 `lib/quiz/runtime.ts` 的 `compareSessionCreationOrder` 同口径。 */
function compareSessions(left: QuizFoldSession, right: QuizFoldSession): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * 读一条记录的应用层 payload。
 *
 * 结构性判据（phase 合法、answers 是普通对象）直接复用 DSL 自己的
 * `isQuizAttemptSkeleton`，不在这里再写一遍。本函数只补两件 DSL 不该知道的事：
 * 应用的 `payloadVersion`，以及把 `unknown` 的作答值收窄成 `QuizAnswers`。
 */
function readPayload(
  record: RuntimeRecord,
): { phase: QuizAttemptPhase; answers: QuizAnswers; results?: QuestionResult[] } | undefined {
  const payload = record.payload;
  if (!isQuizAttemptSkeleton(payload)) return undefined;
  const versioned = payload as { payloadVersion?: unknown; results?: unknown };
  if (versioned.payloadVersion !== PAYLOAD_VERSION) return undefined;
  return {
    phase: payload.phase,
    answers: normalizeAnswers(payload.answers),
    ...(Array.isArray(versioned.results) ? { results: normalizeResults(versioned.results) } : {}),
  };
}

/**
 * 收窄逐题判定。
 *
 * 一条写坏的判定不该让整次折叠抛异常 —— 它的代价只是少一道题的判定，而异常
 * 的代价是整门课的状态都没有。所以逐条挑：题号必须是字符串，`status` 必须是
 * 两个已知值之一，`earned` 不是有限数就按 0 记。
 */
function normalizeResults(value: readonly unknown[]): QuestionResult[] {
  const results: QuestionResult[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Partial<QuestionResult>;
    if (typeof candidate.questionId !== 'string') continue;
    if (candidate.status !== 'correct' && candidate.status !== 'incorrect') continue;
    results.push({
      questionId: candidate.questionId,
      status: candidate.status,
      correct: typeof candidate.correct === 'boolean' ? candidate.correct : null,
      earned: typeof candidate.earned === 'number' && Number.isFinite(candidate.earned)
        ? candidate.earned
        : 0,
    });
  }
  return results;
}

/**
 * 收窄作答值。
 *
 * `QuizAttemptSkeleton.answers` 的值是 app-owned 的 `unknown`，所以这里只放行
 * 两种合法形状（`string` / `string[]`），其余丢掉。丢掉而不是原样透传，是因为
 * 这些值会喂给出题（哪些题要重考）—— 让垃圾流进去，比少一个答案更贵。
 */
function normalizeAnswers(value: Record<string, unknown>): QuizAnswers {
  const answers: QuizAnswers = {};
  for (const [questionId, answer] of Object.entries(value)) {
    if (typeof answer === 'string') {
      answers[questionId] = answer;
      continue;
    }
    if (Array.isArray(answer) && answer.every((item) => typeof item === 'string')) {
      answers[questionId] = [...(answer as string[])];
    }
  }
  return answers;
}

/** 判错：`status` 与 `correct` 通常一致，任一为假都算错（短答题的 `correct` 可为 null）。 */
function isIncorrectResult(result: QuestionResult): boolean {
  return result.status === 'incorrect' || result.correct === false;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * 折叠。
 *
 * 一趟扫描：会话按创建序、会话内按 seq；每条可读记录写进它所属页面的
 * 累加器。会话与页面的锚定关系取自记录本身（quiz 写入器拒绝同一会话挂到
 * 第二个页面，见 `lib/quiz/runtime.ts`），不靠解析 sessionId 里的编码字段。
 */
export function foldQuizAttempts(input: FoldQuizAttemptsInput): QuizAttemptFold {
  const skipped: QuizFoldSkip[] = [];
  const knownSessions = new Set(input.sessions.map((session) => session.id));

  const recordsBySession = new Map<string, RuntimeRecord[]>();
  for (const record of input.records) {
    const existing = recordsBySession.get(record.sessionId);
    if (existing) existing.push(record);
    else recordsBySession.set(record.sessionId, [record]);
    if (!knownSessions.has(record.sessionId)) {
      skipped.push({
        recordId: record.id,
        sessionId: record.sessionId,
        reason: 'unknown-session',
      });
    }
  }

  const byScene = new Map<string, SceneAccumulator>();
  const sceneOrder: string[] = [];
  const sceneFor = (stageId: string, sceneId: string): SceneAccumulator => {
    const key = sceneKey(stageId, sceneId);
    let scene = byScene.get(key);
    if (!scene) {
      scene = { stageId, sceneId, records: [], sessionIds: new Set(), attemptSessions: 0 };
      byScene.set(key, scene);
      sceneOrder.push(key);
    }
    return scene;
  };

  for (const session of [...input.sessions].sort(compareSessions)) {
    const sessionRecords = [...(recordsBySession.get(session.id) ?? [])].sort(
      (left, right) => left.seq - right.seq,
    );
    if (sessionRecords.length === 0) continue;

    // 一个 quiz 会话只锚一页。第一个锚点说了算，其余进 skipped —— 而不是
    // 悄悄把两页的记录混进同一个累加器。
    const anchor = sessionRecords.find((record) => record.sceneId !== undefined)?.sceneId;
    if (anchor === undefined) {
      for (const record of sessionRecords) {
        skipped.push({ recordId: record.id, sessionId: session.id, reason: 'unanchored' });
      }
      continue;
    }

    const scene = sceneFor(session.stageId, anchor);
    let touched = false;
    let reachedSubmit = false;

    for (const record of sessionRecords) {
      // 没有锚点 和 锚到别的页 是两回事，分开报 —— 前者是写入缺字段，后者是
      // 一个会话挂了两页（写入器本该拒绝），诊断时该看的代码完全不同。
      if (record.sceneId === undefined) {
        skipped.push({ recordId: record.id, sessionId: session.id, reason: 'unanchored' });
        continue;
      }
      if (record.sceneId !== anchor) {
        skipped.push({ recordId: record.id, sessionId: session.id, reason: 'mixed-anchor' });
        continue;
      }
      const payload = readPayload(record);
      if (!payload) {
        skipped.push({ recordId: record.id, sessionId: session.id, reason: 'unreadable-payload' });
        continue;
      }
      scene.records.push({ payload, at: record.createdAt });
      touched = true;
      if (payload.phase === 'submitted' || payload.phase === 'reviewed') reachedSubmit = true;
    }

    if (touched) scene.sessionIds.add(session.id);
    if (reachedSubmit) scene.attemptSessions += 1;
  }

  const scenes = sceneOrder.map((key) => {
    const scene = byScene.get(key)!;
    const newest = scene.records.at(-1)!;
    const newestReviewed = [...scene.records]
      .reverse()
      .find((entry) => entry.payload.phase === 'reviewed');

    // 逐题判定：后写覆盖先写，同时保持首次出现顺序，重复题号不会裂成两条。
    // 作答取自**同一条**批改记录 —— 判定与它当时判的那个答案是配对的。
    // 取最新作答会让「status: incorrect」配上后来改成的另一个选项，那是误导。
    const questionsById = new Map<string, QuizQuestionState>();
    for (const result of newestReviewed?.payload.results ?? []) {
      const answer = newestReviewed?.payload.answers[result.questionId];
      questionsById.set(result.questionId, {
        questionId: result.questionId,
        status: result.status,
        earned: result.earned,
        ...(answer !== undefined ? { answer } : {}),
      });
    }
    const questions = [...questionsById.values()];

    const everIncorrect = unique(
      scene.records
        .filter((entry) => entry.payload.phase === 'reviewed')
        .flatMap((entry) => (entry.payload.results ?? []).filter(isIncorrectResult))
        .map((result) => result.questionId),
    );

    return {
      stageId: scene.stageId,
      sceneId: scene.sceneId,
      records: scene.records.length,
      sessions: scene.sessionIds.size,
      attempts: scene.attemptSessions,
      phase: newest.payload.phase,
      answers: { ...newest.payload.answers },
      questions,
      incorrectNow: questions
        .filter((question) => question.status === 'incorrect')
        .map((question) => question.questionId),
      everIncorrect,
      earned: questions.reduce((total, question) => total + question.earned, 0),
      correctCount: questions.filter((question) => question.status === 'correct').length,
      incorrectCount: questions.filter((question) => question.status === 'incorrect').length,
      firstAt: scene.records[0]?.at ?? null,
      lastAt: newest.at,
    } satisfies QuizSceneState;
  });

  return { scenes, skipped };
}

/**
 * 取一页的状态。
 *
 * **两个参数都要** —— 只给 `sceneId` 是不安全的：`document_scenes` 的主键是
 * `(stage_id, id)`，同名 sceneId 可以出现在多门课里。要求 stageId 是为了让
 * "取错课的那一页"在编译期就不可能，而不是靠调用方记得传。
 */
export function sceneStateOf(
  fold: QuizAttemptFold,
  stageId: string,
  sceneId: string,
): QuizSceneState | undefined {
  return fold.scenes.find((scene) => scene.stageId === stageId && scene.sceneId === sceneId);
}
