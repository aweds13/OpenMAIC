/**
 * 学习状态 —— 把答题记录折叠成的一段文本，注入每次 agent 运行的系统提示词。
 *
 * ── 与「学习者画像」的分工（别混）──────────────────────────────────
 *
 * | | 谁写 | 什么时候变 | 内容 |
 * |---|---|---|---|
 * | `学习画像.md` | **人**（学习者自己） | 想改才改 | 起点、目标、UNKNOWN |
 * | `学习状态.md` | **机器**（本模块的刷新器） | 每答一次题 | 哪道题现在错了、哪页没交卷、哪页不必再考 |
 *
 * 分两个文件而不是一个，是因为**谁覆盖谁**必须一眼可见：机器每次刷新都会整体
 * 重写状态文件，如果它和画像共用一个文件，一次刷新就会把学习者手写的话抹掉。
 *
 * ── 为什么「文件是接口」────────────────────────────────────────────
 *
 * 刷新要查库（`runtime_records` + `document_scenes`），而**读取发生在每次运行的
 * 提示词组装里** —— 那是热路径。所以这里刻意分成两半：
 *
 *   · `refreshLearnerStateFromRuntime()` —— 查库、折叠、渲染、写文件。**离线**调用
 *     （显式的一步，不是每次请求）；
 *   · `resolveLearnerState()` —— 只读文件。**热路径**只做这一件事。
 *
 * Python 那边的 BKT 重算将来接在同一个位置：**产出写进这个文件**，热路径一行不改。
 * 这条分工是为了让「换一个更强的模型」不会变成「给每次请求加一个后端依赖」。
 *
 * ── 两个已知的边界（写出来，不假装它精确）──────────────────────────
 *
 * 1. **圈记录只能按 `stage_meta.owner_id`。** `runtime_sessions.learner_key` 是
 *    客户端设备级匿名键（见 `lib/runtime/learner-key.ts`：client-only，服务端
 *    推不出来），所以同一门课上**另一台设备**的记录也会被算进来。本部署是单人
 *    单设备，但这不是普遍成立的前提 —— 刷新器会把用到的 learnerKey 报出来。
 * 2. 路径**加载时求值**、内容**每次重读** —— 与 `prompt-context-file.ts` 同一套
 *    生命周期（换路径要重启，改内容不用）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Queryable } from '@openmaic/storage/document/pg';
import type { RuntimeRecord } from '@openmaic/dsl';

import { createLogger } from '@/lib/logger';
import { foldQuizAttempts, type QuizFoldSession } from '@/lib/quiz/attempt-fold';
import { renderLearnerState, type LearnerStateSceneContent } from '@/lib/quiz/learner-state';
import { formatPracticeResultsForState, readPracticeResults } from '@/lib/practice/results';
import { practiceRoot } from '@/lib/server/agent-runtime/practice-tools';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { agentRuntimeConfig } from './config';
import { readPromptContextFile } from './prompt-context-file';

const log = createLogger('LearnerState');

/** 状态文件路径。没配画像路径也没配状态路径时为 undefined ⇒ 整条链不启用。 */
export function learnerStatePath(): string | undefined {
  if (agentRuntimeConfig.learnerStatePath) return agentRuntimeConfig.learnerStatePath;
  // 缺省落在画像旁边 —— 部署不用改 .env.local 就能用，而且两个文件在一起时
  // "谁写的"一眼可见。
  const profile = agentRuntimeConfig.learnerProfilePath;
  return profile ? join(dirname(profile), '学习状态.md') : undefined;
}

/** 读状态文件；没配 / 读不到 ⇒ null（不注入，而不是注入一段空的）。 */
export function resolveLearnerState(): string | null {
  return readPromptContextFile(learnerStatePath());
}

/** 注入用的框定语 —— 只说三件文本自己说不清的事。 */
export function learnerStatePromptBlock(state: string): string {
  return [
    '## Learner state (recorded on this machine, not guessed)',
    '',
    'Machine-written from the learner\'s own quiz attempts. Treat it as fact.',
    'It lists only what changes what you do next — so if a page is absent from it,',
    'that means nothing was recorded, **not** that the learner never studied it.',
    '',
    '---',
    '',
    state,
  ].join('\n');
}

