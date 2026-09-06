/**
 * @file cli.ts
 * @description 命令行入口
 *
 * 解析命令行参数，分发到对应的处理函数：
 * - run：单轮对话模式
 * - chat：交互式对话模式
 * - session：查看会话记录
 * - help：显示帮助
 *
 * 支持流式输出和工具调用过程的实时展示
 */

import 'dotenv/config';
import { createAgent, CreateAgentResult } from './agent/agent.js';
import {
  listSessions,
  listSessionLogs,
  showSessionTree,
} from './agent/sessions/sessionView.js';
import { parseMCPArgs, parseMCPCommandArgs } from './agent/mcp/mcp.js';
import {
  loadMCPConfig,
  MCPRemoteServerConfig,
  MCPStdioServerConfig,
} from './agent/mcp/mcpConfig.js';
import { DockerSandbox } from './agent/sandbox/dockerSandbox.js';
import { ToolCall, RunCallbacks } from './agent/types.js';
import { LoadingIndicator } from './utils/loading.js';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';

/** 将名称列表格式化为单行，空列表显示“无” */
function formatNameList(names: string[]): string {
  return names.length > 0 ? names.join(', ') : '无';
}

interface RuntimeMCPConfig {
  mcpServers: Record<string, MCPRemoteServerConfig>;
  mcpCommands: Record<string, MCPStdioServerConfig>;
  disabledMCPNames: string[];
}

interface ChatCommandResult {
  switchedAgent?: CreateAgentResult;
  selectedSkillName?: string;
  userInput?: string;
}

/** 关闭一个 Agent 持有的 MCP/Docker 资源，避免 CLI 退出后残留子进程。 */
async function closeAgentResources(current: CreateAgentResult): Promise<void> {
  const closeTasks = current.mcpClients.map(async (client) => {
    const closable = client as { close?: () => unknown };
    if (typeof closable.close === 'function') {
      await closable.close();
    }
  });

  if (closeTasks.length > 0) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 2_000);
      Promise.allSettled(closeTasks).then(done);
    });
  }

  if (current.sandbox instanceof DockerSandbox) {
    await current.sandbox.destroy();
  }
}

/** 加载 .mcp.json，并用命令行中的同名 MCP 配置覆盖它 */
async function resolveMCPConfig(
  flags: Record<string, string | boolean | string[]>,
): Promise<RuntimeMCPConfig> {
  const configFlag = flags['mcp-config'];
  if (configFlag !== undefined && typeof configFlag !== 'string') {
    throw new Error('--mcp-config 需要提供 JSON 文件路径');
  }

  const fileConfig = await loadMCPConfig(configFlag);
  const cliServers = parseMCPArgs((flags.mcp as string[]) || []);
  const cliCommands = parseMCPCommandArgs(
    (flags['mcp-command'] as string[]) || [],
  );

  const duplicateCliNames = Object.keys(cliServers).filter(
    (name) => cliCommands[name],
  );
  if (duplicateCliNames.length > 0) {
    throw new Error(
      `以下 MCP 同时配置了远程和 stdio 连接: ${duplicateCliNames.join(', ')}`,
    );
  }

  const mcpServers = { ...fileConfig.mcpServers, ...cliServers };
  const mcpCommands = { ...fileConfig.mcpCommands, ...cliCommands };

  // 命令行配置优先，并覆盖 JSON 中不同传输类型的同名服务。
  for (const name of Object.keys(cliServers)) delete mcpCommands[name];
  for (const name of Object.keys(cliCommands)) delete mcpServers[name];

  const cliNames = new Set([
    ...Object.keys(cliServers),
    ...Object.keys(cliCommands),
  ]);
  const disabledMCPNames = fileConfig.disabledMCPNames.filter(
    (name) => !cliNames.has(name),
  );

  return { mcpServers, mcpCommands, disabledMCPNames };
}

/**
 * 格式化工具调用为可读字符串
 * 截断过长的字符串参数
 */
function formatToolCall(toolCall: ToolCall): string {
  const args = Object.entries(toolCall.arguments)
    .map(([k, v]) => {
      const val =
        typeof v === 'string'
          ? v.length > 80
            ? v.slice(0, 77) + '...'
            : v
          : JSON.stringify(v);
      return `${k}: ${val}`;
    })
    .join(', ');
  return `${toolCall.name}(${args})`;
}

/**
 * 格式化工具结果为可读字符串
 * 超过 500 字符的结果会被截断
 */
