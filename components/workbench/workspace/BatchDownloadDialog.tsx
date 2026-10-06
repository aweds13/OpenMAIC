'use client';

/**
 * Batch download for the workspace's course library.
 *
 * The rail is where courses are navigated, so it is where they are exported
 * from: picking several here beats opening each course and reaching for its
 * stage-header menu. One ZIP comes out, one folder per course — a browser
 * blocks a page that fires N downloads in a row, and N separate files is worse
 * to file away than one archive anyway.
 *
 * The run is sequential and cancellable, and the dialog stays open afterwards
 * showing a per-course report: with a dozen courses in flight, "导出失败" alone
 * would not say WHICH course to look at, and the whole point of the report is
 * that the other eleven still landed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { Download, Loader2, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils/cn';
import {
  BatchExportCancelledError,
  buildBatchExportZip,
  type BatchExportResult,
  type BatchExportSelection,
} from '@/lib/export/batch-export';

const log = createLogger('BatchDownload');

/** The subset of a course row this dialog needs. */
export interface BatchDownloadCourse {
  readonly id: string;
  readonly name: string;
  readonly sceneCount?: number;
}

interface BatchDownloadDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly courses: readonly BatchDownloadCourse[];
}

interface JobProgress {
  readonly done: number;
  readonly total: number;
  readonly currentName: string;
}

const ALL_CONTENTS: BatchExportSelection = {
  includePptx: true,
  includeInteractive: true,
  includeClassroomZip: true,
};