/** 原子写：先写临时文件再改名，避免读的一侧看到半截内容。 */
async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

export interface RefreshLearnerStateResult {
  path: string;
  text: string;
  scenes: number;
  records: number;
  /** 实际折进去的 learnerKey —— 多于一个就说明混了设备（见模块头注释）。 */
  learnerKeys: string[];
  /**
   * 折进来的**练习结果**条数（来自磁盘上的 `result.json`，不是数据库）。
   *
   * ★ 与 `records` 分开计数是刻意的：这两个数字来源不同，
   *   合并成一个就会让人以为练习结果也进了 `runtime_records`。
   */
  practiceResults: number;
}

export interface RefreshLearnerStateOptions {
  ownerId: string;
  queryable?: Queryable;
  /** 只折这一个 learnerKey；省略则把该 owner 名下所有设备都折进来。 */
  learnerKey?: string;
  /** 覆盖写入路径。测试用临时路径，免得往别人的数据目录里写东西。 */
  path?: string;
  /** 覆盖练习根目录（测试用）。默认 `practiceRoot()` —— **复用同一处实现，不另写一份**。 */
  practiceRoot?: string;
}

/**
 * 查库 → 折叠 → 渲染 → 写文件。**离线调用**（不在提示词组装里）。
 *
 * 没有可说的内容时返回 `text: ''` 并且**不写文件** —— 写一份空状态只会让提示词
 * 多一段噪声，而且 `readPromptContextFile` 本来就会把空文件当没配。
 */
