/**
 * @file agent.ts
 * @description Agent 工厂函数
 *
 * createAgent() 是核心组装函数，负责：
 * 1. 生成会话 ID
 * 2. 创建 LLM 实例（Mock 或 DeepSeek）
 * 3. 创建沙箱（按会话 ID 隔离工作目录）
 * 4. 创建记忆管理器
 * 5. 加载技能
 * 6. 创建 SessionRecorder
 * 7. 注册所有内置工具
 * 8. 接入远程 MCP 服务
 * 9. 组装成 AgentRun 实例
 */

import 'dotenv/config';
import { createLLM } from './llm.js';
import { LocalSandbox, Sandbox } from './sandbox/sandbox.js';
import { DockerSandbox } from './sandbox/dockerSandbox.js';
import { MemoryManager } from './memory.js';
import { SkillManager } from './skills/skills.js';
import { SessionRecorder } from './sessions/session.js';
import { loadSessionMessages } from './sessions/session.js';
import { ToolRegistry } from './tools/registry.js';
import {
  createRunShellTool,
  createReadFileTool,
  createWriteFileTool,
  createFinishTool,
} from './tools/builtin.js';
import {
  createRememberShortTool,
  createRememberLongTool,
  createRecallTool,
} from './memory.js';
import { createUseSkillTool } from './skills/skills.js';
import { connectMCP, connectMCPStdio } from './mcp/mcp.js';
import {
  MCPRemoteServerConfig,
  MCPStdioServerConfig,
} from './mcp/mcpConfig.js';
import { AgentRun } from './loop.js';

/** 创建 Agent 的配置选项 */
export interface CreateAgentOptions {
  /** 使用 Mock LLM（不调用真实 API） */
  mock?: boolean;
  /** 沙箱类型：local（默认）或 docker */
  sandboxType?: 'local' | 'docker';
  /** 远程 HTTP/SSE MCP 服务配置 */
  mcpServers?: Record<string, MCPRemoteServerConfig>;
  /** 本地 stdio MCP 服务配置 */
  mcpCommands?: Record<string, MCPStdioServerConfig>;
  /** JSON 中已禁用、无需连接的 MCP 名称 */
  disabledMCPNames?: string[];
  /** 自定义会话 ID（不传则自动生成） */
  sessionId?: string;
  /** 是否恢复指定会话的对话历史 */
  resumeSession?: boolean;
}

/** MCP 在当前 Agent 中的实际状态 */
export interface MCPStatus {
  name: string;
  state: 'active' | 'failed' | 'disabled';
  error?: string;
}

/** createAgent 的返回结果 */
export interface CreateAgentResult {
  /** Agent 运行实例 */
  agent: AgentRun;
  /** MCP 客户端列表（用于后续清理） */
  mcpClients: unknown[];
  /** 沙箱实例 */
  sandbox: Sandbox;
  /** 会话 ID */
  sessionId: string;
  /** 已成功连接的 MCP 名称 */
  mcpNames: string[];
  /** 全部 MCP 的生效状态 */
  mcpStatuses: MCPStatus[];
  /** Agent 自带的工具名称（不包含 MCP 工具） */
  systemToolNames: string[];
}

/**
 * 创建一个完整的 Agent 实例
 * 按顺序组装所有组件，注册工具，返回可直接运行的 AgentRun
 *
 * @param options 配置选项
 * @returns Agent 实例和关联资源
 */
export async function createAgent(
  options: CreateAgentOptions = {},
): Promise<CreateAgentResult> {
  const mock = options.mock ?? false;
  const mcpClients: unknown[] = [];
  const mcpNames: string[] = [];
  const mcpStatuses: MCPStatus[] = (options.disabledMCPNames || []).map(
    (name) => ({ name, state: 'disabled' }),
  );
  // 生成会话 ID（如果未传入）
  const sessionId =
    options.sessionId ||
    `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 1. 创建 LLM 实例
  const llm = createLLM(mock);

  // 2. 创建沙箱（按会话隔离工作目录：workspace/<sessionId>/）
  let sandbox: Sandbox;
  if (options.sandboxType === 'docker') {
    sandbox = new DockerSandbox(undefined, undefined, sessionId);
  } else {
    sandbox = new LocalSandbox(undefined, sessionId);
  }

  // 3. 创建记忆管理器
  const memory = new MemoryManager();

  // 4. 创建技能管理器并加载所有技能
  const skills = new SkillManager();
  await skills.loadAll();

  // 5. 创建 SessionRecorder（传入 sessionId 保持一致）
  const recorder = new SessionRecorder(sessionId);

  // 6. 注册所有内置工具
  const toolRegistry = new ToolRegistry();

  // 沙箱工具：执行命令、读写文件
  toolRegistry.register(createRunShellTool(sandbox));
  toolRegistry.register(createReadFileTool(sandbox));
  toolRegistry.register(createWriteFileTool(sandbox));

  // 记忆工具：短期记忆、长期记忆、检索
  toolRegistry.register(createRememberShortTool(memory));
  toolRegistry.register(createRememberLongTool(memory));
  toolRegistry.register(createRecallTool(memory));

  // 技能工具：读取技能说明
  toolRegistry.register(createUseSkillTool(skills));

  // finish 工具：提交最终回答
  toolRegistry.register(createFinishTool());

  // MCP 工具注册前保存内置工具列表，供 CLI 展示运行时配置
  const systemToolNames = toolRegistry.listNames();

  // 7. 接入远程 MCP 服务（如果配置了）
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    for (const [name, config] of Object.entries(options.mcpServers)) {
      try {
        const client = await connectMCP(name, config, toolRegistry);
        mcpClients.push(client);
        mcpNames.push(name);
        mcpStatuses.push({ name, state: 'active' });
      } catch (e: unknown) {
        const error = (e as Error).message;
        mcpStatuses.push({ name, state: 'failed', error });
        console.error(`[MCP ${name}] 连接失败: ${error}`);
      }
    }
  }

  if (options.mcpCommands && Object.keys(options.mcpCommands).length > 0) {
    for (const [name, config] of Object.entries(options.mcpCommands)) {
      try {
        const client = await connectMCPStdio(name, config, toolRegistry);
        mcpClients.push(client);
        mcpNames.push(name);
        mcpStatuses.push({ name, state: 'active' });
      } catch (e: unknown) {
        const error = (e as Error).message;
        mcpStatuses.push({ name, state: 'failed', error });
        console.error(`[MCP ${name}] 连接失败: ${error}`);
      }
    }
  }

  // 8. 创建 Agent 运行实例，注入所有依赖
  const agent = new AgentRun(
    {
      mock,
      sandbox,
      llm,
      memory,
      skills,
      recorder,
    },
    toolRegistry,
  );

  if (options.resumeSession) {
    const messages = await loadSessionMessages(sessionId);
    await agent.restoreSession(messages);
  }

  return {
    agent,
    mcpClients,
    sandbox,
    sessionId,
    mcpNames,
    mcpStatuses,
    systemToolNames,
  };
}
