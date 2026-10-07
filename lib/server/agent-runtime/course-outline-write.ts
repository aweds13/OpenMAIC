/**
 * T1：把一页的 brief **落盘**到课程的计划里。
 *
 * ── 为什么需要（这是本 fork 里最"静悄悄"的一个洞）────────────────────
 *
 * `create_stage` 造出来的 stage 是 `outlines: []`，注释还写着 "planning happens in
 * the conversation" —— 而每条 brief 只活在**那一次工具调用**里：`generate_scene`
 * 把它交给内容生成器，然后**扔掉**。于是数据库里没有任何一行说"第 5 页本来要讲 X"。
 *
 * 后果不是"少了个字段"，是下游全部塌掉：
 *
 *   · `read_stage_outline` 显示的 description 退化成页面标题（`mergeStageOutline`
 *     匹配不到计划条目时用 `scene.title` 兜底）—— agent 自己都看不到当初的要求；
 *   · `edit_deck` 的 `shiftCourseOrders` / `renumberCourseOrders` 在
 *     `outlines.length === 0` 时**直接原样返回**（见 `course-edit/tools.ts`）——
 *     也就是说**这两条重排逻辑在 agent 路径上是死代码**；
 *   · 「练习只能考教过的」那类依赖检查（T3）没有可校验的计划可查。
 *
 * ── 为什么是"替换"而不是"追加" ────────────────────────────────────
 *
 * 同一页会被重生成（agent 拿到诊断后重跑 `generate_scene` 很常见）。追加会让
 * 计划里堆出一串同 order 的僵尸条目，于是 `matchOutlineEntries` 的 order 兜底
 * 匹配会配到**错的那一条**。所以：先按 `outlineId` 认身份，认不到再按 `order`
 * 占位，都没有才追加。
 *
 * ── 一个刻意的选择：不动 `generationComplete` ─────────────────────
 *
 * agent 造的课出生就是 `generationComplete: true`，而 `mergeStageOutline` 在这个
 * 标志下**只显示已落盘的页**（计划里"还没生成"的条目会被丢弃）。这正是我们要的：
 * agent 路径上页面是**一页一页**落盘的，把它们当成"排好队但还没做"的规划页会让
 * 课程列表凭空多出不存在页。所以这里只写条目，不碰标志。
 */
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { SceneOutline } from '@/lib/types/generation';

/** 判断两条计划条目是否等价 —— 只比我们真正拥有的字段。 */
function sameEntry(left: SceneOutline | undefined, right: SceneOutline): boolean {
  if (!left) return false;
  const pick = (entry: SceneOutline): string =>
    JSON.stringify([
      entry.id,
      entry.order,
      entry.title,
      entry.type,
      entry.description ?? '',
      entry.keyPoints ?? [],
      entry.widgetType ?? null,
      entry.widgetOutline ?? null,
      entry.quizConfig ?? null,
      entry.pblConfig ?? null,
    ]);
  return pick(left) === pick(right);
}

export interface UpsertOutlineEntryResult {
  /** 新信封。`changed` 为 false 时**就是原来的引用**。 */
  outline: AppDocumentOutline | undefined;
  /**
   * 是否真的变了。
   *
   * 写 outline 只能走全量 `saveDocument`（存储层没有增量 API），所以调用方要
   * 靠这个标志**跳过无意义的整篇保存** —— 重生成一页但内容一字未改时不该写库。
   */
  changed: boolean;
}

/**
 * 把一条计划条目写进课程计划（按 `outlineId` 认身份，认不到按 `order` 占位）。
 *
 * 没有信封时返回 `{ outline: undefined, changed: false }` —— **不发明一个信封**：
 * 信封里装着 requirement / producer / generationComplete 这些我们不该臆造的东西。
 * 那种情况下调用方什么都不做，行为与今天一致（brief 仍然不落盘，而不是落一半）。
 */
export function upsertOutlineEntry(
  outline: AppDocumentOutline | undefined,
  entry: SceneOutline,
): UpsertOutlineEntryResult {
  if (!outline) return { outline: undefined, changed: false };

  const entries = outline.outlines ?? [];
  const byId = entries.findIndex((item) => item.id === entry.id);
  const byOrder = byId < 0 ? entries.findIndex((item) => item.order === entry.order) : -1;
  const index = byId >= 0 ? byId : byOrder;

  /**
   * ★ 提前返回也要**先确认那个 order 上只有一份**（2026-10-07 修）。
   *
   * 原来这里是 `if (index >= 0 && sameEntry(...)) return { changed: false }` ——
   * 内容一样就什么都不做。但如果**同一页有两份条目**，这条路会把去重也一起绕过去
   * （实测：去重写完还是两份，判据当场红）。所以"无需修改"的前提是**那个 order 上
   * 只有一条**。
   */
  const duplicateAtOrder = entries.filter((item) => item.order === entry.order).length > 1;
  if (index >= 0 && sameEntry(entries[index], entry) && !duplicateAtOrder) {
    return { outline, changed: false };
  }

  const next = [...entries];
  if (index >= 0) next[index] = entry;
  else next.push(entry);
  /**
   * ★ **同一个 order 只留一条**（2026-10-07 修）。
   *
   * 上面是按 `findIndex` 找**第一条**同 order 的条目来替换 —— 如果计划里已经有
   * **两条 order 相同的条目**（重排/插页的副作用），那第二条**永远碰不到**：
   * 每次写都在换第一条，**总数永远不变**。
   *
   * 实测后果（`stage-GYvpbYB_aN`）：agent 报「**每补一条就挤掉一条，是等量交换**」，
   * 于是它把计划当成"容量卡住了"、不再尝试补满（51 条 / 56 页，另有一条 order 15 重复）。
   * **真凶是重复条目，不是容量。** 同一页有两份条目本身就是坏状态，写的时候顺手治好。
   *
   * 判据一眼可验：**只保留刚写进去的那一条**（`item === entry`），同 order 的其它全去掉。
   */
  const finalEntries = next
    .filter((item) => item.order !== entry.order || item === entry)
    .sort((left, right) => left.order - right.order);

  return { outline: { ...outline, outlines: finalEntries }, changed: true };
}