export async function refreshLearnerStateFromRuntime(
  options: RefreshLearnerStateOptions,
): Promise<RefreshLearnerStateResult | null> {
  const path = options.path ?? learnerStatePath();
  if (!path) return null;

  // 练习结果来自**磁盘**（练习根目录下、每个练习文件夹里的 result.json），
  // 与自检页记录（数据库）是两个来源。读不动就退化成"没有练习记录"（`readPracticeResults` 不抛）。
  const practiceEntries = await readPracticeResults(options.practiceRoot ?? practiceRoot());
  const practiceSection = formatPracticeResultsForState(practiceEntries);

  const db =
    options.queryable ??
    (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;

  // 1) 这个 owner 名下、有答题会话的课。ownership 的边界就是 stage_meta
  //    （与 owner-bound document store 同一张表）。
  const sessionRows = await db.query<{
    id: string;
    stage_id: string;
    status: QuizFoldSession['status'];
    created_at: Date | string;
    learner_key: string;
  }>(
    `SELECT s.id, s.stage_id, s.status, s.created_at, s.learner_key
       FROM runtime_sessions AS s
       JOIN stage_meta AS m ON m.stage_id = s.stage_id
      WHERE s.kind = 'quizAttempt'
        AND m.owner_id = $1
        AND m.deleted_at IS NULL
        AND ($2::text IS NULL OR s.learner_key = $2)
      ORDER BY s.created_at`,
    [options.ownerId, options.learnerKey ?? null],
  );
  if (sessionRows.rows.length === 0) {
    // 没有自检页记录，但有练习结果 —— 这不是"没什么可说的"。
    // 练习过、代码跑过，那正是学习状态该记下来的东西。
    if (!practiceSection) return null;
    const practiceOnly = `${practiceSection}\n`;
    const previous = await readFile(path, 'utf8').catch(() => null);
    if (previous !== practiceOnly) await writeAtomically(path, practiceOnly);
    return {
      path,
      text: practiceSection,
      scenes: 0,
      records: 0,
      learnerKeys: [],
      practiceResults: practiceEntries.length,
    };
  }

  const sessions: QuizFoldSession[] = sessionRows.rows.map((row) => ({
    id: row.id,
    stageId: row.stage_id,
    status: row.status,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
  const sessionIds = sessions.map((session) => session.id);

  // 2) 记录与页面内容。页面内容用来把题号还原成题干（见 learner-state.ts）。
  const recordRows = await db.query<{ data: RuntimeRecord }>(
    `SELECT data FROM runtime_records WHERE session_id = ANY($1::text[]) ORDER BY session_id, seq`,
    [sessionIds],
  );
  const fold = foldQuizAttempts({
    sessions,
    records: recordRows.rows.map((row) => row.data),
  });

  const sceneIds = fold.scenes.map((scene) => scene.sceneId);
  const stageIds = [...new Set(fold.scenes.map((scene) => scene.stageId))];
  const sceneRows =
    sceneIds.length === 0
      ? { rows: [] as { stage_id: string; id: string; scene_order: number; data: { title?: string; content?: { questions?: { id?: string; question?: string }[] } } }[] }
      : await db.query<{
          stage_id: string;
          id: string;
          scene_order: number;
          data: { title?: string; content?: { questions?: { id?: string; question?: string }[] } };
        }>(
          // ★ stage_id 必须一起过滤：`document_scenes` 的主键是 (stage_id, id)，
          //   同名 sceneId 可以出现在多门课里。少了这个条件会把另一门课的题干
          //   当成这一页的（实测踩过：Dart 的题干差点注进 Git/OOP 课的状态里）。
          `SELECT stage_id, id, scene_order, data FROM document_scenes
            WHERE stage_id = ANY($2::text[])
              AND id = ANY($1::text[])
              AND data->>'type' = 'quiz'`,
          [sceneIds, stageIds],
        );

  const contents: LearnerStateSceneContent[] = sceneRows.rows.map((row) => ({
    stageId: row.stage_id,
    sceneId: row.id,
    order: row.scene_order,
    title: row.data.title ?? row.id,
    questions: (row.data.content?.questions ?? [])
      .filter((question): question is { id: string; question: string } =>
        typeof question.id === 'string' && typeof question.question === 'string',
      )
      .map((question) => ({ id: question.id, question: question.question })),
  }));

  // 状态截至**最新的那条答题记录**，而不是"现在" —— 见 RenderLearnerStateInput.asOf。
  const asOf = fold.scenes
    .map((scene) => scene.lastAt)
    .filter((value): value is string => typeof value === 'string')
    .sort()
    .at(-1);

  // 两个来源分开写、拼在一起 —— 读的人要能看出哪部分来自自检页、哪部分来自练习。
  const text = [
    renderLearnerState({
      scenes: fold.scenes,
      contents,
      skipped: fold.skipped,
      ...(asOf ? { asOf } : {}),
    }),
    practiceSection,
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  const learnerKeys = [...new Set(sessionRows.rows.map((row) => row.learner_key))];
  if (!text)
    return {
      path,
      text: '',
      scenes: 0,
      records: recordRows.rows.length,
      learnerKeys,
      practiceResults: practiceEntries.length,
    };

  // 内容没变就不写。重复写同样的字节只会动 mtime，还会让"这次运行到底更新了
  // 什么"变得没法从文件看出来。
  const next = `${text}\n`;
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== next) await writeAtomically(path, next);

  return {
    path,
    text,
    scenes: fold.scenes.length,
    records: recordRows.rows.length,
    learnerKeys,
    practiceResults: practiceEntries.length,
  };
}

/**
 * 把状态刷到文件，**失败一律降级**（绝不抛）。
 *
 * 调用点在 runner 每次运行的开头 —— 与 `buildMcpTools()` / `resolveMaterialsIndex()`
 * 同一量级的一次性工作（都不是在提示词组装里逐块跑的）。刷新失败时这一次运行
 * 就用**上一次写下的文件**，所以库连不上不会拖死会话 —— 与 §1.1 的能力注册
 * 同一条原则：外部依赖坏了，必须退化成"没有它也能跑"。
 */
export async function refreshLearnerStateBestEffort(ownerId: string): Promise<void> {
  try {
    await refreshLearnerStateFromRuntime({ ownerId });
  } catch (error) {
    log.warn({ error: String(error), ownerId }, 'learner-state refresh failed; keeping the last file');
  }
}

