'use client';

import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { PPTCodeElement, CodeLine } from '@openmaic/dsl';

// ==================== Shiki Singleton ====================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let highlighterPromise: Promise<any> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-light'],
        langs: [
          'python',
          'javascript',
          'typescript',
          'json',
          'go',
          'rust',
          'java',
          'c',
          'cpp',
          'html',
          'css',
          'bash',
          'sql',
          'yaml',
          'markdown',
          'jsx',
          'tsx',
        ],
      }),
    );
  }
  return highlighterPromise;
}

// ==================== Helpers ====================

/**
 * Parse Shiki HTML output into per-line HTML fragments.
 * Shiki outputs: <pre ...><code><span class="line">...</span>\n...</code></pre>
 * We split by `<span class="line">` boundaries and strip the trailing `</span>`.
 */
function parseShikiLines(html: string): string[] {
  const codeMatch = html.match(/<code>([\s\S]*?)<\/code>/);
  if (!codeMatch) return [];

  const parts = codeMatch[1].split('<span class="line">');
  const lines: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const endIdx = part.lastIndexOf('</span>');
    if (endIdx !== -1) {
      lines.push(part.substring(0, endIdx));
    }
  }
  return lines;
}

// ==================== Types ====================

export interface BaseCodeElementProps {
  elementInfo: PPTCodeElement;
  animate?: boolean;
  selectable?: boolean;
}

interface LineAnimationState {
  type: 'typing' | 'inserted' | 'replaced';
  timestamp: number;
}

// ==================== Typing Easing ====================

const STUTTER_COUNT = 5;
const STUTTER_AMOUNT = 0.04;
const LINE_GAP_MS = 120;
const TAB_SIZE = 4;

function visualLength(s: string): number {
  let len = 0;
  for (const ch of s) {
    len += ch === '\t' ? TAB_SIZE : 1;
  }
  return len;
}

function getTypingCharCount(content: string): number {
  const trimmed = content.replace(/^[\t ]+/, '');
  return trimmed.length;
}

function computeRevealSteps(content: string): number[] {
  const total = visualLength(content);
  if (total === 0) return [1];

  const trimmed = content.replace(/^[\t ]+/, '');
  const indentPart = content.slice(0, content.length - trimmed.length);

  let cumVisual = 0;
  for (const ch of indentPart) {
    cumVisual += ch === '\t' ? TAB_SIZE : 1;
  }

  const steps: number[] = [cumVisual / total];

  for (const ch of trimmed) {
    cumVisual += ch === '\t' ? TAB_SIZE : 1;
    steps.push(cumVisual / total);
  }

  return steps;
}

function humanTypingEase(t: number): number {
  const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
  const stutter = Math.sin(t * Math.PI * STUTTER_COUNT) * STUTTER_AMOUNT * 4 * t * (1 - t);
  return Math.min(Math.max(eased + stutter, 0), 1);
}

// ==================== TypingReveal ====================

