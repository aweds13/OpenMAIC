import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Value } from 'typebox/value';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import type { CourseDocument, CourseStore } from '@/lib/server/agent-runtime/course-tools';
import { buildDslCourseToolset } from '@/lib/server/agent-runtime/course-tools';
import {
  buildGenerationTools,
  collectUnresolvedMediaPlaceholders,
  filterKnownActions,
} from '@/lib/server/agent-runtime/generation-tools';
import type { Scene } from '@/lib/types/stage';

function slide(id: string, order: number, title = id): Scene {
  return {
    id,
    stageId: 'stage-test',
    order,
    title,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#2463eb'],
          fontColor: '#111',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
    actions: [],
  } as Scene;
}

function document(scenes: Scene[]): CourseDocument {
  const outlines = scenes.map((scene) => ({
    id: scene.outlineId ?? scene.id,
    order: scene.order,
    title: scene.title,
    type: scene.type,
    description: `${scene.title} brief`,
    keyPoints: [],
  }));
  // ★ generate_scene 现在有**阶段冻结**的门槛（计划非空 + 已冻结 + 这一页在计划里）。
  //   夹具的计划条目本来就有，缺的只是"已冻结" —— 这里把它补上。
  //   这不是松弛判据，是把真实前置条件补进夹具；判据本身另有 plan-freeze.test.ts 钉住。
  const freezeDir = process.env.OPENMAIC_PLAN_FREEZE_DIR ?? join(process.cwd(), 'data', 'plan-freeze');
  mkdirSync(freezeDir, { recursive: true });
  writeFileSync(
    join(freezeDir, 'stage-test.json'),
    JSON.stringify({
      stageId: 'stage-test',
      frozen: true,
      frozenAt: 1,
      frozenEntryCount: outlines.length,
      revision: 0,
      revisions: [],
    }),
    'utf8',
  );
  return {
    stage: { id: 'stage-test', name: 'Test', createdAt: 1, updatedAt: 1 },
    scenes,
    outline: { outlines, createdAt: 1, updatedAt: 1 },
  } as CourseDocument;
}

function state(initial: CourseDocument | null) {
  let doc = initial ? structuredClone(initial) : null;
  const store = {
    loadDocument: vi.fn(async () => doc),
    putScene: vi.fn(async (_stageId: string, scene: Scene) => {
      if (!doc) throw new Error('missing');
      const index = doc.scenes.findIndex((item) => item.id === scene.id);
      doc.scenes =
        index < 0
          ? [...doc.scenes, scene]
          : doc.scenes.map((item) => (item.id === scene.id ? scene : item));
    }),
    saveDocument: vi.fn(async (next: CourseDocument) => {
      doc = structuredClone(next);
    }),
  } as unknown as CourseStore;
  return { store, get: () => doc };
}

