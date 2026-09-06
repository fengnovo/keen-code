/**
 * @file mcpConfig.ts
 * @description 加载 Claude Code 风格的 .mcp.json 配置
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 远程 HTTP/SSE MCP 服务配置 */
export interface MCPRemoteServerConfig {
  url: string;
  /** 不传时根据 URL 自动判断；/sse 使用 SSE，其余使用 Streamable HTTP */
  transport?: 'http' | 'sse';
  headers?: Record<string, string>;
}

/** 本地 stdio MCP 服务配置 */
export interface MCPStdioServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 默认 pipe：静默捕获并仅在连接失败时显示 */
  stderr?: 'pipe' | 'inherit' | 'ignore';
}

/** 从 JSON 文件解析出的 MCP 配置 */
export interface LoadedMCPConfig {
  mcpServers: Record<string, MCPRemoteServerConfig>;
  mcpCommands: Record<string, MCPStdioServerConfig>;
  /** JSON 中通过 disabled: true 禁用的 MCP 名称 */
  disabledMCPNames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 展开 ${ENV_VAR} / ${ENV_VAR:-default}，避免在 JSON 中直接写密钥 */
function expandEnvVariables(value: string, location: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name: string, defaultValue: string | undefined) => {
      const envValue = process.env[name];
      if (envValue !== undefined && envValue !== '') return envValue;
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`${location} 引用了未设置的环境变量 ${name}`);
    },
  );
}

function parseStringMap(
  value: unknown,
  location: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${location} 必须是字符串键值对象`);
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new Error(`${location}.${key} 必须是字符串`);
    }
    result[key] = expandEnvVariables(item, `${location}.${key}`);
  }
  return result;
}

function parseStringArray(value: unknown, location: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${location} 必须是字符串数组`);
  }
  return value.map((item, index) =>
    expandEnvVariables(item, `${location}[${index}]`),
  );
}

/**
 * 加载 MCP JSON 配置。
 *
 * 默认读取当前工作目录的 .mcp.json；默认文件不存在时返回空配置。
 * 显式传入文件路径后，如果文件不存在或内容不合法则抛出错误。
 */
export async function loadMCPConfig(
  configPath?: string,
): Promise<LoadedMCPConfig> {
  const isExplicitPath = configPath !== undefined;
  const resolvedPath = path.resolve(configPath || '.mcp.json');

  let content: string;
  try {
    content = await fs.readFile(resolvedPath, 'utf-8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !isExplicitPath) {
      return { mcpServers: {}, mcpCommands: {}, disabledMCPNames: [] };
    }
    throw new Error(
      `无法读取 MCP 配置 ${resolvedPath}: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(
      `MCP 配置 ${resolvedPath} 不是有效 JSON: ${(error as Error).message}`,
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error(`MCP 配置 ${resolvedPath} 必须包含 mcpServers 对象`);
  }

  const result: LoadedMCPConfig = {
    mcpServers: {},
    mcpCommands: {},
    disabledMCPNames: [],
  };
  const configDir = path.dirname(resolvedPath);

  for (const [name, rawEntry] of Object.entries(parsed.mcpServers)) {
    const location = `mcpServers.${name}`;
    if (!name.trim()) {
      throw new Error('mcpServers 中的服务名称不能为空');
    }
    if (!isRecord(rawEntry)) {
      throw new Error(`${location} 必须是对象`);
    }
    if (
      rawEntry.disabled !== undefined &&
      typeof rawEntry.disabled !== 'boolean'
    ) {
      throw new Error(`${location}.disabled 必须是布尔值`);
    }
    if (rawEntry.disabled === true) {
      result.disabledMCPNames.push(name);
      continue;
    }

    const type = rawEntry.type;
    if (type !== undefined && typeof type !== 'string') {
      throw new Error(`${location}.type 必须是字符串`);
    }

    if (rawEntry.url !== undefined && typeof rawEntry.url !== 'string') {
      throw new Error(`${location}.url 必须是字符串`);
    }
    if (
      rawEntry.command !== undefined &&
      typeof rawEntry.command !== 'string'
    ) {
      throw new Error(`${location}.command 必须是字符串`);
    }
    if (
      typeof rawEntry.url === 'string' &&
      typeof rawEntry.command === 'string'
    ) {
      throw new Error(`${location} 不能同时配置 url 和 command`);
    }

    if (typeof rawEntry.url === 'string') {
      if (!rawEntry.url.trim()) {
        throw new Error(`${location}.url 不能为空`);
      }
      if (
        type !== undefined &&
        type !== 'http' &&
        type !== 'sse' &&
        type !== 'streamable-http'
      ) {
        throw new Error(`${location}.type 仅支持 http、streamable-http 或 sse`);
      }

      result.mcpServers[name] = {
        url: expandEnvVariables(rawEntry.url, `${location}.url`),
        transport:
          type === 'sse' ? 'sse' : type === undefined ? undefined : 'http',
        headers: parseStringMap(rawEntry.headers, `${location}.headers`),
      };
      continue;
    }

    if (typeof rawEntry.command === 'string') {
      if (!rawEntry.command.trim()) {
        throw new Error(`${location}.command 不能为空`);
      }
      if (type !== undefined && type !== 'stdio') {
        throw new Error(`${location}.type 必须是 stdio`);
      }

      const rawCwd = rawEntry.cwd;
      if (rawCwd !== undefined && typeof rawCwd !== 'string') {
        throw new Error(`${location}.cwd 必须是字符串`);
      }
      if (typeof rawCwd === 'string' && !rawCwd.trim()) {
        throw new Error(`${location}.cwd 不能为空`);
      }
      const expandedCwd = rawCwd
        ? expandEnvVariables(rawCwd, `${location}.cwd`)
        : undefined;
      const stderr = rawEntry.stderr;
      if (
        stderr !== undefined &&
        stderr !== 'pipe' &&
        stderr !== 'inherit' &&
        stderr !== 'ignore'
      ) {
        throw new Error(`${location}.stderr 仅支持 pipe、inherit 或 ignore`);
      }

      result.mcpCommands[name] = {
        command: expandEnvVariables(rawEntry.command, `${location}.command`),
        args: parseStringArray(rawEntry.args, `${location}.args`),
        env: parseStringMap(rawEntry.env, `${location}.env`),
        cwd: expandedCwd
          ? path.resolve(configDir, expandedCwd)
          : undefined,
        stderr,
      };
      continue;
    }

    throw new Error(`${location} 必须配置 url 或 command`);
  }

  return result;
}
