import type { Metadata } from 'next';

import { DueReviewList } from '@/components/learning/due-review-list';

/**
 * `/review` —— 「今天该复习什么」的落点。
 *
 * ## 为什么是一个独立路由，而不是塞进播放态侧栏
 *
 * 复习不是「看某一页」的动作：同一批到期关横跨几门课、几页，播放态里
 * 一次只显示一页，把它放进去就得先让人切到对的课、对的页才能复习一道题。
 * 一张跨课的到期列表本来就不是某一页的附属物。
 *
 * ## 为什么不挂在 `/workspace` 里
 *
 * `/workspace` 是 Pro 工作台，两道服务端门（`NEXT_PUBLIC_PRO_WORKBENCH_ENABLED`
 * 与 agent runtime）任一关掉就 `redirect('/')`。复习这条链跟 Pro 无关：
 * 它读的是 `xq_review_schedule`，写的是 `xq_event`，两者都不经 agent。
 * 挂在 Pro 下面会让「关掉 Pro」顺带把复习也关掉，而那是两回事。
 *
 * ## 为什么这个页面没有服务端数据获取
 *
 * 读侧要经过 `/api/persistence/xq/reviews`，那条路自己做了 owner 与
 * 数据库配置的判断（`PERSISTENCE_NOT_CONFIGURED` / `OWNER_RETIRED`）。
 * 在这里再判一遍就会有两处判据，且服务端渲染会把「本人此刻的到期队列」
 * 缓存进 HTML —— 那是随时刻变的东西，`no-store` 已经写在响应头上了。
 *
 * `dynamic = 'force-dynamic'`：同一条理由，这一页永远不预渲染。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'OpenMAIC · 复习',
};

export default function ReviewPage() {
  return (
    <main className="mx-auto w-full max-w-[760px] px-5 py-12 sm:px-8">
      <DueReviewList />
    </main>
  );
}
