'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/lib/hooks/use-i18n';
import {
  createXqSessionsClient,
  sessionSummary,
  totalActiveMs,
  type XqSessionDigestView,
} from '@/lib/learning/xq-session-client';

/**
 * 学习记录：这一次学了多久、翻了几页、问过几次。
 *
 * ## 为什么这些数字只在这里，不进学习状态块
 *
 * `learner-state-render.ts` 的每一条都有硬约束（零冷启动、稳定排序、
 * 首行声明「是数据不是指令」）。而这里的数字**每分钟都在变**：
 * 把它写进状态块会让前缀缓存每轮失效，而它本身又不足以支撑任何判定 ——
 * N3 §4.4 的原话是这些阈值「全是切分参数，不是剂量参数」。
 * 所以它是一页给人看的东西，不是一个给模型读的事实。
 *
 * ## 为什么三种状态必须分开说
 *
 * 与对话日志同一条：**没读到**（网络/服务端失败）不许说成「今天没学」。
 * 一份空的会话列表看起来像「他今天什么都没做」，而真正的原因可能只是
 * 服务端没起来 —— 那会让人去怀疑自己的自律。
 *
 * ## 为什么开着的会话单独标出来，且不计入合计
 *
 * 一个还没关的会话，它的「活跃毫秒」只会越算越小（正在进行的间隔还没
 * 被下一条事件截断）。把它加进「今天一共学了多久」，那个数会**倒退**。
 * 所以合计只累加已结束的，进行中的那一条单独标「进行中」。
 */

export interface SessionListProps {
  /** 测试用：不注入就走网络。 */
  readonly sessionClient?: ReturnType<typeof createXqSessionsClient>;
}

type ReadState = 'loading' | 'ready' | 'failed';

function minutesLabel(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

export function SessionList({ sessionClient }: SessionListProps) {
  const { t } = useI18n();
  const client = useMemo(() => sessionClient ?? createXqSessionsClient(), [sessionClient]);

  const [state, setState] = useState<ReadState>('loading');
  const [sessions, setSessions] = useState<readonly XqSessionDigestView[]>([]);
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
      setSessions(result.sessions);
      setState('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reloadToken]);

  // 加载态由点击处理器设，不在 effect 体内同步设（`react-hooks/set-state-in-effect`）。
  const reload = useCallback(() => {
    setState('loading');
    setReloadToken((token) => token + 1);
  }, []);

  if (state === 'loading') {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="session-loading">
        {t('sessions.loading')}
      </p>
    );
  }

  if (state === 'failed') {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="session-failed">
        <p className="text-sm text-gray-600 dark:text-gray-300">{t('sessions.readFailed')}</p>
        <button
          type="button"
          onClick={reload}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
        >
          {t('sessions.retry')}
        </button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="session-empty">
        {t('sessions.empty')}
      </p>
    );
  }

  const totalMinutes = minutesLabel(totalActiveMs(sessions));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="session-total">
        {t('sessions.total', { minutes: totalMinutes, count: sessions.length })}
      </p>
      <ol className="flex flex-col gap-3">
        {sessions.map((session) => {
          const summary = sessionSummary(session);
          return (
            <li
              key={session.sessionId}
              data-testid="session-entry"
              className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {session.startedAt.slice(0, 16).replace('T', ' ')}
                </span>
                <span className="text-sm font-medium">
                  {t('sessions.minutes', { minutes: summary.minutes })}
                </span>
                {summary.open && (
                  <span
                    className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                    data-testid="session-open"
                  >
                    {t('sessions.open')}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('sessions.detail', {
                  events: session.eventCount,
                  pages: session.pageCount,
                  answers: session.answers.submitted,
                  hints: session.hints.instrumental,
                })}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
