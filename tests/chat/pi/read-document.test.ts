import { describe, expect, it, vi } from 'vitest';

import { buildReadDocumentTool } from '@/lib/chat/pi/tools/read-document';

/**
 * `read_document` 的契约测试。
 *
 * 这个工具存在的理由（写在这里免得以后被"简化"掉）：
 * `course_search(layer="L4")` 只给标题 + 600 字符摘要，agent 因此**读不到正文**；
 * 而 L4 有 3039 篇、有的 233MB，**不能一股脑给全文**。
 * 所以要 peek（便宜，判断相关性）/ full（贵，用户确认后才调）两档。
 */

/**
 * `AgentToolResult<T>` 的**公开类型里没有 `isError`**，但它在运行时是真实字段 ——
 * `pi-agent-core` 内部（agent-loop.js）和项目自己（director-loop.ts:235、
 * native-whiteboard.ts:402、course-search.ts:155）都在读写它。
 * 工具作者通过**推断返回类型**绕过了这个缺口（多余属性检查不作用于推断返回类型），
 * 测试里按声明类型访问就会报 TS2339 ⇒ 这里显式断言。
 */
function isErrorResult(out: unknown): boolean {
  return (out as { isError?: boolean }).isError === true;
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

const DOC = {
  id: 'doc:Library/c7019c2213ea',
  title: 'ICML2024_Genie_生成式交互环境',
  source: '本地文档 (Library)',
  path: 'D:/x/y.pdf',
  relPath: '论文与专著/…/ICML2024_Genie.pdf',
  ext: '.pdf',
  bytes: 1234,
  pagesTotal: 27,
  pagesRead: 27,
  truncatedPages: false,
  needsMineru: false,
  extractedBy: 'pymupdf',
  chars: 72178,
  nChunks: 106,
};

describe('read_document', () => {
  it('registers under the name read_document and is not configured without a baseUrl', async () => {
    const tool = buildReadDocumentTool({});
    expect(tool.name).toBe('read_document');

    const out = await tool.execute('c1', { id: DOC.id, mode: 'peek' });
    expect(out.details.status).toBe('not_configured');
    expect(isErrorResult(out)).toBe(true);
    // 没配置时**绝不能**让模型以为读到了东西
    expect(JSON.stringify(out.content)).toContain('not configured');
  });

  it('peek asks the /document endpoint and surfaces a rough table of contents', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/document?');
      expect(url).toContain('mode=peek');
      expect(decodeURIComponent(url)).toContain(DOC.id);
      return jsonResponse({
        mode: 'peek',
        document: DOC,
        preview: '## 这是什么…',
        previewTruncated: true,
        toc: [
          { i: 0, head: '## 这是什么（一句话定位）' },
          { i: 1, head: 'Genie: Generative Interactive Environments' },
        ],
      });
    });

    const tool = buildReadDocumentTool({
      config: { baseUrl: 'http://127.0.0.1:8720/' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await tool.execute('c1', { id: DOC.id, mode: 'peek' });

    expect(out.details.status).toBe('ok');
    expect(out.details.toc).toHaveLength(2);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('Rough contents');
    expect(text).toContain('## 这是什么（一句话定位）');
    // ★ 必须告诉模型"这只是预览"，否则它会当成读完了
    expect(text).toContain('mode="full"');
  });

  it('full forwards offset/limit and reports paging when there is more', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('mode=full');
      expect(url).toContain('offset=800');
      expect(url).toContain('limit=400');
      return jsonResponse({
        mode: 'full',
        document: DOC,
        offset: 800,
        limit: 400,
        text: 'BODY',
        returned: 400,
        hasMore: true,
        nextOffset: 1200,
      });
    });

    const tool = buildReadDocumentTool({
      config: { baseUrl: 'http://127.0.0.1:8720' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await tool.execute('c1', { id: DOC.id, mode: 'full', offset: 800, limit: 400 });

    expect(out.details.status).toBe('ok');
    expect(out.details.hasMore).toBe(true);
    expect(out.details.nextOffset).toBe(1200);
    expect((out.content[0] as { text: string }).text).toContain('offset=1200');
  });

  it('a 404 becomes not_found rather than a transport error', async () => {
    const tool = buildReadDocumentTool({
      config: { baseUrl: 'http://127.0.0.1:8720' },
      fetchImpl: (async () => jsonResponse({ error: 'document not found' }, 404)) as unknown as typeof fetch,
    });
    const out = await tool.execute('c1', { id: 'doc:nope', mode: 'peek' });

    expect(out.details.status).toBe('not_found');
    expect(isErrorResult(out)).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain('do not guess ids');
  });

  it('never reflects a raw transport error into tool history', async () => {
    const tool = buildReadDocumentTool({
      config: { baseUrl: 'http://127.0.0.1:8720' },
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8720 — secret-ish detail');
      }) as unknown as typeof fetch,
    });
    const out = await tool.execute('c1', { id: DOC.id, mode: 'peek' });

    expect(out.details.status).toBe('error');
    expect(isErrorResult(out)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('ECONNREFUSED');
  });

  it('rejects arguments that do not match the strict schema', () => {
    const tool = buildReadDocumentTool({ config: { baseUrl: 'http://127.0.0.1:8720' } });
    const prepare = tool.prepareArguments as (args: unknown) => unknown;

    expect(() => prepare({ id: DOC.id })).toThrow();               // mode 必填
    expect(() => prepare({ id: DOC.id, mode: 'peek', extra: 1 })).toThrow();  // 多余字段
    expect(() => prepare({ id: DOC.id, mode: 'read' })).toThrow(); // 非法 mode
    expect(prepare({ id: DOC.id, mode: 'peek' })).toEqual({ id: DOC.id, mode: 'peek' });
  });

  it('retries once with the doc: shelf prefix when the id arrives without it', async () => {
    // The real failure this guards: search prints `doc:<source>/<hash>` and the
    // model copies only the tail, so the read 404s over four missing characters.
    const bare = DOC.id.replace(/^doc:/, '');
    const seen: string[] = [];
    const tool = buildReadDocumentTool({
      config: { baseUrl: 'http://127.0.0.1:8720' },
      fetchImpl: (async (url: string) => {
        seen.push(decodeURIComponent(url));
        return decodeURIComponent(url).includes(`id=${DOC.id}`)
          ? jsonResponse({ mode: 'peek', document: DOC, preview: 'P', toc: [] })
          : jsonResponse({ error: 'document not found' }, 404);
      }) as unknown as typeof fetch,
    });

    const out = await tool.execute('c1', { id: bare, mode: 'peek' });

    expect(out.details.status).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain(`id=${bare}`);
    expect(seen[1]).toContain(`id=${DOC.id}`);
  });

  it('does not retry an id that already carries the prefix', async () => {
    const seen: string[] = [];
    const tool = buildReadDocumentTool({
      config: { baseUrl: 'http://127.0.0.1:8720' },
      fetchImpl: (async (url: string) => {
        seen.push(decodeURIComponent(url));
        return jsonResponse({ error: 'document not found' }, 404);
      }) as unknown as typeof fetch,
    });

    const out = await tool.execute('c1', { id: DOC.id, mode: 'peek' });

    // `doc:doc:...` would be a made-up id, which the tool must never do.
    expect(seen).toHaveLength(1);
    expect(out.details.status).toBe('not_found');
  });
});