function formatToolResult(toolName: string, result: unknown): string {
  const str = JSON.stringify(result, null, 2);
  const truncated = str.length > 500 ? str.slice(0, 497) + '...' : str;
  return truncated;
}

/**
 * 构建 run/chat 通用的回调函数
 * - onToken：流式文本逐字输出到 stdout
 * - onToolCall：显示工具调用信息
 * - onToolResult：显示工具执行结果
 */
function createRunCallbacks(loading: LoadingIndicator): RunCallbacks {
  let responseStarted = false;

  return {
    onToken: (delta: string) => {
      loading.stop();
      if (!responseStarted) {
        process.stdout.write('AI> ');
        responseStarted = true;
      }
      process.stdout.write(delta);
    },
    onToolCall: (toolCall: ToolCall) => {
      loading.stop();
      process.stdout.write(`\n  [工具调用] ${formatToolCall(toolCall)}\n`);
      loading.start('工具执行中');
    },
    onToolResult: (toolName: string, result: unknown) => {
      loading.stop();
      const formatted = formatToolResult(toolName, result);
      process.stdout.write(`  [工具结果] ${formatted}\n\n`);
      loading.start('AI 思考中');
    },
  };
}

/** 把 npx skills 安装到临时目录的结果复制进项目 _skills/ */
async function copySkillsFromStaging(stagingDir: string): Promise<string[]> {
  const stagingSkillsDir = path.join(stagingDir, '.agents', 'skills');
  let entries;
  try {
    entries = await fs.readdir(stagingSkillsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const skillNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (skillNames.length === 0) return [];

  const targetRoot = path.resolve(process.cwd(), '_skills');
  const existing: string[] = [];
  for (const name of skillNames) {
    try {
      await fs.access(path.join(targetRoot, name));
      existing.push(name);
    } catch {
      // 目标不存在，可以安装。
    }
  }
  if (existing.length > 0) {
    throw new Error(
      `以下 Skill 已存在，未执行覆盖: ${existing.join(', ')}`,
    );
  }

  await fs.mkdir(targetRoot, { recursive: true });
  for (const name of skillNames) {
    await fs.cp(
      path.join(stagingSkillsDir, name),
      path.join(targetRoot, name),
      { recursive: true, errorOnExist: true, force: false },
    );
  }

  return skillNames;
}

/** 通过 npx skills 获取 Skill，并安装到当前项目的 _skills/ */
async function skillAddCommand(source: string): Promise<void> {
  if (!source) {
    throw new Error(
      '用法: npm run cli -- skill add <owner/repo 或 URL>',
    );
  }

  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const stagingDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'keen-code-skill-'),
  );

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        npxCommand,
        [
          'skills',
          'add',
          source,
          '--agent',
          'promptscript',
          '--copy',
        ],
        {
          cwd: stagingDir,
          env: process.env,
          stdio: 'inherit',
        },
      );

      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal) {
          reject(new Error(`npx skills add 被信号 ${signal} 终止`));
          return;
        }
        resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) {
      throw new Error(`npx skills add 执行失败，退出码: ${exitCode}`);
    }

    const installedSkills = await copySkillsFromStaging(stagingDir);
    if (installedSkills.length === 0) {
      console.log('未安装任何 Skill。');
      return;
    }

    console.log(`\n已安装到 ${path.resolve(process.cwd(), '_skills')}:`);
    for (const name of installedSkills) console.log(`  - ${name}`);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

/**
 * 解析命令行参数
 * 支持位置参数和 --flag 选项
 * --mcp 参数可重复使用，收集为数组
 *
 * @returns { command, args, flags }
 */
function parseArgs(argv: string[]): {
  command: string;
  args: string[];
  flags: Record<string, string | boolean | string[]>;
} {
  const args: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        // MCP 参数支持重复使用，统一收集为数组
        if (key === 'mcp' || key === 'mcp-command') {
          if (!flags[key]) flags[key] = [];
          (flags[key] as string[]).push(next);
        } else {
          flags[key] = next;
        }
        i++;
      } else {
        flags[key] = true; // 布尔标志
      }
    } else {
      args.push(arg);
    }
  }

  const command = args.shift() || 'help';
  return { command, args, flags };
}