function find(tools: AgentTool<never, never>[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

function deps(store: CourseStore, extra: Record<string, unknown> = {}) {
  return {
    store,
    stageAccess: async () => ({ kind: 'owned' as const }),
    sessionId: 'session-a',
    onCheckpoint: vi.fn(),
    synthesizeTts: vi.fn(async () => ({
      available: true,
      changed: false,
      generated: 0,
      skipped: 0,
      failed: [],
    })),
    ...extra,
  };
}

describe('generation and deck tools', () => {
  it('reports active-skill diagnostics against the persisted stage after generation', async () => {
    const current = state(document([]));
    const onCheckpoint = vi.fn();
    let calls = 0;
    const generate = find(
      buildGenerationTools(
        deps(current.store, {
          onCheckpoint,
          getActiveSkill: () => ({
            id: 'workshop-style',
            name: 'workshop-style',
            description: 'Workshop',
            content: '# Workshop',
            filePath: '/skills/workshop-style/SKILL.md',
            constraints: { sceneCount: { min: 2 } },
            source: 'builtin',
          }),
          aiCall: vi.fn(async () => {
            calls += 1;
            return calls === 1
              ? JSON.stringify([{ id: 'q1', type: 'short_answer', question: 'Try it?' }])
              : JSON.stringify([{ type: 'text', content: 'Narration' }]);
          }),
        }),
      ),
      'generate_scene',
    );
    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Practice',
      type: 'quiz',
      brief: 'Try the idea',
    } as never);
    expect((response.content[0] as { text?: string } | undefined)?.text).toContain(
      'SKILL CONSTRAINT CHECK',
    );
    expect(response.details).toMatchObject({
      skill: 'workshop-style',
      skillViolations: ['1 scenes, the skill requires at least 2'],
    });
    expect(onCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ skill: 'workshop-style', skillViolations: expect.any(Array) }),
    );
  });

  it('keeps an earlier page after a later page generation crashes', async () => {
    const current = state(document([]));
    let contentCalls = 0;
    const aiCall = vi.fn(async () => {
      contentCalls += 1;
      if (contentCalls === 1)
        return JSON.stringify([{ id: 'q1', type: 'short_answer', question: 'First?' }]);
      if (contentCalls === 2) return JSON.stringify([{ type: 'text', content: 'First narration' }]);
      throw new Error('mid-generation failure');
    });
    const tools = buildGenerationTools(deps(current.store, { aiCall }));
    const generate = find(tools, 'generate_scene');
    await generate.execute('first', {
      stageId: 'stage-test',
      order: 1,
      title: 'First',
      type: 'quiz',
      brief: 'First brief',
    } as never);
    await expect(
      generate.execute('second', {
        stageId: 'stage-test',
        order: 2,
        title: 'Second',
        type: 'quiz',
        brief: 'Second brief',
      } as never),
    ).rejects.toThrow('mid-generation failure');
    expect(current.get()?.scenes.map(({ order, title }) => ({ order, title }))).toEqual([
      { order: 1, title: 'First' },
    ]);
  });

  it.each([
    ['slide', 'SLIDE_RAW_SENTINEL', undefined],
    ['quiz', 'QUIZ_RAW_SENTINEL', undefined],
    ['interactive', 'INTERACTIVE_RAW_SENTINEL', { widgetType: 'diagram' }],
  ] as const)(
    'preserves malformed %s generation failures without writing raw model output',
    async (type, rawResponse, interactive) => {
      const existing = slide('existing', 1, 'Existing');
      const current = state(document([existing]));
      const onCheckpoint = vi.fn();
      const generateActions = vi.fn();
      const generate = find(
        buildGenerationTools(
          deps(current.store, {
            onCheckpoint,
            generateActions,
            aiCall: vi.fn(async () => rawResponse),
          }),
        ),
        'generate_scene',
      );
      const before = structuredClone(current.get());
      const originalLogFormat = process.env.LOG_FORMAT;
      const originalLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_FORMAT = 'json';
      process.env.LOG_LEVEL = 'warn';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const response = await generate.execute('call', {
          stageId: 'stage-test',
          order: 1,
          title: '  Replacement  ',
          type,
          brief: 'A replacement page',
          ...(interactive ?? {}),
        } as never);

        const toolResult = response as { isError?: boolean; details: Record<string, unknown> };
        expect(toolResult.isError).toBe(true);
        expect((response.content[0] as { text: string }).text).toBe(
          'The model response could not be parsed into page content; nothing was written.',
        );
        expect(toolResult.details).toEqual({
          error: 'invalid-model-output',
          order: 1,
          title: 'Replacement',
          type,
          sceneId: 'existing',
        });
        expect(JSON.stringify(response)).not.toContain(rawResponse);
        expect(current.get()).toEqual(before);
        expect(current.store.putScene).not.toHaveBeenCalled();
        expect(current.store.saveDocument).not.toHaveBeenCalled();
        expect(generateActions).not.toHaveBeenCalled();
        expect(onCheckpoint).not.toHaveBeenCalled();

        expect(warn).toHaveBeenCalledTimes(1);
        const warning = JSON.parse(String(warn.mock.calls[0][0]));
        expect(warning).toMatchObject({ level: 'WARN', tag: 'AgentGenerationTools' });
        expect(JSON.parse(warning.message)).toEqual({
          error: 'invalid-model-output',
          stageId: 'stage-test',
          order: 1,
          title: 'Replacement',
          type,
          sceneId: 'existing',
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(rawResponse);
      } finally {
        warn.mockRestore();
        if (originalLogFormat === undefined) delete process.env.LOG_FORMAT;
        else process.env.LOG_FORMAT = originalLogFormat;
        if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = originalLogLevel;
      }
    },
  );

  it('refuses destructive PBL type changes and unresolved generation media', async () => {
    const pbl = slide('project', 1, 'Project') as Scene;
    pbl.type = 'pbl';
    pbl.content = { type: 'pbl', projectV2: { id: 'project' } } as never;
    const current = state(document([pbl]));
    const generate = find(buildGenerationTools(deps(current.store)), 'generate_scene');
    const typeChange = await generate.execute('type-change', {
      stageId: 'stage-test',
      order: 1,
      title: 'Replacement',
      type: 'slide',
      brief: 'Replace the project',
    } as never);
    expect(typeChange).toMatchObject({ isError: true, details: { blocked: 'pbl-type-change' } });
    const badMedia = await generate.execute('bad-media', {
      stageId: 'stage-test',
      order: 2,
      title: 'Media',
      type: 'slide',
      brief: 'Use media',
      media: [{ src: 'image:pending', description: 'Pending image' }],
    } as never);
    expect(badMedia).toMatchObject({ isError: true, details: { error: 'media-placeholder-src' } });
    const dataUrlMedia = await generate.execute('data-url-media', {
      stageId: 'stage-test',
      order: 2,
      title: 'Media',
      type: 'slide',
      brief: 'Use media',
      media: [{ src: 'data:image/png;base64,AAAA', description: 'Inline image' }],
    } as never);
    expect(dataUrlMedia).toMatchObject({ isError: true, details: { error: 'invalid-media-src' } });
    expect(current.get()?.scenes).toHaveLength(1);
  });

  it('accepts the stored-asset id generate_image returns and writes it onto the element', async () => {
    // The documented flow is generate_image -> generate_scene.media, and
    // generate_image returns an allocated id now that it stores its bytes in
    // the pool (#1522). The id has to survive both the media gate and the
    // image-id resolution, and land on the element exactly as issued.
    const current = state(document([]));
    let calls = 0;
    const generate = find(
      buildGenerationTools(
        deps(current.store, {
          aiCall: vi.fn(async () => {
            calls += 1;
            return calls === 1
              ? JSON.stringify({
                  elements: [
                    {
                      id: 'image-1',
                      type: 'image',
                      src: 'img_1',
                      left: 0,
                      top: 0,
                      width: 400,
                      height: 225,
                    },
                  ],
                })
              : JSON.stringify([{ type: 'text', content: 'Narration' }]);
          }),
        }),
      ),
      'generate_scene',
    );

    const response = await generate.execute('pool-media', {
      stageId: 'stage-test',
      order: 1,
      title: 'Media',
      type: 'slide',
      brief: 'Use the generated image',
      media: [{ src: 'ast_generated_1', description: 'A microscope', width: 400, height: 225 }],
    } as never);

    expect(response).not.toMatchObject({ isError: true });
    const scene = current.get()?.scenes[0];
    const elements = (scene?.content as { canvas: { elements: { src?: string }[] } }).canvas
      .elements;
    expect(elements[0]?.src).toBe('ast_generated_1');
  });

  it('passes widgetType and widgetOutline through to interactive generation', async () => {
    const current = state(document([]));
    const prompts: string[] = [];
    let calls = 0;
    const aiCall = vi.fn(async (_system: string, user: string) => {
      calls += 1;
      prompts.push(user);
      return calls === 1
        ? '<!DOCTYPE html><html><body><div id="water-cycle"></div></body></html>'
        : '[]';
    });
    const generate = find(buildGenerationTools(deps(current.store, { aiCall })), 'generate_scene');
    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Water Cycle',
      type: 'interactive',
      brief: 'Show how the water cycle works',
      widgetType: 'diagram',
      widgetOutline: { concept: 'Water cycle', diagramType: 'mindmap' },
    } as never);
    expect(response).not.toMatchObject({ isError: true });
    const scene = current.get()?.scenes[0];
    expect(scene).toMatchObject({ type: 'interactive' });
    expect(scene?.content).toMatchObject({ widgetType: 'diagram' });
    expect(prompts[0]).toContain('mindmap');
  });

  it('falls back to a simulation widget when interactive generation omits widgetType', async () => {
    const current = state(document([]));
    let calls = 0;
    const aiCall = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? '<!DOCTYPE html><html><body><div id="energy-slider"></div></body></html>'
        : '[]';
    });
    const generate = find(buildGenerationTools(deps(current.store, { aiCall })), 'generate_scene');
    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Energy',
      type: 'interactive',
      brief: 'Explore energy transfer',
    } as never);
    expect(response).not.toMatchObject({ isError: true });
    expect(current.get()?.scenes[0]?.content).toMatchObject({ widgetType: 'simulation' });
  });

  it('rejects widgetType on non-interactive pages without writing anything', async () => {
    const current = state(document([]));
    const generate = find(buildGenerationTools(deps(current.store)), 'generate_scene');
    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Slide',
      type: 'slide',
      brief: 'A plain slide',
      widgetType: 'diagram',
    } as never);
    expect(response).toMatchObject({
      isError: true,
      details: { error: 'widget-requires-interactive' },
    });
    expect(current.get()?.scenes).toHaveLength(0);
  });

  it('rejects malformed widgetOutline values without writing anything', async () => {
    const current = state(document([]));
    const generate = find(buildGenerationTools(deps(current.store)), 'generate_scene');
    const base = {
      stageId: 'stage-test',
      order: 1,
      title: 'Slide',
      brief: 'A plain slide',
    };
    const nullOutline = await generate.execute('null-outline', {
      ...base,
      type: 'interactive',
      widgetType: 'diagram',
      widgetOutline: null,
    } as never);
    expect(nullOutline).toMatchObject({
      isError: true,
      details: { error: 'invalid-widget-outline' },
    });
    const stringOutline = await generate.execute('string-outline', {
      ...base,
      type: 'interactive',
      widgetOutline: 'mindmap',
    } as never);
    expect(stringOutline).toMatchObject({
      isError: true,
      details: { error: 'invalid-widget-outline' },
    });
    const wrongType = await generate.execute('wrong-type', {
      ...base,
      type: 'slide',
      widgetOutline: null,
    } as never);
    expect(wrongType).toMatchObject({
      isError: true,
      details: { error: 'widget-requires-interactive' },
    });
    expect(current.get()?.scenes).toHaveLength(0);
  });

  it('mirrors the generator defaults when only one widget field is provided', async () => {
    const current = state(document([]));
    const prompts: string[] = [];
    let calls = 0;
    const aiCall = vi.fn(async (_system: string, user: string) => {
      calls += 1;
      prompts.push(user);
      return calls % 2 === 1
        ? '<!DOCTYPE html><html><body><div id="widget"></div></body></html>'
        : '[]';
    });
    const generate = find(buildGenerationTools(deps(current.store, { aiCall })), 'generate_scene');
    // Bare widgetType: the handler must supply widgetOutline { concept: title },
    // otherwise generateWidgetContent returns null.
    const typeOnly = await generate.execute('type-only', {
      stageId: 'stage-test',
      order: 1,
      title: 'Gravity Playground',
      type: 'interactive',
      brief: 'Play with gravity',
      widgetType: 'simulation',
    } as never);
    expect(typeOnly).not.toMatchObject({ isError: true });
    expect(current.get()?.scenes[0]?.content).toMatchObject({ widgetType: 'simulation' });
    expect(prompts[0]).toContain('Gravity Playground');
    // Bare widgetOutline: widgetType defaults to simulation and keeps the outline.
    const outlineOnly = await generate.execute('outline-only', {
      stageId: 'stage-test',
      order: 2,
      title: 'Entropy',
      type: 'interactive',
      brief: 'Explore entropy',
      widgetOutline: { concept: 'Entropy of mixing' },
    } as never);
    expect(outlineOnly).not.toMatchObject({ isError: true });
    expect(current.get()?.scenes[1]?.content).toMatchObject({ widgetType: 'simulation' });
    expect(prompts[2]).toContain('Entropy of mixing');
  });

  it('validates widget params through the tool schema', () => {
    const generate = find(buildGenerationTools(deps(state(document([])).store)), 'generate_scene');
    const base = {
      stageId: 'stage-test',
      order: 1,
      title: 'Title',
      type: 'interactive',
      brief: 'Brief',
    };
    expect(Value.Check(generate.parameters, { ...base, widgetType: 'diagram' })).toBe(true);
    // procedural-skill stays gated behind task-engine mode: the tool schema
    // must keep rejecting it until a vocational signal reaches this layer.
    expect(Value.Check(generate.parameters, { ...base, widgetType: 'procedural-skill' })).toBe(
      false,
    );
    expect(Value.Check(generate.parameters, { ...base, widgetType: 'hologram' })).toBe(false);
  });

  it('detects slide media placeholders without returning page bodies', () => {
    const scene = slide('media', 1);
    (scene.content as Extract<Scene['content'], { type: 'slide' }>).canvas.elements = [
      { id: 'image-1', type: 'image', src: 'image:pending' },
      { id: 'video-1', type: 'video', src: '', mediaRef: 'video:pending' },
    ] as never;
    expect(collectUnresolvedMediaPlaceholders(scene)).toEqual([
      { elementId: 'image-1', type: 'image', placeholder: 'image:pending' },
      { elementId: 'video-1', type: 'video', placeholder: 'video:pending' },
    ]);
  });

  it('makes duplicate_scene idempotent for a replayed call id', async () => {
    const current = state(document([slide('source', 1)]));
    const duplicate = find(buildGenerationTools(deps(current.store)), 'duplicate_scene');
    const params = { stageId: 'stage-test', templateSceneId: 'source', targetOrder: 2 };
    await duplicate.execute('same-call', params as never);
    const replay = await duplicate.execute('same-call', params as never);
    expect(current.get()?.scenes).toHaveLength(2);
    expect(replay.details).toMatchObject({ replay: true });
  });

  it('renumbers scenes and outline entries together for reorder and delete', async () => {
    const a = slide('a', 1, 'A');
    a.outlineId = 'oa';
    const b = slide('b', 2, 'B');
    b.outlineId = 'ob';
    const c = slide('c', 3, 'C');
    c.outlineId = 'oc';
    const current = state(document([a, b, c]));
    const edit = find(buildDslCourseToolset(deps(current.store)), 'edit_deck');
    await edit.execute('reorder', {
      stageId: 'stage-test',
      op: 'reorder',
      orderedIds: ['c', 'a', 'b'],
    } as never);
    await edit.execute('delete', { stageId: 'stage-test', op: 'delete', sceneId: 'a' } as never);
    expect(current.get()?.scenes.map((scene) => [scene.id, scene.order])).toEqual([
      ['c', 1],
      ['b', 2],
    ]);
    expect(
      (current.get()?.outline as { outlines: Array<{ id: string; order: number }> }).outlines.map(
        (entry) => [entry.id, entry.order],
      ),
    ).toEqual([
      ['oc', 1],
      ['ob', 2],
    ]);
  });

  it('drops action types unknown to the shared DSL', () => {
    expect(
      filterKnownActions([
        { id: 'speech', type: 'speech', text: 'Known' },
        { id: 'future', type: 'future_action' } as never,
      ]),
    ).toEqual([{ id: 'speech', type: 'speech', text: 'Known' }]);
  });

  it('marks every new document writer sequential', () => {
    const tools = buildDslCourseToolset(deps(state(document([slide('a', 1)])).store));
    for (const name of [
      'generate_scene',
      'generate_actions',
      'duplicate_scene',
      'generate_tts',
      'edit_deck',
    ]) {
      expect(find(tools, name)).toMatchObject({ executionMode: 'sequential' });
    }
    for (const name of ['list_scenes', 'read_stage', 'grep_stage']) {
      expect(find(tools, name)).not.toHaveProperty('executionMode');
    }
  });

  it('fails closed through an owner-bound store for every new write tool', async () => {
    const foreign = state(null);
    const tools = buildDslCourseToolset(deps(foreign.store));
    const calls: Array<[string, Record<string, unknown>]> = [
      ['generate_scene', { stageId: 'foreign', order: 1, title: 'X', type: 'slide', brief: 'X' }],
      ['generate_actions', { stageId: 'foreign', order: 1 }],
      ['duplicate_scene', { stageId: 'foreign', templateOrder: 1, targetOrder: 2 }],
      ['generate_tts', { stageId: 'foreign', order: 1 }],
      ['edit_deck', { stageId: 'foreign', op: 'delete', order: 1 }],
    ];
    for (const [name, params] of calls) {
      const response = await find(tools, name).execute(`call-${name}`, params as never);
      expect(response).toMatchObject({ isError: true });
    }
    expect(foreign.get()).toBeNull();
  });
});

