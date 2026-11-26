import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryWhiteboardVisibility } from '@/lib/chat/pi/whiteboard-visibility';

const OWNER_COOKIE = '66666666-6666-4666-8666-666666666666';
const OTHER_COOKIE = '77777777-7777-4777-8777-777777777777';
const OWNER = `anon:${OWNER_COOKIE}`;

function request(
  body: unknown,
  headers: Record<string, string> = { cookie: `anonymous_id=${OWNER_COOKIE}` },
): NextRequest {
  return new Request('http://localhost/api/chat/pi/whiteboard-visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('whiteboard visibility callback route', () => {
  beforeEach(() => vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', ''));
  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    vi.unstubAllEnvs();
  });

  it('does not let malformed, foreign, or mismatched callbacks settle the owner', async () => {
    let queryId = '';
    const pending = queryWhiteboardVisibility({
      stageId: 'stage-1',
      learnerKey: OWNER,
      // 这条用例本身**不等**超时：它要的是「三次错回调之后 query 还挂着」。
      // 1 秒在冷模块导入慢的机器上不够 —— 三次 POST 加起来接近 2 秒，
      // 于是最后那次正确回调拿到 404（不是权限判错，是 query 已经超时走了）。
      // 给足预算，判据不变。
      timeoutMs: 30_000,
      dispatch: async (id) => {
        queryId = id;
      },
    });
    await vi.waitFor(() => expect(queryId).not.toBe(''));
    const { POST } = await import('@/app/api/chat/pi/whiteboard-visibility/route');

    // Another owner naming this owner's learner key the way the old header did.
    expect(
      (
        await POST(
          request(
            { queryId, stageId: 'stage-1', visibility: 'closed' },
            { cookie: `anonymous_id=${OTHER_COOKIE}`, 'x-learner-key': OWNER },
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (await POST(request({ queryId, stageId: 'wrong-stage', visibility: 'closed' }))).status,
    ).toBe(404);
    expect(
      (await POST(request({ queryId, stageId: 'stage-1', visibility: 'closed', extra: true })))
        .status,
    ).toBe(400);

    expect((await POST(request({ queryId, stageId: 'stage-1', visibility: 'open' }))).status).toBe(
      204,
    );
    await expect(pending).resolves.toBe('open');
  });

  it('answers 401 for a credential an owner auth method rejects', async () => {
    const { configureOwnerAuthentication } = await import('@/lib/server/identity');
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    configureOwnerAuthentication({
      methods: [{ name: 'rejecting', authenticate: async () => ({ status: 'invalid' }) }],
    });
    const { POST } = await import('@/app/api/chat/pi/whiteboard-visibility/route');

    const response = await POST(request({ queryId: 'q', stageId: 'stage-1', visibility: 'open' }));

    expect(response.status).toBe(401);
  });
});
