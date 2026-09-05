/**
 * @file registry.ts
 * @description 工具注册表
 *
 * 管理所有可用工具，提供：
 * - 注册（register）
 * - 查询（has / get / listNames）
 * - 执行（execute，自动用 Zod 校验参数）
 * - 生成 LLM 工具定义（toToolDefinitions，将 Zod Schema 转 JSON Schema）
 */

import { z, ZodSchema } from "zod";
import { ToolDefinition } from "../types.js";

// ---------- 工具接口 ----------
/** 工具定义，所有工具都需要实现此接口 */
export interface Tool<TParams = unknown, TReturn = unknown> {
  /** 工具名称（唯一标识） */
  name: string;
  /** 工具描述（会传给 LLM） */
  description: string;
  /** Zod 参数 schema（用于校验和生成 JSON Schema） */
  schema: ZodSchema<TParams>;
  /** 执行函数 */
  execute(params: TParams): Promise<TReturn>;
}

// ---------- 工具注册表 ----------
/**
 * 工具注册表
 * 管理所有可用工具，提供注册、查询、执行、生成 LLM 工具定义等功能
 */
export class ToolRegistry {
  /** name → Tool 映射 */
  private tools = new Map<string, Tool>();

  /** 注册一个工具（重名会报错） */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 ${tool.name} 已存在`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 检查工具是否存在 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 获取工具定义 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 列出所有工具名称 */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 将所有工具转换成 LLM 能理解的工具定义
   * Zod Schema → JSON Schema，连同 name 和 description 一起
   */
  toToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      const jsonSchema = zodToJsonSchema(tool.schema);
      defs.push({
        name: tool.name,
        description: tool.description,
        parameters: jsonSchema,
      });
    }
    return defs;
  }

  /**
   * 执行一个工具调用
   * 先用 Zod schema 校验参数，校验通过后执行
   * @throws 参数校验失败或工具不存在时抛出异常
   */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`未知工具：${name}`);
    }

    // Zod 参数校验
    const result = tool.schema.safeParse(args);
    if (!result.success) {
      throw new Error(
        `工具 ${name} 参数错误：${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`
      );
    }

    return tool.execute(result.data);
  }
}

// ---------- 辅助函数：Zod → JSON Schema ----------
/**
 * 将 Zod Schema 转换为 JSON Schema
 * 简单实现，覆盖常用的 Zod 类型（object / array / optional / 基本类型）
 */
function zodToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  // Zod 类型名 → JSON Schema 类型名
  const typeMap: Record<string, string> = {
    ZodString: "string",
    ZodNumber: "number",
    ZodBoolean: "boolean",
    ZodNull: "null",
    ZodArray: "array",
    ZodObject: "object",
  };

  // 通过 _def.typeName 获取 Zod 类型名
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  const typeName = def.typeName;

  // 对象类型：遍历 shape 生成 properties 和 required
  if (typeName === "ZodObject") {
    const shape = (def as unknown as { shape: Record<string, ZodSchema> }).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      // 非 optional 的字段加入 required
      const innerDef = (value as unknown as { _def: { typeName: string; innerType?: ZodSchema } })._def;
      if (innerDef.typeName !== "ZodOptional") {
        required.push(key);
      }
    }

    return { type: "object", properties, required };
  }

  // 数组类型：递归处理 items
  if (typeName === "ZodArray") {
    const innerType = (def as unknown as { type: ZodSchema }).type;
    return { type: "array", items: zodToJsonSchema(innerType) };
  }

  // Optional 类型：递归处理内部类型
  if (typeName === "ZodOptional") {
    const innerType = (def as unknown as { innerType: ZodSchema }).innerType;
    return zodToJsonSchema(innerType);
  }

  // 基本类型：直接映射
  if (typeMap[typeName]) {
    return { type: typeMap[typeName] };
  }

  // 默认返回 string 类型
  return { type: "string" };
}
