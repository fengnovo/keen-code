/**
 * @file memory.ts
 * @description 记忆系统实现
 *
 * 分为两层：
 * - 短期记忆：Map 结构，只在当前 session 内有效，会话结束即消失
 * - 长期记忆：持久化到 memory/long_term.json，跨会话保留
 *
 * 同时提供 3 个记忆工具供 AI 调用：remember、remember_longterm、recall
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Tool } from "./tools/registry.js";
import { z } from "zod";

/** 记忆条目 */
export interface MemoryEntry {
  key: string;
  value: string;
  /** ISO 格式的时间戳 */
  createdAt: string;
}

/**
 * 记忆管理器
 * 管理短期记忆（内存 Map）和长期记忆（JSON 文件持久化）
 */
export class MemoryManager {
  /** 短期记忆：key → value，只在当前会话内有效 */
  private shortTerm: Map<string, string> = new Map();
  /** 长期记忆文件路径 */
  private longTermPath: string;

  constructor() {
    // 从当前文件位置推算项目根目录，定位 _memory/ 目录
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "../..");
    const memoryDir = path.join(projectRoot, "_memory");
    fs.mkdir(memoryDir, { recursive: true });
    this.longTermPath = path.join(memoryDir, "long_term.json");
  }

  // ---------- 短期记忆操作 ----------

  /** 写入短期记忆 */
  rememberShort(key: string, value: string): void {
    this.shortTerm.set(key, value);
  }

  /** 读取单条短期记忆 */
  getShort(key: string): string | undefined {
    return this.shortTerm.get(key);
  }

  /** 获取所有短期记忆条目 */
  getAllShort(): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    for (const [key, value] of this.shortTerm) {
      entries.push({ key, value, createdAt: "" });
    }
    return entries;
  }

  // ---------- 长期记忆操作 ----------

  /** 从文件加载长期记忆 */
  private async loadLongTerm(): Promise<MemoryEntry[]> {
    try {
      const content = await fs.readFile(this.longTermPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return []; // 文件不存在或解析失败，返回空数组
    }
  }

  /** 保存长期记忆到文件 */
  private async saveLongTerm(entries: MemoryEntry[]): Promise<void> {
    await fs.writeFile(this.longTermPath, JSON.stringify(entries, null, 2), "utf-8");
  }

  /**
   * 写入长期记忆（持久化）
   * 如果 key 已存在则更新，否则新增
   */
  async rememberLong(key: string, value: string): Promise<void> {
    const entries = await this.loadLongTerm();
    const existing = entries.findIndex((e) => e.key === key);
    if (existing >= 0) {
      entries[existing].value = value;
      entries[existing].createdAt = new Date().toISOString();
    } else {
      entries.push({ key, value, createdAt: new Date().toISOString() });
    }
    await this.saveLongTerm(entries);
  }

  /**
   * 检索长期记忆：简单的关键词匹配
   * 后续可以扩展为向量检索
   * @param query 检索关键词，为空时返回最近条目
   * @param limit 返回条数上限，默认 5
   */
  async recall(query: string, limit = 5): Promise<MemoryEntry[]> {
    const entries = await this.loadLongTerm();
    if (!query.trim()) {
      return entries.slice(-limit).reverse();
    }
    const lowerQuery = query.toLowerCase();
    const matched = entries.filter(
      (e) =>
        e.key.toLowerCase().includes(lowerQuery) ||
        e.value.toLowerCase().includes(lowerQuery)
    );
    return matched.slice(-limit).reverse();
  }

  /** 获取所有长期记忆条目 */
  async getAllLong(): Promise<MemoryEntry[]> {
    return this.loadLongTerm();
  }

  /**
   * 生成记忆摘要，注入到 system prompt 中
   * 让 AI 知道当前有哪些记忆可用
   */
  async getMemorySummary(): Promise<string> {
    const short = this.getAllShort();
    const long = await this.getAllLong();

    const parts: string[] = [];

    if (short.length > 0) {
      parts.push("【短期记忆】");
      for (const entry of short) {
        parts.push(`- ${entry.key}: ${entry.value}`);
      }
    }

    if (long.length > 0) {
      parts.push("【长期记忆】");
      // 只展示最近 10 条，避免 prompt 过长
      for (const entry of long.slice(-10)) {
        parts.push(`- ${entry.key}: ${entry.value}`);
      }
    }

    return parts.join("\n");
  }
}

// ---------- 记忆相关工具定义 ----------

/** remember 工具：写入短期工作记忆 */
export function createRememberShortTool(memory: MemoryManager): Tool {
  return {
    name: "remember",
    description: "写入短期工作记忆，只在当前 session 内有效",
    schema: z.object({
      key: z.string().describe("记忆的键名"),
      value: z.string().describe("记忆的内容"),
    }),
    async execute(params: { key: string; value: string }) {
      memory.rememberShort(params.key, params.value);
      return { success: true };
    },
  };
}

/** remember_longterm 工具：写入长期持久化记忆 */
export function createRememberLongTool(memory: MemoryManager): Tool {
  return {
    name: "remember_longterm",
    description: "写入长期记忆，会持久化保存，下次会话仍可检索",
    schema: z.object({
      key: z.string().describe("记忆的键名"),
      value: z.string().describe("记忆的内容"),
    }),
    async execute(params: { key: string; value: string }) {
      await memory.rememberLong(params.key, params.value);
      return { success: true };
    },
  };
}

/** recall 工具：按关键词检索长期记忆 */
export function createRecallTool(memory: MemoryManager): Tool {
  return {
    name: "recall",
    description: "检索长期记忆，按关键词匹配",
    schema: z.object({
      query: z.string().describe("检索关键词"),
      limit: z.number().optional().describe("返回条数，默认 5"),
    }),
    async execute(params: { query: string; limit?: number }) {
      const results = await memory.recall(params.query, params.limit);
      return { results };
    },
  };
}
