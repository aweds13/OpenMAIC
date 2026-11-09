'use client';

import { useEffect, useState } from 'react';
import { createXqReviewClient } from '@/lib/learning/xq-review-client';

/**
 * 复习入口上的那个角标：**今天有几关到期**。
 *
 * ## 为什么它必须能「什么都不显示」
 *
 * 三种状态刻意分开：
 * - **读到 0**：不显示角标（没有到期复习是常态，一块「0」是噪声）。
 * - **读到 n > 0**：显示数字。
 * - **没读到**（网络失败 / 服务没起）：**也不显示**。
 *
 * 第三种是最要紧的：把「没读到」画成「没有」正是复习页自己最不该犯的错
 * （`due-review-list.tsx` 里 `readFailed` 与 `empty` 是两句不同的话）。
 * 但角标只有一块地方，说不了两句话 —— 所以它**沉默**。
 * 沉默的代价是「今天有 3 关到期却没提示」，说话的代价是「明明有 3 关，
 * 界面说没有了」—— 后者会让人真的不去复习。
 *
 * ## 为什么在 `focus` 时重读
 *
 * 这个角标挂在首页，人可能开着一整天。切回来时那一刻的数字才是他关心的；
 * 定时轮询既要一个常驻定时器，又会在没人看的时候发请求。`focus` 是免费的
 * 边界：人回来了才问一次。
 *
 * ## 为什么不取「最大 50 条以上」
 *
 * 服务端一次最多回 50 条（`DUE_REVIEW_CARD_LIMIT`），所以角标封顶就写
 * `50+`。写「50」会让人以为正好 50 关，而实际上可能有两百。
 */
const BADGE_CAP = 50;

/**
 * 角标上要显示什么。`null` = 什么都不显示。
 *
 * 抽成纯函数是为了能测：这个组件自己几乎全是副作用（读队列、听 `focus`），
 * 而真正会错的是这条**判定**（0 该不该显示、没读到该不该显示、50 之后怎么写）。
 */
export function badgeText(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  return count >= BADGE_CAP ? `${BADGE_CAP}+` : String(count);
}

export function DueReviewBadge({
  reviewClient,
}: {
  reviewClient?: ReturnType<typeof createXqReviewClient>;
}) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    // 组件卸载后不再 setState。`focus` 监听器与首次读取共用一个标记。
    let cancelled = false;
    const client = reviewClient ?? createXqReviewClient();

    const read = async () => {
      const result = await client.listDue();
      if (cancelled) return;
      // 读失败 ⇒ `null`（沉默）。见文件头：这里说不了两句话。
      setCount(result.ok ? result.cards.length : null);
    };

    void read();
    window.addEventListener('focus', read);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', read);
    };
  }, [reviewClient]);

  const text = badgeText(count);
  if (text === null) return null;

  return (
    <span
      data-testid="home-review-badge"
      aria-hidden="true"
      className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-violet-500 px-1 text-[10px] font-medium leading-none text-white"
    >
      {text}
    </span>
  );
}
