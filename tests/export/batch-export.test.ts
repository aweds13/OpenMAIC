import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import {
  BatchExportCancelledError,
  BatchExportEmptySelectionError,
  assignCourseFolders,
  batchExportFileName,
  buildBatchExportZip,
  deriveCourseDeck,
  sanitizeArchiveComponent,
  type BatchExportCourseData,
  type BatchExportDeps,
} from '@/lib/export/batch-export';
import { collectInteractivePages } from '@/lib/export/use-export-pptx';
import type { Scene, Stage } from '@/lib/types/stage';

// ─── Fixtures ─────────────────────────────────────────────────────────

function slideScene(id: string, viewportSize = 1000, viewportRatio = 0.5625): Scene {
  return {
    id,
    stageId: 'stg',
    title: `Slide ${id}`,
    order: 1,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [], viewportSize, viewportRatio } },
  } as unknown as Scene;
}

function interactiveScene(id: string, title = 'Spin the frame'): Scene {
  return {
    id,
    stageId: 'stg',
    title,
    order: 2,
    type: 'interactive',
    content: { type: 'interactive', url: '', html: '<html><body>ok</body></html>' },
  } as unknown as Scene;
}

function courseData(id: string, scenes: Scene[]): BatchExportCourseData {
  return { stage: { id, name: `Course ${id}` } as unknown as Stage, scenes };
}

const ALL = { includePptx: true, includeInteractive: true, includeClassroomZip: true };

async function zipEntries(blob: Blob): Promise<string[]> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir)
    .sort();
}

/**
 * Fakes for the three heavy builders. `collectInteractive` mirrors the real
 * collector's path contract: scene order, zero-padded index, `interactive/`
 * under the caller's prefix.
 */
function fakeDeps(
  data: Record<string, BatchExportCourseData | null>,
  overrides: Partial<BatchExportDeps> = {},
): Partial<BatchExportDeps> {
  return {
    loadCourse: vi.fn(async (stageId: string) => data[stageId] ?? null),
    buildPptx: vi.fn(async () => new Blob(['pptx-bytes'])),
    buildClassroomZip: vi.fn(async () => ({
      zip: new Blob(['classroom-bytes']),
      fileName: 'inner-name.maic.zip',
    })),
    collectInteractive: vi.fn(async (scenes: readonly Scene[], opts) => {
      const prefix = opts?.pathPrefix ?? '';
      const files = scenes
        .filter((scene) => scene.content.type === 'interactive')
        .map((scene, index) => ({
          path: `${prefix}interactive/${String(index + 1).padStart(2, '0')}_${scene.title}.html`,
          html: '<html></html>',
        }));
      return { files, failedAssetUrls: [] };
    }),
    ...overrides,
  };
}

// ─── Pure helpers ─────────────────────────────────────────────────────

describe('sanitizeArchiveComponent', () => {
  it('replaces path-hostile characters and trims trailing dots/spaces', () => {
    expect(sanitizeArchiveComponent('a/b:c*d?e"f<g>h|i', 'x')).toBe('a_b_c_d_e_f_g_h_i');
    expect(sanitizeArchiveComponent('lesson. ', 'x')).toBe('lesson');
    expect(sanitizeArchiveComponent('   ', 'fallback')).toBe('fallback');
    expect(sanitizeArchiveComponent('', 'fallback')).toBe('fallback');
  });

  it('keeps CJK names intact', () => {
    expect(sanitizeArchiveComponent('机器学习 第 3 讲', 'x')).toBe('机器学习 第 3 讲');
  });
});

describe('assignCourseFolders', () => {
  it('gives duplicate names distinct folders, case-insensitively', () => {
    const folders = assignCourseFolders([
      { id: '1', name: 'Untitled' },
      { id: '2', name: 'untitled' },
      { id: '3', name: 'Untitled' },
    ]);
    expect(folders.get('1')).toBe('Untitled');
    expect(folders.get('2')).toBe('untitled (2)');
    expect(folders.get('3')).toBe('Untitled (3)');
  });

  it('falls back to the course id when the name sanitizes to nothing', () => {
    const folders = assignCourseFolders([{ id: 'abc', name: '///' }]);
    expect(folders.get('abc')).toBe('___');
    const empty = assignCourseFolders([{ id: 'abc', name: '   ' }]);
    expect(empty.get('abc')).toBe('abc');
  });
});