/** 显示帮助信息 */
function showHelp(): void {
  console.log(
    `
keen-code - 一个最小的 Agent Harness

用法:
  npm run cli -- <command> [options]

命令:
  run <message>        单轮对话，输入消息，输出回答
  chat                 交互式对话模式
  skill add <source>   通过 npx skills 安装到项目 _skills/
  session list           列出所有 会话记录
  session tree <sid> <tid>  以树状结构查看单个 run
  help                 显示此帮助信息

选项:
  --mock               使用 Mock LLM（不调用真实 API）
  --sandbox <type>     沙箱类型: local (默认) / docker
  --mcp-config <path>  MCP JSON 配置文件（默认: .mcp.json）
  --mcp <name=url>     接入远程 MCP 服务（可多次使用）
  --mcp-command <name=command args...>
                       接入本地 stdio MCP 服务（可多次使用）

示例:
  npm run cli -- run "你好"
  npm run cli -- run "你好" --mock
  npm run chat
  npm run cli -- skill add <owner/repo>
  npm run cli -- skill add https://modelscope.cn/skills/@anthropics/skill-creator
  npm run cli -- chat --sandbox docker
  npm run cli -- session list
  npm run cli -- session tree sess_xxx run_xxx
`.trim(),
  );
}

// ---------- run 命令：单轮对话 ----------
/**
 * 单轮对话模式
 * 输入一条消息，输出 AI 回答后退出
 */
async function runCommand(
  message: string,
  flags: Record<string, string | boolean | string[]>,
): Promise<void> {
  const mock = flags.mock === true;
  const sandboxType = (flags.sandbox as string) || 'local';
  const { mcpServers, mcpCommands, disabledMCPNames } =
    await resolveMCPConfig(flags);

  const current = await createAgent({
    mock,
    sandboxType: sandboxType as 'local' | 'docker',
    mcpServers,
    mcpCommands,
    disabledMCPNames,
  });
  const { agent, sandbox } = current;

  try {
    console.log(`> ${message}\n`);
    console.log(`[工作目录: ${sandbox.getWorkDir()}]\n`);

    // 流式输出 AI 回答
    const loading = new LoadingIndicator();
    loading.start('AI 思考中');
    try {
      await agent.run(message, createRunCallbacks(loading));
    } finally {
      loading.stop();
    }
    console.log('\n');

    const recorder = agent.getRecorder();
    console.log(`\n[会话记录已保存: ${recorder.getFilePath()}]`);
  } finally {
    await closeAgentResources(current);
  }
}

// ---------- chat 命令：交互式对话 ----------
/**
 * 交互式对话模式
 * 支持多轮对话和内置命令（/exit /help /session 等）
 */
