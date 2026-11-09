'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createXqAiLogClient,
  turnSummary,
  type XqAiLogEntry,
} from '@/lib/learning/xq-ai-log-client';
import { useI18n } from '@/lib/hooks/use-i18n';

/**
 * 对话日志：他在这道题上问了 AI 什么、AI 回了什么。
 *
 * ## 为什么这一页只读，没有「删除」和「导出」
 *
 * 这是**事实流的一面镜子**（`xq_event` 只追加、`runtime_records` 只追加）。
 * 给一面镜子加删除按钮，等于给「他说过什么」加编辑权 —— 那不是这一层
 * 该有的权力。要撤销一次提问，正确做法是再写一条 `voided` 事件，
 * 不是在界面上抹掉一行。
 *
 * ## 为什么三种状态必须分开说
 *
 * - **没读到**（网络/服务端失败）：说「没读到」，不许说成「没有记录」。
 * - **读到了、一条都没有**：说「还没有记录」。
 * - **一条提问但配不到对话**：说「记下了提问，但没找到那场对话」。
 *
 * 第三种是最容易做错的：把空 `turns` 画成普通的一条记录，看起来像
 * 「AI 什么都没说」。它其实说明**子锚点没写上**或**对话被滚动到别的代**
 * —— 这正是排查「为什么 AI 日志里全是空的」时唯一有用的信息。
 *
 * ## 为什么把代数（`generations`）显示出来
 *
 * 一场对话在库里可能是几行（超过 256 条记录会开新一代）。服务端已经
 * 按 base id 归并过，但**归并了几代**是排查信息：它解释「为什么这里
 * 记录了半场」。不显示的话，这个事实就只存在于某个人的记忆里。
 */

export interface AiLogListProps {
  /** 测试用：不注入就走网络。 */
  readonly logClient?: ReturnType<typeof createXqAiLogClient>;
}

type ReadState = 'loading' | 'ready' | 'failed';

export function AiLogList({ logClient }: AiLogListProps) {
  const { t } = useI18n();
  const client = useMemo(() => logClient ?? createXqAiLogClient(), [logClient]);

  const [state, setState] = useState<ReadState>('loading');
  const [entries, setEntries] = useState<readonly XqAiLogEntry[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await client.read();
      if (cancelled) return;
      if (!result.ok) {
        setState('failed');
        return;
      }
      setEntries(result.entries);
      setState('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reloadToken]);

  // 重读由点击触发：加载态在这里设，不在 effect 里同步设 ——
  // `react-hooks/set-state-in-effect` 禁止在 effect 体内同步改状态。
  const reload = useCallback(() => {
    setState('loading');
    setReloadToken((token) => token + 1);
  }, []);

  if (state === 'loading') {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="ai-log-loading">
        {t('aiLog.loading')}
      </p>
    );
  }

  if (state === 'failed') {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="ai-log-failed">
        <p className="text-sm text-gray-600 dark:text-gray-300">{t('aiLog.readFailed')}</p>
        <button
          type="button"
          onClick={reload}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
        >
          {t('aiLog.retry')}
        </button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="ai-log-empty">
        {t('aiLog.empty')}
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-6" data-testid="ai-log-list">
      {entries.map((entry) => {
        const summary = turnSummary(entry);
        return (
          <li
            key={entry.eventId}
            data-testid="ai-log-entry"
            className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {entry.occurredAt.slice(0, 16).replace('T', ' ')}
              </span>
              <span className="text-sm font-medium">
                {t('aiLog.meta', {
                  scene: entry.sceneId,
                  question: entry.questionId,
                })}
              </span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {entry.hintSubtype === 'executive' ? t('aiLog.executive') : t('aiLog.instrumental')}
              </span>
              {entry.generations > 1 && (
                <span
                  className="text-xs text-amber-600 dark:text-amber-400"
                  data-testid="ai-log-generations"
                >
                  {t('aiLog.generations', { count: entry.generations })}
                </span>
              )}
            </div>

            {entry.stem !== '' && (
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">{entry.stem}</p>
            )}

            {!summary.answered ? (
              <p
                className="mt-2 text-xs text-amber-600 dark:text-amber-400"
                data-testid="ai-log-no-turns"
              >
                {t('aiLog.noTurns')}
              </p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {entry.turns.map((turn) => (
                  <li
                    key={turn.recordId}
                    className={
                      turn.role === 'user'
                        ? 'text-sm text-gray-700 dark:text-gray-200'
                        : 'text-sm text-gray-600 dark:text-gray-300'
                    }
                  >
                    <span className="mr-2 text-xs font-medium text-gray-400 dark:text-gray-500">
                      {turn.role === 'user' ? t('aiLog.you') : t('aiLog.ai')}
                    </span>
                    <span className="whitespace-pre-wrap">{turn.text}</span>
                    {turn.truncated && (
                      <span className="ml-1 text-xs text-gray-400">{t('aiLog.truncated')}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
