# F4 批量导出 —— 契约

## 这条契约管什么

管「一次性把多门课带走」这条路上**能被跑出来的结论**：归档是不是一个、每门课文件夹里是不是真能用、某一门坏掉之后报告里能不能看出是哪一门。

不管 ZIP 内部的字节格式（那是 `lib/export/` 的职责）、也不管单个 PPTX 的版面是否正确（那是 F1/F2 的事）—— 只关心「批量」这层新增的约束。

## 逐条验收

### SR-F4.1 多门课必须能一次导出为单个归档，不得要求逐课点击

- **输入**：`buildBatchExportZip(courses, selection, options)`，其中 `courses` 是 `[{id, name}, …]` 且长度 ≥ 2；`selection` 至少有一个开关为 `true`。
- **期望**：只产生**一个** `Blob`，一次 `zip.generateAsync({ type: 'blob' })`；归档顶层是**一课一个文件夹**，文件夹名来自课程名（`sanitizeArchiveComponent`），同名课按大小写不敏感去重，第二门加 ` (2)`；文件名恒为 `OpenMAIC-batch-YYYY-MM-DD-HHmm.zip`（`batchExportFileName(now)`），与课程数量无关。全程只需要调用方点一次。
- **失败长什么样**：返回 N 个 Blob、或返回一个把 N 门课的产物平铺在同一层的 ZIP（`A.pptx`、`B.pptx` 直接躺在根上）、或要求调用方对每门课各调一次。
- **判据落点**：`tests/export/batch-export.test.ts` 的 `describe('buildBatchExportZip')` —— `writes one folder per course holding pptx, interactive pages and the classroom zip`（断言 `zipEntries(result.blob)` 恰好等于 5 个按课分文件夹的条目，且 `result.fileName === 'OpenMAIC-batch-2026-10-06-1530.zip'`）；`describe('assignCourseFolders')` 的两条（`gives duplicate names distinct folders, case-insensitively` / `falls back to the course id when the name sanitizes to nothing`）；`describe('batchExportFileName')`。命令：`npx vitest run tests/export/batch-export.test.ts`。
- **两边各自要满足**：
  - 批量层（`lib/export/batch-export.ts`）：只建一个 `JSZip` 实例；文件夹在进循环前用 `assignCourseFolders(courses)` 一次性算好，循环里只查表，不得边跑边改名。
  - UI 层（`components/workbench/workspace/BatchDownloadDialog.tsx`）：`saveAs(result.blob, result.fileName)` **只调一次**，在整批返回之后；不得在 per-course 循环里下载。

### SR-F4.2 导出必须包含课件可用所需的全部资源，不得只是页面骨架

- **输入**：一门课的 `{stage, scenes}`，`scenes` 里同时含 slide 场景与 interactive 场景；`selection` 三个开关全开。
- **期望**：课程文件夹里三个产物都在，且都是**真的**能用的东西，不是占位：
  - `<name>.pptx` —— 与单课导出同一个 builder 产出，能打开、有幻灯片；
  - `interactive/NN_<title>.html` —— 每页自包含（样式与资源已内联），编号从 `01` 起，标题里的路径字符被清洗；
  - `<name>.maic.zip` —— 可重新导入的整门课归档；这是**唯一**能带走 quiz/PBL 场景的产物（它们只存在于 app 内 React 渲染器里，没有 standalone HTML）。
  
  课程没有 slide 时 `skippedPptx = true`（降级，不是失败）；没有 interactive 场景时 `skippedInteractive = true`（同上）。这两种情况下其余产物仍要齐全。资源抓取失败时，失败的 URL 必须进 `failedAssetUrls`，不得静默丢图。
