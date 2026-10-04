/**
 * 秘塔 AI 搜索（Metaso）Web Search 集成。
 *
 * API（照 `_tools/metaso-own/server.mjs` 的实测实现）：
 *   POST {baseUrl}/search   body: { q, scope, size, page }
 *   headers: { Authorization: `Bearer <key>` }
 *
 * ⚠️ **结果数组的键随 scope 变化**（`webpages` / `documents` / `images` / `videos` …），
 *    所以不能写死键名。第一版第三方包就是踩在这个上：schema 里声明了字段，
 *    渲染器却不输出。这里按「**第一个非 `searchParameters` 的数组**」识别
 *    —— 和 `metaso-own` 同一套判法。
 *
 * 顶层还有：
 *   · `total`            命中总数
 *   · `credits`          本次消耗积分（秘塔按次计费，实测固定约 3 分/次）
 *   · `summary`          AI 综合摘要（**是生成物，要和原文片段区分开**）
 *   · `searchParameters` 服务端回显的参数
 *
 * 每条结果：`title` / `link` / `snippet` / `rawContent` / `score` / `position` / `date` / `thumbnail`
 */

import { createLogger } from '@/lib/logger';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { normalizeWebSearchQuery } from './utils';

const log = createLogger('Metaso');

const DEFAULT_BASE_URL = 'https://metaso.cn/api/v1';

interface MetasoItem {
  title?: string;
  link?: string;
  url?: string;
  snippet?: string;
  rawContent?: string;
  score?: number;
  position?: number;
  date?: string;
  thumbnail?: string;
}

interface MetasoResponse {
  total?: number;
  credits?: number;
  summary?: string;
  searchParameters?: unknown;
  message?: string;
  code?: unknown;
  [key: string]: unknown;
}

/**
 * 结果数组的键随 scope 变 —— 按「第一个非 `searchParameters` 的数组」识别。
 * （`credits`/`total` 是数字，`summary` 是字符串，都不会被误认成数组。）
 */
function pickResults(data: MetasoResponse): { key: string | null; items: MetasoItem[] } {
  for (const [key, value] of Object.entries(data)) {
    if (key === 'searchParameters') continue;
    if (Array.isArray(value)) return { key, items: value as MetasoItem[] };
  }
  return { key: null, items: [] };
}

function mapMetasoResult(item: MetasoItem, index: number): WebSearchSource | undefined {
  const url = (item.link || item.url || '').trim();
  if (!url) return undefined;
  return {
    title: (item.title || '').trim() || url,
    url,
    // 优先原文，其次片段 —— 两者都空则给空串（调用方会截断展示）
    content: (item.rawContent || item.snippet || '').trim(),
    score: typeof item.score === 'number' ? item.score : index,
  };
}

export function buildMetasoSearchUrl(baseUrl: string): string {
  const trimmed = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const root = trimmed.endsWith('/search') ? trimmed.slice(0, -'/search'.length) : trimmed;
  return `${root}/search`;
}

export async function searchWithMetaso(params: {
  query: string;
  apiKey?: string;
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { query: rawQuery, maxResults = 5, apiKey, baseUrl, signal } = params;
  const query = normalizeWebSearchQuery(rawQuery);

  const key = apiKey?.trim();
  if (!key) {
    throw new Error('Metaso API key is not configured. Set METASO_API_KEY on the server.');
  }

  const startedAt = Date.now();
  const requestUrl = buildMetasoSearchUrl(baseUrl || DEFAULT_BASE_URL);
  const res = await proxyFetch(requestUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    // scope=webpage 是默认面（document/paper/image/video/podcast 是别的面）
    body: JSON.stringify({ q: query, scope: 'webpage', size: Math.max(1, maxResults) }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Metaso error (${res.status}): ${errorText || res.statusText}`);
  }

  const rawText = await res.text();
  let data: MetasoResponse;
  try {
    data = JSON.parse(rawText) as MetasoResponse;
  } catch {
    throw new Error('Metaso returned a non-JSON response.');
  }

  // 服务端错误也走 200 的情况：有 message 且**没有任何结果数组**才算错
  const { key: resultKey, items } = pickResults(data);
  if (resultKey === null && typeof data.message === 'string' && data.message) {
    throw new Error(`Metaso API error: code=${String(data.code)} message=${data.message}`);
  }

  const sources = items
    .map((item, index) => mapMetasoResult(item, index))
    .filter((source): source is WebSearchSource => !!source)
    .slice(0, maxResults);

  if (sources.length === 0 && (data.total ?? items.length) > 0) {
    log.warn('Metaso reported results but none could be mapped', {
      resultKey,
      total: data.total,
      rawResultCount: items.length,
      requestUrl,
    });
  }

  return {
    // ★ summary 是 AI 生成物，不是原文 —— 放在 answer 里（调用方有区分），
    //   绝不混进 sources[].content（那里必须是可引用的原文片段）。
    answer: typeof data.summary === 'string' ? data.summary : '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}
