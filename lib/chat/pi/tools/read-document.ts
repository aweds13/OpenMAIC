import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

/**
 * `read_document` — 读**本地文档层（L4）**里某一篇的正文。
 *
 * ## 为什么需要它（不做的话 L4 等于白建）
 *
 * `course_search` 的 `layer=L4` 只返回**标题 + 600 字符摘要**。agent 因此
 * 只知道「有这么一篇」，不知道「这篇讲了什么」—— 讲不出内容，也就用不到
 * 备课里。而 L4 有 3039 篇、有的 233 MB，**不能一股脑给全文**（会撑爆上下文）。
 *
 * 所以分两档，配 human-in-the-loop：
 *
 * - `mode=peek` → 开头 + **每个分块的首句**（≈ 粗略目录）+ 总长度。
 *   便宜。**用来看"值不值得读"**，不是用来读的。
 *
 * - `mode=full` → 正文（可 `offset`/`limit` 翻页，单次上限 60000 字符）。
 *   贵。**只在用户确认要纳入之后调**。
 *
 * 预期调用序列：
 *   1. `course_search(layer="L4")` 拿到候选 id 列表；
 *   2. 对候选逐篇 `read_document(mode="peek")`，看粗目录判断相关性；
 *   3. **把候选列给用户，用 `ask_user` 问要纳入哪几篇**；
 *   4. 只对用户选中的调 `read_document(mode="full")`。
 *
 * 服务端实现在本机的 Python sidecar 里（`_tools/course-crawler/course_rag_server.py`
 * 的 `/document`），与 `course_search` **共用同一个服务**（同一个 baseUrl）。
 */

const DOC_MODES = ['peek', 'full'] as const;

const ReadDocumentParams = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        'Document id exactly as returned by course_search with layer="L4" (looks like "doc:Library/c7019c2213ea"). Do not invent or truncate it.',
    }),
    mode: Type.Union([Type.Literal('peek'), Type.Literal('full')], {
      description:
        'peek = opening text plus per-chunk first lines (a rough table of contents) — cheap, use it to judge relevance. '
        + 'full = the document body — expensive, use it ONLY after the user confirmed they want this document included.',
    }),
    offset: Type.Optional(
      Type.Number({
        minimum: 0,
        description: 'For mode="full": character offset to start at (paging). Default 0.',
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 60000,
        description: 'For mode="full": max characters to return. Default and ceiling are 60000.',
      }),
    ),
  },
  { additionalProperties: false },
);

export type ReadDocumentParams = Static<typeof ReadDocumentParams>;

export interface ReadDocumentConfig {
  /** Same sidecar as course_search. e.g. http://127.0.0.1:8720 */
  baseUrl?: string;
}

interface DocMeta {
  id: string;
  title: string;
  source: string;
  path: string;
  relPath: string;
  ext: string;
  bytes?: number;
  pagesTotal?: number;
  pagesRead?: number;
  truncatedPages?: boolean;
  needsMineru?: boolean;
  extractedBy?: string;
  chars: number;
  nChunks: number;
}

export interface ReadDocumentDetails {
  status: 'ok' | 'not_configured' | 'not_found' | 'error';
  id: string;
  mode: string;
  retrievedAt: string;
  document?: DocMeta;
  /** mode=full */
  offset?: number;
  returned?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
  /** mode=peek */
  toc?: Array<{ i: number; head: string }>;
}

