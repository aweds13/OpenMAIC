'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getXqEventClient } from '@/lib/learning/xq-event-client';
import {
  createXqReviewClient,
  groupCardsByScene,
  reviewCardKey,
  type XqDueReviewCard,
  type XqDueReviewGroup,
  type XqReviewOutcomeClient,
} from '@/lib/learning/xq-review-client';
import { useI18n } from '@/lib/hooks/use-i18n';

/**
 * 到期复习列表，带三个按钮：答对 / 答错 / 跳过。
 *
 * ## 为什么按钮是这三种，而不是「开始复习」
 *
 * 复习的对象是一道**已经做过的题**，界面拿不到题面之外的作答条件：
 * 没有答题框、没有判分服务，也不需要 —— 人知道自己答没答对，而且
 * 这一层记的正是「他自己说答对了没有」。四关的每一次都靠这条自报推进。
 *
 * 「跳过」不是「答对了」的同义词：它只关掉这一关、不动后面的排期
 * （服务端 `skip` 只写 `done_at`、不写事件）。让人能诚实地跳过一次，
 * 比逼他二选一更能保住这张表的可信度。
 *
 * ## 为什么一次只发一条、发完立刻刷新
 *
 * 读完一次队列就把卡片握在手里，之后每点一个按钮：
 * **发请求 → 等回执 → 从本地列表里移掉那一条**。不重新拉整张表：
 * 重拉会在网络慢的时候把「刚点过的那条」又画回来，看起来像没记上。
 * 只有「读失败」或用户手动刷新才重新拉。
 *
 * ## 为什么失败要说出来
 *
 * 事件发送端失败是静默的（少一条浏览记录不影响谁），这里失败必须让人看见：
 * 他以为记上了、其实没有，那这一关明天还会出现在列表里 —— 而他会以为
 * 是系统坏了。所以失败时把那条留在列表里并标红。
 */

export interface DueReviewListProps {
  /** 测试与故事书用：不注入就走网络。 */
  readonly reviewClient?: ReturnType<typeof createXqReviewClient>;
  readonly resolveSessionId?: (stageId: string) => Promise<string | undefined>;
}

type WriteState = 'idle' | 'writing' | 'failed';

export function DueReviewList({ reviewClient, resolveSessionId }: DueReviewListProps) {
  const { t } = useI18n();
  const client = useMemo(() => reviewClient ?? createXqReviewClient(), [reviewClient]);
  const sessionFor = useMemo(
    () => resolveSessionId ?? ((stageId: string) => getXqEventClient().sessionFor(stageId)),
    [resolveSessionId],
  );

  const [cards, setCards] = useState<readonly XqDueReviewCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [writes, setWrites] = useState<Record<string, WriteState>>({});
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 这里**不**同步 `setLoading(true)`：初始就是 true，重读由点击处理器
    // 自己先把它置 true（那是事件，不是渲染副作用），否则每次挂载都会多一轮
    // 级联渲染 —— eslint 的 `react-hooks/set-state-in-effect` 说的是同一件事。
    void client.listDue().then((result) => {
      if (cancelled) return;
      setCards(result.cards);
      setReadFailed(!result.ok);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client, reloadToken]);

  const record = useCallback(
    async (card: XqDueReviewCard, outcome: XqReviewOutcomeClient) => {
      const key = reviewCardKey(card);
      setWrites((prev) => ({ ...prev, [key]: 'writing' }));
      const sessionId = await sessionFor(card.stageId);
      if (sessionId === undefined) {
        // 没有会话就没法把这条事实挂上去。事件发送端能懒开一个，
        // 这里也一样：`sessionFor` 会自己开会话，只有开会话失败才走到这。
        setWrites((prev) => ({ ...prev, [key]: 'failed' }));
        return;
      }
      const result = await client.record({
        stageId: card.stageId,
        sceneId: card.sceneId,
        questionId: card.questionId,
        concept: card.concept,
        round: card.round,
        outcome,
        sessionId,
        occurredAt: new Date().toISOString(),
      });
      if (!result.ok) {
        setWrites((prev) => ({ ...prev, [key]: 'failed' }));
        return;
      }
      setCards((prev) => prev.filter((entry) => reviewCardKey(entry) !== key));
      setWrites((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [client, sessionFor],
  );

  if (loading) {
    return <p className="ws-quiet text-[13px]">{t('review.loading')}</p>;
  }

  if (cards.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {readFailed ? (
          <>
            <p className="text-[13px] text-red-600">{t('review.readFailed')}</p>
            <button
              type="button"
              className="ws-quiet w-fit text-[12px] underline"
              onClick={() => {
                setLoading(true);
                setReloadToken((token) => token + 1);
              }}
            >
              {t('review.retry')}
            </button>
          </>
        ) : (
          <p className="ws-quiet text-[13px]">{t('review.empty')}</p>
        )}
      </div>
    );
  }

  const groups: readonly XqDueReviewGroup[] = groupCardsByScene(cards);

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section
          key={`${group.stageId}\u0000${group.sceneId}`}
          data-testid="due-review-group"
          className="flex flex-col gap-2"
        >
          <h3 className="text-[14px] font-medium">{group.title}</h3>
          <ol className="flex flex-col gap-3">
            {group.cards.map((card) => {
              const key = reviewCardKey(card);
              const state = writes[key] ?? 'idle';
              return (
                <li
                  key={key}
                  data-testid="due-review-card"
                  className="rounded-lg border border-black/10 p-3"
                >
                  <p className="text-[13px] leading-relaxed">{card.questionStem}</p>
                  <p className="ws-quiet mt-1 text-[12px]">
                    {t('review.meta', {
                      round: card.round,
                      concept: card.concept === '' ? t('review.noConcept') : card.concept,
                    })}
                  </p>
                  {/* 概念读数。没有就不显示这一行 —— 不写「暂未定」占位：
                      那个词在这里会被读成「他大概不会」，而 `null` 的含义是
                      「这个概念一条可判的证据都没有」，两件事差得很远。 */}
                  {card.mastery === null ? null : (
                    <p
                      data-testid="due-review-mastery"
                      data-tri={card.mastery.tri}
                      className="ws-quiet mt-1 text-[12px]"
                    >
                      {t('review.mastery', {
                        tri: t(`review.tri.${card.mastery.tri}` as never),
                        questions: card.mastery.questions,
                        n: card.mastery.n,
                      })}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {(['pass', 'fail', 'skip'] as const).map((outcome) => (
                      <button
                        key={outcome}
                        type="button"
                        disabled={state === 'writing'}
                        onClick={() => void record(card, outcome)}
                        className={
                          outcome === 'skip'
                            ? 'ws-quiet rounded-md border border-black/10 px-2 py-1 text-[12px]'
                            : 'rounded-md border border-black/10 px-2 py-1 text-[12px]'
                        }
                      >
                        {t(`review.action.${outcome}`)}
                      </button>
                    ))}
                    {state === 'writing' ? (
                      <span className="ws-quiet text-[12px]">{t('review.saving')}</span>
                    ) : null}
                    {state === 'failed' ? (
                      <span className="text-[12px] text-red-600">{t('review.saveFailed')}</span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
