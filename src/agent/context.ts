/**
 * @file context.ts
 * @description 上下文管理器
 *
 * 管理对话消息历史，当历史过长时自动压缩：
 * - 保留最近 N 轮原始消息
 * - 将旧消息交给 LLM 生成压缩摘要
 * - 摘要作为 system 消息注入到上下文中
 *
 * 这样可以在保持关键信息的同时，控制传给 LLM 的消息数量
 */

import { ChatMessage, LLMProvider } from "./types.js";

/** 超过 20 轮对话触发压缩 */
const MAX_TURNS_BEFORE_COMPRESS = 20;
/** 压缩时保留最近 6 轮不压缩 */
const KEEP_RECENT_TURNS = 6;

/**
 * 上下文管理器
 * 维护消息历史，提供自动压缩能力
 */
export class ContextManager {
  /** 消息历史 */
  private messages: ChatMessage[] = [];
  /** LLM 实例，用于生成压缩摘要 */
  private llm: LLMProvider;
  /** 压缩后的历史摘要 */
  private compressedSummary: string = "";

  constructor(llm: LLMProvider, systemPrompt?: string) {
    this.llm = llm;
    if (systemPrompt) {
      this.messages.push({ role: "system", content: systemPrompt });
    }
  }

  /** 添加一条消息到历史 */
  addMessage(message: ChatMessage): void {
    this.messages.push(message);
  }

  /**
   * 获取所有消息（如果有压缩摘要，插入到 system prompt 之后）
   * 这样 LLM 既能看到压缩摘要，又能看到最近的完整对话
   */
  getMessages(): ChatMessage[] {
    if (!this.compressedSummary) {
      return this.messages;
    }

    // 把压缩摘要插入到第一条 system 消息之后
    const result: ChatMessage[] = [];
    let inserted = false;
    for (const msg of this.messages) {
      result.push(msg);
      if (msg.role === "system" && !inserted) {
        result.push({
          role: "system",
          content: `【对话历史摘要】\n${this.compressedSummary}`,
        });
        inserted = true;
      }
    }
    return result;
  }

  /** 计算当前有多少轮用户-助手对话（按 user 消息数计算） */
  private countTurns(): number {
    return this.messages.filter((m) => m.role === "user").length;
  }

  /**
   * 检查是否需要压缩，如果需要则执行压缩
   * @returns 是否执行了压缩
   */
  async maybeCompress(): Promise<boolean> {
    if (this.countTurns() <= MAX_TURNS_BEFORE_COMPRESS) {
      return false;
    }
    await this.compress();
    return true;
  }

  /**
   * 执行压缩：
   * 1. 分离 system 消息和对话消息
   * 2. 保留最近 KEEP_RECENT_TURNS 轮对话消息
   * 3. 将旧消息交给 LLM 生成压缩摘要
   * 4. 替换消息历史为：system + 摘要 + 最近几轮
   */
  private async compress(): Promise<void> {
    // 分离 system 消息和对话消息
    const systemMsgs: ChatMessage[] = [];
    const conversationMsgs: ChatMessage[] = [];

    for (const msg of this.messages) {
      if (msg.role === "system") {
        systemMsgs.push(msg);
      } else {
        conversationMsgs.push(msg);
      }
    }

    // 计算要保留的消息数量（每轮约 3 条：user + assistant + tool）
    const keepCount = KEEP_RECENT_TURNS * 3;
    if (conversationMsgs.length <= keepCount) return;

    const toCompress = conversationMsgs.slice(0, conversationMsgs.length - keepCount);
    const toKeep = conversationMsgs.slice(conversationMsgs.length - keepCount);

    // 构造压缩请求，让 LLM 把旧对话总结为摘要
    const compressPrompt = `
请将以下对话历史压缩成一段简洁的摘要，保留关键信息（用户的需求、重要的工具调用和结果、已完成的工作等）。
不要丢失关键细节，但要尽量简洁。

---
${this.formatMessagesForSummary(toCompress)}
---

请用中文输出摘要：
`.trim();

    const summaryResponse = await this.llm.chat(
      [{ role: "user", content: compressPrompt }],
      [] // 压缩请求不需要工具
    );

    const newSummary = summaryResponse.content || "（摘要生成失败）";

    // 如果之前已有摘要，追加合并
    if (this.compressedSummary) {
      this.compressedSummary = `${this.compressedSummary}\n\n[后续对话摘要] ${newSummary}`;
    } else {
      this.compressedSummary = newSummary;
    }

    // 替换消息历史：system + 保留的最近几轮
    this.messages = [...systemMsgs, ...toKeep];
  }

  /**
   * 将消息格式化为文本，用于交给 LLM 生成压缩摘要
   */
  private formatMessagesForSummary(messages: ChatMessage[]): string {
    return messages
      .map((m) => {
        const role = m.role.toUpperCase();
        let content = m.content || "";
        // assistant 消息的工具调用信息也要包含
        if (m.tool_calls?.length) {
          content += `\n[工具调用] ${m.tool_calls
            .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`)
            .join("; ")}`;
        }
        // tool 消息标注工具名
        if (m.role === "tool") {
          return `[TOOL RESULT ${m.name || m.tool_call_id}]: ${content.slice(0, 500)}`;
        }
        return `[${role}]: ${content}`;
      })
      .join("\n\n");
  }

  /** 手动触发压缩（chat 模式下 /compress 命令用） */
  async forceCompress(): Promise<void> {
    await this.compress();
  }

  /** 获取当前压缩摘要内容 */
  getCompressedSummary(): string {
    return this.compressedSummary;
  }
}
