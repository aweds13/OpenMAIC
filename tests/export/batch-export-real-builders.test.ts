// @vitest-environment jsdom
/**
 * Integration: the batch composition driving the REAL builders.
 *
 * `batch-export.test.ts` pins the composition against fakes. This file answers
 * the different question the fakes cannot: with real `buildPptxBlob`, the real
 * interactive-page collector and the real classroom-ZIP builder, does one batch
 * call actually produce a course folder of usable artifacts? A green unit suite
 * only says the code ran the way it was written — not that a learner gets a
 * deck and a re-importable course out of the other end.
 *
 * `loadCourse` is the one thing stubbed: it is the browser's document store
 * boundary (`accessDocument`), not part of the export pipeline. Everything
 * downstream of the loaded scenes is the production code path.
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSlideFixture } from '@/tests/edit/round-trip/fixtures';
import type { Scene, Stage } from '@/lib/types/stage';

const COURSE_NAME = '机器学习 第一讲';

/**
 * `@/lib/utils/database` builds its Dexie instance at MODULE LOAD and captures
 * `indexedDB`/`IDBKeyRange` from the global then, so the shim must be installed
 * before that graph is imported — hence the dynamic import inside each test
 * rather than a top-level `import { buildBatchExportZip }`.
 */
async function loadBatchBuilder() {
  return (await import('@/lib/export/batch-export')).buildBatchExportZip;
}

function interactiveScene(): Scene {
  return {
    id: 'interactive-1',
    stageId: 'stage-1',
    type: 'interactive',
    title: '牛顿迭代演示',
    order: 2,
    content: {
      type: 'interactive',
      url: '',
      html: '<!doctype html><html><body><h1>Newton</h1></body></html>',
    },
  } as unknown as Scene;
}

async function readZip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

async function entryNames(zip: JSZip): Promise<string[]> {
  return Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir)
    .sort();
}

describe('batch export with the real builders', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('produces a real PPTX, a real interactive page and a real classroom ZIP in one course folder', async () => {
    const buildBatchExportZip = await loadBatchBuilder();
    const { scene: slideScene } = makeSlideFixture();
    const stage = {
      id: 'stage-1',
      name: COURSE_NAME,
      createdAt: 1,
      updatedAt: 2,
    } as unknown as Stage;

    const result = await buildBatchExportZip([{ id: 'stage-1', name: COURSE_NAME }], {
      includePptx: true,
      includeInteractive: true,
      includeClassroomZip: true,
    }, {
      deps: {
        loadCourse: async () => ({
          stage,
          scenes: [{ ...slideScene, stageId: 'stage-1' }, interactiveScene()],
        }),
      },
    });

    const outer = await readZip(result.blob);
    // Assert the per-course outcome FIRST: a course that threw is recorded with
    // a reason, and the missing entry would otherwise be the only symptom.
    expect(result.courses[0].error).toBeUndefined();
    expect(await entryNames(outer)).toEqual([
      `${COURSE_NAME}/interactive/01_牛顿迭代演示.html`,
      `${COURSE_NAME}/${COURSE_NAME}.maic.zip`,
      `${COURSE_NAME}/${COURSE_NAME}.pptx`,
    ]);

    // The PPTX is a real deck, not our stub's `pptx-bytes`.
    const pptx = await JSZip.loadAsync(await outer.file(`${COURSE_NAME}/${COURSE_NAME}.pptx`)!.async('uint8array'));
    expect(Object.keys(pptx.files)).toContain('ppt/slides/slide1.xml');
    const slideXml = await pptx.file('ppt/slides/slide1.xml')!.async('string');
    expect(slideXml.length).toBeGreaterThan(200);

    // The interactive page kept the resource pack's shape and its own bytes.
    const page = await outer.file(`${COURSE_NAME}/interactive/01_牛顿迭代演示.html`)!.async('string');
    expect(page).toContain('Newton');

    // The classroom ZIP is a re-importable archive of the same course: a real
    // manifest naming the stage, carrying BOTH scenes (the slide and the
    // interactive page) — i.e. the artifact that keeps quiz/PBL scenes too.
    const classroom = await JSZip.loadAsync(
      await outer.file(`${COURSE_NAME}/${COURSE_NAME}.maic.zip`)!.async('uint8array'),
    );
    expect(Object.keys(classroom.files)).toContain('manifest.json');
    const manifest = JSON.parse(await classroom.file('manifest.json')!.async('string'));
    expect(manifest.stage.name).toBe(COURSE_NAME);
    expect(manifest.scenes).toHaveLength(2);
    expect(manifest.scenes.map((scene: { type: string }) => scene.type).sort()).toEqual([
      'interactive',
      'slide',
    ]);
    // The real deck build is CPU-bound and this file runs inside the full
    // parallel suite, where 5s of wall clock is not a lot to ask for. Same
    // class of contention as the documented `voice-clone-tools` WAV timeout.
  }, 30_000);

  it('skips the PPTX for an interactive-only course without failing the batch', async () => {
    const buildBatchExportZip = await loadBatchBuilder();
    const stage = { id: 'stage-2', name: '纯交互', createdAt: 1, updatedAt: 2 } as unknown as Stage;
    const result = await buildBatchExportZip([{ id: 'stage-2', name: '纯交互' }], {
      includePptx: true,
      includeInteractive: true,
      includeClassroomZip: false,
    }, {
      deps: {
        loadCourse: async () => ({
          stage,
          scenes: [{ ...interactiveScene(), stageId: 'stage-2' }],
        }),
      },
    });

    const outer = await readZip(result.blob);
    expect(await entryNames(outer)).toEqual(['纯交互/interactive/01_牛顿迭代演示.html']);
    expect(result.courses[0].skippedPptx).toBe(true);
    expect(result.courses[0].error).toBeUndefined();
  });
});
