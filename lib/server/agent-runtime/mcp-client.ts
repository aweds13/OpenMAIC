/**
 * MCP 客户端 —— 把外部 MCP 服务器接进 agent 的工具集。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────
 *
 * agent-runtime 原本**没有任何 MCP 集成**（全目录搜 `modelcontextprotocol`
 * 零命中）。它只有内置工具，拿不到别的服务。
 *
 * 而本机上已经装好了一批 MCP 服务器（arxiv / deepxiv / literature / github /
 * metaso / dblp），它们**本来就是为这个项目准备的**（用户原话）。缺的只是
 * 一个客户端。
 *
 * `@modelcontextprotocol/sdk` 已经是本仓库的直接依赖，所以这一层不引入新依赖。
 *
 * ── 为什么是通用的，而不是写死 GitHub ────────────────────────────
 *
 * 用户当前只要 GitHub（「论文的话之后再弄，因为我还是个初学者」）。但服务器
 * 列表写在配置里、代码不认具体是哪一家 —— 以后想开 arxiv，加一行配置即可，
 * 不用改代码。写死 GitHub 只省几十行，却让下一次加服务器重来一遍。
 *
 * ── 配置格式（env `OPENMAIC_MCP_SERVERS`，JSON）────────────────────
 *
 *   {
 *     "github": {
 *       "command": "C:\\Program Files\\nodejs\\node.exe",
 *       "args": ["D:\\...\\github-mcp\\server.mjs"],
 *       "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_PERSONAL_ACCESS_TOKEN" },
 *       "toolCallTimeoutMs": 120000
 *     }
 *   }
 *
 * `env` 的值写成 `$NAME` 表示**从进程环境变量取值** —— 这样密钥只存在
 * `.env.local`，配置文件里看不到明文（用户明确要求）。
 *
 * ── 连接是长连接，所以要有池 ──────────────────────────────────────
 *
 * MCP 服务器是**常驻子进程**：起一次、用很多次。每个会话都重起一遍会
 * 慢得离谱，还会漏进程。所以这里按服务器名缓存连接，首次用到才启动。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createLogger } from '@/lib/logger';

const log = createLogger('McpClient');

/** 一次工具调用的默认超时。 */
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export interface McpServerConfig {
  command: string;
  args?: string[];
  /** 值形如 `$NAME` 时从 process.env 取；否则当字面量。 */
  env?: Record<string, string>;
  toolCallTimeoutMs?: number;
}

/** 一个已连接的服务器：客户端 + 它声明的工具。 */
interface McpConnection {
  config: McpServerConfig;
  client: Client;
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

/** 按服务器名缓存的连接。模块级 —— 一个 Next 进程共用。 */
const connections = new Map<string, Promise<McpConnection>>();

/**
 * 读服务器配置。
 *
 * 解析失败一律当作"没配"：一段坏 JSON 不该让所有会话报错，只该让 MCP 像
 * 没开一样消失 —— 跟 course_search / 材料库同一个原则。
 */
export function resolveMcpServers(): Record<string, McpServerConfig> {
  const raw = process.env.OPENMAIC_MCP_SERVERS?.trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const cfg = value as Partial<McpServerConfig> | null;
      if (!cfg || typeof cfg.command !== 'string' || !cfg.command) continue;
      out[name] = {
        command: cfg.command,
        ...(Array.isArray(cfg.args) ? { args: cfg.args.map(String) } : {}),
        ...(cfg.env && typeof cfg.env === 'object'
          ? { env: cfg.env as Record<string, string> }
          : {}),
        ...(typeof cfg.toolCallTimeoutMs === 'number'
          ? { toolCallTimeoutMs: cfg.toolCallTimeoutMs }
          : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** `$NAME` → process.env 的值；缺了就报错，不要静默给空串。 */
function expandEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v.startsWith('$')) {
      const name = v.slice(1);
      const real = process.env[name];
      if (!real) {
        throw new Error(
          `MCP env ${k} references $${name}, but that variable is not set. Refusing to start the server with an empty credential.`,
        );
      }
      out[k] = real;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 拿到某个服务器的连接（没有就起一个）。
 *
 * ★ 失败的 Promise **不会**留在缓存里：一次启动失败（比如网络抖动）不该
 *   把那个服务器永久钉死 —— 下次调用要能重试。
 */
async function connect(name: string, config: McpServerConfig): Promise<McpConnection> {
  const existing = connections.get(name);
  if (existing) {
    try {
      return await existing;
    } catch {
      connections.delete(name);
    }
  }

  const promise = (async (): Promise<McpConnection> => {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...expandEnv(config.env) },
      // MCP 服务器的日志走 stderr；stdout 是协议通道，别去读它。
      stderr: 'pipe',
    });

    const client = new Client({ name: 'openmaic', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const listed = await client.listTools();
    const tools = (listed.tools ?? []).map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    }));

    log.info(`MCP server "${name}" connected with ${tools.length} tools`);
    return { config, client, tools };
  })();

  connections.set(name, promise);
  return promise;
}

/** MCP 工具的全名。沿用 DSH 的 `mcp__server__tool` 形式，用户眼熟。 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export interface ResolvedMcpTools {
  /** 可以直接注册进 agent 工具集的条目。 */
  tools: Array<{
    /** 注册用的全名。 */
    name: string;
    server: string;
    tool: string;
    description: string;
    inputSchema: unknown;
  }>;
  /** 连上了但一个工具都没有、或连不上的服务器，供调用方记录。 */
  failed: Array<{ server: string; error: string }>;
}

/**
 * 把所有配置好的服务器的工具**汇总**出来。
 *
 * 连不上的服务器只记进 `failed`，不影响别的 —— 一个挂掉的 MCP 不该让整场
 * 会话起不来。
 */
export async function listMcpTools(): Promise<ResolvedMcpTools> {
  const servers = resolveMcpServers();
  const tools: ResolvedMcpTools['tools'] = [];
  const failed: ResolvedMcpTools['failed'] = [];

  const names = Object.keys(servers);
  if (names.length === 0) return { tools, failed };

  await Promise.all(
    names.map(async (name) => {
      try {
        const conn = await connect(name, servers[name]);
        for (const t of conn.tools) {
          tools.push({
            name: mcpToolName(name, t.name),
            server: name,
            tool: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ server: name, error: message });
        log.warn(`MCP server "${name}" unavailable: ${message}`);
      }
    }),
  );

  return { tools, failed };
}

/** 调一次 MCP 工具，返回给模型的文本。 */
export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
  const servers = resolveMcpServers();
  const config = servers[server];
  if (!config) return { text: `MCP server "${server}" is not configured.`, isError: true };

  const conn = await connect(server, config);
  const timeout = config.toolCallTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  const result = (await conn.client.callTool({ name: tool, arguments: args }, undefined, {
    timeout,
    ...(signal ? { signal } : {}),
  })) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };

  const text = (result.content ?? [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');

  return {
    text: text || '(the tool returned no text)',
    isError: result.isError === true,
  };
}

/** 关掉全部连接。进程退出时调用，免得留一堆孤儿子进程。 */
export async function closeMcpConnections(): Promise<void> {
  const all = [...connections.values()];
  connections.clear();
  await Promise.all(
    all.map(async (p) => {
      try {
        const conn = await p;
        await conn.client.close();
      } catch {
        // 已经断了就算了。
      }
    }),
  );
}