- **失败长什么样**：文件夹里只有一个 HTML 空壳 / 一个只有标题页的 PPTX；interactive 页引用外部 `https://` 资源（离线打开就白屏）；quiz、PBL 场景在归档里彻底消失且没有任何提示；`failedAssetUrls` 恒为空数组。
- **判据落点**：
  - `tests/export/batch-export-real-builders.test.ts` —— `produces a real PPTX, a real interactive page and a real classroom ZIP in one course folder`、`skips the PPTX for an interactive-only course without failing the batch`（这两个用例跑**真实** builder，`loadCourse` 是唯一 stub）。命令：`npx vitest run tests/export/batch-export-real-builders.test.ts`。
  - `tests/export/batch-export.test.ts` —— `marks a course with no slides or no interactive scenes as skipped, not failed`、`honours the content selection`。
  - `tests/export/resource-pack-export.test.ts` 与 `tests/export/inline-assets.test.ts` 分别钉住单课资源打包与资源内联（`collectAssetRefs` / `createAssetFetcher` / `toDataUri` / `inlineCssUrls`）。
  - **`failedAssetUrls` 被填充这条暂无自动化判据**，人工核对方式：造一门 interactive 页引用一个 404 的 `https://` 图片，跑一次批量导出，确认返回的该课 `failedAssetUrls` 里出现那个 URL（当前 tests 里 `failedAssetUrls` 只作为 mock 返回值 `[]` 出现）。
- **两边各自要满足**：
  - 批量层：三个产物必须复用单课的既有 builder（`buildPptx` / `collectInteractive` / `buildClassroomZip`），不得另写一套简化版 —— 简化版会与单课导出在命名和顺序上漂移。
  - UI 层：三个产物各有一个开关（`includePptx` / `includeInteractive` / `includeClassroomZip`），开关文案要说清「关掉会少什么」，不能只说「导出选项」。

### SR-F4.3 导出必须报告每门课的成功/失败，不得整体静默

- **输入**：三门课，中间那门 `loadCourse` 抛错（模拟文档库爆炸）。
- **期望**：
  - 单门课的异常被 catch 住，记进该课的 `error` 字段后 `continue`，**不影响其余课程**；坏课在归档里不留任何文件夹（不能留半成品）。
  - 返回值 `courses[]` 每项含 `id / name / folder / files / skippedPptx / skippedInteractive / failedAssetUrls`，失败的再加 `error`（字符串，来自异常 message）。
  - 只有两种情况会整批失败：`BatchExportCancelledError`（调用方取消，**不得保存半个归档**）与 `BatchExportEmptySelectionError`（三开关全关）。
  - `totalFiles === 0` 时调用方**不得保存**，要给「没有可导出的内容」的提示，而不是下载一个空 ZIP。
  - UI 在这批跑完后，把选择器替换成**逐课报告**：每门课一行，成功显示文件数、失败显示失败标记且 `title` 是原始 `error`；有失败课时弹 warning 并列出这些课的名字。
- **失败长什么样**：一门课抛错导致整批返回空、或整批成功但归档里少了一门课而界面什么都不说；界面只显示「导出失败」一个词、不说是哪门课；`totalFiles === 0` 却仍然 `saveAs` 了一个空包。
- **判据落点**：
  - `tests/export/batch-export.test.ts` —— `isolates a broken course: the rest of the batch still lands`（断言归档含 `A/A.pptx`、`C/C.pptx`，且**没有任何** `B/` 前缀条目，`failed` 恰好 1 条、`id === 'c2'`、`error` 含 `document store exploded`）、`treats an unloadable course as a per-course failure`（`courses[0].error` 为真且 `totalFiles === 0`）、`throws a cancellation error instead of saving a partial archive`、`refuses a selection that asks for nothing`。
  - `tests/workbench/batch-download-dialog.test.ts` —— `replaces the picker with a per-course report after the run`（断言 `batch-download-summary` 出现、`batch-download-course-list` 消失、`batch-download-result-c1` 的文本含课程名）、`does not run when nothing is selected`。
  - **`totalFiles === 0` 时弹 `nothingToExport` 而不保存这条暂无自动化判据**，人工核对方式：只看 checkpoint 为 interaction 的课程、且三个开关全关掉再点导出，确认没有文件落盘、只有一条 warning。
- **两边各自要满足**：
  - 批量层：catch 只允许 `continue`，**不得**把异常向上抛（取消例外）；`error` 字段必须是可读 message，不得塞对象或堆栈。
  - UI 层：`result.courses` 必须逐条渲染，不能只渲染汇总；`totalFiles === 0` 的分支要在 `saveAs` **之前**判。
