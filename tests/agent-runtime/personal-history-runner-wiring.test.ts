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

    // ★ 允许表在 v1.5.0 之后由 `assembleCapabilityRuntime` 现算
    //   （`new Set([...baseAllowedToolNames, ...tools.map(…)]`），runner 侧不再出现
    //   那行 `new Set(tools.map(…))`。要保证的事没变："这四个工具真的能调"。
    //   现在有两条结构保证：
    //   ① 四个工具的常量名被显式点名进 `baseAllowedToolNames`；
    //   ② 它们也确实在 `candidateTools` 里构造出来了。
    expect(source).toContain('...PERSONAL_HISTORY_TOOL_NAMES');
  });
});
