'use client';

import type { PPTTextElement } from '@openmaic/dsl';
import { TEXT_LINE_HEIGHT, TEXT_PADDING_PX } from '@/lib/slide/text-metrics';
import { useElementShadow } from '../hooks/useElementShadow';
import { ElementOutline } from '../ElementOutline';

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
}

/**
 * Base text element component (read-only)
 * Renders static text content with styling
 */
export function BaseTextElement({ elementInfo, target }: BaseTextElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);

  return (
    <div
      className="base-element-text absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{
          transform: `rotate(${elementInfo.rotate}deg)`,
          backgroundColor: elementInfo.fill,
          opacity: elementInfo.opacity,
        }}
      >
        {/*
          ★★ 行高与内边距**显式写进 DOM**，不再靠 class 里的字面量（2026-10-10）。
          原因：`lib/quiz/layout-check.ts` 要按"渲染器实际用的那个数"估算文字装不装得下，
          而 class 里的 `leading-[1.5]` 与检查器里的常数是**两个各自会漂的字面量**
          （实测 1.6 时 23 条"装不下"里 20 条是假阳性）。现在两侧读
          `@/lib/slide/text-metrics` 的同一个常量；元素自己带 `lineHeight` 时仍然优先。
        */}
        <div
          className="element-content relative break-words"
          style={{
            width: elementInfo.vertical ? 'auto' : `${elementInfo.width}px`,
            height: elementInfo.vertical ? `${elementInfo.height}px` : 'auto',
            padding: `${TEXT_PADDING_PX}px`,
            textShadow: shadowStyle,
            lineHeight: elementInfo.lineHeight ?? TEXT_LINE_HEIGHT,
            letterSpacing: `${elementInfo.wordSpace || 0}px`,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            // @ts-expect-error - CSS custom property
            '--paragraphSpace': `${elementInfo.paragraphSpace === undefined ? 5 : elementInfo.paragraphSpace}px`,
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          <div
            className={`text ProseMirror-static relative ${target === 'thumbnail' ? 'pointer-events-none' : ''}`}
            dangerouslySetInnerHTML={{ __html: elementInfo.content }}
          />
        </div>
      </div>
    </div>
  );
}
