/**
 * Batch export: several courses' artifacts in ONE archive.
 *
 * The workspace used to have exactly one way to get a PPTX or a course's
 * interactive pages: open the course and use its stage-header download menu.
 * With a library of courses that is "open them one by one", and a browser
 * blocks a page that fires N downloads in a row anyway — so the batch is a
 * single ZIP whose top level is one folder per course.
 *
 * What a course folder holds, and why:
 *  - `<course>.pptx` — the slide deck (same builder as the single export).
 *  - `interactive/NN_<title>.html` — the self-contained interactive pages, from
 *    the SAME collector the single-course resource pack uses, so the two
 *    cannot drift on naming or ordering.
 *  - `<course>.maic.zip` — the re-importable classroom archive. It is the only
 *    artifact that carries a course WHOLE: quiz and PBL scenes render through
 *    the app's own React renderers and have no standalone-HTML export, so the
 *    classroom ZIP is the only thing that preserves them.
 *
 * This module is deliberately free of React, toasts and `saveAs`: it builds a
 * blob and reports per-course outcomes, and the dialog owns everything the user
 * sees. Course loading and the three builders are injectable so the composition
 * — folder naming, per-course isolation, which scenes qualify — is unit-testable
 * without a browser, a document store, or a real PPTX run.
 */
import { CLASSROOM_ZIP_EXTENSION } from './classroom-zip-types';
import type { Scene, Stage, SlideContent } from '@/lib/types/stage';
import type { Slide } from '@openmaic/dsl';
import type { FetchAsset } from './inline-assets';
// TYPE-ONLY on purpose. `use-export-pptx` carries pptxgenjs, and the workspace
// rail mounts the dialog that mounts this module — a value import here would
// pull the whole deck builder into the rail's chunk and into every test that
// renders the rail. The real collector is loaded lazily in `defaultDeps`.
import type { InteractivePageFile } from './use-export-pptx';

/** One course as the batch sees it: identity only — the builder loads the rest. */
export interface BatchExportCourseInput {
  readonly id: string;
  readonly name: string;
}

/** Which of the three artifacts each course folder should hold. */
export interface BatchExportSelection {
  readonly includePptx: boolean;
  readonly includeInteractive: boolean;
  readonly includeClassroomZip: boolean;
}

/** A course's stage + scenes, as the builders want them. */
export interface BatchExportCourseData {
  readonly stage: Stage;
  readonly scenes: Scene[];
}

/**
 * The four things the composition needs from the app. Defaults live below and
 * are what the dialog uses; tests replace them wholesale.
 */
export interface BatchExportDeps {
  /** Load one course without opening it (no store mutation, no navigation). */
  readonly loadCourse: (stageId: string) => Promise<BatchExportCourseData | null>;
  readonly buildPptx: (
    slides: Slide[],
    slideScenes: Scene[],
    viewportRatio: number,
    viewportSize: number,
    ratioPx2Inch: number,
    ratioPx2Pt: number,
    stageId?: string,
  ) => Promise<Blob>;
  readonly buildClassroomZip: (
    stage: Stage,
    scenes: Scene[],
  ) => Promise<{ zip: Blob; fileName: string }>;
  readonly collectInteractive: (
    scenes: readonly Scene[],
    opts: { fetcher?: FetchAsset; pathPrefix?: string },
  ) => Promise<{ files: InteractivePageFile[]; failedAssetUrls: string[] }>;
  /** Shared fetcher for the interactive pages' external assets. */
  readonly fetcher?: FetchAsset;
}

/** Per-course outcome. `error` means this course was skipped, not the batch. */
export interface BatchExportCourseResult {
  readonly id: string;
  readonly name: string;
  /** The folder this course occupies inside the archive. */
  readonly folder: string;
  /** ZIP-relative paths that were written for this course. */
  readonly files: string[];
  /** True when the course has no slide scenes, so no PPTX was written. */
  readonly skippedPptx: boolean;
  /** True when the course has no interactive scenes. */
  readonly skippedInteractive: boolean;
  /** External asset URLs the interactive pages could not inline. */
  readonly failedAssetUrls: string[];
  /** Set when the course could not be exported at all. */
  readonly error?: string;
}

export interface BatchExportResult {
  readonly blob: Blob;
  readonly fileName: string;
  readonly courses: BatchExportCourseResult[];
  readonly totalFiles: number;
}

export interface BatchExportOptions {
  readonly deps?: Partial<BatchExportDeps>;
  /** Called once before each course starts, and once after it finishes. */
  readonly onProgress?: (progress: {
    readonly done: number;
    readonly total: number;
    readonly currentName: string;
  }) => void;
  /** Cancels between courses; the archive is discarded, nothing is saved. */
  readonly signal?: AbortSignal;
  /** Injected for a deterministic archive name in tests. */
  readonly now?: Date;
}

