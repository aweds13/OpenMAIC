import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findNotesForConcept, notesDbPath } from '@/lib/notes/local-kb';

/**
 * ★ 只读笔记检索（`lib/notes/local-kb.ts`）的判据。
 *
 * ── 它最危险的失败方式不是报错，是**安静地多给证据** ──────────────
 *
 * 松口径（FTS5 + bm25）在同一份真库上对 104 个概念有 83 个命中，其中 **75 个是噪音** ——
 * 命中那些行的标题与小节路径里根本没有那个名字。这种命中不会让任何测试红，
 * 它只会让模型「有据可依」地编一段关于学习者的判断（SR-F11.6 明令禁止）。
 *
 * 所以这一份夹具的重点**不是**「能不能查到」，是三条反向判据：
 *   · 只在正文里出现 ⇒ **0 条**（不许退化成全文检索）；
 *   · 「Foo 与 Bar」只出现一块 ⇒ **0 条**（不许退化成 OR）；
 *   · 库不在 / 表不在 / SQL 坏 ⇒ `[]`，**不抛**（旁证拿不到不该拖垮学情刷新）。
 *
 * ★ 夹具自给自足：用 `node:sqlite` 在临时目录建一个最小库，**不读那台机器上的真库**
 *   （CI 里没有它；而且真库会变，判据不该跟着数据漂）。
 */
