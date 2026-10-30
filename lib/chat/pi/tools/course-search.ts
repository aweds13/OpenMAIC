import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

/**
 * `course_search` — 让 agent 检索**已采集的名校课程库**。
 *
 * ## 为什么是"工具"而不是"库"
 *
 * 需求：「RAG 索引得是还能集成到清华那个框架」。
 *
 * OpenMAIC 自己有 `lib/rag/`（`KnowledgeIndex` 接口），但实测那份代码
 * **在库外没有任何调用者** —— 只有 tests 引它，没有 API 路由、没有 agent 工具。
 * 所以它不是现成的接入点。
 *
 * 真正能让 agent「用上」课程数据的缝，是 `lib/chat/pi/tools/` 下的 agent 工具，
 * 在 `tools/call-agent.ts` 里组装成 `nativeTools`。本文件照 `web-search.ts`
 * 的形状写，挂进去即可。
 *
 * 检索本身跑在**本地 Python 服务**里（`_tools/course-crawler/course_rag_server.py`），
 * 复用那边已经验证过的一套：
 *   · 分层（L0 课程 / L1 开设 / L2 单元 / L3 资源），**按层检索**
 *   · 英文走 BM25（不用 TF-IDF 余弦 —— 它按 L2 范数归一化会系统性惩罚有讲义的课）
 *   · 中文走 bge-m3 嵌入（本地 Ollama，零 token；BM25 跨不了语言）
 *
 * 这样 OpenMAIC 侧**零新依赖**（只用一个 `fetch`），检索实现可以独立演进。
 */

const LAYERS = ['auto', 'L0', 'L1', 'L2', 'L3', 'L4'] as const;

const CourseSearchParams = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 400,
      pattern: '\\S',
      description:
        'What to look for: a topic ("distributed systems"), a technique ("paxos"), or a course code ("6.824"). Chinese works too.',
    }),
    layer: Type.Optional(
      Type.Union(
        [
          Type.Literal('auto'),
          Type.Literal('L0'),
          Type.Literal('L1'),
          Type.Literal('L2'),
          Type.Literal('L3'),
          Type.Literal('L4'),
        ],
        {
          description:
            'auto = find courses (L0+L2). L3 = only inside lecture materials (slides/notes/transcripts). ' +
            "L4 = the LOCAL DOCUMENT shelf (the learner's own PDFs, slides and Obsidian notes, " +
            '~3k documents) — use it when the question is about material the learner already has ' +
            'rather than about courses that exist somewhere.',
        },
      ),
    ),
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 12,
        description: 'Maximum number of courses to return. Defaults to 6.',
      }),
    ),
  },
  { additionalProperties: false },
);

type CourseSearchParams = Static<typeof CourseSearchParams>;

const COURSE_SEARCH_ARGUMENT_KEYS = new Set(['query', 'layer', 'maxResults']);

function hasStrictArgumentShape(args: unknown): args is CourseSearchParams {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  try {
    const prototype = Object.getPrototypeOf(args);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (!Object.hasOwn(args, 'query')) return false;
    return Reflect.ownKeys(args).every(
      (key) => typeof key === 'string' && COURSE_SEARCH_ARGUMENT_KEYS.has(key),
    );
  } catch {
    return false;
  }
}

export type CourseSearchConfig = {
  /** Base URL of the local course RAG service, e.g. `http://127.0.0.1:8720`. */
  baseUrl: string;
  timeoutMs?: number;
};

export type CourseSearchHit = {
  id: string;
  number: string;
  title: string;
  source: string;
  layers: string[];
  score: number;
  term: string;
  units: string;
  prereq: string;
  description: string;
  url: string;
  nUnits: number;
  nResources: number;
  hasMaterials: boolean;
  /**
   * 块级命中（2026-10-03）。L4 现在是**块**为单位，所以一条命中可能是
   * 「某篇文档的第 12 块」而不是「整篇文档」。
   *
   * `parentId` 是**整篇文档**的 id —— `read_document` 要的是它，不是 `id`。
   * `sampled` 为 true 表示这篇太长、只等距取了若干块（覆盖全文，不是只取开头）。
   */
  parentId?: string | null;
  chunkIndex?: number | null;
  chunkOf?: number | null;
  sampled?: boolean | null;
};

export interface CourseSearchDetails {
  status: 'ok' | 'not_configured' | 'no_results' | 'error';
  query: string;
  layer: string;
  method?: string;
  retrievedAt: string;
  courseCount: number;
  courses: CourseSearchHit[];
}