describe('deriveCourseDeck', () => {
  it('takes the viewport from the course’s own first slide, not a global', () => {
    const deck = deriveCourseDeck([interactiveScene('i1'), slideScene('s1', 1280, 0.75)]);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slideScenes.map((scene) => scene.id)).toEqual(['s1']);
    expect(deck.viewportSize).toBe(1280);
    expect(deck.viewportRatio).toBe(0.75);
  });

  it('falls back to 1000×16:9 when the slide carries no viewport', () => {
    const deck = deriveCourseDeck([slideScene('s1', undefined as never, undefined as never)]);
    expect(deck.viewportSize).toBe(1000);
    expect(deck.viewportRatio).toBe(0.5625);
  });
});

describe('batchExportFileName', () => {
  it('is a deterministic, ASCII, second-resolution-free name', () => {
    expect(batchExportFileName(new Date(2026, 9, 6, 15, 30))).toBe(
      'OpenMAIC-batch-2026-10-06-1530.zip',
    );
  });
});

// ─── Composition ──────────────────────────────────────────────────────

describe('buildBatchExportZip', () => {
  it('writes one folder per course holding pptx, interactive pages and the classroom zip', async () => {
    const courses = [
      { id: 'c1', name: '机器学习' },
      { id: 'c2', name: '操作系统' },
    ];
    const result = await buildBatchExportZip(courses, ALL, {
      deps: fakeDeps({
        c1: courseData('c1', [slideScene('s1'), interactiveScene('i1', 'Demo')]),
        c2: courseData('c2', [slideScene('s2')]),
      }),
      now: new Date(2026, 9, 6, 15, 30),
    });

    const entries = await zipEntries(result.blob);
    expect(entries).toEqual([
      '操作系统/操作系统.maic.zip',
      '操作系统/操作系统.pptx',
      '机器学习/interactive/01_Demo.html',
      '机器学习/机器学习.maic.zip',
      '机器学习/机器学习.pptx',
    ]);
    expect(result.fileName).toBe('OpenMAIC-batch-2026-10-06-1530.zip');
    expect(result.totalFiles).toBe(5);
    expect(result.courses.every((course) => !course.error)).toBe(true);
    // The classroom builder's own file name is NOT used: the entry is named
    // for the course, so the batch owns its own naming.
    expect(entries).not.toContain('机器学习/inner-name.maic.zip');
  });

  it('honours the content selection', async () => {
    const data = { c1: courseData('c1', [slideScene('s1'), interactiveScene('i1')]) };
    const pptxOnly = await buildBatchExportZip(
      [{ id: 'c1', name: 'A' }],
      {
        includePptx: true,
        includeInteractive: false,
        includeClassroomZip: false,
      },
      { deps: fakeDeps(data) },
    );
    expect(await zipEntries(pptxOnly.blob)).toEqual(['A/A.pptx']);

    const interactiveOnly = await buildBatchExportZip(
      [{ id: 'c1', name: 'A' }],
      {
        includePptx: false,
        includeInteractive: true,
        includeClassroomZip: false,
      },
      { deps: fakeDeps(data) },
    );
    expect(await zipEntries(interactiveOnly.blob)).toEqual([
      'A/interactive/01_Spin the frame.html',
    ]);
  });

  it('marks a course with no slides or no interactive scenes as skipped, not failed', async () => {
    const result = await buildBatchExportZip([{ id: 'c1', name: 'A' }], ALL, {
      deps: fakeDeps({ c1: courseData('c1', [interactiveScene('i1')]) }),
    });
    const [course] = result.courses;
    expect(course.error).toBeUndefined();
    expect(course.skippedPptx).toBe(true);
    expect(course.skippedInteractive).toBe(false);
    expect(result.totalFiles).toBe(2);
  });

  it('isolates a broken course: the rest of the batch still lands', async () => {
    const deps = fakeDeps({
      c1: courseData('c1', [slideScene('s1')]),
      c3: courseData('c3', [slideScene('s3')]),
    });
    (deps.loadCourse as ReturnType<typeof vi.fn>).mockImplementation(async (stageId: string) => {
      if (stageId === 'c2') throw new Error('document store exploded');
      return stageId === 'c1'
        ? courseData('c1', [slideScene('s1')])
        : courseData('c3', [slideScene('s3')]);
    });

    const result = await buildBatchExportZip(
      [
        { id: 'c1', name: 'A' },
        { id: 'c2', name: 'B' },
        { id: 'c3', name: 'C' },
      ],
      ALL,
      { deps },
    );

    const entries = await zipEntries(result.blob);
    expect(entries).toContain('A/A.pptx');
    expect(entries).toContain('C/C.pptx');
    expect(entries.some((entry) => entry.startsWith('B/'))).toBe(false);
    const failed = result.courses.filter((course) => course.error);
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('c2');
    expect(failed[0].error).toContain('document store exploded');
  });

  it('treats an unloadable course as a per-course failure', async () => {
    const result = await buildBatchExportZip([{ id: 'gone', name: 'Gone' }], ALL, {
      deps: fakeDeps({ gone: null }),
    });
    expect(result.courses[0].error).toBeTruthy();
    expect(result.totalFiles).toBe(0);
  });

  it('reports progress from 0/total up to total/total', async () => {
    const seen: Array<[number, number]> = [];
    await buildBatchExportZip(
      [
        { id: 'c1', name: 'A' },
        { id: 'c2', name: 'B' },
      ],
      ALL,
      {
        deps: fakeDeps({
          c1: courseData('c1', [slideScene('s1')]),
          c2: courseData('c2', [slideScene('s2')]),
        }),
        onProgress: (progress) => seen.push([progress.done, progress.total]),
      },
    );
    expect(seen).toEqual([
      [0, 2],
      [1, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it('refuses a selection that asks for nothing', async () => {
    await expect(
      buildBatchExportZip([{ id: 'c1', name: 'A' }], {
        includePptx: false,
        includeInteractive: false,
        includeClassroomZip: false,
      }),
    ).rejects.toBeInstanceOf(BatchExportEmptySelectionError);
  });

  it('throws a cancellation error instead of saving a partial archive', async () => {
    const controller = new AbortController();
    const deps = fakeDeps({
      c1: courseData('c1', [slideScene('s1')]),
      c2: courseData('c2', [slideScene('s2')]),
    });
    // Abort while the first course is being built.
    (deps.buildPptx as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort();
      return new Blob(['pptx-bytes']);
    });

    await expect(
      buildBatchExportZip(
        [
          { id: 'c1', name: 'A' },
          { id: 'c2', name: 'B' },
        ],
        ALL,
        { deps, signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(BatchExportCancelledError);
  });

  it('reads each course once, and never the same course twice', async () => {
    const deps = fakeDeps({
      c1: courseData('c1', [slideScene('s1')]),
      c2: courseData('c2', [slideScene('s2')]),
    });
    await buildBatchExportZip(
      [
        { id: 'c1', name: 'A' },
        { id: 'c2', name: 'B' },
      ],
      ALL,
      { deps },
    );
    expect((deps.loadCourse as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual(
      ['c1', 'c2'],
    );
  });
});

// ─── Shared interactive collector ─────────────────────────────────────

describe('collectInteractivePages', () => {
  it('keeps the resource pack’s own naming when no prefix is given', async () => {
    const { files } = await collectInteractivePages([interactiveScene('i1', 'Spin')]);
    expect(files).toEqual([{ path: 'interactive/01_Spin.html', html: expect.any(String) }]);
  });

  it('prefixes every page under a course folder and skips non-interactive scenes', async () => {
    const { files } = await collectInteractivePages(
      [slideScene('s1'), interactiveScene('i1', 'A'), interactiveScene('i2', 'B')],
      { pathPrefix: '课程/' },
    );
    expect(files.map((file) => file.path)).toEqual([
      '课程/interactive/01_A.html',
      '课程/interactive/02_B.html',
    ]);
  });

  it('sanitizes a title that would otherwise break out of the folder', async () => {
    const { files } = await collectInteractivePages([interactiveScene('i1', '../evil')]);
    expect(files[0].path).toBe('interactive/01_.._evil.html');
  });
});
