// @vitest-environment jsdom
/**
 * The batch-download dialog is the only entry point to the batch export, so its
 * wiring — which courses the selection actually hands to the builder, that the
 * produced archive is saved, and that the per-course report replaces the picker
 * — is pinned here. The builder itself is covered by `batch-export.test.ts`.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ calls: [] as Array<{ name: string }> }));
const builder = vi.hoisted(() => ({ calls: [] as Array<{ ids: string[]; selection: unknown }> }));

vi.mock('file-saver', () => ({
  saveAs: (_blob: Blob, name: string) => {
    saved.calls.push({ name });
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  }),
}));

// Keep the real error classes (the dialog branches on them) and stub only the
// build entry point.
vi.mock('@/lib/export/batch-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export/batch-export')>();
  return {
    ...actual,
    buildBatchExportZip: vi.fn(
      async (
        courses: Array<{ id: string; name: string }>,
        selection: unknown,
        options?: {
          onProgress?: (p: { done: number; total: number; currentName: string }) => void;
        },
      ) => {
        builder.calls.push({ ids: courses.map((course) => course.id), selection });
        options?.onProgress?.({ done: 1, total: courses.length, currentName: courses[0].name });
        return {
          blob: new Blob(['zip']),
          fileName: 'OpenMAIC-batch-2026-10-06-1530.zip',
          totalFiles: courses.length * 2,
          courses: courses.map((course) => ({
            id: course.id,
            name: course.name,
            folder: course.name,
            files: [`${course.name}/${course.name}.pptx`],
            skippedPptx: false,
            skippedInteractive: true,
            failedAssetUrls: [],
          })),
        };
      },
    ),
  };
});

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { BatchDownloadDialog } from '@/components/workbench/workspace/BatchDownloadDialog';

const COURSES = [
  { id: 'c1', name: '机器学习', sceneCount: 12 },
  { id: 'c2', name: '操作系统', sceneCount: 8 },
  { id: 'c3', name: '编译原理', sceneCount: 20 },
];

describe('BatchDownloadDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    saved.calls = [];
    builder.calls = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderDialog = () =>
    act(() =>
      root.render(
        createElement(BatchDownloadDialog, {
          open: true,
          onOpenChange: () => {},
          courses: COURSES,
        }),
      ),
    );

  const query = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);

  const clickCourse = (id: string) => {
    const checkbox = query(`batch-download-course-${id}`)?.querySelector('button[role="checkbox"]');
    if (!checkbox) throw new Error(`no checkbox for ${id}`);
    act(() => {
      (checkbox as HTMLElement).click();
    });
  };

  const clickStart = () => {
    const button = query('batch-download-start') as HTMLButtonElement;
    act(() => {
      button.click();
    });
  };

  it('lists every course with its page count', async () => {
    await renderDialog();
    expect(query('batch-download-course-c1')).not.toBeNull();
    expect(query('batch-download-course-c1')?.textContent).toContain('机器学习');
    // The page count rides the rail's own `workspace.sceneCount` key (mocked to
    // its identity here), i.e. one wording for the count everywhere.
    expect(query('batch-download-course-c3')?.textContent).toBe('编译原理workspace.sceneCount');
    expect(query('batch-download-count')?.textContent).toBe(
      'workspace.batchDownload.selectedSummary',
    );
  });

  it('keeps the download button disabled until a course is picked', async () => {
    await renderDialog();
    expect((query('batch-download-start') as HTMLButtonElement).disabled).toBe(true);
    clickCourse('c1');
    expect((query('batch-download-start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('filters the picker without changing the true course total', async () => {
    await renderDialog();
    const input = query('batch-download-filter') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '操作');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(query('batch-download-course-c1')).toBeNull();
    expect(query('batch-download-course-c2')).not.toBeNull();
  });

  it('hands exactly the picked courses and the content selection to the builder, then saves the archive', async () => {
    await renderDialog();
    clickCourse('c1');
    clickCourse('c3');
    clickStart();
    // The builder resolves on a microtask; flush it.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(builder.calls).toHaveLength(1);
    expect(builder.calls[0].ids).toEqual(['c1', 'c3']);
    expect(builder.calls[0].selection).toEqual({
      includePptx: true,
      includeInteractive: true,
      includeClassroomZip: true,
    });
    expect(saved.calls).toEqual([{ name: 'OpenMAIC-batch-2026-10-06-1530.zip' }]);
  });

  it('replaces the picker with a per-course report after the run', async () => {
    await renderDialog();
    clickCourse('c1');
    clickStart();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(query('batch-download-summary')).not.toBeNull();
    expect(query('batch-download-course-list')).toBeNull();
    expect(query('batch-download-result-c1')?.textContent).toContain('机器学习');
  });

  it('does not run when nothing is selected', async () => {
    await renderDialog();
    clickStart();
    await act(async () => {
      await Promise.resolve();
    });
    expect(builder.calls).toHaveLength(0);
    expect(saved.calls).toHaveLength(0);
  });
});
