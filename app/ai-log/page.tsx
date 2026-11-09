import type { Metadata } from 'next';

import { AiLogList } from '@/components/learning/ai-log-list';

/**
 * 对话日志页。
 *
 * ## 为什么 `force-dynamic`
 *
 * 这一页的内容随「刚问的一句」变化，而且读的是当前 learner 的私有事实。
 * 静态化会把某一次的快照发给所有人 —— 复习页同样的理由，见
 * `app/review/page.tsx` 的文件头。
 *
 * ## 为什么没有服务端数据获取
 *
 * 与 `/review` 同一条：判据在 `app/api/persistence/[...path]/route.ts`
 * 的 `handleXqAiLog` 一处（`day` 校验、`limit` 上限、`cache-control`）。
 * 在这一页再写一遍取数逻辑就是第二处投影，两处会漂。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'OpenMAIC · 对话日志',
};

export default function AiLogPage() {
  return (
    <main className="mx-auto w-full max-w-[760px] px-5 py-12 sm:px-8">
      <h1 className="mb-2 text-xl font-semibold">对话日志</h1>
      <p className="mb-8 text-sm text-gray-500 dark:text-gray-400">
        记录你在哪一道题上问过 AI、问了什么、它回了什么。只读 ——
        撤销一次提问要靠再写一条撤销事件，不在这里抹掉。
      </p>
      <AiLogList />
    </main>
  );
}