type Options = {
  config?: ReadDocumentConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

function hasStrictArgumentShape(args: unknown): args is ReadDocumentParams {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  try {
    const prototype = Object.getPrototypeOf(args);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (!Object.hasOwn(args, 'id')) return false;
    if (!Object.hasOwn(args, 'mode')) return false;
    const allowed = new Set(['id', 'mode', 'offset', 'limit']);
    return Reflect.ownKeys(args).every((key) => typeof key === 'string' && allowed.has(key));
  } catch {
    return false;
  }
}

async function executeReadDocument(
  opts: Options & { params: ReadDocumentParams; signal?: AbortSignal },
) {
  const id = opts.params.id.trim();
  const mode = opts.params.mode;
  const retrievedAt = (opts.now ?? (() => new Date()))().toISOString();
  const config = opts.config;

  if (!config?.baseUrl) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Document reading is not configured. Do not claim to have read any document; explain the limitation instead.',
        },
      ],
      details: {
        status: 'not_configured' as const,
        id,
        mode,
        retrievedAt,
      },
      isError: true,
    };
  }

  const root = config.baseUrl.replace(/\/+$/, '');
  const qs = new URLSearchParams({ id, mode });
  if (mode === 'full') {
    if (typeof opts.params.offset === 'number') qs.set('offset', String(opts.params.offset));
    if (typeof opts.params.limit === 'number') qs.set('limit', String(opts.params.limit));
  }
  const url = `${root}/document?${qs.toString()}`;

  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const response = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: opts.signal,
    });

    if (response.status === 404) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No document with id "${id}". Use an id returned by course_search (layer="L4"); do not guess ids.`,
          },
        ],
        details: { status: 'not_found' as const, id, mode, retrievedAt },
        isError: true,
      };
    }
    if (!response.ok) throw new Error(`document endpoint returned ${response.status}`);

    const payload = (await response.json()) as {
      mode?: string;
      document?: DocMeta;
      preview?: string;
      previewTruncated?: boolean;
      toc?: Array<{ i: number; head: string }>;
      text?: string;
      offset?: number;
      returned?: number;
      hasMore?: boolean;
      nextOffset?: number | null;
      hint?: string;
    };
    const doc = payload.document;

    if (mode === 'peek') {
      const tocLines = (payload.toc ?? [])
        .slice(0, 40)
        .map((t) => `   [${t.i}] ${t.head}`)
        .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Document (peek) — "${doc?.title ?? id}"`,
              doc
                ? `   file: ${doc.relPath || doc.path} · ${doc.ext} · ${
                    doc.pagesTotal ?? '?'
                  } pages · ${doc.chars} chars · ${doc.nChunks} chunks`
                : '',
              doc?.needsMineru
                ? '   ⚠️ no text could be extracted from this file (scanned?); the body is empty.'
                : '',
              '',
              '   Rough contents (first line of each chunk):',
              tocLines || '   (no chunks)',
              '',
              '   Opening:',
              `   ${(payload.preview ?? '').slice(0, 2000)}`,
              payload.previewTruncated ? '   …(opening truncated)' : '',
              '',
              'This is only a preview. If the user wants this document used, call read_document again with mode="full".',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        details: {
          status: 'ok' as const,
          id,
          mode,
          retrievedAt,
          document: doc,
          toc: payload.toc,
        },
      };
    }

    // mode === full
    return {
      content: [
        {
          type: 'text' as const,
          text: [
            `Document (full) — "${doc?.title ?? id}"` +
              (doc ? ` · chars ${payload.offset ?? 0}–${(payload.offset ?? 0) + (payload.returned ?? 0)} of ${doc.chars}` : ''),
            '',
            payload.text ?? '',
            payload.hasMore
              ? `\n…(more available; call again with offset=${payload.nextOffset})`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      details: {
        status: 'ok' as const,
        id,
        mode,
        retrievedAt,
        document: doc,
        offset: payload.offset,
        returned: payload.returned,
        hasMore: payload.hasMore,
        nextOffset: payload.nextOffset,
      },
    };
  } catch {
    // Never reflect raw transport errors into tool history.
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Document reading is unavailable right now. Do not claim to have read the document; explain the limitation instead.',
        },
      ],
      details: { status: 'error' as const, id, mode, retrievedAt },
      isError: true,
    };
  }
}

export function buildReadDocumentTool(
  opts: Options = {},
): AgentTool<typeof ReadDocumentParams, ReadDocumentDetails> {
  return {
    name: 'read_document',
    label: 'Read a local document',
    description:
      'Read a document from the learner\'s LOCAL DOCUMENT shelf (the same set course_search reaches with layer="L4"): their own PDFs, slide decks and Obsidian notes. '
      + 'Use mode="peek" first to see a rough table of contents and judge relevance, then list the candidates to the user and let them choose; '
      + 'only call mode="full" for documents the user confirmed they want included. Never invent a document id and never claim to have read something you did not read.',
    parameters: ReadDocumentParams,
    executionMode: 'sequential',
    prepareArguments: (args) => {
      if (!hasStrictArgumentShape(args) || !Value.Check(ReadDocumentParams, args)) {
        throw new Error('read_document arguments must match the strict schema.');
      }
      return args;
    },
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Operation aborted', 'AbortError');
      }
      return executeReadDocument({ ...opts, params, signal });
    },
  };
}
