import { nanoid } from 'nanoid';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import { matchOutlineEntries } from '../course-outline-union';
import { putSceneBringingCurrent } from '../document-writes';
import { createBlankScene } from './apply';
import type { CourseToolDeps } from '../course-tools';
import { COURSE_STAGE_ID_DESCRIPTION } from '../course-stage';
import { synthesizeSceneNarration } from '../scene-tts';
import { runStageMutation } from '../mutation-fence';

const Target = {
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  sceneId: Type.Optional(Type.String()),
  order: Type.Optional(Type.Integer({ minimum: 1 })),
};

const GenerateTtsParams = Type.Object({
  ...Target,
  force: Type.Optional(Type.Boolean()),
});

const DeckParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  op: Type.Union([
    Type.Literal('retitle'),
    Type.Literal('insert'),
    Type.Literal('delete'),
    Type.Literal('reorder'),
  ]),
  sceneId: Type.Optional(Type.String()),
  order: Type.Optional(Type.Integer({ minimum: 1 })),
  title: Type.Optional(Type.String()),
  type: Type.Optional(
    Type.Union([
      Type.Literal('slide'),
      Type.Literal('quiz'),
      Type.Literal('interactive'),
      Type.Literal('pbl'),
    ]),
  ),
  atOrder: Type.Optional(Type.Integer({ minimum: 1 })),
  orderedIds: Type.Optional(Type.Array(Type.String())),
});

function result(text: string, details: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text' as const, text }], details, ...(isError ? { isError } : {}) };
}

function resolveScene(scenes: readonly Scene[], target: { sceneId?: string; order?: number }) {
  return target.sceneId
    ? scenes.find((scene) => scene.id === target.sceneId)
    : scenes.find((scene) => scene.order === target.order);
}

export function shiftCourseOrders(
  scenes: readonly Scene[],
  outline: AppDocumentOutline | undefined,
  at: number,
  delta: number,
) {
  const shiftedScenes = scenes.map((scene) =>
    scene.order >= at ? { ...scene, order: scene.order + delta } : scene,
  );
  if (!outline?.outlines?.length) return { scenes: shiftedScenes, outline };
  return {
    scenes: shiftedScenes,
    outline: {
      ...outline,
      outlines: outline.outlines
        .map((entry) => (entry.order >= at ? { ...entry, order: entry.order + delta } : entry))
        .sort((a, b) => a.order - b.order),
    },
  };
}

export function renumberCourseOrders(
  scenes: readonly Scene[],
  outline: AppDocumentOutline | undefined,
  /**
   * ★ **`dropUnmatched` 必须由调用方显式表态**（2026-10-07 修，实测数据丢失）。
   *
   * 这个函数被**两个语义完全不同的 op** 调用：
   * · `delete`（删掉一页）—— 对不上页面的计划条目**本来就该消失** ⇒ `true`；
   * · `reorder`（重排 / 插入之后的顺延）—— 对不上的条目**绝不能丢**，
   *   它代表"计划里有、页面还没做"，是合法的可见状态 ⇒ `false`。
   *
   * 原来没有这个参数、两条路都丢 ⇒ 实测：agent 补进 9 条、**同时丢掉 9 条**
   * （`stage-GYvpbYB_aN` 始终 50 条），并把这理解成"**计划容量只有 50 条**"。
   * ★ 我第一次"修"这里时没区分调用方、直接保留全部，被 delete 那条既有判据挡下，
   *   于是**整个撤回**了 —— 撤回是错的：该修的是**让调用方表态**，不是不动。
   *
   * 默认 `true` = 保持 delete 的既有语义（那条判据钉着它）。
   */
  options: { dropUnmatched?: boolean } = {},
) {
  const dropUnmatched = options.dropUnmatched ?? true;
  const numbered = scenes.map((scene, index) => ({ ...scene, order: index + 1 }));
  if (!outline?.outlines?.length) return { scenes: numbered, outline };
  const matches = matchOutlineEntries(
    [...scenes].sort((a, b) => a.order - b.order),
    outline.outlines,
  );
  const kept: SceneOutline[] = [];
  const unmatched: SceneOutline[] = [];
  outline.outlines.forEach((entry, index) => {
    const scene = numbered.find((candidate) => matches.get(candidate.id) === index);
    if (scene) kept.push({ ...entry, order: scene.order });
    else if (!dropUnmatched) unmatched.push(entry);
  });
  if (unmatched.length > 0) {
    const last = kept.reduce((max, entry) => Math.max(max, entry.order), 0);
    unmatched.forEach((entry, index) => kept.push({ ...entry, order: last + index + 1 }));
  }
  kept.sort((a, b) => a.order - b.order);
  return { scenes: numbered, outline: { ...outline, outlines: kept } };
}

