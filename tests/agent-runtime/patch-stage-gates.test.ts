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

function patchTool(
  store: CourseStore,
  reviewedStages?: Set<string>,
  readReviewReceipt?: (stageId: string) => Promise<unknown | null>,
) {
  const tools = buildDslCourseTools({
    store,
    stageAccess: async () => OWNED,
    onCheckpoint: () => undefined,
    ...(reviewedStages ? { reviewedStages } : {}),
    // ★ 必须显式注入：不注入时闸会去真读 `OPENMAIC_PLAN_FREEZE_DIR` 下的凭据，
    //   而那是**跨用例共享的磁盘状态** —— 一条用例写的凭据会让后一条用例静默放行。
    readReviewReceipt: readReviewReceipt ?? (async () => null),
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

/**
 * ★ 2026-10-08 新增的两道闸：**结构洞**（空页 / 引用指向空页或越界）与**审查凭据**。
 *
 * 由来一（结构洞）：Day02 第 19 页《嵌套循环：双层 for 怎么跑》的 `canvas.elements` 是
 * **0 个**，而第 18 页写着「双层 for 见第 19 页」。这两条**逐页 diff 看不出来**，
 * 上一版只在 `course_audit` 里报 —— agent 不主动跑就永远看不到。
 *
 * 由来二（审查凭据）：用户要「第一次修改老课之前，要有一张审过的凭据」。**必须是代码闸**：
 * 本仓栽过一次 —— 说了「修复一下 Day1」，agent 查了一下就直接改页，不问也不审。
 *
 * 两道闸的规矩与超载闸一致：**先拒一次、把数字摆出来、问过之后带凭据再来**；
 * 而且都在**任何写入之前**拒（页面没被动过）。
 */
describe('★ patch_stage：结构洞闸（空页 / 坏引用）', () => {
  const emptySlide = (order: number): Scene =>
    ({
      id: `scene-empty-${order}`,
      stageId: 'stage-test',
      order,
      type: 'slide',
      title: `空页 ${order}`,
      content: { type: 'slide', canvas: { elements: [] } },
      actions: [],
    }) as unknown as Scene;

  it('★ 课里有空页 ⇒ 拒绝，并把页码摆出来；页面一个字没动', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf([slide(1, '短内容'), emptySlide(2)], false));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/1',
      intent: '改一下',
      ops: setOp('el-1', '改过的内容'),
    });
    const text = (response.content?.[0]?.text ?? '') + JSON.stringify(response.details);
    expect(response.isError).toBe(true);
    expect(response.details?.blocked).toBe('course-has-holes');
    expect(response.details?.emptyPages).toEqual([2]);
    expect(text).toContain('结构性空洞');
    expect(current.get().scenes[0]?.content).toMatchObject({
      canvas: { elements: [{ content: '<p>短内容</p>' }] },
    });
  });

  it('★ 引用指向空页也算洞 ⇒ 拒绝', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf([slide(1, '双层 for 见第 2 页'), emptySlide(2)], false));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/1',
      intent: '改一下',
      ops: setOp('el-1', '改过的内容'),
    });
    expect(response.details?.blocked).toBe('course-has-holes');
    expect(JSON.stringify(response.details)).toContain('"to":2');
  });

  it('★ 带上凭据 ⇒ 放行（闸只拒第一次，不是棘轮）', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf([slide(1, '短内容'), emptySlide(2)], false));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/1',
      intent: '补完空页之后再改这页',
      ops: setOp('el-1', '改过的内容'),
      holesAcknowledged: true,
      reviewAcknowledged: true,
    });
    expect(response.isError).toBeFalsy();
    expect(response.details?.blocked).toBeUndefined();
  });
});

describe('★ patch_stage：审查闸（B 方案）', () => {
  const eightPages = (): Scene[] =>
    Array.from({ length: 8 }, (_, index) => slide(index + 1, '短内容'));

  it('★ 8 页的课 + 这次运行里没审过 ⇒ 拒绝，并说清两条出口', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf(eightPages(), false));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/2',
      intent: '改一下',
      ops: setOp('el-1', '改过的内容'),
    });
    const text = (response.content?.[0]?.text ?? '') + JSON.stringify(response.details);
    expect(response.isError).toBe(true);
    expect(response.details?.blocked).toBe('course-not-reviewed');
    expect(response.details?.pageCount).toBe(8);
    expect(text).toContain('review_course');
    expect(text).toContain('reviewAcknowledged');
  });

  it('★ 同一运行里审过 ⇒ 放行（凭据真的被读了）', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf(eightPages(), false));
    const response = await patchTool(current.store, new Set(['stage-test'])).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/2',
      intent: '改一下',
      ops: setOp('el-1', '改过的内容'),
    });
    expect(response.isError).toBeFalsy();
    expect(response.details?.blocked).toBeUndefined();
  });

  it('★ 课太小（< 8 页）不拦 —— 审查一次的成本比收益大', async () => {
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

  it('★ 明说不用审 ⇒ 放行', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf(eightPages(), false));
    const response = await patchTool(current.store).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/2',
      intent: '学习者说这次不用审',
      ops: setOp('el-1', '改过的内容'),
      reviewAcknowledged: true,
    });
    expect(response.isError).toBeFalsy();
  });
});

/**
 * ★ 审查凭据**落盘**（2026-10-08：用户定了「收尾时审一次」）。
 *
 * 既然审查发生在**课程收尾**，那"以后再来修这门课"就是**另一次运行** ——
 * 凭据只在 run 内有效的话，每次修老课都会被迫重审整门课（一次长上下文调用）。
 * 所以盘上的凭据必须被认。
 */
describe('★ patch_stage：审查凭据落盘（跨 run）', () => {
  const eightPages = (): Scene[] =>
    Array.from({ length: 8 }, (_, index) => slide(index + 1, '短内容'));

  it('★ 盘上有凭据 ⇒ 放行（这次运行没审过也算）', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf(eightPages(), false));
    const receipt = { stageId: 'stage-test', reviewedAt: '2026-10-08T00:00:00.000Z', pageCount: 8, reportChars: 900 };
    const response = await patchTool(current.store, undefined, async () => receipt).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/2',
      intent: '收尾时审过了，这次只改一页',
      ops: setOp('el-1', '改过的内容'),
    });
    expect(response.isError).toBeFalsy();
    expect(response.details?.blocked).toBeUndefined();
  });

  it('★ 盘上**没有**凭据 ⇒ 照旧拒（别把闸放成空的）', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const current = harness(documentOf(eightPages(), false));
    const response = await patchTool(current.store, undefined, async () => null).execute('c', {
      stageId: 'stage-test',
      target: '/scenes/2',
      intent: '改一下',
      ops: setOp('el-1', '改过的内容'),
    });
    expect(response.details?.blocked).toBe('course-not-reviewed');
  });
});
