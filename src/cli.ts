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
import { DockerSandbox } from './agent/sandbox/dockerSandbox.js';
import { AgentRun } from './agent/loop.js';
import { ToolCall, RunCallbacks } from './agent/types.js';
import { LoadingIndicator } from './utils/loading.js';
import * as readline from 'node:readline';

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
  session list           列出所有 会话记录
  session tree <sid> <tid>  以树状结构查看单个 run
  help                 显示此帮助信息

选项:
  --mock               使用 Mock LLM（不调用真实 API）
  --sandbox <type>     沙箱类型: local (默认) / docker
  --mcp <name=url>     接入远程 MCP 服务（可多次使用）
  --mcp-command <name=command args...>
                       接入本地 stdio MCP 服务（可多次使用）

示例:
  npm run cli -- run "你好"
  npm run cli -- run "你好" --mock
  npm run chat
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
  const mcpServers = parseMCPArgs((flags.mcp as string[]) || []);
  const mcpCommands = parseMCPCommandArgs(
    (flags['mcp-command'] as string[]) || [],
  );

  const { agent, sandbox, sessionId } = await createAgent({
    mock,
    sandboxType: sandboxType as 'local' | 'docker',
    mcpServers,
    mcpCommands,
  });

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

  // 清理 Docker 容器
  if (sandbox instanceof DockerSandbox) {
    await sandbox.destroy();
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
  const mcpServers = parseMCPArgs((flags.mcp as string[]) || []);
  const mcpCommands = parseMCPCommandArgs(
    (flags['mcp-command'] as string[]) || [],
  );

  let current = await createAgent({
    mock,
    sandboxType: sandboxType as 'local' | 'docker',
    mcpServers,
    mcpCommands,
  });

  const recorder = current.agent.getRecorder();
  console.log('=== keen-code chat 模式 ===');
  console.log('输入 /exit 退出，/help 查看内置命令');
  console.log(`Session: ${recorder.getSessionId()}`);
  console.log(`Run:   ${recorder.getRunId()}`);
  console.log(`工作目录: ${current.sandbox.getWorkDir()}`);
  console.log('');

  // 创建 readline 交互
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '你> ',
  });
  let isClosing = false;
  let activeRequest: AbortController | undefined;

  rl.prompt();

  const handleSigint = (): void => {
    if (activeRequest && !activeRequest.signal.aborted) {
      activeRequest.abort();
      console.log('\n已暂停当前请求，再次按 Ctrl+C 退出。');
    } else {
      rl.close();
    }
  };
  process.on('SIGINT', handleSigint);

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Agent 运行期间暂停 readline，避免流式输出与当前输入提示互相覆盖
    rl.pause();
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);

    let requestController: AbortController | undefined;
    try {
      // 处理内置命令（以 / 开头）
      if (input.startsWith('/')) {
        const switched = await handleChatCommand(input, current.agent, rl, {
          mock,
          sandboxType: sandboxType as 'local' | 'docker',
          mcpServers,
          mcpCommands,
        });
        if (switched) {
          if (current.sandbox instanceof DockerSandbox) {
            await current.sandbox.destroy();
          }
          current = switched;
          console.log(`已切换到会话: ${current.sessionId}`);
          console.log(`工作目录: ${current.sandbox.getWorkDir()}`);
        }
        return;
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
      if (!isClosing) {
        rl.resume();
        rl.prompt();
      }
    }
  });

  rl.on('close', async () => {
    isClosing = true;
    process.removeListener('SIGINT', handleSigint);
    // 退出时清理 Docker 容器
    if (current.sandbox instanceof DockerSandbox) {
      await current.sandbox.destroy();
    }
    console.log('\n再见！');
    process.exit(0);
  });
}

/**
 * 处理 chat 模式下的内置命令
 * 支持 /exit /help /session /compress /memory /skills
 */
async function handleChatCommand(
  input: string,
  agent: AgentRun,
  rl: readline.Interface,
  options: {
    mock: boolean;
    sandboxType: 'local' | 'docker';
    mcpServers: Record<string, string>;
    mcpCommands: Record<string, { command: string; args: string[] }>;
  },
): Promise<CreateAgentResult | undefined> {
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
  /session            查看当前会话记录路径
  /session <sid>      切换到指定会话并恢复历史
  /session list       列出所有会话
  /session tree <sid> <rid>  查看某个 run 的树状结构
  /log                查看当前会话的对话列表
  /compress          手动压缩对话历史
  /memory            查看当前记忆
  /skills            列出可用技能

对话进行中按 Ctrl+C 暂停当前请求，再按一次 Ctrl+C 退出
`.trim(),
      );
      break;

    case '/session': {
      if (parts[1] === 'list') {
        await listSessions();
      } else if (parts[1] === 'tree' && parts[2] && parts[3]) {
        await showSessionTree(parts[2], parts[3]);
      } else if (parts[1]) {
        return createAgent({
          ...options,
          sessionId: parts[1],
          resumeSession: true,
        });
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
      } else {
        console.log(`\n可用技能 (${list.length} 个):`);
        for (const s of list) {
          console.log(`  - ${s.name}: ${s.description}`);
        }
        console.log('');
      }
      break;
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
