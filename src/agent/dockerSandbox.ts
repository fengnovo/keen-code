/**
 * @file dockerSandbox.ts
 * @description Docker 沙箱实现
 * 在 Docker 容器中隔离执行 shell 命令，提供更强的安全隔离
 * 文件读写直接在本地操作（workspace 目录已挂载到容器）
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "./sandbox.js";

/** 默认 Docker 镜像 */
const DEFAULT_IMAGE = "node:22.12.0";
/** 容器名前缀 */
const CONTAINER_PREFIX = "keen-code-";

/**
 * Docker 沙箱
 * 启动一个长驻容器，workspace 目录挂载到容器的 /workspace
 * 命令通过 docker exec 在容器内执行
 */
export class DockerSandbox implements Sandbox {
  private workDir: string;
  private containerName: string;
  private image: string;
  /** 容器是否已启动（懒加载） */
  private containerStarted: boolean = false;

  /**
   * @param workDir 自定义工作目录（优先级最高）
   * @param image Docker 镜像名
   * @param sessionId 会话 ID，用于创建按会话隔离的子目录
   */
  constructor(workDir?: string, image?: string, sessionId?: string) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "../..");

    if (workDir) {
      this.workDir = workDir;
    } else {
      const base = path.join(projectRoot, "workspace");
      this.workDir = sessionId ? path.join(base, sessionId) : base;
    }
    this.image = image || DEFAULT_IMAGE;
    this.containerName = `${CONTAINER_PREFIX}${Date.now()}`;
  }

  /**
   * 确保容器已启动（懒加载）
   * 使用 tail -f /dev/null 保持容器持续运行
   */
  private async ensureContainer(): Promise<void> {
    if (this.containerStarted) return;

    // 确保工作目录存在
    await fs.mkdir(this.workDir, { recursive: true });

    // 启动一个长驻容器
    await new Promise<void>((resolve, reject) => {
      execFile(
        "docker",
        [
          "run",
          "-d",               // 后台运行
          "--name", this.containerName,
          "-v", `${this.workDir}:/workspace`, // 挂载 workspace 目录
          "-w", "/workspace",  // 设置容器内工作目录
          "--rm",              // 停止后自动删除容器
          this.image,
          "tail", "-f", "/dev/null", // 保持容器运行
        ],
        { timeout: 60000 },
        (error) => {
          if (error) {
            reject(
              new Error(
                `启动 Docker 容器失败: ${error.message}\n请确认 Docker 已启动，且镜像 ${this.image} 可用`
              )
            );
          } else {
            this.containerStarted = true;
            resolve();
          }
        }
      );
    });
  }

  /**
   * 在 Docker 容器中执行 shell 命令
   * 通过 docker exec 在已启动的容器内执行
   */
  async runShell(
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.ensureContainer();

    return new Promise((resolve) => {
      execFile(
        "docker",
        [
          "exec",
          this.containerName,
          "/bin/bash",
          "-c",
          command,
        ],
        {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
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
   * 路径安全检查（与 LocalSandbox 相同）
   * 文件读写直接在本地操作，因为 workspace 已挂载到容器
   */
  private resolvePath(relativePath: string): string {
    const resolved = path.resolve(this.workDir, relativePath);
    const normalizedWorkDir = this.workDir.endsWith("/") ? this.workDir : this.workDir + "/";
    if (resolved !== this.workDir && !resolved.startsWith(normalizedWorkDir)) {
      throw new Error(`路径越界：${relativePath}`);
    }
    return resolved;
  }

  /** 读取工作目录内的文件（直接在本地读取） */
  async readFile(relativePath: string): Promise<string> {
    const fullPath = this.resolvePath(relativePath);
    return fs.readFile(fullPath, "utf-8");
  }

  /** 写入工作目录内的文件（直接在本地写入） */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }

  /** 获取工作目录绝对路径 */
  getWorkDir(): string {
    return this.workDir;
  }

  /** 停止并删除容器（清理资源） */
  async destroy(): Promise<void> {
    if (!this.containerStarted) return;
    return new Promise((resolve) => {
      execFile(
        "docker",
        ["rm", "-f", this.containerName],
        { timeout: 10000 },
        () => {
          this.containerStarted = false;
          resolve();
        }
      );
    });
  }

  /** 获取容器名称 */
  getContainerName(): string {
    return this.containerName;
  }
}