describe('★ 个人知识库只读检索（strict 口径）', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'notes-'));
  });

  afterEach(() => {
    // ★ Windows 上 sqlite 句柄刚 close 时目录仍可能短暂被占 ⇒ EPERM。
    //   模块内部有 finally close，这里再给 5 次重试（生产代码不改，只松测试的删除）。
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  interface FixtureSection {
    sectionKey: string;
    headingPath: string;
    content: string;
    id?: string;
  }

  interface FixtureNote {
    id: string;
    path: string;
    title: string;
    sections?: FixtureSection[];
  }

  /** 建一个最小库（表名与列名照真库：`notes` / `sections`），返回 db 路径。 */
  function makeDb(notes: FixtureNote[], name = 'vault.sqlite3'): string {
    const dbPath = join(root, name);
    const db = new DatabaseSync(dbPath, { readOnly: false });
    try {
      db.exec(`
        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          path_key TEXT,
          title TEXT NOT NULL,
          title_norm TEXT,
          source_mtime_ns INTEGER,
          source_size INTEGER,
          indexed_at_utc TEXT
        );
        CREATE TABLE sections (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL,
          section_key TEXT,
          heading TEXT,
          heading_path TEXT,
          heading_norm TEXT,
          level INTEGER,
          content TEXT,
          snippet TEXT
        );
      `);
      notes.forEach((note, noteIndex) => {
        db.prepare(
          'INSERT INTO notes (id, path, path_key, title, title_norm) VALUES (?, ?, ?, ?, ?)',
        ).run(note.id, note.path, note.path.toLowerCase(), note.title, note.title.toLowerCase());
        (note.sections ?? []).forEach((section, sectionIndex) => {
          db.prepare(
            'INSERT INTO sections (id, note_id, section_key, heading, heading_path, level, content, snippet) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            section.id ?? `s${noteIndex}-${sectionIndex}`,
            note.id,
            section.sectionKey,
            section.headingPath,
            section.headingPath,
            2,
            section.content,
            section.content.slice(0, 20),
          );
        });
      });
    } finally {
      db.close();
    }
    return dbPath;
  }

  it('★ 概念名在标题里 ⇒ 命中 1 条，且 headingPath 是空串（命中的是整篇）', () => {
    const dbPath = makeDb([
      { id: 'n1', path: '编程/JS/闭包.md', title: '闭包与作用域' },
      { id: 'n2', path: '编程/JS/数组.md', title: '数组的 map' },
    ]);

    const hits = findNotesForConcept('闭包', { dbPath });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      noteId: 'n1',
      title: '闭包与作用域',
      path: '编程/JS/闭包.md',
      headingPath: '',
    });
  });

  it('★ 概念名在小节 heading_path 里 ⇒ 命中，并带出那条小节路径', () => {
    const dbPath = makeDb([
      {
        id: 'n1',
        path: '编程/JS/读书笔记.md',
        title: '读书笔记',
        sections: [
          { sectionKey: 'a', headingPath: '语言基础 > 递归', content: '无关正文' },
          { sectionKey: 'b', headingPath: '语言基础 > 循环', content: '无关正文' },
        ],
      },
    ]);

    const hits = findNotesForConcept('递归', { dbPath });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('编程/JS/读书笔记.md');
    expect(hits[0]?.headingPath).toBe('语言基础 > 递归');
  });

  it('★★ 概念名只在正文里（不在 title / heading_path）⇒ 0 条 —— 这条锁住「不许退化成松口径」', () => {
    const dbPath = makeDb([
      {
        id: 'n1',
        path: '编程/JS/泛泛而谈.md',
        title: '一些心得',
        sections: [
          {
            sectionKey: 'a',
            headingPath: '前言 > 随便写写',
            // 正文里满是「闭包」，但标题与小节路径里一个都没有。
            content: '闭包就是能记住外层变量的函数。闭包闭包闭包。',
          },
        ],
      },
    ]);

    expect(findNotesForConcept('闭包', { dbPath })).toEqual([]);
  });

  it('★ 「Foo 与 Bar」两个块都出现才命中，只出现一个不命中（AND 不是 OR）', () => {
    const dbPath = makeDb([
      { id: 'n1', path: 'a/只有前一半.md', title: 'Foo 入门' },
      { id: 'n2', path: 'a/只有后一半.md', title: 'Bar 速查' },
      { id: 'n3', path: 'a/两半都有.md', title: 'Foo 与 Bar 对照' },
    ]);

    const hits = findNotesForConcept('Foo 与 Bar', { dbPath });

    expect(hits.map((hit) => hit.path)).toEqual(['a/两半都有.md']);
  });

  it('★ 块可以一个落在标题、一个落在小节路径（两处都算同一个「出现」）', () => {
    const dbPath = makeDb([
      {
        id: 'n1',
        path: 'a/拆开挂.md',
        title: 'Foo 的心智模型',
        sections: [{ sectionKey: 'a', headingPath: '对比 > Bar 的边界', content: '' }],
      },
      { id: 'n2', path: 'a/只有 Foo.md', title: 'Foo 的心智模型' },
    ]);

    const hits = findNotesForConcept('Foo 与 Bar', { dbPath });

    expect(hits.map((hit) => hit.path)).toEqual(['a/拆开挂.md']);
  });

  it('★ 两个字的 CJK 块不当停用块丢掉：「作用域」单独也查得到', () => {
    const dbPath = makeDb([{ id: 'n1', path: 'a/x.md', title: '作用域链' }]);
    expect(findNotesForConcept('作用域', { dbPath })).toHaveLength(1);
  });

  it('★ 单字 CJK 块与并列停用块切完就空了 ⇒ 直接 [] 且不碰库（库路径给假的也不抛）', () => {
    const dbPath = join(root, '真的不存在.sqlite3');
    expect(findNotesForConcept('与', { dbPath })).toEqual([]);
    expect(findNotesForConcept('的 和 及', { dbPath })).toEqual([]);
    expect(findNotesForConcept('', { dbPath })).toEqual([]);
    expect(findNotesForConcept('   ', { dbPath })).toEqual([]);
  });

  it('★★ db 文件不存在 ⇒ [] 且不抛（只读连接打不开也不能把异常甩给调用方）', () => {
    expect(() =>
      findNotesForConcept('闭包', { dbPath: join(root, 'missing.sqlite3') }),
    ).not.toThrow();
    expect(findNotesForConcept('闭包', { dbPath: join(root, 'missing.sqlite3') })).toEqual([]);
  });

  it('★ 表不存在（索引被重装过）⇒ [] 且不抛', () => {
    const dbPath = join(root, 'empty.sqlite3');
    const db = new DatabaseSync(dbPath, { readOnly: false });
    db.exec('CREATE TABLE 别的表 (id TEXT)');
    db.close();

    expect(() => findNotesForConcept('闭包', { dbPath })).not.toThrow();
    expect(findNotesForConcept('闭包', { dbPath })).toEqual([]);
  });

  it('★ 结果条数 ≤ 5（默认 5，传 100 也只回 5）', () => {
    const notes: FixtureNote[] = Array.from({ length: 9 }, (_, index) => ({
      id: `n${index}`,
      path: `a/${index}.md`,
      title: `递归 第 ${index} 篇`,
    }));
    const dbPath = makeDb(notes);

    expect(findNotesForConcept('递归', { dbPath })).toHaveLength(5);
    expect(findNotesForConcept('递归', { dbPath, limit: 100 })).toHaveLength(5);
    expect(findNotesForConcept('递归', { dbPath, limit: 2 })).toHaveLength(2);
    // 0 / 负数 / NaN 一律回默认 5，不是回 0（回 0 会静默变成「一篇都没有」）。
    expect(findNotesForConcept('递归', { dbPath, limit: 0 })).toHaveLength(5);
    expect(findNotesForConcept('递归', { dbPath, limit: -3 })).toHaveLength(5);
    expect(findNotesForConcept('递归', { dbPath, limit: Number.NaN })).toHaveLength(5);
  });

  it('★ 按 path 去重：同一 path 两行（索引重建过）只算一条', () => {
    const dbPath = makeDb([
      { id: 'n1', path: 'a/重复.md', title: '闭包（旧）' },
      { id: 'n2', path: 'a/重复.md', title: '闭包（新）' },
    ]);

    const hits = findNotesForConcept('闭包', { dbPath });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('a/重复.md');
  });

  it('★ 同一 path 命中多节时只回一条，优先标题命中（headingPath 回空串）', () => {
    const dbPath = makeDb([
      {
        id: 'n1',
        path: 'a/多节.md',
        title: '闭包笔记',
        sections: [
          { sectionKey: 'a', headingPath: '一 > 闭包', content: '' },
          { sectionKey: 'b', headingPath: '二 > 闭包', content: '' },
        ],
      },
    ]);

    const hits = findNotesForConcept('闭包', { dbPath });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.headingPath).toBe('');
  });

  it('★★ 真库的 `notes.id` 是 INTEGER —— number 形态也必须收，不能悄悄丢光每一行', () => {
    // ★ 这条是实测踩出来的：真库 schema 是 `id INTEGER PRIMARY KEY AUTOINCREMENT`，
    //   `node:sqlite` 回 number；早先只收 string ⇒ 真库 697 篇、标题里明明有「递归」
    //   两篇，模块却回 []。契约里 `noteId` 是 string，所以这里必须 `String()` 转换。
    const dbPath = join(root, 'int-ids.sqlite3');
    const db = new DatabaseSync(dbPath, { readOnly: false });
    try {
      db.exec(`
        CREATE TABLE notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL
        );
        CREATE TABLE sections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id INTEGER NOT NULL,
          heading_path TEXT
        );
      `);
      db.prepare('INSERT INTO notes (path, title) VALUES (?, ?)').run(
        'a/int.md',
        '利用 Stolz 定理确定递归序列的渐近系数',
      );
    } finally {
      db.close();
    }

    const hits = findNotesForConcept('递归', { dbPath });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.noteId).toBe('1');
    expect(typeof hits[0]?.noteId).toBe('string');
  });

  it('★ 没有 sections 行的笔记只凭标题也能命中（LEFT JOIN，不是 INNER）', () => {
    const dbPath = makeDb([{ id: 'n1', path: 'a/空笔记.md', title: '闭包要点' }]);
    const hits = findNotesForConcept('闭包', { dbPath });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.headingPath).toBe('');
  });

  it('★ LIKE 的 % 与 _ 当字面字符查，不当通配符', () => {
    const dbPath = makeDb([
      { id: 'n1', path: 'a/pct.md', title: '100% 覆盖率的代价' },
      { id: 'n2', path: 'a/pct2.md', title: '100 次覆盖率的代价' },
      { id: 'n3', path: 'a/snake.md', title: 'snake_case 命名' },
      { id: 'n4', path: 'a/snake2.md', title: 'snakeXcase 命名' },
    ]);

    expect(findNotesForConcept('100%', { dbPath }).map((hit) => hit.path)).toEqual(['a/pct.md']);
    expect(findNotesForConcept('snake_case', { dbPath }).map((hit) => hit.path)).toEqual([
      'a/snake.md',
    ]);
  });

  it('★ 概念名里的括号与顿号是切块符，不是要查的字面', () => {
    const dbPath = makeDb([{ id: 'n1', path: 'a/x.md', title: '闭包与作用域' }]);

    // 「闭包（closure）」切出 `闭包` 与 `closure` —— 后者在这篇里没有，所以不命中；
    // 只留 `闭包` 的那次命中。
    expect(findNotesForConcept('闭包', { dbPath })).toHaveLength(1);
    expect(findNotesForConcept('闭包（closure）', { dbPath })).toEqual([]);
    expect(findNotesForConcept('闭包、作用域', { dbPath })).toHaveLength(1);
  });
});

