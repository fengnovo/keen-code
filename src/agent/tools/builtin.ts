/**
 * @file builtin.ts
 * @description 内置工具定义
 *
 * 提供 4 个核心工具：
 * - run_shell：在沙箱中执行 shell 命令
 * - read_file：读取工作目录内的文件
 * - write_file：写入工作目录内的文件
 * - finish：提交最终回答，结束任务
 */

import { z } from 'zod';
import { Tool } from './registry.js';
import { Sandbox } from '../sandbox/sandbox.js';

/**
 * run_shell 工具：在沙箱工作目录中执行 shell 命令
 * 返回 stdout、stderr 和退出码
 */
export function createRunShellTool(sandbox: Sandbox): Tool {
  return {
    name: 'run_shell',
    description: '在沙箱工作目录中执行 shell 命令，返回命令输出',
    schema: z.object({
      command: z.string().describe('要执行的 shell 命令'),
    }),
    async execute(params: { command: string }, signal?: AbortSignal) {
      const result = await sandbox.runShell(params.command, signal);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}

/**
 * read_file 工具：读取沙箱工作目录内的文件内容
 * 路径相对于工作目录
 */
export function createReadFileTool(sandbox: Sandbox): Tool {
  return {
    name: 'read_file',
    description: '读取沙箱工作目录内的文件内容',
    schema: z.object({
      path: z.string().describe('文件路径，相对于工作目录'),
    }),
    async execute(params: { path: string }) {
      try {
        const content = await sandbox.readFile(params.path);
        return { content };
      } catch (e: unknown) {
        return { error: (e as Error).message };
      }
    },
  };
}

/**
 * write_file 工具：向沙箱工作目录内的文件写入内容
 * 路径相对于工作目录，自动创建父目录
 */
export function createWriteFileTool(sandbox: Sandbox): Tool {
  return {
    name: 'write_file',
    description: '向沙箱工作目录内的文件写入内容',
    schema: z.object({
      path: z.string().describe('文件路径，相对于工作目录'),
      content: z.string().describe('要写入的文件内容'),
    }),
    async execute(params: { path: string; content: string }) {
      try {
        await sandbox.writeFile(params.path, params.content);
        return { success: true, path: params.path };
      } catch (e: unknown) {
        return { success: false, error: (e as Error).message };
      }
    },
  };
}

/**
 * finish 工具：提交最终回答，结束当前任务
 * Agent 主循环检测到此工具调用后，立即返回 answer 并结束本轮
 */
export function createFinishTool(): Tool {
  return {
    name: 'finish',
    description: '提交最终回答，结束本次任务',
    schema: z.object({
      answer: z.string().describe('最终的回答内容'),
    }),
    async execute(params: { answer: string }) {
      return { finished: true, answer: params.answer };
    },
  };
}