export function BatchDownloadDialog({ open, onOpenChange, courses }: BatchDownloadDialogProps) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [contents, setContents] = useState<BatchExportSelection>(ALL_CONTENTS);
  const [query, setQuery] = useState('');
  const [job, setJob] = useState<JobProgress | null>(null);
  const [report, setReport] = useState<BatchExportResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Every open starts from a clean slate. Selections deliberately do NOT
  // persist: a stale check set plus a "download" press is how somebody ships
  // the wrong twelve courses.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set<string>());
    setContents(ALL_CONTENTS);
    setQuery('');
    setJob(null);
    setReport(null);
  }, [open]);

  const running = job !== null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return courses;
    return courses.filter((course) => (course.name || '').toLowerCase().includes(needle));
  }, [courses, query]);

  const picked = useMemo(
    () => courses.filter((course) => selected.has(course.id)),
    [courses, selected],
  );

  const noContent =
    !contents.includePptx && !contents.includeInteractive && !contents.includeClassroomZip;

  const toggleCourse = useCallback((id: string, next: boolean) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Closing mid-run must stop the run: the archive is assembled in memory
      // and its remaining courses would keep loading documents in the
      // background with nothing left to show for it.
      if (!next && abortRef.current) abortRef.current.abort();
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const start = useCallback(async () => {
    if (running) return;
    const targets = courses.filter((course) => selected.has(course.id));
    if (targets.length === 0) {
      toast.warning(t('workspace.batchDownload.noSelection'));
      return;
    }
    if (noContent) {
      toast.warning(t('workspace.batchDownload.noContent'));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setReport(null);
    setJob({ done: 0, total: targets.length, currentName: targets[0]?.name ?? '' });
    try {
      const result = await buildBatchExportZip(
        targets.map((course) => ({ id: course.id, name: course.name })),
        contents,
        {
          signal: controller.signal,
          onProgress: (progress) =>
            setJob({
              done: progress.done,
              total: progress.total,
              currentName: progress.currentName,
            }),
        },
      );
      setReport(result);
      const failed = result.courses.filter((course) => course.error);
      if (result.totalFiles === 0) {
        toast.warning(t('workspace.batchDownload.nothingToExport'));
      } else {
        saveAs(result.blob, result.fileName);
        if (failed.length > 0) {
          toast.warning(
            t('workspace.batchDownload.doneWithFailures', { failed: failed.length }),
            { description: failed.map((course) => course.name).join('、') },
          );
        } else {
          toast.success(t('workspace.batchDownload.done', { files: result.totalFiles }));
        }
      }
    } catch (error) {
      if (error instanceof BatchExportCancelledError) {
        toast.info(t('workspace.batchDownload.cancelled'));
      } else {
        log.error('Batch download failed:', error);
        toast.error(t('workspace.batchDownload.failed'));
      }
    } finally {
      abortRef.current = null;
      setJob(null);
    }
  }, [courses, selected, contents, noContent, running, t]);

  const okCount = report ? report.courses.filter((course) => !course.error).length : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* DialogContent portals to `body`, i.e. OUTSIDE `.ws-root` — so the
          workspace's own `ws-*` classes and `--ws-*` tokens are not inherited
          here. Everything below is plain product chrome on purpose. */}
      <DialogContent className="sm:max-w-[600px]" data-testid="batch-download-dialog">
        <DialogHeader>
          <DialogTitle>{t('workspace.batchDownload.title')}</DialogTitle>
          <DialogDescription>{t('workspace.batchDownload.description')}</DialogDescription>
        </DialogHeader>

        {report ? (
          // ── Result report ────────────────────────────────────────────────
          <div className="flex min-h-0 flex-col gap-2">
            <p className="text-sm" data-testid="batch-download-summary">
              {t('workspace.batchDownload.resultSummary', {
                ok: okCount,
                files: report.totalFiles,
              })}
            </p>
            <div className="max-h-[240px] overflow-y-auto rounded-md border">
              {report.courses.map((course) => (
                <div
                  key={course.id}
                  className="flex items-baseline justify-between gap-3 border-b px-3 py-1.5 text-[12px] last:border-b-0"
                  data-testid={`batch-download-result-${course.id}`}
                >
                  <span className="min-w-0 truncate" title={course.name}>
                    {course.name}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 tabular-nums',
                      course.error ? 'text-destructive' : 'text-muted-foreground',
                    )}
                    title={course.error}
                  >
                    {course.error
                      ? t('workspace.batchDownload.courseFailed')
                      : t('workspace.batchDownload.courseFiles', { files: course.files.length })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* ── What each course folder holds ─────────────────────────── */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t('workspace.batchDownload.contentsLabel')}
              </span>
              <ContentToggle
                id="batch-content-pptx"
                checked={contents.includePptx}
                disabled={running}
                onCheckedChange={(next) =>
                  setContents((prev) => ({ ...prev, includePptx: next }))
                }
                label={t('workspace.batchDownload.contentPptx')}
              />
              <ContentToggle
                id="batch-content-interactive"
                checked={contents.includeInteractive}
                disabled={running}
                onCheckedChange={(next) =>
                  setContents((prev) => ({ ...prev, includeInteractive: next }))
                }
                label={t('workspace.batchDownload.contentInteractive')}
              />
              <ContentToggle
                id="batch-content-classroom"
                checked={contents.includeClassroomZip}
                disabled={running}
                onCheckedChange={(next) =>
                  setContents((prev) => ({ ...prev, includeClassroomZip: next }))
                }
                label={t('workspace.batchDownload.contentClassroomZip')}
                hint={t('workspace.batchDownload.contentClassroomZipHint')}
              />
            </div>

            {/* ── Course picker ────────────────────────────────────────── */}
            <div className="flex items-center gap-2">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-muted/40 px-2.5">
                <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <input
                  data-testid="batch-download-filter"
                  value={query}
                  disabled={running}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('workspace.batchDownload.filterPlaceholder')}
                  aria-label={t('workspace.batchDownload.filterPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={running || filtered.length === 0}
                onClick={() =>
                  setSelected((prev) => {
                    const copy = new Set(prev);
                    for (const course of filtered) copy.add(course.id);
                    return copy;
                  })
                }
              >
                {t('workspace.batchDownload.selectAll')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={running || selected.size === 0}
                onClick={() => setSelected(new Set<string>())}
              >
                {t('workspace.batchDownload.clearSelection')}
              </Button>
            </div>

            <div
              className="max-h-[260px] overflow-y-auto rounded-md border"
              data-testid="batch-download-course-list"
            >
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                  {t('workspace.batchDownload.empty')}
                </p>
              ) : (
                filtered.map((course) => {
                  const checked = selected.has(course.id);
                  return (
                    <label
                      key={course.id}
                      className="flex cursor-pointer items-center gap-2.5 border-b px-3 py-1.5 text-[12px] last:border-b-0 hover:bg-muted/50"
                      data-testid={`batch-download-course-${course.id}`}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={running}
                        onCheckedChange={(next) => toggleCourse(course.id, next === true)}
                      />
                      <span className="min-w-0 flex-1 truncate" title={course.name}>
                        {course.name || t('workspace.untitledCourse')}
                      </span>
                      {course.sceneCount !== undefined ? (
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {t('workspace.sceneCount', { count: course.sceneCount })}
                        </span>
                      ) : null}
                    </label>
                  );
                })
              )}
            </div>

            {/* ── Progress / count ─────────────────────────────────────── */}
            {job ? (
              <div className="flex flex-col gap-1.5" data-testid="batch-download-progress">
                <div className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="min-w-0 truncate" title={job.currentName}>
                    {t('workspace.batchDownload.progress', {
                      done: job.done,
                      total: job.total,
                    })}{' '}
                    · {job.currentName}
                  </span>
                  <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                </div>
                <Progress value={job.total ? (job.done / job.total) * 100 : 0} />
              </div>
            ) : (
              <span className="text-[12px] text-muted-foreground" data-testid="batch-download-count">
                {t('workspace.batchDownload.selectedSummary', {
                  selected: picked.length,
                  total: courses.length,
                })}
              </span>
            )}
          </>
        )}

        <DialogFooter>
          {report ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setReport(null);
                  setSelected(new Set<string>());
                }}
              >
                {t('workspace.batchDownload.again')}
              </Button>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                {t('workspace.batchDownload.close')}
              </Button>
            </>
          ) : (
            <>
              {running ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => abortRef.current?.abort()}
                  data-testid="batch-download-cancel"
                >
                  {t('workspace.batchDownload.cancel')}
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  {t('workspace.batchDownload.close')}
                </Button>
              )}
              <Button
                type="button"
                onClick={() => void start()}
                disabled={running || picked.length === 0 || noContent}
                data-testid="batch-download-start"
              >
                {running ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-3.5" aria-hidden="true" />
                )}
                {t('workspace.batchDownload.start')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One artifact-kind checkbox with an optional second line of explanation. */
function ContentToggle({
  id,
  checked,
  disabled,
  onCheckedChange,
  label,
  hint,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
  readonly hint?: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="mt-0.5"
      />
      <label htmlFor={id} className="cursor-pointer text-[13px] leading-tight">
        {label}
        {hint ? (
          <span className="ml-1.5 text-[11px] text-muted-foreground">{hint}</span>
        ) : null}
      </label>
    </div>
  );
}
