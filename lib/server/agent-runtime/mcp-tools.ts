/**
 * MCP 桥接 —— 把外部 MCP 工具包装成 agent 能用的 `AgentTool`。
 *
 * ── 参数 schema 为什么能直接透传 ──────────────────────────────────
 *
 * MCP 用 JSON Schema 描述工具入参，而本仓库的 `AgentTool.parameters` 接受
 * 的 TypeBox schema **本身就是 JSON Schema**（TypeBox 只是带类型的构造器）。
 * 所以不需要转换 —— 直接透传，模型看到的参数说明和 MCP 服务器声明的完全
 * 一致。自己再映射一层只会引入偏差。
 *
 * ── 为什么名字要加前缀 ────────────────────────────────────────────
 *
 * MCP 工具叫 `search_repositories` 这种裸名，直接注册会和内置工具撞车
 * （`read_material`、`search_material`… 已经占了类似的短名）。注册成
 * `mcp__github__search_repositories` 有三个好处：
 *   1. 不会撞；
 *   2. 模型从名字就知道该去哪儿找；
 *   3. 和 DSH 的命名一致，用户眼熟。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';

import { callMcpTool, listMcpTools, type ResolvedMcpTools } from './mcp-client';

/** 给模型看的工具描述：加上来源，并说明这是外部服务。 */
function describe(server: string, tool: string, description: string): string {
  const head = `[MCP: ${server}] ${description || tool}`.trim();
  return `${head}\n\nRuns on the external MCP server "${server}".`;
}

/**
 * 把一台服务器的一个工具包成 AgentTool。
 *
 * `inputSchema` 从 MCP 来，可能是 undefined（有些服务器不声明）—— 那时退回
 * 一个"任意对象"的开放 schema，而不是拒绝注册：一个没有 schema 的工具仍然
 * 可用，一个不存在的工具则完全不可用。
 */
function bridge(entry: ResolvedMcpTools['tools'][number]): AgentTool<never, never> {
  const schema =
    entry.inputSchema && typeof entry.inputSchema === 'object'
      ? entry.inputSchema
      : { type: 'object', properties: {}, additionalProperties: true };

  return {
    name: entry.name,
    label: `${entry.server}: ${entry.tool}`,
    description: describe(entry.server, entry.tool, entry.description),
    parameters: schema,
    executionMode: 'sequential',
    async execute(_id: string, params: unknown, signal?: AbortSignal) {
      const args =
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};

      try {
        const { text, isError } = await callMcpTool(entry.server, entry.tool, args, signal);
        return {
          content: [{ type: 'text' as const, text }],
          details: { server: entry.server, tool: entry.tool },
          ...(isError ? { isError: true } : {}),
        };
      } catch (error) {
        // 外部服务的失败必须**说清楚是外部失败** —— 不然模型会以为是自己
        // 参数写错了，然后反复重试同一个调用。
        return {
          content: [
            {
              type: 'text' as const,
              text: `MCP server "${entry.server}" failed to run "${entry.tool}": ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          details: { server: entry.server, tool: entry.tool },
          isError: true,
        };
      }
    },
  } as unknown as AgentTool<never, never>;
}

export interface McpToolset {
  tools: AgentTool<never, never>[];
  /** 注册进 allowlist 用的名字。 */
  names: string[];
  /** 连不上的服务器（调用方记录用）。 */
  failed: ResolvedMcpTools['failed'];
}

/**
 * 汇总所有 MCP 服务器的工具。
 *
 * **永远不会抛异常**：MCP 是外部依赖，它挂了不该让整场会话起不来。
 * 连不上的服务器进 `failed`，其余照常注册。
 */
export async function buildMcpTools(): Promise<McpToolset> {
  try {
    const { tools, failed } = await listMcpTools();
    const bridged = tools.map(bridge);
    return { tools: bridged, names: bridged.map((t) => t.name), failed };
  } catch (error) {
    return {
      tools: [],
      names: [],
      failed: [{ server: '*', error: error instanceof Error ? error.message : String(error) }],
    };
  }
}

/**
 * 提示词块。
 *
 * 只在真的有 MCP 工具时出现。要说清三件事：
 *   1. 这些是**外部服务**，不是本地能力；
 *   2. 失败要说出来（外部的失败和参数错误是两回事）；
 *   3. **不要**把外部内容当成本地库的权威 —— 本地课程库仍是课程事实的来源。
 */
export function mcpPromptBlock(names: readonly string[]): string {
  if (names.length === 0) return '';
  const servers = [...new Set(names.map((n) => n.split('__')[1] ?? '?'))].sort();
  return [
    '## External tools (MCP)',
    '',
    `You also have tools from external MCP servers: ${servers.join(', ')}. Their names look like`,
    '`mcp__<server>__<tool>`. They reach services outside this deployment (code hosting,',
    'literature indexes, and so on).',
    '',
    '- Use them when the material genuinely lives out there — open-source repositories, published',
    '  papers — and use the local library for what it holds. **The two are complementary.**',
    '- When one fails, **say that the external service failed**. Do not silently fall back to your',
    '  own recollection and present it as if it came from the source.',
    "- These tools cannot see the learner's local materials, and the local tools cannot see these",
    '  services. Fetch from both when a task needs both.',
  ].join('\n');
}
