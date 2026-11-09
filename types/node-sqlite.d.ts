/**
 * `node:sqlite` 的最小环境声明。
 *
 * ── 为什么需要这一份 ────────────────────────────────────────────
 *
 * 本机 Node 是 v24.19.0，`node:sqlite`（`DatabaseSync`）**运行时可用**；
 * 但仓里的 `@types/node` 是 **20.19.37**，`node_modules/@types/node/` 下**没有
 * `sqlite.d.ts`** ⇒ `import { DatabaseSync } from 'node:sqlite'` 会直接 `TS2307`。
 *
 * 同仓已有两个同类先例（`types/web-extraction-vendors.d.ts`、`types/web-speech.d.ts`）：
 * 第三方 / 运行时有、类型没有的东西，就在 `types/` 下补一份**最小**声明。
 * `tsconfig.json` 的 `include` 覆盖仓里所有 `.ts` 文件（含 `types/` 下的 `.d.ts`），
 * 放这里会被自动带上，不用改配置。
 *
 * ── 为什么只写这么点 ────────────────────────────────────────────
 *
 * 只声明**本仓真的用到**的那几个成员：`lib/notes/local-kb.ts` 用
 * `new DatabaseSync(path, { readOnly })` / `prepare().all()` / `close()`，
 * `tests/notes/local-kb.test.ts` 还要 `exec()` 建表、`run()` 插行。
 * 其余（`open()`、`backup()`、`StatementSync.iterate()`、`setAllowBareNamedParameters()`
 * 之类）一个都不写 —— 声明得越宽，越容易在真正升级 `@types/node` 之前
 * 让人写出**这里能编过、别处编不过**的代码。
 *
 * ★ 升级 `@types/node` 到带 `node:sqlite` 的版本之后，**删掉这个文件**：
 *   两份声明同时在，形状一旦不一致就会互相遮蔽，而报错会指向一个没人看过的 .d.ts。
 */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    /** 直接执行一段（可多句）SQL，不返回行 —— 测试夹具建表用。 */
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export class StatementSync {
    /** 取全部行。★ 对 INSERT/DDL 也能调，返回 `[]`（不是抛错）。 */
    all(...params: unknown[]): unknown[];
    /** 取第一行；没有行时返回 `undefined`。 */
    get(...params: unknown[]): unknown;
    /** 执行写语句 —— 测试夹具插行用。 */
    run(...params: unknown[]): unknown;
  }
}
