/**
 * 学情（xq）的**生产写入口**：把「答题事实」在服务端 append 成功之后落进 `xq_*`。
 *
 * ## 为什么必须挂在这里，不能挂在 `recordQuizAttempt`
 *
 * quiz 的写入链是**浏览器端**的：`components/scene-renderers/quiz-view.tsx` →
 * `createQuizAttemptWriter` → `recordQuizAttempt` → runtime store（HTTP）→
 * `POST /api/persistence/runtime/sessions/:id/records`。前四步跑在浏览器里，
 * 那里**没有 Postgres 连接**，也没有 `xq_*` 的读权限。所以能动的只有服务端这一层。
 *
 * `recordQuizAttempt` 里也拿不到「这条记录一定写成功了」——它把 append 交给
 * store，store 可能走 HTTP store（浏览器），也可能走 PG store（同进程）。
 * 只有服务端的 `appendRecord` 返回了一个带 `seq` 的记录，才说明这一行真的落库了。
 *
 * ## 为什么用 `(recordId, askedAt)` 做幂等键
 *
 * `xq_probe_item` 的唯一键是 `(task_id, stage_id, scene_id, question_id, asked_at)`，
 * 而 `task_id` 我们取 `runtime:<record.id>` —— 一个 record 是一次 append，
 * 它的 id 由调用方 `mintRecordId()` 生成、**跨重试不变**（浏览器重发同一个 append
 * 会带同一个 id，撞 `expectedLastSeq` 冲突后被上层重读重试，但 id 还是那个）。
 * 所以「同一个 record 被投递两次」只会插一次。
 *
 * ★ 不能拿 `(stageId, sceneId, questionId)` 当幂等键：同一道题**本来就该能答多次**，
 * 那正是 `counted_n`（同日重测 0.5）要表达的东西。幂等键必须是「这一次 append」，
 * 不是「这道题」。
 *
 * ## 为什么只处理 `phase === 'reviewed'`
 *
 * 三阶段的 payload 都带 `answers`，但只有 `reviewed` 带 `results`（逐题对错）。
 * `draft` 是「正在答」、`submitted` 是「答完了等批改」——两者都**没有对错结论**。
 * 拿 `answers` 去比答案键是错的：判题规则（多选给部分分、填空大小写、AI 批改）
 * 全在 `lib/quiz/grading.ts` 与批改服务里，这里重算一遍必然与页面显示不一致。
 *
 * 实测：全库 174 条 quiz 记录里只有 7 条 `phase='reviewed'`。这不是缺陷 ——
 * 大部分答题没有交卷，本来就没有对错可记。
 *
 * ## 为什么 `correct === null` 要跳过
 *
 * `QuestionResult.correct` 是 `boolean | null`。`null` 出现在 `short_answer`
 * （AI 批改还没回来）。把它当成「错」会让一个还没批的题立刻算一次失败证据，
 * 而且永久留在 `xq_probe_item` 里（那张表只追加）。跳过是唯一安全的做法：
 * 等 AI 批完，会再 append 一条带结论的 reviewed 记录，那时才落库。
 *
 * ## 四条失败策略
 *
 * 1. **不抛**。学情是派生物，落不进不该让一次答题提交失败 —— 用户看到的是
 *    「提交失败」，而实际答题内容已经存好了，只是状态没更新。抛出去会让人
 *    以为答案丢了。失败只写日志。
 * 2. **不改 `xq_cell_state` 的事务边界**：`ingestProbeItems` 与
 *    `recomputeCellState` 分开调。前者是事实（必须成功），后者是缓存
 *    （失败了下次重算就好）。
 * 3. **排期也在这里做**：答错就排四关。`scheduleReviewForWrong` 自身
 *    `ON CONFLICT DO NOTHING`，重复调用不会把已过掉的关重置。
 * 4. **概念能取到就用**：这道题的最高档恰好只有一个概念时，四关挂到它上面；
 *    取不到（没有题级映射、或最高档并列）就留 `''` 仍然排期 —— 一道错题值得
 *    重练，与它挂在哪个概念上无关。判据只有一份：`XqLearnerStore.conceptForQuestion()`，
 *    与状态块拿格子标签那套规则同源（`ties = 1`）。
 *    ★ 不能「随便挑一个」：`xq_review_schedule` 的唯一键**含 `concept`**，
 *    今天挑 A、明天挑 B 会把同一道错题变成两组四关。
 */
import type { RuntimeStore } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import { createLogger } from '@/lib/logger';
import { asConfidenceMap, confidenceOf } from '@/lib/quiz/confidence';
import type { QuestionResult } from '@/lib/quiz/grading';
import { XqLearnerStore, type ProbeItemInput } from './xq-learner-store';

const log = createLogger('XqProbe');

/** `task_id` 的前缀：一眼能看出这条证据来自哪一次 runtime append。 */
export const RUNTIME_TASK_PREFIX = 'runtime:';

