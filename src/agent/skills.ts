/**
 * @file skills.ts
 * @description 技能系统实现
 *
 * 技能以 SKILL.md 文件形式存储在 skills/ 目录下
 * 每个技能是一个子目录，内含 SKILL.md 描述文件
 * Agent 启动时自动加载所有技能，摘要注入 system prompt
 * AI 可通过 use_skill 工具主动读取技能的完整说明
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Tool } from "./tools/registry.js";
import { z } from "zod";

/** 技能定义 */
export interface Skill {
  /** 技能名称（目录名） */
  name: string;
  /** 从 SKILL.md 中提取的简短描述 */
  description: string;
  /** 完整的 SKILL.md 内容 */
  content: string;
}

/**
 * 技能管理器
 * 负责扫描、加载、管理技能
 */
export class SkillManager {
  /** skills 目录路径 */
  private skillsDir: string;
  /** 已加载的技能：name → Skill */
  private skills: Map<string, Skill> = new Map();

  constructor() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "../..");
    this.skillsDir = path.join(projectRoot, "skills");
  }

  /**
   * 加载 skills/ 目录下所有技能
   * 每个技能是一个子目录，里面需要有 SKILL.md 文件
   * 格式：skills/<skill-name>/SKILL.md
   */
  async loadAll(): Promise<void> {
    this.skills.clear();

    try {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(this.skillsDir, entry.name, "SKILL.md");
        try {
          const content = await fs.readFile(skillPath, "utf-8");
          const description = this.extractDescription(content);
          this.skills.set(entry.name, {
            name: entry.name,
            description,
            content,
          });
        } catch {
          // 子目录里没有 SKILL.md，跳过
        }
      }
    } catch {
      // skills 目录不存在，没有技能
    }
  }

  /**
   * 从 SKILL.md 中提取简短描述
   * 取第一个非标题、非代码块的段落作为描述
   */
  private extractDescription(content: string): string {
    const lines = content.split("\n");
    let inCodeBlock = false;
    const paragraphLines: string[] = [];

    for (const line of lines) {
      // 跳过代码块内容
      if (line.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;
      // 跳过标题行
      if (line.startsWith("#")) continue;
      // 遇到空行时，如果已收集到段落内容就结束
      if (line.trim() === "") {
        if (paragraphLines.length > 0) break;
        continue;
      }
      paragraphLines.push(line.trim());
    }

    const desc = paragraphLines.join(" ");
    return desc.length > 200 ? desc.slice(0, 200) + "..." : desc || "（暂无描述）";
  }

  /** 列出所有已加载的技能 */
  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /** 按名称获取单个技能 */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * 生成技能摘要，注入到 system prompt 中
   * 让 AI 知道当前有哪些技能可用
   */
  getSkillsSummary(): string {
    const skills = this.listSkills();
    if (skills.length === 0) return "";

    const parts = ["【可用技能】"];
    for (const skill of skills) {
      parts.push(`- ${skill.name}: ${skill.description}`);
    }
    parts.push("\n使用 use_skill 工具可读取技能的完整说明。");
    return parts.join("\n");
  }
}

// ---------- use_skill 工具定义 ----------

/** use_skill 工具：读取指定技能的完整 SKILL.md 说明文档 */
export function createUseSkillTool(skillManager: SkillManager): Tool {
  return {
    name: "use_skill",
    description: "读取指定技能的完整 SKILL.md 说明文档",
    schema: z.object({
      name: z.string().describe("技能名称"),
    }),
    async execute(params: { name: string }) {
      const skill = skillManager.getSkill(params.name);
      if (!skill) {
        return { error: `未找到技能：${params.name}` };
      }
      return {
        name: skill.name,
        description: skill.description,
        content: skill.content,
      };
    },
  };
}
