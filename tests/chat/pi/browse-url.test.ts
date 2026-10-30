import { describe, expect, it, vi } from 'vitest';
import { buildBrowseUrlTool } from '@/lib/chat/pi/tools/browse-url';

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

describe('browse_url', () => {
  it('is not configured without a baseUrl, and does not pretend to have opened anything', async () => {
    const tool = buildBrowseUrlTool({});
    expect(tool.name).toBe('browse_url');
    const out = await tool.execute('c1', { url: 'https://arxiv.org/abs/1706.03762' });
    expect(out.details.status).toBe('not_configured');
    expect(isErrorResult(out)).toBe(true);
  });

  it('posts the url and renders text + links', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain('/browse');
      const body = JSON.parse(String(init.body));
      expect(body.url).toBe('https://arxiv.org/abs/1706.03762');
      expect(body.maxChars).toBe(5000);
      return jsonResponse({
        ok: true,
        title: 'Attention Is All You Need',
        status: 200,
        finalUrl: 'https://arxiv.org/abs/1706.03762',
        text: 'Abstract: The dominant sequence transduction models…',
        textChars: 12345,
        truncated: false,
        links: ['https://arxiv.org/pdf/1706.03762'],
        elapsedSec: 8.1,
      });
    });
    const tool = buildBrowseUrlTool({
      config: { baseUrl: 'http://127.0.0.1:8730/' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await tool.execute('c1', {
      url: 'https://arxiv.org/abs/1706.03762',
      maxChars: 5000,
    });
    expect(out.details.status).toBe('ok');
    expect(out.details.title).toBe('Attention Is All You Need');
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('Attention Is All You Need');
    expect(text).toContain('https://arxiv.org/pdf/1706.03762');
  });

  it('reports a server refusal as blocked (not as a transport error)', async () => {
    const tool = buildBrowseUrlTool({
      config: { baseUrl: 'http://127.0.0.1:8730' },
      fetchImpl: (async () =>
        jsonResponse({
          ok: false,
          error: 'blocked',
          reason: 'target resolves to a private/reserved address (127.0.0.1) — refused',
        })) as unknown as typeof fetch,
    });
    const out = await tool.execute('c1', { url: 'http://127.0.0.1:8080/' });
    expect(out.details.status).toBe('blocked');
    expect(isErrorResult(out)).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain('refused');
  });

  it('never reflects a raw transport error', async () => {
    const tool = buildBrowseUrlTool({
      config: { baseUrl: 'http://127.0.0.1:8730' },
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8730');
      }) as unknown as typeof fetch,
    });
    const out = await tool.execute('c1', { url: 'https://example.com' });
    expect(out.details.status).toBe('error');
    expect(JSON.stringify(out)).not.toContain('ECONNREFUSED');
  });

  it('rejects arguments outside the strict schema', () => {
    const tool = buildBrowseUrlTool({ config: { baseUrl: 'http://127.0.0.1:8730' } });
    const prepare = tool.prepareArguments as (a: unknown) => unknown;
    expect(() => prepare({})).toThrow();
    expect(() => prepare({ url: 'https://x.com', evil: 1 })).toThrow();
    expect(() => prepare({ url: 'https://x.com' })).not.toThrow();
  });
});
