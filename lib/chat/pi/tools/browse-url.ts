import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

/**
 * `browse_url` — 用**真浏览器（Playwright + 系统 Edge）**打开一个网页，取回可读正文。
 *
 * ## 和内置 `fetch_url` 的分工
 *
 * `fetch_url` 走一次 HTTP 请求，拿的是**原始 HTML**，而且它有一道
 * **session-URL 信任门**（只允许"会话里出现过的地址"）。对静态页面够用，
 * 但对下面这些就不行：
 *
 *   · 靠 JS 渲染的页面（很多课程页、现代文档站）
 *   · 需要跟随重定向、等网络空闲的页面
 *   · 想要"正文"而不是"整页 HTML"
 *
 * `browse_url` 把页面在真 Edge 里渲染完，**去掉 script/style/nav/footer**
 * 再取 `innerText`，顺手带回页面上的链接 —— 所以更适合：
 *
 *   · 课程材料里的**讲义 PDF 页面**（L3 层的 url）
 *   · `arxiv.org/abs/…` 摘要页
 *   · `github.com/user/repo` 的 README
 *
 * ## ⚠️ 不要用它做什么
 *
 * **不要用它去爬课程目录的"搜索页"。** 我们自己课程数据里的 `sourceUrl`
 * 大多是 `…/search/?P=<课号>` 这种形式（CourseLeaf 的搜索页），爬下来
 * 只是"搜索结果的 HTML" —— 而那条记录本身已经在 `course_search` 的返回里了。
 *
 * 本地文档（`layer=L4`）也用不着它：那些文件就在本机，`read_document` 直接读，
 * 比走浏览器快得多也可靠得多。
 *
 * ## 安全
 *
 * 服务端（`_tools/course-crawler/browse_server.py`）自己挡 SSRF：只允许 http(s)，
 * 解析出的 IP 若落在私有/保留段（含 169.254.169.254 云元数据）就拒绝，
 * **每次重定向都重新检查**。
 */

const BrowseParams = Type.Object(
  {
    url: Type.String({
      minLength: 8,
      maxLength: 2000,
      description:
        'Absolute http(s) URL to open in a real browser. Private/internal addresses are refused by the server.',
    }),
    maxChars: Type.Optional(
      Type.Number({
        minimum: 1000,
        maximum: 120000,
        description: 'Max characters of page text to return. Default 40000.',
      }),
    ),
    waitMs: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 8000,
        description:
          'Extra milliseconds to wait after load for client-side rendering. Default 1500; raise it for heavy SPAs.',
      }),
    ),
  },
  { additionalProperties: false },
);

export type BrowseParams = Static<typeof BrowseParams>;

export interface BrowseConfig {
  /** browse service base URL, e.g. http://127.0.0.1:8730 */
  baseUrl?: string;
}

export interface BrowseDetails {
  status: 'ok' | 'not_configured' | 'blocked' | 'error';
  url: string;
  retrievedAt: string;
  finalUrl?: string;
  httpStatus?: number;
  title?: string;
  textChars?: number;
  truncated?: boolean;
  links?: string[];
  elapsedSec?: number;
}

type Options = {
  config?: BrowseConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

function hasStrictArgumentShape(args: unknown): args is BrowseParams {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  try {
    const prototype = Object.getPrototypeOf(args);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (!Object.hasOwn(args, 'url')) return false;
    const allowed = new Set(['url', 'maxChars', 'waitMs']);
    return Reflect.ownKeys(args).every((key) => typeof key === 'string' && allowed.has(key));
  } catch {
    return false;
  }
}

async function executeBrowse(opts: Options & { params: BrowseParams; signal?: AbortSignal }) {
  const url = opts.params.url.trim();
  const retrievedAt = (opts.now ?? (() => new Date()))().toISOString();
  const config = opts.config;

  if (!config?.baseUrl) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Browsing is not configured. Do not claim to have opened the page; explain the limitation instead.',
        },
      ],
      details: { status: 'not_configured' as const, url, retrievedAt },
      isError: true,
    };
  }

  const root = config.baseUrl.replace(/\/+$/, '');
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${root}/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        url,
        ...(typeof opts.params.maxChars === 'number' ? { maxChars: opts.params.maxChars } : {}),
        ...(typeof opts.params.waitMs === 'number' ? { waitMs: opts.params.waitMs } : {}),
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`browse service returned ${res.status}`);

    const payload = (await res.json()) as {
      ok?: boolean;
      error?: string;
      reason?: string;
      title?: string;
      text?: string;
      textChars?: number;
      truncated?: boolean;
      links?: string[];
      finalUrl?: string;
      status?: number;
      elapsedSec?: number;
    };

    if (!payload.ok) {
      // 拒绝访问（SSRF 门 / 解析失败）要和"服务坏了"分开说
      const blocked = payload.error === 'blocked';
      return {
        content: [
          {
            type: 'text' as const,
            text: blocked
              ? `The browser refused to open ${url}: ${payload.reason ?? 'blocked'}. Private/internal addresses are not reachable from here.`
              : `Could not open ${url}: ${payload.error ?? 'unknown'} ${payload.reason ?? ''}`.trim(),
          },
        ],
        details: {
          status: (blocked ? 'blocked' : 'error') as BrowseDetails['status'],
          url,
          retrievedAt,
        },
        isError: true,
      };
    }

    const links = (payload.links ?? []).slice(0, 40);
    return {
      content: [
        {
          type: 'text' as const,
          text: [
            `Page — ${payload.title || url}`,
            `   ${payload.finalUrl || url} · HTTP ${payload.status ?? '?'} · ${
              payload.textChars ?? 0
            } chars${payload.truncated ? ' (truncated)' : ''} · ${payload.elapsedSec ?? '?'}s`,
            '',
            payload.text ?? '',
            links.length ? '' : '',
            links.length ? `Links on this page:\n${links.map((l) => `   ${l}`).join('\n')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      details: {
        status: 'ok' as const,
        url,
        retrievedAt,
        finalUrl: payload.finalUrl,
        httpStatus: payload.status,
        title: payload.title,
        textChars: payload.textChars,
        truncated: payload.truncated,
        links,
        elapsedSec: payload.elapsedSec,
      },
    };
  } catch {
    // Never reflect raw transport errors into tool history.
    return {
      content: [
        {
          type: 'text' as const,
          text: 'The browser service is unavailable right now. Do not claim to have opened the page; explain the limitation instead.',
        },
      ],
      details: { status: 'error' as const, url, retrievedAt },
      isError: true,
    };
  }
}

export function buildBrowseUrlTool(
  opts: Options = {},
): AgentTool<typeof BrowseParams, BrowseDetails> {
  return {
    name: 'browse_url',
    label: 'Open a web page in a browser',
    description:
      'Open an http(s) page in a real browser (Playwright + Edge) and return its readable text plus the links on it. ' +
      'Use it for pages that need rendering — lecture/notes pages, arxiv abstract pages, GitHub READMEs. ' +
      'It is NOT for the course catalog: course records already come from course_search, and their sourceUrl is ' +
      'usually a CourseLeaf search page, so browsing it adds nothing. Local documents are read with read_document instead.',
    parameters: BrowseParams,
    executionMode: 'sequential',
    prepareArguments: (args) => {
      if (!hasStrictArgumentShape(args) || !Value.Check(BrowseParams, args)) {
        throw new Error('browse_url arguments must match the strict schema.');
      }
      return args;
    },
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Operation aborted', 'AbortError');
      }
      return executeBrowse({ ...opts, params, signal });
    },
  };
}