/** Raised when a batch is cancelled; the caller must not save anything. */
export class BatchExportCancelledError extends Error {
  constructor() {
    super('Batch export cancelled');
    this.name = 'BatchExportCancelledError';
  }
}

/** Raised when the selection asks for no artifact at all. */
export class BatchExportEmptySelectionError extends Error {
  constructor() {
    super('Batch export selected no artifact kind');
    this.name = 'BatchExportEmptySelectionError';
  }
}

const DEFAULT_VIEWPORT_SIZE = 1000;
const DEFAULT_VIEWPORT_RATIO = 0.5625;

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The characters Windows, macOS and Linux disagree about, plus the two shapes
 * Windows silently rewrites at the end of a component (dots and spaces). A ZIP
 * entry is not written by the OS, but it is very often READ by one.
 */
export function sanitizeArchiveComponent(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '_')
    // Control characters would make the entry name unrepresentable in a shell.
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || fallback;
}

/**
 * One folder per course, unique. Two courses may share a name (the library has
 * many "Untitled" / duplicate-by-import rows), and a ZIP entry collision would
 * silently drop one course's files — so the second occurrence gets ` (2)`.
 */
export function assignCourseFolders(
  courses: readonly BatchExportCourseInput[],
): Map<string, string> {
  const used = new Set<string>();
  const assigned = new Map<string, string>();
  for (const course of courses) {
    const base = sanitizeArchiveComponent(course.name, course.id);
    let candidate = base;
    let suffix = 2;
    // Case-insensitive: a ZIP read on Windows/macOS would collide anyway.
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(candidate.toLowerCase());
    assigned.set(course.id, candidate);
  }
  return assigned;
}

/**
 * Split a course's scenes into the deck the PPTX builder takes.
 *
 * The viewport is taken from the course's OWN first slide rather than the
 * canvas store: the store mirrors only the slide currently on screen, so for a
 * course nobody opened it holds some other course's geometry. Slides carry
 * their own `viewportSize`/`viewportRatio` (see `sync-canvas-viewport`), which
 * is exactly the per-course source this needs.
 */
export function deriveCourseDeck(scenes: readonly Scene[]): {
  slideScenes: Scene[];
  slides: Slide[];
  viewportSize: number;
  viewportRatio: number;
} {
  const slideScenes = scenes.filter((scene) => scene.content.type === 'slide');
  const slides = slideScenes.map((scene) => (scene.content as SlideContent).canvas);
  const first = slides[0] as { viewportSize?: number; viewportRatio?: number } | undefined;
  return {
    slideScenes,
    slides,
    viewportSize: finitePositive(first?.viewportSize) ? first.viewportSize : DEFAULT_VIEWPORT_SIZE,
    viewportRatio: finitePositive(first?.viewportRatio)
      ? first.viewportRatio
      : DEFAULT_VIEWPORT_RATIO,
  };
}

/** `OpenMAIC-batch-2026-10-06-1530.zip` — ASCII, sorts by time, no locale. */
export function batchExportFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `OpenMAIC-batch-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}.zip`
  );
}

async function defaultLoadCourse(stageId: string): Promise<BatchExportCourseData | null> {
  // Imported lazily: the document store is browser-only (IndexedDB + the
  // persistence boundary), and this module is unit-tested in node.
  const { accessDocument } = await import('@/lib/document-store');
  const document = (await accessDocument(stageId)).document;
  if (!document) return null;
  return { stage: document.stage, scenes: document.scenes };
}

async function defaultDeps(): Promise<BatchExportDeps> {
  const { buildPptxBlob, collectInteractivePages } = await import('./use-export-pptx');
  const { buildClassroomExportZip } = await import('./use-export-classroom');
  const { createAssetFetcher } = await import('./inline-assets');
  const { createProxiedFetch } = await import('./proxied-fetch');
  return {
    loadCourse: defaultLoadCourse,
    buildPptx: buildPptxBlob,
    buildClassroomZip: (stage, scenes) => buildClassroomExportZip(stage, scenes),
    collectInteractive: collectInteractivePages,
    fetcher: createAssetFetcher({ fetchImpl: createProxiedFetch() }),
  };
}

/**
 * Build the archive. Courses are processed strictly in order — one at a time —
 * because each course's PPTX generation and media collection already saturates
 * the main thread and the media pool; running them concurrently buys nothing
 * and multiplies peak memory by the concurrency.
 *
 * A course that throws is recorded and the batch continues: one broken course
 * must not cost the user the other eleven. Cancellation is checked between
 * courses and rethrown as {@link BatchExportCancelledError}.
 */