/**
 * 这三组回归对应三个实测出来的缺陷（2026-10-05 那节 28 页的课）：
 *
 *   1. 自学模式下 `generate_scene` **仍然**生成并落盘讲稿 —— 162 次
 *      generate_scene 对 160 次 patch_stage，其中 36 次明写「移除自动生成的旁白」。
 *      提示词里那句「不要跑 generate_actions」拦不住，因为讲稿是工具内部写的。
 *   2. 自检页**没有表达题量的参数**，永远落到 SDK 写死的 3 题；实测工作台生成的
 *      自检页全是 3 题，而手工补过的页面是 6/8/10 题。
 *   3. 题量不足时**静默通过** —— json-repair 的修截断分支把写崩的数组砍到最后一个
 *      完整对象再当成功返回。
 */
describe('generate_scene — self-study narration suppression', () => {
  const slideRaw = JSON.stringify({
    elements: [
      {
        id: 'title_1',
        type: 'text',
        left: 60,
        top: 40,
        width: 880,
        height: 80,
        content: '<p>Variables</p>',
      },
    ],
    background: { type: 'solid', color: '#ffffff' },
  });

  function actionsSpy() {
    return vi.fn(async () => [
      { id: 'a1', type: 'speech', text: 'Hello class' },
      { id: 'a2', type: 'spotlight', elementId: 'title_1' },
    ]);
  }

  it('generates narration when the page is not self-study', async () => {
    const current = state(document([]));
    const generateActions = actionsSpy();
    const generate = find(
      buildGenerationTools(
        deps(current.store, {
          generateActions,
          aiCall: vi.fn(async () => slideRaw),
        }),
      ),
      'generate_scene',
    );

    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Variables',
      type: 'slide',
      brief: 'A listen-mode page',
      selfStudy: false,
    } as never);

    expect(generateActions).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ details: { actionCount: 2, selfStudy: false } });
    expect(current.get()?.scenes[0]?.actions).toHaveLength(2);
  });

  it('does not call the narration generator at all for a self-study page', async () => {
    const current = state(document([]));
    const generateActions = actionsSpy();
    const generate = find(
      buildGenerationTools(
        deps(current.store, {
          generateActions,
          aiCall: vi.fn(async () => slideRaw),
        }),
      ),
      'generate_scene',
    );

    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Variables',
      type: 'slide',
      brief: 'A page the learner reads',
      selfStudy: true,
    } as never);

    // The whole point: no second model call, and nothing to clean up afterwards.
    expect(generateActions).not.toHaveBeenCalled();
    expect(response).toMatchObject({ details: { actionCount: 0, selfStudy: true } });
    expect((response.content[0] as { text: string }).text).toContain('Self-study');
    expect(current.get()?.scenes[0]?.actions).toEqual([]);
  });

  it('takes the deployment default when the call omits selfStudy', async () => {
    vi.resetModules();
    vi.stubEnv('OPENMAIC_SELF_STUDY', 'true');
    try {
      const { buildGenerationTools: buildFresh } = await import(
        '@/lib/server/agent-runtime/generation-tools'
      );
      const current = state(document([]));
      const generateActions = actionsSpy();
      const generate = find(
        buildFresh(
          deps(current.store, {
            generateActions,
            aiCall: vi.fn(async () => slideRaw),
          }) as never,
        ),
        'generate_scene',
      );

      const response = await generate.execute('call', {
        stageId: 'stage-test',
        order: 1,
        title: 'Variables',
        type: 'slide',
        brief: 'No mode stated',
      } as never);

      expect(generateActions).not.toHaveBeenCalled();
      expect(response).toMatchObject({ details: { selfStudy: true, actionCount: 0 } });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('generate_scene — quiz question count', () => {
  function quizJson(count: number): string {
    return JSON.stringify(
      Array.from({ length: count }, (_, index) => ({
        id: `q${index + 1}`,
        type: 'single',
        question: `Question ${index + 1}?`,
        options: [
          { label: 'First', value: 'A' },
          { label: 'Second', value: 'B' },
        ],
        answer: ['A'],
        analysis: 'Because.',
        points: 10,
      })),
    );
  }

  it('passes questionCount through to the quiz content prompt', async () => {
    const current = state(document([]));
    const prompts: string[] = [];
    const generate = find(
      buildGenerationTools(
        deps(current.store, {
          generateActions: vi.fn(async () => []),
          aiCall: vi.fn(async (_system: string, user: string) => {
            prompts.push(user);
            return quizJson(7);
          }),
        }),
      ),
      'generate_scene',
    );

    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Self-check',
      type: 'quiz',
      brief: 'Seven questions',
      selfStudy: true,
      quizConfig: { questionCount: 7, difficulty: 'hard', questionTypes: ['multiple'] },
    } as never);

    // Before the fix there was no way to express this at all: the outline never
    // carried quizConfig, so the generator always used its own default of 3.
    expect(prompts[0]).toContain('Question Count: 7');
    expect(prompts[0]).toContain('Difficulty: hard');
    expect(prompts[0]).toContain('Question Types: multiple');
    expect(response).toMatchObject({
      details: { quizRequestedQuestions: 7, quizProducedQuestions: 7 },
    });
    expect(response).not.toMatchObject({ isError: true });
  });

  it('uses a non-3 default when a quiz page omits quizConfig', async () => {
    const current = state(document([]));
    const prompts: string[] = [];
    const generate = find(
      buildGenerationTools(
        deps(current.store, {
          generateActions: vi.fn(async () => []),
          aiCall: vi.fn(async (_system: string, user: string) => {
            prompts.push(user);
            return quizJson(5);
          }),
        }),
      ),
      'generate_scene',
    );

    await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Self-check',
      type: 'quiz',
      brief: 'Some questions',
      selfStudy: true,
    } as never);

    expect(prompts[0]).toContain('Question Count: 5');
  });

  it('reports a truncated quiz instead of quietly shipping fewer questions', async () => {
    const current = state(document([]));
    const generate = find(
      buildGenerationTools(
        deps(current.store, {
          generateActions: vi.fn(async () => []),
          // What json-repair's truncation branch hands back: a complete prefix of
          // the array, parsed "successfully", with no signal that anything is missing.
          aiCall: vi.fn(async () => quizJson(3)),
        }),
      ),
      'generate_scene',
    );

    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Self-check',
      type: 'quiz',
      brief: 'Eight questions',
      selfStudy: true,
      quizConfig: { questionCount: 8 },
    } as never);

    const text = (response.content[0] as { text: string }).text;
    expect(text).toContain('QUESTION COUNT SHORTFALL');
    expect(text).toContain('asked for 8');
    expect(text).toContain('returned 3');
    expect(response).toMatchObject({
      isError: true,
      details: {
        quizRequestedQuestions: 8,
        quizProducedQuestions: 3,
        quizShortfall: true,
      },
    });
    // The page is still persisted: the work done is not thrown away, it is
    // reported as incomplete so the agent can regenerate or top it up.
    expect(current.get()?.scenes[0]).toBeDefined();
  });

  it('rejects quizConfig on a non-quiz page without writing anything', async () => {
    const current = state(document([]));
    const generate = find(buildGenerationTools(deps(current.store)), 'generate_scene');
    const response = await generate.execute('call', {
      stageId: 'stage-test',
      order: 1,
      title: 'Slide',
      type: 'slide',
      brief: 'Not a quiz',
      quizConfig: { questionCount: 5 },
    } as never);
    expect(response).toMatchObject({
      isError: true,
      details: { error: 'quiz-config-requires-quiz' },
    });
    expect(current.get()?.scenes).toHaveLength(0);
  });
});
