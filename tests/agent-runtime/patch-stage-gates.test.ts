import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PPTTextElement } from '@openmaic/dsl';
import type { Scene } from '@/lib/types/stage';
import type { CourseDocument, CourseStore } from '@/lib/server/agent-runtime/course-tools';
import { buildDslCourseTools } from '@/lib/server/agent-runtime/dsl-tools';
import { auditCourse, NOVEL_P90 } from '@/lib/quiz/course-audit';

/**
 * ★ `patch_stage` 的两道闸（2026-10-07 加）。
 *
 * ── 由来：用户实测的一句话 ──────────────────────────────────────
 * 他说「修复一下Day1」，agent **只查了一下计划状态就直接 `patch_stage` 改页** ——
 * 不问、也不把计划或审计给他看。两处结构性原因：
 *
 * ① **门槛原来只挂在 `generate_scene` 上** ⇒ "修复一页"这条**最常见的路完全不受管**。
 *    §结论库里我自己写过"门禁必须挂在两条写入路径上"，当时只修了诊断那两条。
 * ② 根本没有"这一页超载了，先给学习者看数字并确认"这道闸。
 *
 * 这一组把两道闸各钉三下（**拒**、**该放行时放行**、**别把一切都拒掉**）——
 * 只测过拒绝路径的门禁，可能把一切都拒掉（`generation-tools` 那一组踩过同样的坑）。
 */
const OWNED = { kind: 'owned' as const, stage: { stageId: 'stage-test', name: 'Test course' } };

/** 一份**合法**的 slide（照 `dsl-tools.test.ts` 的夹具），正文可换。 */
function slide(order: number, body: string, id = `scene_s${order}`): Scene {
  return {
    id,
    stageId: 'stage-test',
    order,
    title: `第 ${order} 页`,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${order}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#2563eb'],
          fontColor: '#111',
          fontName: 'Inter',
        },
        elements: [
          {
            id: `el-${order}`,
            type: 'text',
            left: 10,
            top: 10,
            width: 800,
            height: 200,
            rotate: 0,
            content: `<p>${body}</p>`,
            defaultFontName: 'Inter',
            defaultColor: '#111',
            fill: '#fff',
          } as PPTTextElement,
        ],
      },
    },
    actions: [],
  } as Scene;
}

/** 60 个互不相同的三字术语 —— 实测 novel=56（> p90=49）。 */
function overloadBody(): string {
  return Array.from(
    { length: 60 },
    (_, index) => `术语${String.fromCharCode(0x4e00 + index)}码`,
  ).join('，');
}

function documentOf(scenes: Scene[], withOutline: boolean): CourseDocument {
  return {
    stage: {
      id: 'stage-test',
      name: 'Test course',
      description: 'd',
      createdAt: 1,
      updatedAt: 1,
    },
    outline: {
      outlines: withOutline
        ? scenes.map((scene) => ({
            id: `outline-${scene.id}`,
            order: scene.order,
            type: scene.type,
            title: scene.title,
            description: `Outline ${scene.title}`,
            keyPoints: [],
          }))
        : [],
    },
    scenes,
  } as unknown as CourseDocument;
}

function harness(initial: CourseDocument) {
  let doc = structuredClone(initial);
  const putScene = vi.fn(async (_stageId: string, scene: Scene) => {
    doc = { ...doc, scenes: doc.scenes.map((item) => (item.id === scene.id ? scene : item)) };
  });
  const loadDocument = vi.fn(async (stageId: string) => (stageId === doc.stage.id ? doc : null));
  return { store: { loadDocument, putScene } as unknown as CourseStore, get: () => doc };
}

function patchTool(store: CourseStore) {
  const tools = buildDslCourseTools({
    store,
    stageAccess: async () => OWNED,
    onCheckpoint: () => undefined,
  });
  const found = tools.find((item) => item.name === 'patch_stage');
  if (!found) throw new Error('patch_stage missing');
  return found as unknown as {
    execute(
      id: string,
      params: Record<string, unknown>,
    ): Promise<{ isError?: boolean; details?: Record<string, unknown>; content?: { text?: string }[] }>;
  };
}

const freezeDir = () =>
  process.env.OPENMAIC_PLAN_FREEZE_DIR ?? join(process.cwd(), 'data', 'plan-freeze');

function setFrozen(frozen: boolean, entryCount = 2) {
  mkdirSync(freezeDir(), { recursive: true });
  writeFileSync(
    join(freezeDir(), 'stage-test.json'),
    JSON.stringify({
      stageId: 'stage-test',
      frozen,
      frozenAt: frozen ? 1 : undefined,
      frozenEntryCount: entryCount,
      revision: 0,
      revisions: [],
    }),
    'utf8',
  );
}

