/**
 * 概念主键与名字归一化 —— 概念图谱最底下的两个纯函数。
 *
 * ── 为什么主键不是名字 ───────────────────────────────────────────
 *
 * 同形异义是实测风险，不是假想风险：拿「构造」这个词在 9 门课 / 234 页里做
 * 名字匹配，算法竞赛图里它指「构造题」，Java 课里它指「构造方法」，一次
 * 按名字 join 就把 8 页错挂到一个概念上。名字是**证据**，不是**身份**。
 *
 * 所以主键是 `c_` + 12 位 hex 的不透明稳定串：它不承载任何语义，因此不会
 * 因为某人的口语、某个外部图改版、某次翻译而漂移。名字与外部 id 全部走
 * `xq_concept_alias` / `xq_concept_external_ref` 两张映射表（见
 * `lib/persistence/xq-learner.ts:204-243` 的 DDL 与那里的注释）。
 *
 * ── 为什么这里不做同义归并 ───────────────────────────────────────
 *
 * `normalizeConceptName` 只做「书写形式」的归一（空白、全角、大小写），
 * **不**把「构造函数」并到「构造方法」、**不**把「数组」并到「Arrays」。
 * 理由：归并是判断，判断要有出处。`xq_concept_alias.source` 这一列就是为
 * 了记住「这个别名是谁给的、凭什么」；一个自动跑的同义词表会把两个本来
 * 不同的概念在一秒钟内永久合并，而合并之后没有任何痕迹能把它拆开。
 */
import { randomBytes } from 'node:crypto';

/** 概念 id 的前缀。带上它，人一眼就能把概念 id 与 stage/scene id 区分开。 */
export const CONCEPT_ID_PREFIX = 'c_';

/** 概念 id 的随机部分长度（hex 字符数）。12 位 hex = 48 bit。 */
export const CONCEPT_ID_HEX_LENGTH = 12;

/**
 * 生成一个概念主键：`c_` + 12 位小写 hex。
 *
 * 48 bit 的随机空间在本库这个量级（目标 60–120 个概念，长期上限几千）上
 * 碰撞概率可以忽略；真正的去重靠 `xq_concept_external_ref`（外部 id 一对一）
 * 与 `xq_concept_alias`（别名同 kind 内一对一），不靠 id 本身。
 *
 * @returns 形如 `c_9f3a1b7e04cd` 的稳定不透明串。
 */
export function newConceptId(): string {
  return `${CONCEPT_ID_PREFIX}${randomBytes(6).toString('hex')}`;
}

/** 全角 ASCII 区（U+FF01–U+FF5E）与半角 ASCII 区的码位差。 */
const FULLWIDTH_ASCII_OFFSET = 0xfee0;

/**
 * 把概念名归一成「用于查别名」的形式。
 *
 * 四步，顺序不能换：
 * 1. 去首尾空白；
 * 2. 全角转半角（`ＡＢＣ` → `ABC`，全角括号/冒号/加号同理；U+3000 全角空格 → 普通空格）；
 * 3. 连续空白压成一个半角空格；
 * 4. 英文小写化（`toLowerCase`，对中文无副作用）。
 *
 * **刻意不做**的事：不改标点、不去括号内容、不做单复数、不做同义词归并。
 * 这些都会把「看起来一样」变成「就是同一个」，而那正是本模块要避免的判断。
 *
 * @param name 原始名字（课程作者的口语、外部图的节点名、页面标题片段都可以）。
 * @returns 归一后的名字；输入全是空白时返回空串（调用方应据此丢弃）。
 */
export function normalizeConceptName(name: string): string {
  let out = name.trim();

  // 全角 → 半角：逐码位映射，不用正则，免得被 `u` 标志的边界情况咬。
  let mapped = '';
  for (const ch of out) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000) {
      mapped += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      mapped += String.fromCodePoint(code - FULLWIDTH_ASCII_OFFSET);
    } else {
      mapped += ch;
    }
  }
  out = mapped;

  // 连续空白压一个。NBSP（U+00A0）也当空白，它在网页复制的标题里很常见。
  out = out.replace(/[\s\u00a0]+/g, ' ');

  return out.toLowerCase();
}
