import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 这个文件**故意读 `runner.ts` 的源码文本**，因为它要钉的是"接线有没有接上"
 * —— 那是一句代码，不是一个运行时值。代价是脆（改写法就会碎），
 * 所以每条断言都写清"它其实在保证什么"。
 */
describe('personal history runner wiring', () => {
  const source = readFileSync(join(process.cwd(), 'lib/server/agent-runtime/runner.ts'), 'utf8');

  it('captures the session owner and keeps all four tools on the normal allowlist', () => {
    // 工具真的被构造出来了，而且拿到了会话 owner。
    expect(source).toContain('buildPersonalHistoryTools(');
    expect(source).toContain('meta.ownerId');
    expect(source).not.toContain('analyze_course_history');

    // ★ 这里原本断言 `...PERSONAL_HISTORY_TOOL_NAMES` —— 即在允许表里点名这一组常量。
    //   现在允许表**从工具表派生**（`allowedToolNames: new Set(tools.map(…))`），
    //   所以里面**不再点名任何一组常量**，那条字面量断言因此失效。
    //   但它想保证的事（"这四个工具真的能调"）其实**变强了**：
    //   工具只要进了 `tools`，就必然在允许表里 —— 结构上不可能漏。
    //   所以改钉**那个派生关系**（见 runner.ts 里那段注释）。
    expect(source).toContain('allowedToolNames: new Set(tools.map((tool) => tool.name))');
  });
});
