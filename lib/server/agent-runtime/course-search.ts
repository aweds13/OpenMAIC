/**
 * `course_search` for the agent runtime — 把**本地课程库/文档层**接进 agent 会话。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────
 *
 * 在此之前，agent-runtime 跟本地课程库**零关联**（全目录 grep 无命中）。
 * 那条链上的智能体在规划课程时，手上只有：模型自己的知识 + 可选的 web_search。
 * 它的课程库（22,505 门课程目录 + 3,089 份本地文档 / 5,800 万字）躺在
 * 8720 端口上，**没有任何工具能碰到**。
 *
 * ── 为什么是"再包一层"而不是重写 ──────────────────────────────────
 *
 * `lib/chat/pi/tools/course-search.ts` 里已经有完整实现，而且它返回的正是
 * `AgentTool`（同一个 `@earendil-works/pi-agent-core`），两边类型通用。
 * 所以这里只做三件事：解析能力、换一段更贴切的描述、给一段 prompt 指引。
 * 检索逻辑一行都不重复。
 *
 * ── 能力注册，不是开关 ────────────────────────────────────────────
 *
 * 跟 web-search.ts 同一个原则：**没配这个服务，就不注册这个工具**。
 * 不给模型一个"存在于工具表里但一调就失败"的死工具 ——
 * 那是模型唯一没法正确理解的一种"不可用"。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';

import { buildCourseSearchTool, type CourseSearchConfig } from '@/lib/chat/pi/tools/course-search';
import { buildReadDocumentTool } from '@/lib/chat/pi/tools/read-document';

/** 这个部署的课程库能力；没配就是 null。 */
export function resolveCourseSearchCapability(): CourseSearchConfig | null {
  const baseUrl = process.env.OPENMAIC_COURSE_SEARCH_URL?.trim();
  if (!baseUrl) return null;
  // 只做最低限度的形状校验：给了值就信任它是 URL，具体连通性由工具调用时暴露。
  // 这里不主动探活 —— 启动期探活会让一个暂时没起来的 sidecar 永久摘掉工具。
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  return { baseUrl };
}

/**
 * 给 agent-runtime 用的 `course_search`。
 *
 * 描述被**整体替换**（不是追加）：`chat/pi` 那份写的是"真实大学课程目录
 * （MIT、Berkeley、Stanford…）"，那是早期只有课程目录时的说法。现在这个库里
 * 既有课程目录、也有学习者自己的文档架，L4 甚至已经细化到"某篇文档的第 N 块"。
 * 描述不准会直接导致模型用错层 —— 比如该查自己手上的材料却去查"哪里开这门课"。
 */
export function buildAgentCourseSearchTool(
  capability: CourseSearchConfig,
): AgentTool<never, never> {
  const base = buildCourseSearchTool({ config: capability });

  const tool = {
    ...base,
    label: 'Search the local course library and document shelf',
    description:
      "Search the learner's LOCAL library (no network). It holds two different things, " +
      'selected by `layer`:\n' +
      '  · the university course catalog (~22k real courses: numbers, terms, prerequisites, ' +
      'whether materials exist) — `layer: "auto"` (L0+L2), or L3 for inside lecture materials;\n' +
      "  · the learner's OWN document shelf (~3k PDFs / slides / notes, tens of millions of " +
      'characters) — `layer: "L4"`.\n' +
      'Use L4 when the question is about material the learner already has; use auto when you ' +
      'need to know what courses exist. Results carry `parentId` + `chunkIndex` for L4 hits: ' +
      'the hit may be one chunk of a longer document.\n' +
      'Call this BEFORE inventing any curriculum. It is **complementary to `web_search`, not a ' +
      'substitute**: use whichever the question needs, and use both when it needs both. The local ' +
      'library has no GitHub repositories and no recently-published material, so a topic it covers ' +
      'does not make a web search unnecessary.',
  } as unknown as AgentTool<never, never>;

  return tool;
}

