'use client';

import { useRef, type CSSProperties, type ReactNode } from 'react';
import type { PPTTextElement } from '@openmaic/dsl';
import { useElementShadow } from '../shared/useElementShadow';
import { ElementOutline } from '../shared/ElementOutline';
import { preservesPlainTextLineBreaks } from '../../utils/richText';
import { useInlineMath, useInnerHtml } from '../../utils/inlineMath';
import { useOptionalSlideContext } from '../../context';
import { hasTextInsets } from '../shared/hasTextInsets';

/**
 * Fallback line height for text elements that do not set one.
 *
 * The DSL documents 1.5 (packages/@openmaic/dsl/src/slides.ts:196), and the host's
 * layout estimator uses the same number (lib/slide/text-metrics.ts in the app).
 * Keep these two equal: the estimator is only meaningful if it measures what is
 * actually drawn. `tests/components/slide-renderer/text-line-height-pin.test.ts`
 * pins the agreement.
 */
export const DEFAULT_TEXT_LINE_HEIGHT = 1.5;

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
  renderContent?: (element: PPTTextElement, defaultContent: ReactNode) => ReactNode;
  /** Keep a recovered shape's label container sized for an absolute-positioned editor. */
  fillHeight?: boolean;
}

export function BaseTextElement({
  elementInfo,
  target,
  renderContent,
  fillHeight = false,
}: BaseTextElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const proseRef = useRef<HTMLDivElement>(null);
  const innerHtml = useInnerHtml(elementInfo.content);
  useInlineMath(proseRef, elementInfo.content);
  // Imported OOXML text carries its own bodyPr insets on the outer div.
  // Adding the editor's default inset again shifts the label and reduces line width.
  const contentHasTextInsets = hasTextInsets(elementInfo.content);

  const classroomSizing = useOptionalSlideContext()?.classroomSizing;
  const vAlign = classroomSizing && !fillHeight ? 'top' : (elementInfo.vAlign ?? 'top');
  const justifyContent =
    vAlign === 'middle' ? 'center' : vAlign === 'bottom' ? 'flex-end' : 'flex-start';
  const defaultContent = (
    <div
      ref={proseRef}
      data-inline-math-root=""
      className="text ProseMirror-static"
      style={{
        position: 'relative',
        pointerEvents: target === 'thumbnail' ? 'none' : undefined,
        whiteSpace: preservesPlainTextLineBreaks(elementInfo.content) ? 'pre-line' : undefined,
      }}
      dangerouslySetInnerHTML={innerHtml}
    />
  );

  return (
    <div
      className="base-element-text"
      style={{
        position: 'absolute',
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper"
        style={{
          width: '100%',
          height: '100%',
          transform: `rotate(${elementInfo.rotate}deg)`,
          // Fill the full text box and rotate it with the glyphs/outline.
          backgroundColor: elementInfo.fill,
          opacity: elementInfo.opacity,
          display: 'flex',
          flexDirection: 'column',
          justifyContent,
        }}
      >
        <div
          className="element-content slide-renderer-prose"
          style={{
            position: 'relative',
            boxSizing: 'border-box',
            padding: contentHasTextInsets && (!classroomSizing || fillHeight) ? 0 : '10px',
            overflowWrap: 'break-word',
            width: elementInfo.vertical ? 'auto' : '100%',
            height: elementInfo.vertical || fillHeight ? '100%' : 'auto',
            display: fillHeight ? 'flex' : undefined,
            flexDirection: fillHeight ? 'column' : undefined,
            justifyContent: fillHeight ? justifyContent : undefined,
            textShadow: shadowStyle,
            // The DSL documents `lineHeight` as optional with a default of 1.5
            // (packages/@openmaic/dsl/src/slides.ts). Rendering `undefined` would
            // let the browser fall back to `normal` (~1.2), which silently
            // disagrees with every host-side height estimate: the editor's
            // layout check computes `lines × fontSize × TEXT_LINE_HEIGHT`, so a
            // 1.2 render reads as "overflows" on pages that actually fit.
            lineHeight: elementInfo.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT,
            letterSpacing:
              elementInfo.wordSpace !== undefined ? `${elementInfo.wordSpace}px` : undefined,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            ...(elementInfo.paragraphSpace !== undefined
              ? ({ '--paragraphSpace': `${elementInfo.paragraphSpace}px` } as CSSProperties)
              : null),
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          {renderContent?.(elementInfo, defaultContent) ?? defaultContent}
        </div>
      </div>
    </div>
  );
}