/** 一条 reviewed 记录的 payload 里我们要的那几项。 */
export interface ReviewedQuizPayload {
  payloadVersion?: unknown;
  phase?: unknown;
  results?: unknown;
  /** 题号 → 自评把握（四档）。收不进来的条目一律当没问过。 */
  confidence?: unknown;
}

/** 写入口要的最小依赖。全部可注入，所以判据不需要真库也能跑。 */
export interface XqProbeRecorderDeps {
  queryable: Queryable;
  now?: () => Date;
  logFailure?: (message: string, error?: unknown) => void;
  /**
   * 真的写进了新事实之后叫一次。**同步、不许抛**（调用方自己兜住）。
   *
   * 存在的理由：学习状态块是一份**文件**，只有人主动刷新才会变。此前那唯一
   * 的刷新点在 agent 运行开头（`runner.ts`），所以「答完题就关掉」这件事发生
   * 之后，状态块会一直停在旧内容上 —— 实测磁盘那份 946 字节，而当时的库渲染
   * 出来是 1405 字节（差一整节练习）。这不是缓存慢，是**没有任何人会再来写它**。
   *
   * 只挂钩在这里而不挂在 `appendRecord` 上：没插入新行（重复投递、没有结论）
   * 时库没变，刷新只会白读一遍文件。
   */
  onRecorded?: () => void;
}

/** 一次 append 写进学情后回什么（调用方只用来打日志，不参与控制流）。 */
export interface XqProbeRecordResult {
  /** 真落进 `xq_probe_item` 的条数。 */
  inserted: number;
  /** 因为 `correct === null` 跳过的条数（AI 还没批完）。 */
  ungraded: number;
  /** 因为唯一键冲突跳过的条数（同一次 append 投递了两次）。 */
  duplicate: number;
  /** 排了四关的错题数。 */
  scheduled: number;
  /** 重算了状态的格数（0 或 1）。 */
  recomputed: number;
}

/** 一条 append 的上下文。`recordId` 是幂等键的一半，`createdAt` 是另一半。 */
export interface XqProbeRecordInput {
  recordId: string;
  stageId: string;
  sceneId: string;
  createdAt: string;
  payload: ReviewedQuizPayload;
}

function asResults(raw: unknown): QuestionResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is QuestionResult =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { questionId?: unknown }).questionId === 'string',
  );
}

/** 这条记录该不该进学情：只有 `reviewed` 且带非空 `results` 才是结论。 */
export function isGradableQuizRecord(payload: ReviewedQuizPayload): boolean {
  return payload.phase === 'reviewed' && asResults(payload.results).length > 0;
}

/**
 * 把一条已经落库的 reviewed 记录写成学情事实。
 *
 * 调用点只有一处（`app/api/persistence/[...path]/route.ts` 的 runtime 写包装），
 * 但本函数刻意不依赖那条路径的任何东西：给 recordId / stageId / sceneId /
 * createdAt 就能跑，所以判据可以拿 PGlite 直接测。
 */
