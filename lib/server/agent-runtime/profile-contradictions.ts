/**
 * 人写的画像与机写的状态，**矛盾要被机器发现**（SR-F11.7 的第二半）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 *
 * 画像说「Dart / Flutter = UNKNOWN」，状态块却说「自检：Dart 进阶八道题
 * 已达判据（8/8，下界 0.78）」。两份文件都被注入同一次运行，都标着「当作
 * 事实」，模型只能二选一或和稀泥。**要人读到才发现，就等于没有机制** ——
 * 人不读第二份。
 *
 * ── 为什么不是「域名 → 概念」 ─────────────────────────────────────
 *
 * 那是第一直觉，实测行不通：真库里 `Dart` 在 `xq_concept` 与 `xq_concept_alias`
 * 上都是 **0 命中**（概念叫 `Dart 变量 var / final / const`，没有「Dart」这个
 * 概念）；`Java` 同样 0 命中；`程序设计基础` 0 命中。
 *
 * 换一条链就通了：**域名 → 页标题 → 格子**。画像里的领域名本来就是课程名，
 * 而课程名在页标题里是原样出现的（`.tmp/_domain_map.mjs` 实测：36 页那门课
 * 有 6 个标题带 `Dart`、5 个带 `Flutter`；22 页那门有 3 个带 `Git`）。
 *
 * ★ 这条链的边界写在下面，别把它当定理用（见「已知的误报」）。
 *
 * ── 已知的误报（接受，不掩盖）────────────────────────────────────
 *
 * 标题是**自然语言**，不是结构化标签：
 *   1. 「别用 Java 的思路写 Dart」这种标题会被算作 Java 的证据；
 *   2. 一门课的页标题全带课程名时，域内任何一页判出来都会触发；
 *   3. 只看标题，不看题干 —— 一页讲 Dart 但八道题全是 Git，这里看不出来。
 *
 * 所以输出的是**「值得人看一眼」的清单**，不是判决书：它进状态块时写的是
 * 「画像说 X 未知，但库里 Y 已知」，由读的人决定信哪份。规格里那条优先级
 * （「矛盾时以人写为准并显式说明」）已经定了谁说了算，这里只负责让矛盾可见。
 */

/** 一个域名的切法：画像的「Dart / Flutter」是**两个**领域挤在一行。 */
const DOMAIN_SEPARATORS = /[/、,，;；]+/u;

/**
 * 一个域名切成若干可用于标题匹配的词。
 *
 * ★ 短于 2 个字/字符的一律丢掉：单字（`程`、`J`）会命中几乎所有标题，
 *   那样的「证据」比没有更坏 —— 它会让人开始忽略这个检测。
 */
export function domainTokens(domain: string): string[] {
  const tokens: string[] = [];
  for (const raw of domain.split(DOMAIN_SEPARATORS)) {
    const token = raw.trim();
    if (Array.from(token).length < 2) continue;
    tokens.push(token);
  }
  return tokens;
}

/**
 * 从画像里挑出**知识状态表**中标着 `UNKNOWN` 的领域。
 *
 * 只认表格「状态」列里的 `UNKNOWN`（整格就是这个词，或它以 `UNKNOWN` 开头）。
 * 刻意**不**收 `## 目标` / `## 语言` 里那种行内 `UNKNOWN：…` —— 那不是知识
 * 领域，页标题里也不可能出现「长期目标」这种词去对上它；收进来只会制造
 * 一堆永远不红的条目。
 */
export function parseUnknownDomains(profile: string): string[] {
  const domains: string[] = [];
  const seen = new Set<string>();
  let inKnowledge = false;

  for (const line of profile.split('\n')) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line);
    if (heading) {
      // 「## 知识状态」以及任何标题里带「知识状态」的小节都算。
      inKnowledge = (heading[1] ?? '').includes('知识状态');
      continue;
    }
    if (!inKnowledge) continue;
    if (!line.trimStart().startsWith('|')) continue;

    const cells = line.split('|').map((cell) => cell.trim());
    // `| 领域 | 状态 | 证据 |` 切出来是 ['', 领域, 状态, 证据, '']。
    if (cells.length < 4) continue;
    const domain = cells[1] ?? '';
    const status = cells[2] ?? '';
    if (domain === '' || domain === '领域') continue; // 表头
    if (domain.startsWith('---')) continue; // 分隔行
    if (!/^UNKNOWN\b/u.test(status)) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }

  return domains;
}

/** 一格（页级三态）在矛盾检测里只需要这几样。 */
export interface ContradictionCell {
  stageId: string;
  sceneId: string;
  title?: string | null;
  tri: string;
}

/** 一条「画像说不知道、库里却判出来了」。 */
export interface ProfileContradiction {
  /** 画像那一行原文的领域名（可能是「Dart / Flutter」这种合称）。 */
  domain: string;
  /** 真正在标题里命中的那个词（`Dart`）。 */
  token: string;
  stageId: string;
  sceneId: string;
  title: string;
  /** 库里的三态：`known` 或 `not-learned`。 */
  tri: string;
}

/**
 * 找出矛盾：画像把某领域标成 `UNKNOWN`，而库里**同一领域**的某页已经判出了
 * 非 `unknown` 的结论。
 *
 * 「同一领域」= 页标题包含该领域切出来的某个词（大小写不敏感）。
 *
 * ★ 排序按 `(domain, stageId, sceneId)` 码点序，与状态块其它节同一条规矩：
 *   两次渲染必须逐字节相同，否则前缀缓存每次失效。
 */
export function findProfileContradictions(input: {
  profile: string;
  cells: readonly ContradictionCell[];
}): ProfileContradiction[] {
  const domains = parseUnknownDomains(input.profile);
  if (domains.length === 0) return [];

  const found: ProfileContradiction[] = [];
  for (const domain of domains) {
    const tokens = domainTokens(domain);
    if (tokens.length === 0) continue;
    for (const cell of input.cells) {
      if (cell.tri === 'unknown') continue;
      const title = (cell.title ?? '').trim();
      if (title === '') continue;
      const lowered = title.toLowerCase();
      const token = tokens.find((candidate) => lowered.includes(candidate.toLowerCase()));
      if (token === undefined) continue;
      found.push({
        domain,
        token,
        stageId: cell.stageId,
        sceneId: cell.sceneId,
        title,
        tri: cell.tri,
      });
    }
  }

  return found.sort(
    (a, b) =>
      compareCodePoints(a.domain, b.domain) ||
      compareCodePoints(a.stageId, b.stageId) ||
      compareCodePoints(a.sceneId, b.sceneId),
  );
}

/** 码点比较 —— `localeCompare` 会随 ICU 版本与系统语言变（与渲染器同一条理由）。 */
function compareCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
