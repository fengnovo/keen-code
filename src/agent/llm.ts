/**
 * @file llm.ts
 * @description LLM 层实现，包含 MockLLM（模拟）和 DeepSeekLLM（真实调用）
 * 两者都实现 LLMProvider 接口，通过 createLLM 工厂函数按需创建
 */

import 'dotenv/config';
import OpenAI from 'openai';
import {
  ChatMessage,
  ToolDefinition,
  ToolCall,
  LLMResponse,
  LLMProvider,
  ChatOptions,
} from './types.js';

// ---------- Mock LLM ----------
/**
 * 模拟 LLM，不调用真实 API
 * 用于本地调试和无网络环境下的开发
 * 会逐字模拟流式输出效果
 */
export class MockLLM implements LLMProvider {
  getModelName(): string {
    return 'mock';
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    options?.signal?.throwIfAborted();
    // 取最后一条用户消息作为输入
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const userInput = lastUserMsg?.content ?? '你好';

    // 构造模拟回复
    const content = `[Mock LLM] 收到你的消息："${userInput}"\n\n我是一个模拟的 AI 助手。当前有 ${tools.length} 个工具可用：${tools.map((t) => t.name).join(', ')}。`;

    // 如果传入了流式回调，逐字模拟输出
    if (options?.onToken) {
      for (const char of content) {
        options?.signal?.throwIfAborted();
        options.onToken(char);
        await new Promise((r) => setTimeout(r, 10)); // 模拟网络延迟
      }
    }

    return {
      content,
      tool_calls: [], // Mock 模式不产生工具调用
    };
  }
}

// ---------- DeepSeek LLM ----------
/**
 * 通过 OpenAI 兼容接口调用 DeepSeek 真实模型
 * 支持流式输出（stream: true），流式失败时自动回退到非流式
 */
export class DeepSeekLLM implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor() {
    // 从环境变量读取配置
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const baseURL = process.env.DEEPSEEK_BASE_URL;
    const model = process.env.DEEPSEEK_MODEL;

    if (!apiKey || apiKey === '你的key') {
      throw new Error(
        '请在 .env 中配置 DEEPSEEK_API_KEY，或使用 --mock 模式运行',
      );
    }

    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model || 'deepseek-v4-flash';
  }

  getModelName(): string {
    return this.model;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    // 将内部工具定义转换为 OpenAI function-calling 格式
    const openaiTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    // 将内部消息格式转换为 OpenAI 消息格式
    const openaiMessages = messages.map((m) => {
      const msg: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };
      // assistant 消息需要携带 tool_calls
      if (m.role === 'assistant' && m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }
      // tool 消息需要携带 tool_call_id
      if (m.role === 'tool') {
        msg.tool_call_id = m.tool_call_id;
      }
      return msg;
    });

    // --- 流式调用 ---
    let content = '';
    // 工具调用在流式中是分块返回的，需要按 index 累积
    const toolCallMap = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let streamFailed = false;

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages:
            openaiMessages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
          stream: true,
        },
        { signal: options?.signal },
      );

      // 逐 chunk 处理流式响应
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // 文本内容：累积并通过回调实时输出
        if (delta.content) {
          content += delta.content;
          if (options?.onToken) {
            options.onToken(delta.content);
          }
        }

        // 工具调用：按 index 累积 id、name、arguments
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: tc.id || '', name: '', args: '' });
            }
            const entry = toolCallMap.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }
      }
    } catch (streamErr) {
      if (options?.signal?.aborted) {
        throw streamErr;
      }
      // 流式失败：如果完全没有收到数据，标记需要回退到非流式
      if (!content && toolCallMap.size === 0) {
        streamFailed = true;
      } else {
        // 部分内容已收到，但工具调用信息不完整时也回退
        if (
          toolCallMap.size > 0 &&
          !Array.from(toolCallMap.values()).every((e) => e.id && e.name)
        ) {
          streamFailed = true;
          content = '';
          toolCallMap.clear();
        }
      }
    }

    // --- 流式失败，回退到非流式调用 ---
    if (streamFailed) {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages:
            openaiMessages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
        },
        { signal: options?.signal },
      );

      const choice = response.choices[0];
      const message = choice.message;

      content = message.content || '';

      // 非流式模式下，一次性输出全部内容
      if (options?.onToken && content) {
        options.onToken(content);
      }

      // 解析非流式返回的工具调用
      if (message.tool_calls) {
        for (const tc of message.tool_calls) {
          toolCallMap.set(toolCallMap.size, {
            id: tc.id,
            name: tc.function.name,
            args: tc.function.arguments || '{}',
          });
        }
      }
    }

    // --- 解析累积的工具调用 ---
    const tool_calls: ToolCall[] = [];
    for (const entry of toolCallMap.values()) {
      try {
        tool_calls.push({
          id: entry.id,
          name: entry.name,
          arguments: JSON.parse(entry.args || '{}'),
        });
      } catch {
        // JSON 解析失败，把原始字符串存入 raw 字段
        tool_calls.push({
          id: entry.id,
          name: entry.name,
          arguments: { raw: entry.args },
        });
      }
    }

    return {
      content: content || null,
      tool_calls,
    };
  }
}

/**
 * LLM 工厂函数
 * @param mock 是否使用 Mock 模式
 * @returns LLMProvider 实例
 */
export function createLLM(mock: boolean): LLMProvider {
  if (mock) {
    return new MockLLM();
  }
  return new DeepSeekLLM();
}
