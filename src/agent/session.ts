/**
 * @file session.ts
 * @description 会话记录器
 *
 * 将 Agent 执行的全过程记录到 JSONL 文件（每行一个 JSON 事件）
 * 包括：会话开始/结束、对话轮次、LLM 调用/响应、工具调用/结果
 *
 * 文件位置：sessions/<sessionId>/<runId>.jsonl
 * 每个 session 一个目录，每次 agent.run() 生成一个 run 文件
 *
 * 注："trace" 这个词预留给评测（eval）记录使用
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 会话事件类型 */
export type SessionEventType =
  | "turn_start"       // 一轮对话开始
  | "llm_call"         // LLM 调用
  | "llm_response"     // LLM 响应
  | "tool_call"        // 工具调用
  | "tool_result"      // 工具结果
  | "turn_end"         // 一轮对话结束
  | "session_start"    // 会话开始
  | "session_end";     // 会话结束

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

/**
 * SessionRecorder - 会话记录器
 * 负责将执行事件写入 JSONL 文件
 */
export class SessionRecorder {
  private sessionId: string;
  private runId: string;
  private sessionDir: string;
  private filePath: string;
  /** 当前轮次 */
  private currentTurn: number = 0;

  constructor(sessionId?: string, runId?: string) {
    this.sessionId = sessionId || this.generateId("sess");
    this.runId = runId || this.generateId("run");

    // 定位 sessions 目录
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "../..");
    this.sessionDir = path.join(projectRoot, "sessions", this.sessionId);
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
    const line = JSON.stringify(event) + "\n";
    await fs.appendFile(this.filePath, line, "utf-8");
  }

  // ---------- 公共记录方法 ----------

  /** 记录会话开始 */
  async sessionStart(userInput: string): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: "session_start",
      turnId: 0,
      data: { userInput, sessionId: this.sessionId, runId: this.runId },
    });
  }

  /** 记录会话结束 */
  async sessionEnd(finalAnswer: string): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: "session_end",
      turnId: this.currentTurn,
      data: { finalAnswer },
    });
  }

  /** 记录一轮对话开始 */
  async turnStart(turnId: number): Promise<void> {
    this.currentTurn = turnId;
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: "turn_start",
      turnId,
      data: {},
    });
  }

  /** 记录 LLM 调用（消息数、工具列表） */
  async llmCall(
    turnId: number,
    messages: unknown[],
    tools: string[]
  ): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: "llm_call",
      turnId,
      data: { messageCount: messages.length, tools },
    });
  }

  /** 记录 LLM 响应（内容前 500 字、内容长度、工具调用数） */
  async llmResponse(
    turnId: number,
    content: string | null,
    toolCallCount: number
  ): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: "llm_response",
      turnId,
      data: {
        content: content?.slice(0, 500) ?? null,
        contentLength: content?.length ?? 0,
        toolCallCount,
      },
    });
  }

  /** 记录工具调用（工具名、参数） */
  async toolCall(turnId: number, toolName: string, args: unknown): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: "tool_call",
      turnId,
      data: { toolName, args },
    });
  }

  /** 记录工具结果（结果前 1000 字符、结果长度） */
  async toolResult(turnId: number, toolName: string, result: unknown): Promise<void> {
    const resultStr = JSON.stringify(result);
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: "tool_result",
      turnId,
      data: {
        toolName,
        result: resultStr.slice(0, 1000),
        resultLength: resultStr.length,
      },
    });
  }

  /** 记录一轮对话结束（输出前 500 字、输出长度） */
  async turnEnd(turnId: number, output: string): Promise<void> {
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      type: "turn_end",
      turnId,
      data: { output: output.slice(0, 500), outputLength: output.length },
    });
  }

  /** 获取会话 ID */
  getSessionId(): string {
    return this.sessionId;
  }

  /** 获取运行 ID（每次 agent.run 一个） */
  getRunId(): string {
    return this.runId;
  }

  /** 获取记录文件路径 */
  getFilePath(): string {
    return this.filePath;
  }
}