function compact(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

type Options = {
  config?: CourseSearchConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

async function executeCourseSearch(
  opts: Options & { params: CourseSearchParams; signal?: AbortSignal },
) {
  const query = opts.params.query.trim();
  const layer = opts.params.layer ?? 'auto';
  const topk = opts.params.maxResults ?? 6;
  const retrievedAt = (opts.now ?? (() => new Date()))().toISOString();
  const config = opts.config;

  if (!config?.baseUrl) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Course search is not configured. Do not invent course facts; explain the limitation instead.',
        },
      ],
      details: {
        status: 'not_configured' as const,
        query,
        layer,
        retrievedAt,
        courseCount: 0,
        courses: [],
      },
      isError: true,
    };
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&layer=${layer}&topk=${topk}`;

  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const response = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(config.timeoutMs ? { signal: opts.signal ?? AbortSignal.timeout(config.timeoutMs) } : {}),
    });
    if (!response.ok) throw new Error(`course search answered ${response.status}`);

    const payload = (await response.json()) as {
      method?: string;
      count?: number;
      hits?: CourseSearchHit[];
    };
    const courses = Array.isArray(payload.hits) ? payload.hits : [];

    if (courses.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No course in the local catalog matches "${query}"${
              layer === 'auto' ? '' : ` at layer ${layer}`
            }. Try a broader topic, or drop the layer filter.`,
          },
        ],
        details: {
          status: 'no_results' as const,
          query,
          layer,
          method: payload.method,
          retrievedAt,
          courseCount: 0,
          courses: [],
        },
      };
    }

    const lines = courses.map((course, index) => {
      const bits = [
        `${index + 1}. ${course.number} — ${compact(course.title, 200)}`,
        `   source: ${course.source}${course.term ? ` · ${course.term}` : ''}${
          course.units ? ` · ${course.units} units` : ''
        }`,
        `   layers present: ${(course.layers ?? []).join('+') || 'unknown'}`,
        course.hasMaterials
          ? `   materials: ${course.nResources} downloadable resources in ${course.nUnits} units`
          : '   materials: none (catalog record only)',
      ];
      // 块命中：明确标出「这是哪篇的哪一块」，否则模型会把它当成一整篇
      if (course.chunkIndex !== undefined && course.chunkIndex !== null) {
        bits.push(
          `   this is chunk ${course.chunkIndex + 1} of ${
            course.chunkOf ?? '?'
          }${course.sampled ? ' (evenly sampled from a long document)' : ''}`,
        );
        if (course.parentId) {
          bits.push(`   full document id for read_document: ${course.parentId}`);
        }
      }
      if (course.prereq) bits.push(`   prerequisites: ${compact(course.prereq, 240)}`);
      if (course.description) bits.push(`   summary: ${compact(course.description, 500)}`);
      if (course.url) bits.push(`   sourceUrl: ${course.url}`);
      return bits.join('\n');
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: [
            `Local course catalog (${payload.count ?? courses.length} matches, method=${
              payload.method ?? 'unknown'
            }, retrievedAt=${retrievedAt}):`,
            lines.join('\n\n'),
            'Only these returned records are real. If a course shows "materials: none", do not claim it has lecture files. Cite the sourceUrl when you rely on a record.',
          ].join('\n'),
        },
      ],
      details: {
        status: 'ok' as const,
        query,
        layer,
        method: payload.method,
        retrievedAt,
        courseCount: courses.length,
        courses,
      },
    };
  } catch {
    // Never reflect raw transport errors into tool history.
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Course search is unavailable right now. Do not invent course facts; explain the limitation instead.',
        },
      ],
      details: {
        status: 'error' as const,
        query,
        layer,
        retrievedAt,
        courseCount: 0,
        courses: [],
      },
      isError: true,
    };
  }
}

export function buildCourseSearchTool(
  opts: Options = {},
): AgentTool<typeof CourseSearchParams, CourseSearchDetails> {
  return {
    name: 'course_search',
    label: 'Search university courses',
    description:
      'Search a local catalog of real university courses (MIT, Berkeley, Stanford, Yale, Cornell, CMU, UPenn, UT Austin, Northeastern, UMD, UC San Diego). Returns course numbers, terms, units, prerequisites and whether lecture materials exist. Use it before inventing any curriculum.',
    parameters: CourseSearchParams,
    executionMode: 'sequential',
    prepareArguments: (args) => {
      if (!hasStrictArgumentShape(args) || !Value.Check(CourseSearchParams, args)) {
        throw new Error('course_search arguments must match the strict schema.');
      }
      return args;
    },
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Operation aborted', 'AbortError');
      }
      return executeCourseSearch({ ...opts, params, signal });
    },
  };
}
