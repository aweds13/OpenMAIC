import { useMemo } from 'react';
import { useCanvasStore, useSceneSelector } from '@/lib/store';
import {
  ElementTypes,
  type PPTElement,
  type PPTLineElement,
  type PPTVideoElement,
  type PPTAudioElement,
  type PPTShapeElement,
  type PPTChartElement,
  type Slide,
  type PPTAnimation,
} from '@openmaic/dsl';
import type { OperateLineHandlers, OperateResizeHandlers } from '@/lib/types/edit';
import { ImageElementOperate } from './ImageElementOperate';
import { TextElementOperate } from './TextElementOperate';
import { ShapeElementOperate } from './ShapeElementOperate';
import { LineElementOperate } from './LineElementOperate';
import { TableElementOperate } from './TableElementOperate';
import { CommonElementOperate } from './CommonElementOperate';
import type { SlideContent } from '@/lib/types/stage';

interface OperateProps {
  readonly elementInfo: PPTElement;
  readonly isSelected: boolean;
  readonly isActive: boolean;
  readonly isActiveGroupElement: boolean;
  readonly isMultiSelect: boolean;
  readonly rotateElement: (
    e: React.MouseEvent,
    element: Exclude<
      PPTElement,
      PPTChartElement | PPTLineElement | PPTVideoElement | PPTAudioElement
    >,
  ) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: Exclude<PPTElement, PPTLineElement>,
    command: OperateResizeHandlers,
  ) => void;
  readonly dragLineElement: (
    e: React.MouseEvent,
    element: PPTLineElement,
    command: OperateLineHandlers,
  ) => void;
  readonly moveShapeKeypoint: (
    e: React.MouseEvent,
    element: PPTShapeElement,
    index: number,
  ) => void;
  readonly openLinkDialog: () => void;
}

/**
 * 元素类型 → 选中时那个"操作层"组件。
 *
 * ★ 导出是为了让判据能钉住**派生关系**（`tests/components/slide-renderer/editable-code-element.test.ts`），
 *   而不是去读源码文本 —— 后者行为零变化也会碎（本仓栽过一次）。
 *
 * ★ 2026-10-09：`code` 原来**不在这张表里**。缺了它，**选中代码块没有缩放手柄**
 *   （调用处 `isSelected && CurrentOperateComponent` 直接短路）。而代码块的盒子恰恰最需要手调：
 *   实测它的内部开销与 `text` 元素不同（内边距 24 + 每行 1.6×字号 + 边框 2），
 *   照抄 `text` 的盒子会把内容挤出去（Day02 第 21 页就是这么坏的）。
 *   ★ 这是 `code` 元素**三处元素表**的第三处（另两处：`ScreenElement`、`EditableElement`）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- element operate components have varying prop signatures
export const ELEMENT_OPERATE_COMPONENTS: Record<string, any> = {
  [ElementTypes.IMAGE]: ImageElementOperate,
  [ElementTypes.TEXT]: TextElementOperate,
  [ElementTypes.SHAPE]: ShapeElementOperate,
  [ElementTypes.LINE]: LineElementOperate,
  [ElementTypes.TABLE]: TableElementOperate,
  [ElementTypes.CHART]: CommonElementOperate,
  [ElementTypes.LATEX]: CommonElementOperate,
  [ElementTypes.VIDEO]: CommonElementOperate,
  [ElementTypes.AUDIO]: CommonElementOperate,
  [ElementTypes.CODE]: CommonElementOperate,
};

export function Operate({
  elementInfo,
  isSelected,
  isActive,
  isActiveGroupElement,
  isMultiSelect,
  rotateElement,
  scaleElement,
  dragLineElement,
  moveShapeKeypoint,
  openLinkDialog: _openLinkDialog,
}: OperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const toolbarState = useCanvasStore.use.toolbarState();

  // Get the formatted animations using a proper selector to avoid infinite loops
  const currentSlide = useSceneSelector<SlideContent, Slide>((content) => content.canvas);

  const formatedAnimations = useMemo(() => {
    if (!currentSlide?.animations) return [];

    const els = currentSlide.elements;
    const elIds = els.map((el) => el.id);
    const animations = currentSlide.animations.filter((animation) =>
      elIds.includes(animation.elId),
    );

    const formatedAnimations: {
      animations: PPTAnimation[];
      autoNext: boolean;
    }[] = [];
    for (const animation of animations) {
      if (animation.trigger === 'click' || !formatedAnimations.length) {
        formatedAnimations.push({ animations: [animation], autoNext: false });
      } else if (animation.trigger === 'meantime') {
        const last = formatedAnimations[formatedAnimations.length - 1];
        last.animations = last.animations.filter((item) => item.elId !== animation.elId);
        last.animations.push(animation);
        formatedAnimations[formatedAnimations.length - 1] = last;
      } else if (animation.trigger === 'auto') {
        const last = formatedAnimations[formatedAnimations.length - 1];
        last.autoNext = true;
        formatedAnimations[formatedAnimations.length - 1] = last;
        formatedAnimations.push({ animations: [animation], autoNext: false });
      }
    }
    return formatedAnimations;
  }, [currentSlide]);

  const CurrentOperateComponent = useMemo(
    () => ELEMENT_OPERATE_COMPONENTS[elementInfo.type] || null,
    [elementInfo.type],
  );

  const elementIndexListInAnimation = useMemo(() => {
    if (!formatedAnimations) return [];
    const indexList = [];
    for (let i = 0; i < formatedAnimations.length; i++) {
      const elIds = formatedAnimations[i].animations.map((item) => item.elId);
      if (elIds.includes(elementInfo.id)) indexList.push(i);
    }
    return indexList;
  }, [formatedAnimations, elementInfo.id]);

  const rotate = useMemo(() => ('rotate' in elementInfo ? elementInfo.rotate : 0), [elementInfo]);
  const height = useMemo(() => ('height' in elementInfo ? elementInfo.height : 0), [elementInfo]);

  const handlerVisible = !elementInfo.lock && (isActiveGroupElement || !isMultiSelect);

  return (
    <div
      className={`operate absolute z-43 select-none ${isMultiSelect && !isActive ? 'opacity-20' : ''}`}
      style={{
        top: elementInfo.top * canvasScale + 'px',
        left: elementInfo.left * canvasScale + 'px',
        transform: `rotate(${rotate}deg)`,
        transformOrigin: `${(elementInfo.width * canvasScale) / 2}px ${(height * canvasScale) / 2}px`,
        pointerEvents: 'auto', // Enable mouse events for operate controls
      }}
    >
      {/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic component dispatch requires type widening */}
      {isSelected && CurrentOperateComponent && (
        <CurrentOperateComponent
          elementInfo={elementInfo as any}
          handlerVisible={handlerVisible}
          rotateElement={rotateElement as any}
          scaleElement={scaleElement as any}
          dragLineElement={dragLineElement as any}
          moveShapeKeypoint={moveShapeKeypoint as any}
        />
      )}
      {/* eslint-enable @typescript-eslint/no-explicit-any */}

      {/* Animation index display */}
      {toolbarState === 'elAnimation' && elementIndexListInAnimation.length > 0 && (
        <div className="animation-index absolute top-0 -left-6 text-xs">
          {elementIndexListInAnimation.map((index) => (
            <div
              key={index}
              className="index-item w-[18px] h-[18px] bg-white text-primary border border-primary flex justify-center items-center mt-[5px] first:mt-0"
            >
              {index + 1}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
