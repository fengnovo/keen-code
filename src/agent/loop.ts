/**
 * @file loop.ts
 * @description Agent 主循环，实现 ReAct（Reason + Act）模式
 * 核心流程：用户输入 → LLM 推理 → 工具执行 → 结果回传 → 循环直到完成
 */

import { LLMProvider, ChatMessage, ToolCall, RunCallbacks } from "./types.js";
import { ToolRegistry } from "./tools/registry.js";
import { Sandbox } from "./sandbox.js";
import { MemoryManager } from "./memory.js";
import { SkillManager } from "./skills.js";
import { ContextManager } from "./context.js";
import { SessionRecorder } from "./session.js";

/** 每轮最多调用 10 次工具，防止死循环 */
const MAX_TOOL_CALLS_PER_TURN = 10;

/** Agent 运行所需的依赖项 */
export interface AgentRunOptions {
  mock?: boolean;
  sandbox: Sandbox;
  llm: LLMProvider;
  memory: MemoryManager;
  skills: SkillManager;
  recorder: SessionRecorder;
}

/**
 * Agent 运行实例
 * 持有所有组件的引用，管理对话上下文，驱动 LLM ↔ 工具 的循环
 */
export class AgentRun {
  private llm: LLMProvider;
  private tools: ToolRegistry;
  private sandbox: Sandbox;
  private memory: MemoryManager;
  private skills: SkillManager;
  private recorder: SessionRecorder;
  private context: ContextManager;
  /** 对话轮次计数 */
  private turnCount: number = 0;

  constructor(options: AgentRunOptions, tools: ToolRegistry) {
    this.llm = options.llm;
    this.sandbox = options.sandbox;
    this.memory = options.memory;
    this.skills = options.skills;
    this.recorder = options.recorder;
    this.tools = tools;
    this.context = new ContextManager(this.llm);
  }

  /**
   * 执行单轮对话：接收用户输入，返回最终回答
   *
   * 流程：
   * 1. 构建 system prompt（注入记忆、技能摘要）
   * 2. 添加用户消息到上下文
   * 3. 检查并执行历史压缩
   * 4. 循环：LLM 推理 → 工具执行 → 结果回传 → 直到 LLM 不再调用工具或调用 finish
   *
   * @param userInput 用户输入文本
   * @param callbacks 可选回调（流式输出、工具调用通知）
   * @returns 最终回答文本
   */
  async run(userInput: string, callbacks?: RunCallbacks): Promise<string> {
    const onToken = callbacks?.onToken;
    const onToolCall = callbacks?.onToolCall;
    const onToolResult = callbacks?.onToolResult;
    this.turnCount++;
    await this.recorder.turnStart(this.turnCount);

    // 第一轮时构建并注入 system prompt
    const systemPrompt = await this.buildSystemPrompt();
    if (this.turnCount === 1) {
      this.context.addMessage({
        role: "system",
        content: systemPrompt,
      });
      await this.recorder.sessionStart(userInput);
    }

    // 添加用户消息到上下文
    this.context.addMessage({
      role: "user",
      content: userInput,
    });

    // 检查是否需要压缩历史（超过 20 轮时触发）
    await this.context.maybeCompress();

    // --- Agent 主循环 ---
    let toolCallsThisTurn = 0;

    while (toolCallsThisTurn < MAX_TOOL_CALLS_PER_TURN) {
      const messages = this.context.getMessages();
      const toolDefs = this.tools.toToolDefinitions();

      // 调用 LLM（带流式回调）
      await this.recorder.llmCall(
        this.turnCount,
        messages,
        toolDefs.map((t) => t.name)
      );
      const response = await this.llm.chat(messages, toolDefs, { onToken });
      await this.recorder.llmResponse(
        this.turnCount,
        response.content,
        response.tool_calls.length
      );

      // 情况 1：LLM 没有调用工具，直接返回文本回答
      if (response.tool_calls.length === 0) {
        const answer = response.content || "（无响应内容）";
        this.context.addMessage({
          role: "assistant",
          content: answer,
        });
        await this.recorder.turnEnd(this.turnCount, answer);
        return answer;
      }

      // 情况 2：LLM 调用了工具，先记录 assistant 消息（含 tool_calls）
      this.context.addMessage({
        role: "assistant",
        content: response.content ?? "",
        tool_calls: response.tool_calls,
      });

      // 逐个执行工具调用
      for (const toolCall of response.tool_calls) {
        toolCallsThisTurn++;
        if (onToolCall) onToolCall(toolCall); // 通知 CLI 层显示工具调用

        const result = await this.executeToolCall(toolCall);
        if (onToolResult) onToolResult(toolCall.name, result); // 通知 CLI 层显示结果

        // 把工具执行结果加回消息历史，供下一轮 LLM 推理使用
        this.context.addMessage({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify(result),
        });
      }

      // 情况 3：如果调用了 finish 工具，直接结束本轮
      const finishCall = response.tool_calls.find((tc: ToolCall) => tc.name === "finish");
      if (finishCall) {
        const finishAnswer = (finishCall.arguments as { answer?: string }).answer;
        // 优先用 finish 的 answer 参数；如果没有，用 LLM 返回的 content
        const answer = String(
          finishAnswer || response.content || "（任务完成）"
        );
        await this.recorder.sessionEnd(answer);
        await this.recorder.turnEnd(this.turnCount, answer);
        return answer;
      }

      // 情况 4：工具调用完毕但没调 finish，继续循环让 LLM 决定下一步
    }

    // 达到工具调用上限，返回最后一条 assistant 消息
    const msgs = this.context.getMessages();
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    const answer = lastAssistant?.content || "（达到工具调用上限，已停止）";
    await this.recorder.turnEnd(this.turnCount, answer);
    return answer;
  }