/**
 * ★ 路径解析：**找不到就 `undefined`，不抛** —— 这是「旁证可以没有」的第一道闸。
 *
 * 不测「读 APPDATA 里那个真配置」：那会把判据绑到某台机器的目录上。
 * 这里只钉两件可推理的事：显式路径优先（且必须真的存在），空环境变量当没设。
 */
describe('★ 笔记库路径解析', () => {
  let root: string;
  const originalEnv = process.env.OPENMAIC_NOTES_DB;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'notes-path-'));
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OPENMAIC_NOTES_DB;
    else process.env.OPENMAIC_NOTES_DB = originalEnv;
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('★ 显式给的路径存在 ⇒ 原样返回', () => {
    const dbPath = join(root, 'vault.sqlite3');
    const db = new DatabaseSync(dbPath, { readOnly: false });
    db.exec('CREATE TABLE notes (id TEXT)');
    db.close();

    expect(notesDbPath({ dbPath })).toBe(dbPath);
  });

  it('★ 显式给的路径不存在 ⇒ undefined（不抛，也不回退去读配置）', () => {
    process.env.OPENMAIC_NOTES_DB = join(root, 'env.sqlite3');
    expect(notesDbPath({ dbPath: join(root, 'nope.sqlite3') })).toBeUndefined();
  });

  it('★ 环境变量空串 / 纯空白当没设（不拿空路径去 open）', () => {
    process.env.OPENMAIC_NOTES_DB = '   ';
    const resolved = notesDbPath();
    // 没有 APPDATA 配置（或配置指向不存在的文件）时必须是 undefined；
    // 无论如何都不能是空串。
    expect(resolved === undefined || resolved.trim().length > 0).toBe(true);
    expect(resolved).not.toBe('');
  });

  it('★ 环境变量指向不存在的文件 ⇒ undefined（存在性检查在返回前做）', () => {
    process.env.OPENMAIC_NOTES_DB = join(root, 'ghost.sqlite3');
    expect(notesDbPath()).toBeUndefined();
  });
});
