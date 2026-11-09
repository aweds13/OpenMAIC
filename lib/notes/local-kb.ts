/**
 * 个人知识库（Obsidian Vault）的**只读薄检索层** —— 服务端库模块，不是 agent 工具。
 *
 * ── 它是干什么的 ────────────────────────────────────────────────
 *
 * 给一个概念名（`xq_question_concept` 里那种，例如「递归」「闭包与作用域」），
 * 回答「本人是不是在哪篇笔记里写过它」，最多 5 条、只要路径级证据
 * （笔记 id / 标题 / 路径 / 命中那一节的小标题）。**不读正文、不返回正文、
 * 不写任何东西** —— 正文由人去看，模型只看「有没有」。
 *
 * ── ★ 裁决：不接进工具面 ─────────────────────────────────────────
 *
 * `docs/research/材料统一/07-合成设计与实施拆分.md` §7 的接入表已裁决：
 * pika 三技能 **不接进工具面**，只在文档里写明「个人知识库是另一个房东」。
 * 理由（同表右列）：两个库分开；合并检索的重叠面是「接口留了 `source: 'personal'`，
 * 接不接是调用方的事」。笔记属于**另一个房东**（`D:/文档/jelly_ware/知识库`），
 * 不归本仓的课程/学情数据管，把它挂成 `notes_search` 之类只会让 agent 以为
 * 「笔记里的结论可以当判定依据」—— 那正是 SR-F11.6 禁止的事。
 *
 * ⇒ **后来的人请不要顺手注册它**：不要动 `lib/server/agent-runtime/runner.ts`
 * 的工具装配，不要包一层 `buildXxxTool`。它只被服务端代码 import。
 *
 * ── ★ 只看 strict 口径，不用 FTS/bm25 ───────────────────────────
 *
 * 实测（104 个概念，同一份真库）：松口径（`section_fts` + bm25）有 **83 个概念命中**，
 * 其中 **75 个是噪音** —— 命中行的标题与小节路径里**根本没有那个名字**
 * （CJK 分词把「作用域」拆成单字之后，bm25 对着任何一篇讲 JS 的笔记都给分）。
 * 这种命中喂给模型就是给它编证据，比查不到更坏。
 *
 * 所以这里的判据是**字面 AND**：
 *   1. 概念名按 `[\s/、，,（）()]+` 切片；
 *   2. 丢掉停用块（长度 ≤ 1 的 CJK 块，以及 `与`/`和`/`及`/`的`/`或`）；
 *   3. 剩下的块**全部**出现在 `notes.title` 或 `sections.heading_path` 里（`LIKE '%块%'`，
 *      `%` `_` `\` 三个字符有转义）；
 *   4. 按 `notes.path` 去重，`LIMIT` 默认 5、最多 5。
 *
 * 「全部块都要出现」不是严格偏好，是判据本身：「闭包与作用域」只命中「闭包」的笔记
 * 可能整篇没提作用域，那不是这条概念的旁证。
 *
 * ── ★ 对调用方的唯一承诺：**永不抛** ────────────────────────────
 *
 * 库文件不在、表不存在（用户重装过索引）、SQL 报错、概念名切不出 token、
 * 配置读不出来 —— 一律返回 `[]`，最多 `console.warn` 一行再 `return []`
 * （语言层面用 `catch { }` 远处兜住）。笔记检索是**旁证**，旁证拿不到不该让
 * 学情刷新失败；这也是 `lib/practice/results.ts` 那条「读取失败 = 没有记录」的同一句。
 *
 * ── db 路径解析顺序（改了要同步这里）─────────────────────────────
 *
 *   1. 显式 `deps.dbPath`（测试与脚本用这个，不读配置）；
 *   2. 环境变量 `OPENMAIC_NOTES_DB` —— **非空字符串才用**（空串当没设）；
 *   3. `%APPDATA%/manage-personal-knowledge/obsidian-vault-notes.json` 的 `db_path`
 *      （那是另一个应用 manage-personal-knowledge 的配置，路径由它维护，不抄进本仓）；
 *   4. 都没有 / 解析出来的文件不存在 ⇒ `undefined`。
 *
 * ★ **不要**把 `C:/Users/<某人>/AppData/...` 写死成唯一来源：路径是那个应用的，
 * 它搬家（或换机器）本仓不该跟着改代码。`undefined` 是正常状态，不是错误。
 *
 * ── 读法 ────────────────────────────────────────────────────────
 *
 * `new DatabaseSync(path, { readOnly: true })`（Node 22+ 的 `node:sqlite`；本机 v24.19.0
 * 实测 open ≈ 3.7 ms、一次 LIKE 查询 ≈ 12 ms）。`@types/node` 20.x 没有这个模块的类型，
 * 最小声明在 `types/node-sqlite.d.ts`。连接在 `finally` 里 close —— 只读也不能漏句柄
 * （Windows 上没关的句柄会让临时目录删不掉）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 一条命中 —— **路径级证据**，不是内容。
 *
 * 故意不带正文与片段：调用方拿它做什么（在状态块里写一句、让人点开看）由调用方决定；
 * 带正文会诱使上游把笔记段落直接塞进提示词，而 SR-F11.6 禁止笔记影响判定。
 */