const setOp = (id: string, text: string) => [
  { op: 'set', path: `/content/canvas/elements/0/content`, value: `<p>${text}</p>` },
];

const PREV_GATE = process.env.OPENMAIC_PLAN_GATE;
afterEach(() => {
  if (PREV_GATE === undefined) delete process.env.OPENMAIC_PLAN_GATE;
  else process.env.OPENMAIC_PLAN_GATE = PREV_GATE;
});

describe('★ patch_stage：计划门槛（② 与 generate_scene 同一条判据）', () => {
  it('门槛关着时不拦（默认部署以外的地方不受影响）', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf([slide(1, '短内容')], false));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/1',
      intent: '改一下',
      ops: setOp('el-1', '改过的内容'),
    });
    expect(response.details?.blocked).toBeUndefined();
  });

  it('★ 门槛开着 + 计划为空 ⇒ 拒；而且消息里报的是【patch_stage】，不是 generate_scene', async () => {
    process.env.OPENMAIC_PLAN_GATE = '1';
    const current = harness(documentOf([slide(1, '短内容')], false));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/1',
      intent: '改一下',
      ops: setOp('el-1', '改过的内容'),
    });
    const text = (response.content?.[0]?.text ?? '') + JSON.stringify(response.details);
    expect(response.isError).toBe(true);
    expect(response.details?.blocked).toBe('plan-not-frozen');
    expect(text).toContain('patch_stage 被拒绝');
    // ★ 这条是刻意的：原来三条拒绝信息都写死 generate_scene，
    //   搬到 patch_stage 之后会让模型以为该去调 generate_scene。
    expect(text).not.toContain('generate_scene 被拒绝');
    // 而且是**在任何写入之前**拒的 —— 页面没被动过。
    expect(current.get().scenes[0]?.content).toMatchObject({
      canvas: { elements: [{ content: '<p>短内容</p>' }] },
    });
  });

  it('★ 该放行时放行：门槛开着 + 已冻结 + 这一页在计划里 ⇒ 不拦', async () => {
    process.env.OPENMAIC_PLAN_GATE = '1';
    setFrozen(true, 1);
    const current = harness(documentOf([slide(1, '短内容')], true));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/1',
      intent: '改一下',
      ops: setOp('el-1', '改过的内容'),
    });
    expect(response.details?.blocked).toBeUndefined();
    expect(response.isError).toBeFalsy();
  });
});

describe('★ patch_stage：超载页必须先给学习者看数字（② 新增的闸）', () => {
  it('夹具前提成立：那一页真的被判超载', () => {
    const page = slide(1, overloadBody());
    const audit = auditCourse([
      {
        stageId: 'stage-test',
        sceneId: page.id,
        order: 1,
        title: page.title,
        type: page.type,
        content: page.content,
      },
    ]);
    // ★ 前提本身也要断言 —— 否则夹具哪天不再超载，这一组会【静默地空过】。
    expect(audit.pages[0]?.novel).toBeGreaterThan(NOVEL_P90);
  });

  it('★ 超载页 + 没有确认 ⇒ 拒，并把数字给出来', async () => {
    delete process.env.OPENMAIC_PLAN_GATE; // 只让这道闸生效
    const current = harness(documentOf([slide(1, overloadBody())], true));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/1',
      intent: '把这页改小一点',
      ops: setOp('el-1', '改过的内容'),
    });
    const text = response.content?.[0]?.text ?? '';
    expect(response.isError).toBe(true);
    expect(response.details?.blocked).toBe('page-overloaded');
    expect(response.details?.novelP90).toBe(NOVEL_P90);
    expect(typeof response.details?.novel).toBe('number');
    // 拒绝信息里必须有：数字、`ask_user`、以及"拿到答复再带 flag 回来"。
    expect(text).toContain(String(NOVEL_P90));
    expect(text).toContain('ask_user');
    expect(text).toContain('overloadAcknowledged');
    // 同样：拒在写入之前。
    expect(current.get().scenes[0]?.content).toMatchObject({
      canvas: { elements: [{ content: `<p>${overloadBody()}</p>` }] },
    });
  });

  it('★ 带上确认 ⇒ 放行', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf([slide(1, overloadBody())], true));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/1',
      intent: '学习者选了拆页，先改这一页',
      ops: setOp('el-1', '改过的内容'),
      overloadAcknowledged: true,
    });
    expect(response.details?.blocked).toBeUndefined();
  });

  it('★ 别把一切都拒掉：**不超载**的页不需要确认', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf([slide(1, '短内容')], true));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/1',
      intent: '改一下',
      ops: setOp('el-1', '改过的内容'),
    });
    expect(response.details?.blocked).toBeUndefined();
  });
});
