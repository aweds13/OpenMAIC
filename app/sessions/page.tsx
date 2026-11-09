import type { Metadata } from 'next';

import { SessionList } from '@/components/learning/session-list';

/**
 * 学习记录页：这一次学了多久、翻了几页、问过几次。
 *
 * ## 为什么 `force-dynamic`
 *
 * 内容随「刚关掉的那一次学习」变化，且读的是当前 learner 的私有事实。
 * 与 `/review`、`/ai-log` 同一条理由。
 *
 * ## 为什么没有服务端数据获取
 *
 * 判据在 `app/api/persistence/[...path]/route.ts` 的 `handleXqSessionDigest`
 * 一处（`day` 校验、`limit` 上限、`cache-control`）。在这一页再写一遍
 * 取数逻辑就是第二处投影，两处会漂。
 *
 * ## 为什么这里没有「今天该做什么」
 *
 * 那是 `/review` 的事。这一页只回答「已经发生的」，因为这两件事读的是
 * 不同的东西：一个读计划（`xq_review_schedule`），一个读事实（`xq_event`）。
 * 把它们并到一页，会让人以为「学了 40 分钟」等于「今天做完了」。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'OpenMAIC · 学习记录',
};

export default function SessionsPage() {
  return (
    <main className="mx-auto w-full max-w-[760px] px-5 py-12 sm:px-8">
      <h1 className="mb-2 text-xl font-semibold">学习记录</h1>
      <p className="mb-8 text-sm text-gray-500 dark:text-gray-400">
        每一次学习的时长、翻过的页、交过的卷。时长扣掉了中途离开的部分 ——
        挂钟时间与「其中多少算在学」是两件事。
      </p>
      <SessionList />
    </main>
  );
}