  /**
   * 执行单个工具调用
   * 先记录会话事件，再执行工具，最后记录结果事件
   */
  private async executeToolCall(toolCall: ToolCall): Promise<unknown> {
    await this.recorder.toolCall(this.turnCount, toolCall.name, toolCall.arguments);

    let result: unknown;
    try {
      result = await this.tools.execute(toolCall.name, toolCall.arguments);
    } catch (e: unknown) {
      result = { error: (e as Error).message };
    }

    await this.recorder.toolResult(this.turnCount, toolCall.name, result);
    return result;
  }

  /**
   * 构建 system prompt
   * 注入基础指令、工作目录、记忆摘要、技能摘要等上下文信息
   */
  private async buildSystemPrompt(): Promise<string> {
    const parts: string[] = [];

    // 基础指令
    parts.push(
      `你是一个有用的 AI 助手。你可以调用工具来完成任务。

重要规则：
1. 对于简单的问题（如自我介绍、知识问答、闲聊），直接回复文本即可，不需要调用任何工具。
2. 只有当任务需要执行命令、读写文件、检索记忆等操作时，才调用相应的工具。
3. 当你完成了需要工具的任务后，调用 finish 工具提交最终回答，并在 answer 参数中写明你的回答。
4. 在沙箱中执行命令时，请谨慎操作，不要执行危险命令。`
    );

    // 注入当前工作目录
    parts.push(`\n当前工作目录: ${this.sandbox.getWorkDir()}`);

    // 注入记忆摘要（短期 + 长期）
    const memorySummary = await this.memory.getMemorySummary();
    if (memorySummary) {
      parts.push(`\n${memorySummary}`);
    }

    // 注入技能摘要
    const skillsSummary = this.skills.getSkillsSummary();
    if (skillsSummary) {
      parts.push(`\n${skillsSummary}`);
    }

    return parts.join("\n");
  }

  /** 获取上下文管理器（chat 模式下 /compress 命令用） */
  getContextManager(): ContextManager {
    return this.context;
  }

  /** 获取会话记录器 */
  getRecorder(): SessionRecorder {
    return this.recorder;
  }

  /** 获取工具注册表 */
  getTools(): ToolRegistry {
    return this.tools;
  }

  /** 获取记忆管理器 */
  getMemory(): MemoryManager {
    return this.memory;
  }

  /** 获取技能管理器 */
  getSkills(): SkillManager {
    return this.skills;
  }
}