async function chatCommand(
  flags: Record<string, string | boolean | string[]>,
): Promise<void> {
  const mock = flags.mock === true;
  const sandboxType = (flags.sandbox as string) || 'local';
  const { mcpServers, mcpCommands, disabledMCPNames } =
    await resolveMCPConfig(flags);

  let current = await createAgent({
    mock,
    sandboxType: sandboxType as 'local' | 'docker',
    mcpServers,
    mcpCommands,
    disabledMCPNames,
  });

  const skillNames = current.agent
    .getSkills()
    .listSkills()
    .map((skill) => skill.name);
  console.log(`模型: ${current.agent.getModelName()}`);
  console.log(`Skills: ${formatNameList(skillNames)}`);
  console.log(`MCP: ${formatNameList(current.mcpNames)}`);
  console.log(`系统工具: ${formatNameList(current.systemToolNames)}`);
  console.log('System Prompt:');
  console.log(await current.agent.getSystemPrompt());
  console.log('');

  // 创建 readline 交互
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '你> ',
  });
  let isClosing = false;
  let isRequestRunning = false;
  let activeRequest: AbortController | undefined;
  let pendingSkillName: string | undefined;

  rl.prompt();

  let lastSigintAt = 0;
  const handleSigint = (): void => {
    const now = Date.now();
    if (now - lastSigintAt < 50) return;
    lastSigintAt = now;

    if (activeRequest && !activeRequest.signal.aborted) {
      activeRequest.abort();
      console.log('\n已暂停当前请求，再次按 Ctrl+C 退出。');
    } else {
      rl.close();
    }
  };
  rl.on('SIGINT', handleSigint);
  process.on('SIGINT', handleSigint);

  rl.on('line', async (line) => {
    let input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (isRequestRunning) {
      console.log('当前请求仍在处理中，按 Ctrl+C 可立即暂停。');
      return;
    }

    let selectedSkillName: string | undefined;
    if (pendingSkillName && !input.startsWith('/')) {
      selectedSkillName = pendingSkillName;
      pendingSkillName = undefined;
      rl.setPrompt('你> ');
    }

    // 保持 readline 活跃，确保请求期间 Ctrl+C 仍能被捕获。
    isRequestRunning = true;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);

    let requestController: AbortController | undefined;
    try {
      // 处理内置命令（以 / 开头）
      if (input.startsWith('/')) {
        const commandResult = await handleChatCommand(input, current, rl, {
          mock,
          sandboxType: sandboxType as 'local' | 'docker',
          mcpServers,
          mcpCommands,
          disabledMCPNames,
        });
        if (commandResult?.switchedAgent) {
          await closeAgentResources(current);
          current = commandResult.switchedAgent;
          pendingSkillName = undefined;
          rl.setPrompt('你> ');
          console.log(`已切换到会话: ${current.sessionId}`);
          console.log(`工作目录: ${current.sandbox.getWorkDir()}`);
        }

        if (commandResult?.selectedSkillName) {
          if (commandResult.userInput) {
            selectedSkillName = commandResult.selectedSkillName;
            input = commandResult.userInput;
          } else {
            pendingSkillName = commandResult.selectedSkillName;
            rl.setPrompt(`你[${pendingSkillName}]> `);
            return;
          }
        } else {
          return;
        }
      }

      // 正常对话（流式输出 + 工具调用展示）
      const loading = new LoadingIndicator();
      loading.start('AI 思考中');
      requestController = new AbortController();
      activeRequest = requestController;
      try {
        await current.agent.run(
          input,
          createRunCallbacks(loading),
          requestController.signal,
          selectedSkillName,
        );
      } finally {
        if (activeRequest === requestController) activeRequest = undefined;
        loading.stop();
      }
      console.log('\n');
    } catch (e: unknown) {
      if (requestController?.signal.aborted) {
        console.log('请求已暂停。');
      } else {
        console.error(`\n错误: ${(e as Error).message}\n`);
      }
    } finally {
      isRequestRunning = false;
      if (!isClosing) {
        rl.prompt();
      }
    }
  });

  rl.on('close', async () => {
    isClosing = true;
    rl.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGINT', handleSigint);
    await closeAgentResources(current);
    console.log('\n再见！');
    process.exit(0);
  });
}

/**
 * 处理 chat 模式下的内置命令
 * 支持 /exit /help /model /mcp /session /compress /memory /skills
 */
