/**
 * @file types.ts
 * @description 核心类型定义文件，定义了 Agent 运行所需的所有核心接口和类型
 * 包括聊天消息、工具定义、LLM 接口、流式回调等
 */

/** 聊天消息角色类型 */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 聊天消息，对应 OpenAI 消息格式 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant 消息可能携带的工具调用 */
  tool_calls?: ToolCall[];
  /** tool 角色消息需要携带对应的 tool_call_id */
  tool_call_id?: string;
  /** tool 角色消息的工具名 */
  name?: string;
}

/** 工具定义，转换为 JSON Schema 后传给 LLM */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>;
}

/** LLM 返回的工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  /** 工具参数，已从 JSON 字符串解析为对象 */
  arguments: Record<string, unknown>;
}

/** LLM 的完整响应 */
export interface LLMResponse {
  /** 文本内容，可能为 null（纯工具调用时） */
  content: string | null;
  /** 工具调用列表，可能为空数组 */
  tool_calls: ToolCall[];
}

/** 流式输出回调，每收到一个 token 片段就调用一次 */
export type StreamCallback = (delta: string) => void;

/** 工具调用开始回调，在工具执行前触发 */
export type ToolCallCallback = (toolCall: ToolCall) => void;

/** 工具调用结果回调，在工具执行完毕后触发 */
export type ToolResultCallback = (toolName: string, result: unknown) => void;

/** LLM 调用时的可选配置 */
export interface ChatOptions {
  /** 流式输出回调，传入后文本会逐 token 回调 */
  onToken?: StreamCallback;
}

/** Agent 运行时的回调选项，CLI 层用这些回调实现实时输出 */
export interface RunCallbacks {
  /** LLM 文本流式回调 */
  onToken?: StreamCallback;
  /** 工具调用开始回调 */
  onToolCall?: ToolCallCallback;
  /** 工具调用结果回调 */
  onToolResult?: ToolResultCallback;
}

/** LLM Provider 接口，所有 LLM 实现都需要满足此接口 */
export interface LLMProvider {
  /**
   * 调用大模型，传入消息历史和可用工具，返回模型响应
   * @param messages 消息历史（包含 system / user / assistant / tool）
   * @param tools 可用工具列表
   * @param options 可选配置（流式回调等）
   * @returns LLM 响应（文本内容 + 工具调用）
   */
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): Promise<LLMResponse>;
}