export async function buildBatchExportZip(
  courses: readonly BatchExportCourseInput[],
  selection: BatchExportSelection,
  options: BatchExportOptions = {},
): Promise<BatchExportResult> {
  if (!selection.includePptx && !selection.includeInteractive && !selection.includeClassroomZip) {
    throw new BatchExportEmptySelectionError();
  }
  const overrides = options.deps ?? {};
  // Lazy and single-flight: a caller that injects the four builders (the unit
  // tests do) never loads the browser-only module graph at all. The default
  // fetcher only comes along with them — an injected collector brought its own.
  const needsDefaults =
    !overrides.loadCourse ||
    !overrides.buildPptx ||
    !overrides.buildClassroomZip ||
    !overrides.collectInteractive;
  const defaults = needsDefaults ? await defaultDeps() : null;
  const fetcher = overrides.fetcher ?? defaults?.fetcher;
  const deps: BatchExportDeps = {
    loadCourse: overrides.loadCourse ?? defaults!.loadCourse,
    buildPptx: overrides.buildPptx ?? defaults!.buildPptx,
    buildClassroomZip: overrides.buildClassroomZip ?? defaults!.buildClassroomZip,
    collectInteractive: overrides.collectInteractive ?? defaults!.collectInteractive,
    ...(fetcher ? { fetcher } : {}),
  };

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const folders = assignCourseFolders(courses);
  const results: BatchExportCourseResult[] = [];

  for (const [index, course] of courses.entries()) {
    if (options.signal?.aborted) throw new BatchExportCancelledError();
    const folder = folders.get(course.id)!;
    options.onProgress?.({ done: index, total: courses.length, currentName: course.name });

    const files: string[] = [];
    let skippedPptx = false;
    let skippedInteractive = false;
    const failedAssetUrls: string[] = [];

    try {
      const data = await deps.loadCourse(course.id);
      if (!data) throw new Error(`Course ${course.id} could not be loaded`);

      const deck = deriveCourseDeck(data.scenes);

      if (selection.includePptx) {
        if (deck.slides.length === 0) {
          skippedPptx = true;
        } else {
          const base = sanitizeArchiveComponent(course.name, course.id);
          const stageId = data.stage?.id ?? course.id;
          const pptx = await deps.buildPptx(
            deck.slides,
            deck.slideScenes,
            deck.viewportRatio,
            deck.viewportSize,
            96 * (deck.viewportSize / 960),
            (96 / 72) * (deck.viewportSize / 960),
            stageId,
          );
          const path = `${folder}/${base}.pptx`;
          zip.file(path, await pptx.arrayBuffer());
          files.push(path);
        }
      }

      if (selection.includeInteractive) {
        const interactive = await deps.collectInteractive(data.scenes, {
          pathPrefix: `${folder}/`,
          ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
        });
        if (interactive.files.length === 0) {
          skippedInteractive = true;
        } else {
          for (const file of interactive.files) {
            zip.file(file.path, file.html);
            files.push(file.path);
          }
          failedAssetUrls.push(...interactive.failedAssetUrls);
        }
      }

      if (selection.includeClassroomZip) {
        if (options.signal?.aborted) throw new BatchExportCancelledError();
        const base = sanitizeArchiveComponent(course.name, course.id);
        const classroom = await deps.buildClassroomZip(data.stage, data.scenes);
        const path = `${folder}/${base}${CLASSROOM_ZIP_EXTENSION}`;
        zip.file(path, await classroom.zip.arrayBuffer());
        files.push(path);
      }
    } catch (error) {
      if (error instanceof BatchExportCancelledError) throw error;
      // One course's failure is a line in the report, never the end of the run.
      results.push({
        id: course.id,
        name: course.name,
        folder,
        files,
        skippedPptx,
        skippedInteractive,
        failedAssetUrls,
        error: error instanceof Error ? error.message : String(error),
      });
      options.onProgress?.({ done: index + 1, total: courses.length, currentName: course.name });
      continue;
    }

    results.push({
      id: course.id,
      name: course.name,
      folder,
      files,
      skippedPptx,
      skippedInteractive,
      failedAssetUrls,
    });
    options.onProgress?.({ done: index + 1, total: courses.length, currentName: course.name });
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  return {
    blob,
    fileName: batchExportFileName(options.now ?? new Date()),
    courses: results,
    totalFiles: results.reduce((sum, result) => sum + result.files.length, 0),
  };
}