async function handleChatCommand(
  input: string,
  current: CreateAgentResult,
  rl: readline.Interface,
  options: {
    mock: boolean;
    sandboxType: 'local' | 'docker';
    mcpServers: Record<string, MCPRemoteServerConfig>;
    mcpCommands: Record<string, MCPStdioServerConfig>;
    disabledMCPNames: string[];
  },
): Promise<ChatCommandResult | undefined> {
  const agent = current.agent;
  const parts = input.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case '/exit':
      rl.close();
      return;

    case '/help':
      console.log(
        `
内置命令:
  /exit              退出
  /model             查看当前模型名称
  /mcp               查看所有 MCP 及生效状态
  /skills                     查看所有已加载 Skill
  /skills <名称或序号> [消息]  选择 Skill，并在本行或下一行聊天
  /session            查看当前会话记录路径
  /session <sid>      切换到指定会话并恢复历史
  /session list       列出所有会话
  /session tree <sid> <rid>  查看某个 run 的树状结构
  /log                查看当前会话的对话列表
  /compress          手动压缩对话历史
  /memory            查看当前记忆

对话进行中按 Ctrl+C 暂停当前请求，再按一次 Ctrl+C 退出
`.trim(),
      );
      break;

    case '/model':
      console.log(`当前模型: ${agent.getModelName()}`);
      break;

    case '/mcp': {
      const statuses = [...current.mcpStatuses].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      if (statuses.length === 0) {
        console.log('暂无 MCP 配置。');
      } else {
        console.log(`\nMCP (${statuses.length} 个):`);
        for (const status of statuses) {
          const label =
            status.state === 'active'
              ? '已生效'
              : status.state === 'disabled'
                ? '未生效（已禁用）'
                : '未生效（连接失败）';
          console.log(`  - ${status.name}: ${label}`);
        }
        console.log('');
      }
      break;
    }

    case '/session': {
      if (parts[1] === 'list') {
        await listSessions();
      } else if (parts[1] === 'tree' && parts[2] && parts[3]) {
        await showSessionTree(parts[2], parts[3]);
      } else if (parts[1]) {
        return {
          switchedAgent: await createAgent({
            ...options,
            sessionId: parts[1],
            resumeSession: true,
          }),
        };
      } else {
        const recorder = agent.getRecorder();
        console.log(`当前会话记录: ${recorder.getFilePath()}`);
      }
      break;
    }

    case '/log':
      await listSessionLogs(agent.getRecorder().getSessionId());
      break;

    case '/compress': {
      const ctx = agent.getContextManager();
      console.log('正在压缩对话历史...');
      await ctx.forceCompress();
      console.log('压缩完成！');
      const summary = ctx.getCompressedSummary();
      if (summary) {
        console.log(`摘要预览: ${summary.slice(0, 200)}...`);
      }
      break;
    }

    case '/memory': {
      const memory = agent.getMemory();
      const short = memory.getAllShort();
      const long = await memory.getAllLong();
      console.log(`\n短期记忆 (${short.length} 条):`);
      for (const e of short) {
        console.log(`  ${e.key}: ${e.value}`);
      }
      console.log(`\n长期记忆 (${long.length} 条):`);
      for (const e of long) {
        console.log(`  ${e.key}: ${e.value}`);
      }
      console.log('');
      break;
    }

    case '/skills': {
      const skills = agent.getSkills();
      const list = skills.listSkills();
      if (list.length === 0) {
        console.log(
          '暂无可用技能。在 _skills/ 目录下创建子目录和 SKILL.md 即可添加技能。',
        );
        break;
      }

      const selection = parts[1];
      if (!selection) {
        console.log(`\nSkills (${list.length} 个):`);
        list.forEach((skill, index) => {
          console.log(`  ${index + 1}. ${skill.name}`);
        });
        console.log('\n使用方式: /skills <名称或序号> [聊天内容]');
        console.log('只选择 Skill 时，可在下一行输入聊天内容。\n');
        break;
      }

      const index = Number(selection);
      const selectedSkill =
        Number.isInteger(index) && index >= 1
          ? list[index - 1]
          : skills.getSkill(selection);
      if (!selectedSkill) {
        console.log(`Skill 不存在: ${selection}，输入 /skills 查看可用列表`);
        break;
      }

      const userInput = parts.slice(2).join(' ').trim();
      if (!userInput) {
        console.log(`已选择 Skill: ${selectedSkill.name}，请继续输入聊天内容。`);
      }
      return {
        selectedSkillName: selectedSkill.name,
        userInput: userInput || undefined,
      };
    }

    default:
      console.log(`未知命令: ${cmd}，输入 /help 查看可用命令`);
  }
}

// ---------- session 命令 ----------
/**
 * 会话记录查看命令
 * 支持 list（列出所有）和 tree（查看详情）
 */
async function sessionCommand(
  subcommand: string,
  args: string[],
): Promise<void> {
  switch (subcommand) {
    case 'list':
      await listSessions();
      break;
    case 'tree':
      if (args.length < 2) {
        console.error('用法: session tree <sessionId> <runId>');
        process.exit(1);
      }
      await showSessionTree(args[0], args[1]);
      break;
    default:
      console.error(`未知 session 子命令: ${subcommand}`);
      console.log('可用: list, tree');
      process.exit(1);
  }
}

// ---------- 主入口 ----------
/**
 * 程序主入口
 * 解析命令行参数，分发到对应的处理函数
 */
async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;

    case 'run':
      if (args.length === 0) {
        console.error('请输入消息内容');
        console.log('用法: npm run cli -- run "你的消息"');
        process.exit(1);
      }
      await runCommand(args.join(' '), flags);
      break;

    case 'chat':
      await chatCommand(flags);
      break;

    case 'skill':
      if (args[0] !== 'add') {
        console.error('用法: npm run cli -- skill add <owner/repo 或 URL>');
        process.exit(1);
      }
      await skillAddCommand(args[1]);
      break;

    case 'session':
      if (args.length === 0) {
        console.error('用法: session list | session tree <sessionId> <runId>');
        process.exit(1);
      }
      await sessionCommand(args[0], args.slice(1));
      break;

    default:
      console.error(`未知命令: ${command}`);
      console.log('输入 npm run cli -- help 查看帮助');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('运行出错:', e.message);
  process.exit(1);
});