export interface NoteHit {
  /** `notes.id`（本库自己的行 id，不是角色的概念 id）。 */
  noteId: string;
  /** `notes.title`。 */
  title: string;
  /** `notes.path` —— vault 内的相对路径，去重就按它。 */
  path: string;
  /**
   * 命中那一节的 `sections.heading_path`（「A > B」这种形状）；
   * **标题命中时为 `''`** —— 那说明命中的是整篇，没有具体一节。
   */
  headingPath: string;
}

/** 只读检索的依赖注入点（测试一律走 `dbPath`，不碰真库也不读全局 env）。 */
export interface NotesLookupDeps {
  /** 显式 db 路径；给了就不看环境变量与配置。 */
  dbPath?: string;
  /** 最多几条（默认 5，超过 5 按 5 算 —— 旁证不需要一屏）。 */
  limit?: number;
}

/** 硬上限：再多也不再是「旁证」，而是一张搜索结果页。 */
const MAX_LIMIT = 5;

/** 概念名的切块字符集 —— 与使用者写概念名的习惯对齐（中英文顿号、逗号、括号、斜杠、空白）。 */
const BLOCK_SEPARATOR = /[\s/、，,（）()]+/;

/** 停用块：它们只表达并列关系，出现在名字里不构成区分度（「A 与 B」的「与」）。 */
const STOP_BLOCKS = new Set(['与', '和', '及', '的', '或']);

/** CJK 判定：够用来判「一个字的 CJK 块是噪音」，不追求 Unicode 完整性。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** `LIKE ... ESCAPE <char>` 的转义符。★ 必须当**参数**传（字面量 `'\\'` 会被当成两个字符，见文件头）。 */
const LIKE_ESCAPE = String.fromCharCode(92);

/** 环境变量名 —— 与 `OPENMAIC_*` 家族一致（本仓所有运行期开关都是这个前缀）。 */
const ENV_NOTES_DB = 'OPENMAIC_NOTES_DB';

/** 另一个应用的配置文件（它的 `db_path` 字段才是真源）。 */
const CONFIG_RELATIVE = join('manage-personal-knowledge', 'obsidian-vault-notes.json');

/**
 * 解析笔记索引 db 的路径；**找不到就 `undefined`，不抛**。
 *
 * 顺序见文件头「db 路径解析顺序」。★ 最后一步是**存在性检查**：
 * 配置指向一个搬走了的文件是常态（vault 在另一个房东那里），
 * 让调用方拿到一个不存在的路径只会把错误推到 `DatabaseSync` 里面去。
 */
