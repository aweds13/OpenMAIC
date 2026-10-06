'use client';

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { BookOpen, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 「自学模式」开关按钮。
 *
 * 和 InteractiveModeButton 同构（都是 pressed 型开关），但刻意换了配色
 * （emerald，而不是 interactive 的 cyan）—— 两个长得一样的按钮并排放在
 * 工具栏里会让人分不清哪个是哪个。
 *
 * 这个按钮只负责写 settings.selfStudyEnabled；真正的行为在
 * lib/server/self-study-mode.ts 和两个路由里。
 */
type DataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

type SelfStudyButtonProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  'aria-pressed' | 'children'
> &
  DataAttributes & {
    pressed: boolean;
    label: string;
    onPressedChange: (pressed: boolean) => void;
  };

export const SelfStudyButton = forwardRef<HTMLButtonElement, SelfStudyButtonProps>(
  function SelfStudyButton(
    { pressed, label, onPressedChange, className, onClick, ...buttonProps },
    ref,
  ) {
    return (
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        aria-pressed={pressed}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onPressedChange(!pressed);
        }}
        className={cn(
          'relative inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-all active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 motion-reduce:transition-none motion-reduce:active:scale-100 dark:focus-visible:outline-emerald-300',
          pressed
            ? 'border-emerald-400 bg-emerald-100 text-emerald-900 shadow-sm shadow-emerald-200/60 dark:border-emerald-200 dark:bg-emerald-400 dark:text-slate-950 dark:shadow-[0_0_18px_rgba(52,211,153,0.45)]'
            : 'border-emerald-600 bg-transparent text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/50',
          className,
        )}
      >
        {pressed ? (
          <Check aria-hidden="true" className="relative z-10 size-3.5" />
        ) : (
          <BookOpen aria-hidden="true" className="relative z-10 size-3.5" />
        )}
        <span className="relative z-10">{label}</span>
      </button>
    );
  },
);