export function buildCourseAudioAndDeckTools(deps: CourseToolDeps): AgentTool<never, never>[] {
  const generateTts: AgentTool<typeof GenerateTtsParams> = {
    name: 'generate_tts',
    label: 'Generate narration audio',
    description:
      'Synthesize narration for one persisted page. By default only speech actions without audio are filled; force regenerates all speech audio.',
    parameters: GenerateTtsParams,
    async execute(_callId, params, signal) {
      const doc = await deps.store.loadDocument(params.stageId);
      const scene = resolveScene(doc?.scenes ?? [], params);
      if (!doc || !scene) return result('Page not found. Call list_scenes.', {}, true);
      const summary = await (deps.synthesizeTts ?? synthesizeSceneNarration)({
        scene,
        force: params.force ?? false,
        roster: doc.stage.generatedAgentConfigs,
        signal,
        ownerId: deps.ownerId,
      });
      if (!summary.available) {
        return result(
          'No enabled server TTS capability is available. The page was unchanged.',
          {
            sceneId: scene.id,
          },
          true,
        );
      }
      if (summary.changed) {
        await runStageMutation(signal, () =>
          putSceneBringingCurrent(deps.store, params.stageId, scene),
        );
        deps.onCheckpoint({
          tool: 'generate_tts',
          stageId: params.stageId,
          sceneId: scene.id,
          order: scene.order,
          title: scene.title,
          sceneType: scene.type,
          detail: `narration audio persisted for ${scene.id}`,
        });
      }
      return result(
        `Narration audio: ${summary.generated} generated, ${summary.skipped} skipped, ${summary.failed.length} failed.`,
        {
          sceneId: scene.id,
          ...summary,
        },
      );
    },
  };

  const editDeck: AgentTool<typeof DeckParams> = {
    name: 'edit_deck',
    label: 'Edit course pages',
    description: 'Retitle, insert, delete, or reorder pages without regenerating their content.',
    parameters: DeckParams,
    async execute(_callId, params, signal) {
      const doc = await deps.store.loadDocument(params.stageId);
      if (!doc) return result('No course document yet. Call create_stage first.', {}, true);
      const scenes = [...doc.scenes].sort((a, b) => a.order - b.order);
      const outline = doc.outline as AppDocumentOutline | undefined;
      if (params.op === 'retitle') {
        const scene = resolveScene(scenes, params);
        if (!scene || !params.title?.trim())
          return result('retitle needs a page and title.', {}, true);
        const next = { ...scene, title: params.title.trim() } as Scene;
        const nextOutline = outline?.outlines?.map((entry) =>
          entry.id === scene.outlineId || entry.order === scene.order
            ? { ...entry, title: next.title }
            : entry,
        );
        await runStageMutation(signal, () =>
          deps.store.saveDocument({
            ...doc,
            scenes: scenes.map((item) => (item.id === scene.id ? next : item)),
            outline: nextOutline ? { ...outline, outlines: nextOutline } : doc.outline,
          }),
        );
        deps.onCheckpoint({
          tool: 'edit_deck',
          stageId: params.stageId,
          sceneId: scene.id,
          detail: `retitled ${scene.id}`,
        });
        return result(`Renamed page to "${next.title}".`, { sceneId: scene.id });
      }
      if (params.op === 'insert') {
        const at = Math.min(params.atOrder ?? scenes.length + 1, scenes.length + 1);
        const shifted = shiftCourseOrders(scenes, outline, at, 1);
        const created = createBlankScene({
          id: `scene-${nanoid(12)}`,
          stageId: params.stageId,
          order: at,
          title: params.title?.trim() || `Page ${at}`,
          type: params.type ?? 'slide',
        });
        await runStageMutation(signal, () =>
          deps.store.saveDocument({
            ...doc,
            scenes: [...shifted.scenes, created].sort((a, b) => a.order - b.order),
            outline: shifted.outline,
          }),
        );
        deps.onCheckpoint({
          tool: 'edit_deck',
          stageId: params.stageId,
          sceneId: created.id,
          order: at,
          detail: `inserted ${created.id}`,
        });
        return result(`Inserted page "${created.title}" at order ${at}.`, {
          sceneId: created.id,
          order: at,
        });
      }
      if (params.op === 'delete') {
        const scene = resolveScene(scenes, params);
        if (!scene) return result('delete needs an existing page.', {}, true);
        const next = renumberCourseOrders(
          scenes.filter((item) => item.id !== scene.id),
          outline,
        );
        await runStageMutation(signal, () =>
          deps.store.saveDocument({ ...doc, scenes: next.scenes, outline: next.outline }),
        );
        deps.onCheckpoint({
          tool: 'edit_deck',
          stageId: params.stageId,
          detail: `deleted ${scene.id}`,
        });
        return result(`Deleted page "${scene.title}".`, { pageCount: next.scenes.length });
      }
      if (!params.orderedIds?.length) return result('reorder needs orderedIds.', {}, true);
      const byId = new Map(scenes.map((scene) => [scene.id, scene]));
      const ordered = params.orderedIds.flatMap((id) => {
        const scene = byId.get(id);
        if (!scene) return [];
        byId.delete(id);
        return [scene];
      });
      ordered.push(...scenes.filter((scene) => byId.has(scene.id)));
      // ★ reorder / 插入后的顺延：**不许丢对不上的条目**（它们代表'计划里有、页面还没做'）。
      const next = renumberCourseOrders(ordered, outline, { dropUnmatched: false });
      await runStageMutation(signal, () =>
        deps.store.saveDocument({ ...doc, scenes: next.scenes, outline: next.outline }),
      );
      deps.onCheckpoint({ tool: 'edit_deck', stageId: params.stageId, detail: 'reordered pages' });
      return result('Reordered pages.', {
        pages: next.scenes.map(({ id, order, title }) => ({ id, order, title })),
      });
    },
  };

  return [generateTts, editDeck] as unknown as AgentTool<never, never>[];
}

export const COURSE_AUDIO_DECK_TOOL_NAMES = ['generate_tts', 'edit_deck'] as const;
