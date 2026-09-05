/**
 * @file mcp.ts
 * @description 远程 MCP (Model Context Protocol) 接入
 *
 * 通过动态导入 @modelcontextprotocol/client 包，连接远程 MCP 服务
 * 将远程工具注册到本地 ToolRegistry，工具名加前缀避免冲突
 *
 * 用法：
 *   npm run cli -- chat --mcp tandem=https://tandem.ac/mcp
 */

import { ToolRegistry } from "./tools/registry.js";
import { Tool } from "./tools/registry.js";
import { z } from "zod";
import { scanMCPServer, formatScanResult, shouldBlockTool, SecurityScanOptions } from "./mcpSecurity.js";

// MCP 客户端类型（动态导入，避免未安装时报错）
// 使用 any 以兼容不同版本的 MCP SDK
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MCPClient = any;

/**
 * 连接一个远程 MCP 服务，将其工具注册到 ToolRegistry 中
 *
 * @param name 服务名称（用于工具前缀，格式：name__toolName）
 * @param url  MCP 服务 URL
 * @param registry 工具注册表
 * @param securityOptions 安全扫描配置（可选，默认阻止 critical/high 级别工具）
 * @returns 连接后的 MCP 客户端
 *
 * 注意：需要安装 @modelcontextprotocol/client 包
 */
export async function connectMCP(
  name: string,
  url: string,
  registry: ToolRegistry,
  securityOptions: SecurityScanOptions = {}
): Promise<MCPClient> {
  // 动态导入 MCP SDK（未安装时报错提示）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SSEClientTransport: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let StreamableHTTPClientTransport: any;

  try {
    const mcpModule = await import("@modelcontextprotocol/client");
    Client = mcpModule.Client;
    SSEClientTransport = mcpModule.SSEClientTransport;
    StreamableHTTPClientTransport = mcpModule.StreamableHTTPClientTransport;
  } catch {
    throw new Error(
      "未安装 @modelcontextprotocol/client 包，请运行: npm install @modelcontextprotocol/client"
    );
  }

  // 根据 URL 选择传输方式：含 /sse 用 SSE，否则用 StreamableHTTP
  let transport: unknown;
  if (url.includes("/sse")) {
    transport = new SSEClientTransport(new URL(url));
  } else {
    transport = new StreamableHTTPClientTransport(new URL(url));
  }

  // MCP SDK 2.x API：构造函数传 clientInfo，connect 传 transport
  const client = new Client({ name: "keen-code", version: "0.1.0" });

  // 连接并初始化 MCP 会话
  await client.connect(transport);

  // 获取远程工具列表
  const toolsResult = await client.listTools();

  console.log(`[MCP ${name}] 已连接，发现 ${toolsResult.tools.length} 个工具:`);
  for (const tool of toolsResult.tools) {
    console.log(`  - ${tool.name}`);
  }

  // 安全扫描：检查 MCP 服务器和工具的安全性（OWASP MCP Top 10）
  const scanResult = scanMCPServer(url, toolsResult.tools);
  console.log(formatScanResult(scanResult));

  // 将每个远程工具包装成本地 Tool 接口并注册
  // 跳过存在 critical/high 安全问题的工具（除非 warnOnly 模式）
  let blockedCount = 0;
  for (const mcpTool of toolsResult.tools) {
    const toolName = `${name}__${mcpTool.name}`; // 加前缀避免命名冲突

    if (shouldBlockTool(mcpTool.name, scanResult, securityOptions)) {
      console.log(`  ⛔ 已阻止注册危险工具: ${toolName}`);
      blockedCount++;
      continue;
    }

    const wrappedTool = createMCPToolWrapper(
      toolName,
      mcpTool.name,
      mcpTool.description || "",
      mcpTool.inputSchema as Record<string, unknown>,
      client
    );
    registry.register(wrappedTool);
  }

  if (blockedCount > 0) {
    console.log(`[MCP ${name}] 已注册 ${toolsResult.tools.length - blockedCount} 个工具，阻止 ${blockedCount} 个危险工具`);
  }

  return client;
}

/**
 * 将 MCP 远程工具包装成本地 Tool 接口
 * MCP 工具的参数是动态 JSON Schema，用通用 zod schema 接收任意对象
 * 执行时将参数原样传给 MCP 服务
 */
function createMCPToolWrapper(
  localName: string,
  remoteName: string,
  description: string,
  _inputSchema: Record<string, unknown>,
  client: MCPClient
): Tool {
  // 用 z.record(z.unknown()) 接收任意参数对象
  const schema = z.record(z.unknown());

  return {
    name: localName,
    description: `[MCP] ${description}`,
    schema,
    async execute(params: Record<string, unknown>) {
      try {
        const result = await client.callTool({
          name: remoteName,
          arguments: params,
        });

        // MCP 返回的 content 是数组，可能包含文本、图片等
        // 统一提取文本内容返回
        if (result.content && Array.isArray(result.content)) {
          const textParts = result.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { text?: string }) => c.text || "")
            .join("\n");
          return { content: textParts, isError: result.isError || false };
        }

        return result;
      } catch (e: unknown) {
        return { error: (e as Error).message };
      }
    },
  };
}

/**
 * 从 --mcp 命令行参数解析 MCP 服务配置
 * 参数格式：name=url，可传多个
 *
 * 示例：--mcp tandem=https://tandem.ac/mcp --mcp other=https://other.com/sse
 */
export function parseMCPArgs(mcpArgs: string[]): Record<string, string> {
  const servers: Record<string, string> = {};
  for (const arg of mcpArgs) {
    const eqIndex = arg.indexOf("=");
    if (eqIndex > 0) {
      const name = arg.slice(0, eqIndex);
      const url = arg.slice(eqIndex + 1);
      servers[name] = url;
    }
  }
  return servers;
}