function TypingReveal({
  html,
  durationMs,
  revealSteps,
  onComplete,
}: {
  html: string;
  durationMs: number;
  revealSteps: number[];
  onComplete: () => void;
}) {
  const typingUnitCount = revealSteps.length - 1;

  const [revealPct, setRevealPct] = useState(revealSteps[0]);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (typingUnitCount <= 0) {
      const t = setTimeout(() => {
        setRevealPct(1);
        onComplete();
      }, 0);
      return () => clearTimeout(t);
    }

    startRef.current = performance.now();
    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const linearT = Math.min(elapsed / durationMs, 1);
      const easedProgress = humanTypingEase(linearT);

      const stepIdx = Math.min(Math.floor(easedProgress * (typingUnitCount + 1)), typingUnitCount);

      setRevealPct(revealSteps[stepIdx]);

      if (linearT < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setRevealPct(1);
        onComplete();
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [durationMs, typingUnitCount, revealSteps, onComplete]);

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span
        style={{
          clipPath: `inset(0 ${(1 - revealPct) * 100}% 0 0)`,
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {revealPct < 1 && (
        <span
          className="absolute top-0 w-[2px] bg-gray-800"
          style={{
            left: `${revealPct * 100}%`,
            height: '1.1em',
            animation: 'code-cursor-blink 0.6s step-end infinite',
          }}
        />
      )}
    </span>
  );
}

// ==================== CodeLineRow ====================

function getTypingDuration(content: string): number {
  return Math.max(getTypingCharCount(content) * 40, 250);
}

const REPLACE_SELECT_MS = 350;

function CodeLineRow({
  line,
  lineNumber,
  highlightedHtml,
  showLineNumbers,
  animState,
  animate,
  typingDelay,
}: {
  line: CodeLine;
  lineNumber: number;
  highlightedHtml: string;
  showLineNumbers: boolean;
  animState?: LineAnimationState;
  animate: boolean;
  typingDelay: number;
}) {
  const isNewLine = animate && !!animState && animState.type !== 'replaced';
  const isReplace = animate && animState?.type === 'replaced';

  const [mounted, setMounted] = useState(!isNewLine || typingDelay === 0);

  useEffect(() => {
    if (!isNewLine) {
      const timer = setTimeout(() => setMounted(true), 0);
      return () => clearTimeout(timer);
    }
    if (isNewLine && typingDelay > 0) {
      const timer = setTimeout(() => setMounted(true), typingDelay);
      return () => clearTimeout(timer);
    }
  }, [isNewLine, typingDelay]);

  const [typing, setTyping] = useState(isNewLine && typingDelay === 0);

  useEffect(() => {
    if (mounted && isNewLine) {
      const t = setTimeout(() => setTyping(true), 0);
      return () => clearTimeout(t);
    }
  }, [mounted, isNewLine]);

  const handleTypingComplete = useCallback(() => {
    setTyping(false);
  }, []);

  const prevHtmlRef = useRef(highlightedHtml);
  const [replacePhase, setReplacePhase] = useState<'idle' | 'select' | 'type'>('idle');
  const [oldHtml, setOldHtml] = useState<string | null>(null);

  useEffect(() => {
    if (isReplace && prevHtmlRef.current !== highlightedHtml) {
      setOldHtml(prevHtmlRef.current);
      setReplacePhase('select');
      const timer = setTimeout(() => {
        setReplacePhase('type');
        setTyping(true);
        setOldHtml(null);
        prevHtmlRef.current = highlightedHtml;
      }, REPLACE_SELECT_MS);
      return () => clearTimeout(timer);
    }
    prevHtmlRef.current = highlightedHtml;
  }, [isReplace, highlightedHtml]);

  const [highlight, setHighlight] = useState<string | null>(() => {
    if (!animState) return null;
    if (animState.type === 'inserted') return 'rgba(34, 197, 94, 0.12)';
    return null;
  });

  useEffect(() => {
    if (animState?.type === 'inserted') {
      const t = setTimeout(() => setHighlight('rgba(34, 197, 94, 0.12)'), 0);
      return () => clearTimeout(t);
    }
  }, [animState]);

  const [highlightFading, setHighlightFading] = useState(false);
  useEffect(() => {
    if (!highlight || highlightFading || typing) return;
    const fadeTimer = setTimeout(() => setHighlightFading(true), 0);
    const clearTimer = setTimeout(() => {
      setHighlight(null);
      setHighlightFading(false);
    }, 2000);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [highlight, typing, highlightFading]);

  const typingDuration = getTypingDuration(line.content);
  const revealSteps = useMemo(() => computeRevealSteps(line.content), [line.content]);

  if (!mounted) return null;

  let bgColor = highlight || 'transparent';
  if (replacePhase === 'select') bgColor = 'rgba(59, 130, 246, 0.18)';

  let contentNode: React.ReactNode;
  if (replacePhase === 'select' && oldHtml) {
    contentNode = <span dangerouslySetInnerHTML={{ __html: oldHtml }} />;
  } else if (typing) {
    contentNode = (
      <TypingReveal
        html={highlightedHtml}
        durationMs={typingDuration}
        revealSteps={revealSteps}
        onComplete={handleTypingComplete}
      />
    );
  } else {
    contentNode = <span dangerouslySetInnerHTML={{ __html: highlightedHtml }} />;
  }

  return (
    <motion.div
      initial={isNewLine ? { opacity: 0, height: 0 } : false}
      animate={{
        opacity: 1,
        height: 'auto',
        backgroundColor: bgColor,
        transition: {
          duration: 0.3,
          ease: [0.16, 1, 0.3, 1],
          backgroundColor: { duration: 0.4 },
        },
      }}
      exit={{
        backgroundColor: 'rgba(59, 130, 246, 0.18)',
        height: 0,
        opacity: 0,
        transition: {
          backgroundColor: { duration: 0 },
          height: { duration: 0, delay: 0.3 },
          opacity: { duration: 0, delay: 0.3 },
        },
      }}
      className="flex leading-[1.6]"
      style={{
        fontSize: 'inherit',
        overflow: 'hidden',
      }}
    >
      {showLineNumbers && (
        <span
          className="select-none text-right shrink-0 pr-4 pl-2"
          style={{
            width: '3.5em',
            color: '#9ca3af',
            userSelect: 'none',
          }}
        >
          {lineNumber}
        </span>
      )}
      {/* 右内边距交给代码区自己（`px-3`）—— 这里再加一个 `pr-4` 会让左右不等宽。 */}
      <span className="flex-1" style={{ whiteSpace: 'pre', tabSize: 4 }}>
        {contentNode}
      </span>
    </motion.div>
  );
}

// ==================== BaseCodeElement ====================

export function BaseCodeElement({ elementInfo, animate, selectable }: BaseCodeElementProps) {
  // ★ 2026-10-09：**幻灯片上默认不显示行号**（原来默认 true）。
  //   实测（Day02 第 21 页，盒子 250px 宽）：行号槽是 `3.5em` ≈ **49px + 16px 间距**，
  //   占掉盒子宽度的 **20%**，直接把最长一行挤出可视区（横向溢出 47px）。
  //   行号的价值是"能指着某一行讲执行顺序"，那只有在**盒子够宽**时才划算
  //   —— 所以它是 per-element 的开关（转换那一页的人自己决定），不是全局默认。
  // ★ `language` / `fileName` 现在**不参与渲染**（顶栏去掉了），但仍留在 elementInfo 里：
  //   `language` 仍决定 Shiki 怎么高亮；两者都是"将来要恢复顶栏"时的现成数据。
  //   故意不解构 `fileName` —— 解构了不用就是死代码。
  const { language, lines, showLineNumbers = false, fontSize = 14 } = elementInfo;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const codeBodyRef = useRef<HTMLDivElement>(null);

  // Drag-to-scroll inside the code body (for non-whiteboard callers like slides),
  // plus wheel containment.
  // When `selectable` is true (whiteboard), drag-to-scroll is disabled so users
  // can select and copy code text with the pointer, while wheel containment
  // remains active to prevent whiteboard zoom during mouse-wheel scroll.
  useEffect(() => {
    const el = codeBodyRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.stopPropagation();
    };
    el.addEventListener('wheel', onWheel, { passive: true });

    if (selectable) {
      el.style.cursor = '';
      return () => {
        el.removeEventListener('wheel', onWheel);
      };
    }

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;
    let activePointer: number | null = null;

    const endDrag = () => {
      if (activePointer !== null && el.hasPointerCapture(activePointer)) {
        el.releasePointerCapture(activePointer);
      }
      dragging = false;
      activePointer = null;
      el.style.cursor = 'grab';
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      activePointer = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = el.scrollLeft;
      startScrollTop = el.scrollTop;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== activePointer) return;
      el.scrollLeft = startScrollLeft - (e.clientX - startX);
      el.scrollTop = startScrollTop - (e.clientY - startY);
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerId !== activePointer) return;
      endDrag();
    };

    const onLostCapture = () => {
      endDrag();
    };

    el.style.cursor = 'grab';
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerEnd);
    el.addEventListener('pointercancel', onPointerEnd);
    el.addEventListener('lostpointercapture', onLostCapture);

    return () => {
      endDrag();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
      el.removeEventListener('lostpointercapture', onLostCapture);
      el.removeEventListener('wheel', onWheel);
    };
  }, [selectable]);

  // Wheel events that land on the code element's header / border still need
  // native propagation stopped — synthetic React `onWheel` would not, because
  // whiteboard's wheel handler is registered with native `addEventListener`.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const stopWheelOutsideBody = (e: WheelEvent) => {
      const body = codeBodyRef.current;
      if (body && body.contains(e.target as Node)) return;
      e.stopPropagation();
    };

    el.addEventListener('wheel', stopWheelOutsideBody);
    return () => el.removeEventListener('wheel', stopWheelOutsideBody);
  }, []);

  // Block whiteboard pan from triggering when the user clicks the header /
  // border. Whiteboard's pan is a React `onPointerDown`, so synthetic
  // stopPropagation suffices — native listeners are not needed here.
  const stopPointer = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [highlighter, setHighlighter] = useState<any>(null);
  const prevLinesRef = useRef<CodeLine[]>(lines);
  const isFirstRenderRef = useRef(true);

  // The entrance animation states must exist on the very first render:
  // CodeLineRow latches `mounted` from its initial props, so if the rows
  // mount before the states arrive (the old setTimeout(0) path), every row
  // takes the non-animated branch and the per-line stagger collapses into
  // simultaneous typing (#531).
  const [animStates, setAnimStates] = useState<Map<string, LineAnimationState>>(() => {
    const states = new Map<string, LineAnimationState>();
    if (animate) {
      lines.forEach((line, i) => {
        states.set(line.id, { type: 'typing', timestamp: i * 80 });
      });
    }
    return states;
  });

  useEffect(() => {
    // First render's states are computed synchronously in the useState
    // initializer above; this effect only handles subsequent line edits.
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }

    const states = new Map<string, LineAnimationState>();

    if (animate) {
      const prevIds = new Set(prevLinesRef.current.map((l) => l.id));

      for (const line of lines) {
        if (!prevIds.has(line.id)) {
          states.set(line.id, { type: 'inserted', timestamp: 0 });
        }
      }

      for (const line of lines) {
        const prev = prevLinesRef.current.find((p) => p.id === line.id);
        if (prev && prev.content !== line.content) {
          states.set(line.id, { type: 'replaced', timestamp: 0 });
        }
      }

      prevLinesRef.current = lines;
    }

    const t = setTimeout(() => setAnimStates(states), 0);
    return () => clearTimeout(t);
  }, [lines, animate]);

  useEffect(() => {
    getHighlighter().then(setHighlighter);
  }, []);

  const highlightedLines = useMemo(() => {
    if (!highlighter) return null;

    const code = lines.map((l) => l.content).join('\n');

    let lang = language;
    try {
      highlighter.getLoadedLanguages();
    } catch {
      lang = 'text';
    }

    try {
      const html = highlighter.codeToHtml(code, { lang, theme: 'github-light' });
      const parsed = parseShikiLines(html);

      return lines.map((line, i) => ({
        id: line.id,
        html: parsed[i] || escapeHtml(line.content),
      }));
    } catch {
      return lines.map((line) => ({
        id: line.id,
        html: escapeHtml(line.content),
      }));
    }
  }, [highlighter, lines, language]);

  const fallbackLines = useMemo(() => {
    return lines.map((line) => ({
      id: line.id,
      html: escapeHtml(line.content),
    }));
  }, [lines]);

  const lineHtmlMap = highlightedLines || fallbackLines;

  const typingDelays = useMemo(() => {
    const delays = new Map<string, number>();
    let cumulative = 0;
    for (const line of lines) {
      if (animStates.has(line.id)) {
        delays.set(line.id, cumulative);
        cumulative += getTypingDuration(line.content) + LINE_GAP_MS;
      }
    }
    return delays;
  }, [lines, animStates]);

  return (
    <div
      ref={wrapperRef}
      className="base-element-code absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
      onPointerDown={stopPointer}
      onClick={stopPointer}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <style>{`
          @keyframes code-cursor-blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        `}</style>

        <div
          className="element-content w-full h-full flex flex-col overflow-hidden"
          style={{
            borderRadius: '6px',
            border: '1px solid #e5e7eb',
            background: '#f8f9fa',
            fontFamily:
              '"JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", ui-monospace, SFMono-Regular, "Liberation Mono", Menlo, Monaco, Consolas, monospace',
            fontSize: `${fontSize}px`,
          }}
        >
          {/*
            ★ 2026-10-09：**原来这里有一条仿 macOS 编辑器的顶栏** —— 红黄绿三个圆点 +
            右上角语言标签（`JAVA`），外加 8px 圆角与投影。它在这台机器上被用户否掉了
            （原话「感觉这个代码块丑丑的」），理由实测得出来：
              · 顶栏固定 **32px + 1px 边框**，而这一页的盒子只有 **127px 高** ⇒ 光它自己
                吃掉 **26%**，再叠上内边距与 5 行 × 22.4px，代码区只剩 93px 装 128px
                ⇒ **纵向溢出 35px**（第 5 行的 `}` 根本看不到）；
              · 投影 + 圆角 + 三点让它读起来像**一个浮起来的窗口**，而幻灯片其余部分
                是白底纯文字 —— 两种语言打架。
            现在只留"浅底 + 细边框"这一层，与正文同一套语言。
            语言名与文件名仍然在 `elementInfo` 里，只是不再占版面；
            要恢复顶栏的话，判据 `tests/components/code-element-chrome.test.ts` 会先红。
          */}

          {/* Code body */}
          <div
            ref={codeBodyRef}
            className={
              selectable
                ? 'flex-1 overflow-auto py-3 px-3 select-text cursor-text'
                : 'flex-1 overflow-auto py-3 px-3'
            }
            style={{
              color: '#24292e',
              ...(selectable
                ? {}
                : {
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    touchAction: 'none',
                  }),
            }}
          >
            <div style={{ minWidth: 'max-content' }}>
              <AnimatePresence initial={false} mode="popLayout">
                {lineHtmlMap.map((lineData, index) => {
                  const line = lines[index];
                  if (!line) return null;
                  return (
                    <CodeLineRow
                      key={line.id}
                      line={line}
                      lineNumber={index + 1}
                      highlightedHtml={lineData.html}
                      showLineNumbers={showLineNumbers}
                      animState={animStates.get(line.id)}
                      animate={!!animate}
                      typingDelay={typingDelays.get(line.id) ?? 0}
                    />
                  );
                })}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ==================== Utilities ====================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