/**
 * `read_document` —— 把 course_search 命中的 L4 **块**展开成整篇文档。
 *
 * 为什么必须有它：L4 检索返回的是块（`doc:xxx#12`），只带一个 chunkIndex。
 * 只有 course_search 而没有 read_document，等于"能查到某本书第 12 页，
 * 但没有任何工具能翻开这本书" —— 命中之后无法跟进，模型只能靠那一段
 * 断章取义。两者是配套的，注册 course_search 就必须同时注册它。
 *
 * 同样复用 `chat/pi` 的实现，共用一个 baseUrl。
 */
export function buildAgentReadDocumentTool(
  capability: CourseSearchConfig,
): AgentTool<never, never> {
  return buildReadDocumentTool({ config: { baseUrl: capability.baseUrl } }) as unknown as AgentTool<
    never,
    never
  >;
}

/**
 * 提示词块，**与工具同生共死**：
 * 只有工具被注册时才出现，所以模型不会读到一段描述不存在工具的指引。
 *
 * ★ 这里刻意**不写"优先用本地"** —— 本地库和联网是**互补的两条腿**，
 *   不是二选一。学习者要的东西有相当一部分（GitHub 上的开源项目、成熟
 *   电子书、更新快的内容）**本地库里根本没有**，只能从网上拿。
 *   写成"优先本地"会诱导模型用一篇不相干的本地讲义去顶替一个本该联网
 *   查的开源项目 —— 那比查不到更糟，因为看起来像有依据。
 */
/**
 * 课程库块的**能力条件**。
 *
 * ★ `hasWebSearch` 必填（§12 同一条思路）：本块由课程库能力单独把关，而
 *   `web_search` 是**另一个**能力。实测（2026-10-07）：课程库配了、web search 没配时，
 *   本块仍然说"You have … and `web_search` for the open web" —— 模型会去找那个不存在的工具。
 *
 * ★ 标题**不动**：pin 里断言了它（`## Local library and the web are complementary`），
 *   而那里恰好是"课程库配了、web search 没配"的配置 —— 改标题会连带破断言，
 *   且标题只是描述话题，不是让模型去调什么。
 */
export interface CourseLibraryCapabilities {
  hasWebSearch: boolean;
}

export function courseLibraryPromptBlock(capabilities: CourseLibraryCapabilities): string {
  const { hasWebSearch } = capabilities;
  return [
    '## Local library and the web are complementary',
    '',
    ...(hasWebSearch
      ? [
          "You have `course_search` + `read_document` for the learner's LOCAL library, and `web_search`",
          'for the open web. **They are not alternatives — use whichever the question needs, and use both',
          'when it needs both.**',
        ]
      : [
          "You have `course_search` + `read_document` for the learner's LOCAL library.",
          '**This deployment has no web search** — work from the local library and your own knowledge,',
          'and say so when the local library does not cover something.',
        ]),
    '',
    '**Local library (`course_search`)** — two shelves, picked by `layer`:',
    '',
    '- **Course catalog** (`auto` = L0+L2, or `L3` for inside lecture materials): ~22k real',
    '  university courses with numbers, terms, units and prerequisites. Grounds "what is actually',
    '  taught" instead of an invented syllabus.',
    "- **Document shelf** (`L4`): ~3k of the learner's own PDFs, slides and notes.",
    '',
    '**`read_document` finishes what `course_search` starts.** An L4 hit is a *chunk*, not a whole',
    'document. It carries `parentId` and `chunkIndex`/`chunkOf`. To use it properly:',
    '',
    '1. `course_search(layer="L4")` to find candidates;',
    '2. `read_document(mode="peek")` on a candidate to see a rough table of contents;',
    '3. `read_document(mode="full")` only for documents worth reading (it pages at 60k chars).',
    '',
    'Never treat one chunk as the whole text, and never invent a document id.',
    '',
    ...(hasWebSearch
      ? [
          '**`web_search`** — the open web. Reach for it when the material is *not* local and cannot be:',
          'open-source projects and their repos, well-known free e-books and courses, current releases,',
          'version-specific behaviour, anything that changed recently. A topic existing in the local',
          'library does **not** make web search unnecessary — the learner may want the community',
          'implementation even when a lecture note covers the concept.',
        ]
      : []),
  ].join('\n');
}