export async function recordProbeFromRuntimeAppend(
  input: XqProbeRecordInput,
  deps: XqProbeRecorderDeps,
): Promise<XqProbeRecordResult> {
  const result: XqProbeRecordResult = {
    inserted: 0,
    ungraded: 0,
    duplicate: 0,
    scheduled: 0,
    recomputed: 0,
  };
  if (!isGradableQuizRecord(input.payload)) return result;

  const askedAt = new Date(input.createdAt);
  if (Number.isNaN(askedAt.getTime())) {
    // 时间戳坏了就不写：`xq_probe_item.asked_at` 是排期的锚点，
    // 拿一个假时间去排四关，比不排更糟（会把复习排到过去或几十年后）。
    (deps.logFailure ?? defaultLogFailure)(
      `xq: runtime record ${input.recordId} has an unparseable createdAt (${input.createdAt})`,
    );
    return result;
  }

  const store = new XqLearnerStore({ queryable: deps.queryable });
  const taskId = `${RUNTIME_TASK_PREFIX}${input.recordId}`;
  const graded: { result: QuestionResult; correct: boolean }[] = [];
  for (const item of asResults(input.payload.results)) {
    if (typeof item.correct !== 'boolean') {
      result.ungraded += 1;
      continue;
    }
    graded.push({ result: item, correct: item.correct });
  }
  if (graded.length === 0) return result;

  // ★ 自评是**事实**，不是判定。它只落 `xq_probe_item.confidence_pre`，
  // 不进 `EvidenceItem`（`lib/quiz/xq-mastery.ts` 里刻意没有这个字段）——
  // Karpicke & Roediger 2008 实测预测 50% / 实际 80% 对 33%、组间 F<1，
  // 自评与真实零相关。所以它既不能让一格变「会」，也不能让它变「不会」。
  const confidence = asConfidenceMap(input.payload.confidence);
  const items: ProbeItemInput[] = graded.map(({ result: item, correct }) => {
    const level = confidenceOf(confidence, item.questionId);
    return {
      taskId,
      stageId: input.stageId,
      sceneId: input.sceneId,
      questionId: item.questionId,
      askedAt,
      correct,
      source: 'existing',
      ...(level === undefined ? {} : { confidencePre: level }),
    };
  });

  try {
    const ingested = await store.ingestProbeItems(items);
    result.inserted = ingested.inserted;
    result.duplicate = ingested.skipped;
  } catch (error) {
    // 事实没落进去就不要往下走：缓存与排期都是从事实推出来的。
    (deps.logFailure ?? defaultLogFailure)(
      `xq: failed to ingest ${items.length} probe item(s) for record ${input.recordId}`,
      error,
    );
    return result;
  }

  // 只有真的新插了行才值得重算/排期。重复投递时 `inserted === 0`，
  // 重算与排期都是幂等的，但没必要每次都跑。
  if (result.inserted === 0) return result;

  try {
    await store.recomputeCellState(input.stageId, input.sceneId);
    result.recomputed = 1;
  } catch (error) {
    (deps.logFailure ?? defaultLogFailure)(
      `xq: failed to recompute cell ${input.stageId}/${input.sceneId}`,
      error,
    );
  }

  for (const { result: item, correct } of graded) {
    if (correct) continue;
    try {
      // 概念：这道题的最高档恰好只有一个概念时才是它，否则留空。
      // 取不到不是失败 —— 四关按题排，`concept` 只是可选标注
      // （见 xq-learner.ts 第四节）。但取到了就要用：唯一键含 concept，
      // 同一道错题今天挂 A、明天挂 B 会变成两组四关。
      const concept = await store.conceptForQuestion(input.stageId, input.sceneId, item.questionId);
      await store.scheduleReviewForWrong(input.stageId, input.sceneId, item.questionId, concept);
      result.scheduled += 1;
    } catch (error) {
      (deps.logFailure ?? defaultLogFailure)(
        `xq: failed to schedule review for ${input.stageId}/${input.sceneId}/${item.questionId}`,
        error,
      );
    }
  }

  // 库变了，状态块就该跟着变。放最后：前面每一步都只是「这次写成功了没有」，
  // 到这里才确定新事实真的落进去了。调用方负责兜住异常（见本文件第四节第 1 条：
  // 学情是派生物，落不进不许让答题失败）。
  if (result.inserted > 0) {
    try {
      deps.onRecorded?.();
    } catch (error) {
      (deps.logFailure ?? defaultLogFailure)('xq: onRecorded hook failed', error);
    }
  }

  return result;
}

function defaultLogFailure(message: string, error?: unknown): void {
  if (error === undefined) log.warn(message);
  else log.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * 把 `appendRecord` 包一层：**写完**之后才落学情，且永远不让学情失败影响这次写。
 *
 * 三条顺序上的硬约束：
 *
 * 1. **先 append 再落学情**。反过来的话，学情里会留下「appended 失败但证据已记」
 *    的孤儿证据 —— 而那正是 `canonical` 状态与事实分叉的开始。
 * 2. **`record.sceneId` 优先于 `init.sceneId`**。store 可能补全/规范锚点，
 *    记录上那个才是真的写进去的（`appendRecord` 回的是落库后的记录）。
 * 3. **整套 try/catch 包住**。`gates` 里那条「答题提交不能因为学情失败而失败」
 *    是本函数存在的理由本身，不是附加要求。
 *
 * 这个包装层还能被测试无痛替换：`deps.queryable` 换成 PGlite、
 * `inner` 换成内存 store 就能跑端到端。
 */
export function withXqProbeRecording(inner: RuntimeStore, deps: XqProbeRecorderDeps): RuntimeStore {
  return {
    ...inner,
    appendRecord: async (init, options) => {
      const record = await inner.appendRecord(init, options);
      try {
        const payload = record.payload as ReviewedQuizPayload;
        if (!isGradableQuizRecord(payload)) return record;
        const session = await inner.getSession(record.sessionId);
        // 只认 quizAttempt：PBL/chat 的 payload 里也可能出现 `results` 字样，
        // 但它们的语义完全不同，混进来会让 `xq_probe_item` 变成杂物表。
        if (session === undefined || session.kind !== 'quizAttempt') return record;
        const sceneId = record.sceneId ?? init.sceneId;
        if (typeof sceneId !== 'string' || sceneId === '') return record;
        await recordProbeFromRuntimeAppend(
          {
            recordId: record.id,
            stageId: session.stageId,
            sceneId,
            createdAt: record.createdAt,
            payload,
          },
          deps,
        );
      } catch (error) {
        // 连 `getSession` 都失败也算学情失败 —— 不影响这次写。
        (deps.logFailure ?? defaultLogFailure)(
          `xq: probe recording skipped for record ${record.id}`,
          error,
        );
      }
      return record;
    },
  };
}