export function notesDbPath(deps: NotesLookupDeps = {}): string | undefined {
  const candidate = resolveCandidate(deps);
  if (!candidate) return undefined;
  try {
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** 三步候选（不做存在性检查）—— 拆出来是为了让环境变量优先级能被单独测到。 */
function resolveCandidate(deps: NotesLookupDeps): string | undefined {
  const explicit = asNonEmptyString(deps.dbPath);
  if (explicit) return explicit;

  let fromEnv: string | undefined;
  try {
    fromEnv = asNonEmptyString(process.env[ENV_NOTES_DB]);
  } catch {
    fromEnv = undefined;
  }
  if (fromEnv) return fromEnv;

  return dbPathFromConfig();
}

/** 读另一个应用的配置里的 `db_path`；文件不在 / JSON 坏 / 字段空 ⇒ `undefined`。 */
function dbPathFromConfig(): string | undefined {
  try {
    // ★ 只认 `APPDATA`（Windows 的 Roaming）。没有它就不猜 `~/.config`：
    //   猜错目录读到别人的配置比读不到更坏。
    const appData = asNonEmptyString(process.env.APPDATA);
    if (!appData) return undefined;
    const raw = readFileSync(join(appData, CONFIG_RELATIVE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const dbPath = (parsed as { db_path?: unknown }).db_path;
    return asNonEmptyString(dbPath);
  } catch {
    return undefined;
  }
}

/** 非空字符串才算数（空串 / 空白 / 非字符串一律 `undefined`）。 */
function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 概念名 → 检索块。切不出来 / 全是停用块 ⇒ `[]`（调用方据此直接返回 `[]`，不查库）。
 *
 * 去重是必要的：「A 与 A」切成两个 `A` 会让 SQL 里出现两条同样的 `LIKE`，
 * 结果不变但白扫一遍。
 */
function conceptBlocks(concept: string): string[] {
  const blocks = concept
    .split(BLOCK_SEPARATOR)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    // 「长度 ≤ 1 的 CJK 块」是单字噪音（「的」「类」「包」），ASCII 单字（`C`、`R`）留着。
    .filter((block) => !(block.length <= 1 && CJK.test(block)))
    .filter((block) => !STOP_BLOCKS.has(block));
  return [...new Set(blocks)];
}

/** 把块包成 `%块%` 并转义 `\` `%` `_`（顺序要紧：先转义反斜杠，否则会把新加的转义符再转一次）。 */
function likePattern(block: string): string {
  const escaped = block.replace(/[\\%_]/g, (ch) => LIKE_ESCAPE + ch);
  return '%' + escaped + '%';
}

/**
 * 严格口径的查询：每个块都必须出现在标题**或**小节路径里。
 *
 * 三层嵌套是为了让「标题命中」只算一次：`titleHit` 在中间层算好，
 * 外层用它在同一 path 的多行里挑代表性那行（标题命中优先，否则按 heading_path 排）。
 * `ROW_NUMBER()` 需要 SQLite ≥ 3.25，本机 `sqlite_version()` 是 3.53.3。
 *
 * ★ 用 `LEFT JOIN`：只有标题、没有任何 `sections` 行的笔记也必须能命中
 * （索引里 0 节的笔记是真实存在的，它不是坏数据）。
 */
function buildQuery(blockCount: number): string {
  const titleCond = Array.from({ length: blockCount }, () => 'n.title LIKE ? ESCAPE ?').join(
    ' OR ',
  );
  const rowCond = Array.from(
    { length: blockCount },
    () => '(n.title LIKE ? ESCAPE ? OR s.heading_path LIKE ? ESCAPE ?)',
  ).join(' AND ');

  return [
    'SELECT noteId, title, path, headingPath FROM (',
    '  SELECT noteId, title, path,',
    "    CASE WHEN titleHit = 1 THEN '' ELSE COALESCE(rawHeadingPath, '') END AS headingPath,",
    '    ROW_NUMBER() OVER (',
    '      PARTITION BY path ORDER BY titleHit DESC, rawHeadingPath, rowId',
    '    ) AS rn',
    '  FROM (',
    '    SELECT n.id AS rowId, n.id AS noteId, n.title AS title, n.path AS path,',
    '      s.heading_path AS rawHeadingPath,',
    `      CASE WHEN (${titleCond}) THEN 1 ELSE 0 END AS titleHit`,
    '    FROM notes n',
    '    LEFT JOIN sections s ON s.note_id = n.id',
    `    WHERE ${rowCond}`,
    '  )',
    ') WHERE rn = 1',
    'ORDER BY path',
    'LIMIT ?',
  ].join('\n');
}

/**
 * 查「这个概念的旁证笔记」，**最多 5 条，永不抛**。
 *
 * 返回 `[]` 的六种正常情况（都不是错误）：库文件不存在、表不存在、SQL 报错、
 * 概念名切不出块、连接打不开、查询命中 0 行。最多 `console.warn` 一行。
 */
export function findNotesForConcept(concept: string, deps: NotesLookupDeps = {}): NoteHit[] {
  if (typeof concept !== 'string') return [];
  const blocks = conceptBlocks(concept);
  if (blocks.length === 0) return [];

  const dbPath = notesDbPath(deps);
  if (!dbPath) return [];

  const limit = normalizeLimit(deps.limit);
  const patterns = blocks.map(likePattern);

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const params: unknown[] = [];
    // 参数按 SQL 文本里 `?` 出现的顺序绑定：先 SELECT 的 titleHit，再 WHERE，最后 LIMIT。
    for (const pattern of patterns) params.push(pattern, LIKE_ESCAPE);
    for (const pattern of patterns) params.push(pattern, LIKE_ESCAPE, pattern, LIKE_ESCAPE);
    params.push(limit);

    const rows = db.prepare(buildQuery(blocks.length)).all(...params);
    return toHits(rows, limit);
  } catch (error) {
    // 只读路径上的任何失败都等价于「没有旁证」—— 见文件头「永不抛」。
    console.warn(
      `[local-kb] 笔记检索跳过：${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  } finally {
    // 只读也要 close：Windows 上没关的句柄会让临时目录删不掉（测试的 afterEach 会撞上）。
    try {
      db?.close();
    } catch {
      /* 已经关掉 / 打开失败 —— 没有可做的 */
    }
  }
}

/** 条数：默认 5，`NaN`/负数/0 一律回默认，超过 5 按 5。 */
function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return MAX_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return MAX_LIMIT;
  return Math.min(floored, MAX_LIMIT);
}

/**
 * 行 → `NoteHit`。SQL 返回的类型在 `node:sqlite` 里是 `unknown`，
 * 所以这里逐字段收窄：**形状不对的行整条丢掉**，不拿 `String(undefined)` 造一个假标题。
 *
 * ★ `noteId` 两种形状都要收：真库的 `notes.id` 是 **`INTEGER PRIMARY KEY AUTOINCREMENT`**
 *   （`node:sqlite` 回一个 number），而测试夹具照 SR 文档写成 TEXT。只收 string 会让
 *   真库**每一行都被悄悄丢掉** —— 实测踩过：真库 697 篇，`递归` 明明有 2 篇标题命中，
 *   模块却回 `[]`。所以 number 也认，统一 `String()` 成契约里的 string。
 */
function toHits(rows: unknown[], limit: number): NoteHit[] {
  const hits: NoteHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (hits.length >= limit) break;
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const noteId = idToString(record.noteId);
    const title = typeof record.title === 'string' ? record.title : '';
    const path = typeof record.path === 'string' ? record.path : '';
    if (!noteId || !path) continue;
    // 按 path 去重（SQL 已经用 ROW_NUMBER 去过一次，这里是第二道：调用方不该看到重复路径）。
    if (seen.has(path)) continue;
    seen.add(path);
    hits.push({
      noteId,
      title,
      path,
      headingPath: typeof record.headingPath === 'string' ? record.headingPath : '',
    });
  }
  return hits;
}

/** `notes.id` 可能是 TEXT 也可能是 INTEGER（真库是后者）—— 两种都收，别的当空。 */
function idToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return '';
}
