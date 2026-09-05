/**
 * @file sandbox.ts
 * @description 本地沙箱实现
 * 在本地 workspace 目录中隔离执行 shell 命令和文件读写
 * 每个会话有独立的工作目录（workspace/<sessionId>/）
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- 沙箱接口 ----------
/** 沙箱抽象接口，LocalSandbox 和 DockerSandbox 都实现此接口 */
export interface Sandbox {
  /** 在沙箱工作目录中执行 shell 命令 */
  runShell(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  /** 读取工作目录内的文件（路径相对于工作目录） */
  readFile(relativePath: string): Promise<string>;

  /** 写入工作目录内的文件 */
  writeFile(relativePath: string, content: string): Promise<void>;

  /** 获取沙箱工作目录的绝对路径 */
  getWorkDir(): string;
}

// ---------- 本地沙箱 ----------
/**
 * 本地沙箱，直接在本地 workspace 目录中执行命令
 * 适合本地开发调试，不需要 Docker 环境
 */
export class LocalSandbox implements Sandbox {
  private workDir: string;

  /**
   * @param workDir 自定义工作目录（优先级最高）
   * @param sessionId 会话 ID，用于创建按会话隔离的子目录
   */
  constructor(workDir?: string, sessionId?: string) {
    // 从当前文件位置推算项目根目录（src/agent/ → 上两级 → 项目根）
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "../..");

    if (workDir) {
      this.workDir = workDir;
    } else {
      // 默认：workspace/<sessionId>/，按会话隔离
      const base = path.join(projectRoot, "workspace");
      this.workDir = sessionId ? path.join(base, sessionId) : base;
    }

    // 确保工作目录存在（异步触发但不等待，mkdir recursive 通常足够快）
    fs.mkdir(this.workDir, { recursive: true });
  }

  /**
   * 在沙箱工作目录中执行 shell 命令
   * 通过 /bin/bash -c 执行，设置 30 秒超时和 1MB 输出上限
   */
  async runShell(
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      execFile(
        "/bin/bash",
        ["-c", command],
        {
          cwd: this.workDir,
          timeout: 30000,       // 30 秒超时
          maxBuffer: 1024 * 1024, // 1MB 输出上限
        },
        (error, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            exitCode: error?.code ? Number(error.code) : error ? 1 : 0,
          });
        }
      );
    });
  }

  /**
   * 路径安全检查：确保解析后的路径仍在工作目录内
   * 防止路径穿越攻击（如 ../../../etc/passwd）
   */
  private resolvePath(relativePath: string): string {
    const resolved = path.resolve(this.workDir, relativePath);
    // 末尾加 / 避免前缀匹配误判（如 workDir=/a/b 匹配 /a/bcd）
    const normalizedWorkDir = this.workDir.endsWith("/") ? this.workDir : this.workDir + "/";
    if (resolved !== this.workDir && !resolved.startsWith(normalizedWorkDir)) {
      throw new Error(`路径越界：${relativePath}`);
    }
    return resolved;
  }

  /** 读取工作目录内的文件 */
  async readFile(relativePath: string): Promise<string> {
    const fullPath = this.resolvePath(relativePath);
    return fs.readFile(fullPath, "utf-8");
  }

  /** 写入工作目录内的文件（自动创建父目录） */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }

  /** 获取工作目录绝对路径 */
  getWorkDir(): string {
    return this.workDir;
  }
}
