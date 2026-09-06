/**
 * @file session.ts
 * @description 会话记录器
 *
 * 将 Agent 执行的全过程记录到 JSONL 文件（每行一个 JSON 事件）
 * 包括：会话开始、对话轮次、LLM 调用/响应、工具调用/结果
 *
 * 文件位置：_sessions/<sessionId>/<runId>.jsonl
 * 每个 session 一个目录，每个 AgentRun 实例使用一个 run 文件
 *
 * 注："trace" 这个词预留给评测（eval）记录使用
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectPath } from '../../paths.js';
import { ChatMessage } from '../types.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** sessionId 会进入文件路径，必须禁止斜杠、点号和其他特殊字符。 */
export function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('sessionId 只能包含字母、数字、下划线和连字符');
  }
}

/** 会话事件类型 */
export type SessionEventType =
  | 'turn_start' // 一轮对话开始
  | 'llm_call' // LLM 调用
  | 'llm_response' // LLM 响应
  | 'tool_call' // 工具调用
  | 'tool_result' // 工具结果
  | 'turn_end' // 一轮对话结束
  | 'session_start' // 会话开始
  | 'session_end'; // 仅用于兼容旧版记录

/** 会话事件结构 */
export interface SessionEvent {
  /** ISO 格式时间戳 */
  timestamp: string;
  /** 事件类型 */
  type: SessionEventType;
  /** 对话轮次 ID（session_start/end 用 0） */
  turnId: number;
  /** 事件数据（不同类型有不同字段） */
  data: Record<string, unknown>;
}

/** 从 JSONL 会话记录中恢复可供 LLM 使用的基础对话历史 */
export async function loadSessionMessages(
  sessionId: string,
): Promise<ChatMessage[]> {
  assertValidSessionId(sessionId);
  const sessionDir = projectPath('_sessions', sessionId);

  let fileNames: string[];
  try {
    fileNames = (await fs.readdir(sessionDir)).filter((name) =>
      name.endsWith('.jsonl'),
    );
  } catch {
    return [];
  }

  const completedTurns: {
    timestamp: string;
    userInput: string;
    output: string;
  }[] = [];
  for (const fileName of fileNames) {
    const content = await fs.readFile(path.join(sessionDir, fileName), 'utf-8');
    const pendingTurns = new Map<
      number,
      { timestamp: string; userInput: string }
    >();
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line) as SessionEvent;
        if (
          event.type === 'turn_start' &&
          typeof event.data.userInput === 'string'
        ) {
          pendingTurns.set(event.turnId, {
            timestamp: event.timestamp,
            userInput: event.data.userInput,
          });
        } else if (
          event.type === 'turn_end' &&
          typeof event.data.output === 'string'
        ) {
          const start = pendingTurns.get(event.turnId);
          if (start) {
            completedTurns.push({
              timestamp: start.timestamp,
              userInput: start.userInput,
              output: event.data.output,
            });
            pendingTurns.delete(event.turnId);
          }
        }
      } catch {
        // 忽略不完整的 JSONL 行，避免单条损坏记录阻止恢复整个会话
      }
    }
  }

  completedTurns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const messages: ChatMessage[] = [];
  for (const turn of completedTurns) {
    messages.push({ role: 'user', content: turn.userInput });
    messages.push({ role: 'assistant', content: turn.output });
  }
  return messages;
}

/**
 * SessionRecorder - 会话记录器
 * 负责将执行事件写入 JSONL 文件
 */
export class SessionRecorder {
  private sessionId: string;
  private runId: string;
  private sessionDir: string;
  private filePath: string;

  constructor(sessionId?: string, runId?: string) {
    this.sessionId = sessionId || this.generateId('sess');
    this.runId = runId || this.generateId('run');
    assertValidSessionId(this.sessionId);

    this.sessionDir = projectPath('_sessions', this.sessionId);
    this.filePath = path.join(this.sessionDir, `${this.runId}.jsonl`);
  }

  /** 生成带时间戳和随机后缀的 ID */
  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 确保会话目录存在 */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }

  /** 写入一条会话事件到 JSONL 文件 */
  private async writeEvent(event: SessionEvent): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(this.filePath, line, 'utf-8');
  }

  // ---------- 公共记录方法 ----------

  /** 记录会话开始 */
  async sessionStart(userInput: string): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: 'session_start',
      turnId: 0,
      data: { userInput, sessionId: this.sessionId, runId: this.runId },
    });
  }

  /** 记录一轮对话开始 */
  async turnStart(turnId: number, userInput?: string): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: 'turn_start',
      turnId,
      data: userInput === undefined ? {} : { userInput },
    });
  }

  /** 记录 LLM 调用（消息数、工具列表） */
  async llmCall(
    turnId: number,
    messages: unknown[],
    tools: string[],
  ): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: 'llm_call',
      turnId,
      data: { messageCount: messages.length, tools },
    });
  }

  /** 记录 LLM 响应（完整内容、内容长度、工具调用数） */
  async llmResponse(
    turnId: number,
    content: string | null,
    toolCallCount: number,
  ): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: 'llm_response',
      turnId,
      data: {
        // 保存完整文本（不截断），保证 Web/恢复会话能看到完整的历史
        content: content ?? null,
        contentLength: content?.length ?? 0,
        toolCallCount,
      },
    });
  }

  /** 记录工具调用（工具名、参数） */
  async toolCall(
    turnId: number,
    toolName: string,
    args: unknown,
  ): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: 'tool_call',
      turnId,
      data: { toolName, args },
    });
  }

  /** 记录工具结果（结果前 1000 字符、结果长度） */
  async toolResult(
    turnId: number,
    toolName: string,
    result: unknown,
  ): Promise<void> {
    const resultStr = JSON.stringify(result);
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: 'tool_result',
      turnId,
      data: {
        toolName,
        result: resultStr.slice(0, 1000),
        resultLength: resultStr.length,
      },
    });
  }

  /** 记录一轮对话结束（完整输出和输出长度） */
  async turnEnd(turnId: number, output: string): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: 'turn_end',
      turnId,
      // 保存完整输出（不截断），Web 端历史记录依赖此字段还原完整回答
      data: { output, outputLength: output.length },
    });
  }

  /** 获取会话 ID */
  getSessionId(): string {
    return this.sessionId;
  }

  /** 获取记录文件路径 */
  getFilePath(): string {
    return this.filePath;
  }
}
