/**
 * @file server.ts
 * @description HTTP/SSE 服务：把 keen-code 的 Agent 能力暴露给 Web 前端
 *
 * 能力：
 *  - POST /v1/chat      SSE 流式对话（token / tool_call / tool_result / done / error）
 *  - DELETE /v1/sessions/:id  删除该会话在 keen-code 的记录与工作目录
 *  - GET  /v1/health    健康检查
 *
 * 设计要点：
 *  - 进程内 Map 长驻每个 session 的 AgentRun 实例，保持对话上下文（类似 CLI chat）
 *  - sessionId 由 Web 端生成并透传，keen-code 的 _sessions/workspace 按该 id 落盘
 *  - 服务重启后，同一 sessionId 会通过 resumeSession 从 JSONL 恢复历史
 */
import 'dotenv/config';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createAgent,
  CreateAgentResult,
  disposeAgent,
} from './agent/agent.js';
import { assertValidSessionId } from './agent/sessions/session.js';
import type { ToolCall } from './agent/types.js';
import { projectPath } from './paths.js';

const PORT = Number(process.env.KEEN_CODE_PORT || process.env.PORT || 8787);

const sessionsRoot = projectPath('_sessions');
const workspaceRoot = projectPath('workspace');

/** 进程内长驻的 Agent 会话实例 */
interface AgentHolder {
  runtime: CreateAgentResult;
  mock: boolean;
}
const agents = new Map<string, AgentHolder>();
const activeRuns = new Map<string, AbortController>();

/** 发送一条 SSE data 事件 */
function sendSSE(
  res: http.ServerResponse,
  obj: Record<string, unknown>,
): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/** 获取（或创建）某个会话的 Agent 实例 */
async function getOrCreateAgent(
  sessionId: string,
  mock: boolean,
  signal: AbortSignal,
): Promise<AgentHolder> {
  const existing = agents.get(sessionId);
  // mock 模式切换时重建
  if (existing && existing.mock === mock) return existing;

  if (existing) {
    await disposeAgent(existing.runtime);
    agents.delete(sessionId);
  }

  const created = await createAgent({
    sessionId,
    mock,
    resumeSession: true, // 有历史则恢复，无历史则为空
    signal,
  });
  const holder: AgentHolder = {
    runtime: created,
    mock,
  };
  agents.set(sessionId, holder);
  return holder;
}

/** 处理 /v1/chat：SSE 流式对话 */
async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (e as Error).message }));
    return;
  }

  const sessionId = String(body.sessionId || '');
  const message = String(body.message || '').trim();
  const mock = body.mock === true;

  if (!sessionId || !message) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'sessionId 和 message 不能为空' }));
    return;
  }
  try {
    assertValidSessionId(sessionId);
  } catch (error: unknown) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (error as Error).message }));
    return;
  }

  if (activeRuns.has(sessionId)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '该会话正在处理上一条消息' }));
    return;
  }

  const requestController = new AbortController();
  activeRuns.set(sessionId, requestController);
  const handleDisconnect = (): void => {
    if (!res.writableEnded) requestController.abort();
  };
  res.once('close', handleDisconnect);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  try {
    const holder = await getOrCreateAgent(
      sessionId,
      mock,
      requestController.signal,
    );
    // agent.run 的返回值才是真正的最终回答：
    //  - 模型直接流式输出文本时，返回累计的完整 content；
    //  - 模型通过 finish 工具一次性提交 answer 时（无 token 流），
    //    返回的是 finish 的 answer 参数。绝不能忽略，否则 done 事件
    //    携带的内容会残缺，导致 Web 端历史记录不全。
    let streamed = '';
    const runAnswer = await holder.runtime.agent.run(
      message,
      {
        onToken: (delta: string) => {
          streamed += delta;
          sendSSE(res, { type: 'token', content: delta });
        },
        onToolCall: (tc: ToolCall) => {
          sendSSE(res, {
            type: 'tool_call',
            name: tc.name,
            args: tc.arguments,
          });
        },
        onToolResult: (toolName: string, result: unknown) => {
          sendSSE(res, { type: 'tool_result', name: toolName, result });
        },
      },
      requestController.signal,
    );

    const finalAnswer = runAnswer || streamed;

    // finish 工具可能一次性返回答案，补发尚未通过 token 事件发送的部分。
    const remaining = finalAnswer.startsWith(streamed)
      ? finalAnswer.slice(streamed.length)
      : '';
    if (remaining) {
      sendSSE(res, { type: 'token', content: remaining });
    }

    sendSSE(res, { type: 'done', answer: finalAnswer });
  } catch (e) {
    if (!requestController.signal.aborted) {
      sendSSE(res, { type: 'error', message: (e as Error).message });
    }
  } finally {
    activeRuns.delete(sessionId);
    res.removeListener('close', handleDisconnect);
    if (!res.writableEnded) res.end();
  }
}

/** 删除一个会话在 keen-code 侧的全部数据 */
async function handleDeleteSession(
  sessionId: string,
  res: http.ServerResponse,
): Promise<void> {
  try {
    assertValidSessionId(sessionId);
  } catch (error: unknown) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (error as Error).message }));
    return;
  }
  activeRuns.get(sessionId)?.abort();
  activeRuns.delete(sessionId);
  const holder = agents.get(sessionId);
  agents.delete(sessionId);
  if (holder) await disposeAgent(holder.runtime);
  const targets = [
    path.join(sessionsRoot, sessionId),
    path.join(workspaceRoot, sessionId),
  ];
  for (const dir of targets) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (e) {
      console.error(`清理 ${dir} 失败:`, (e as Error).message);
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sessionId }));
}

/** 简单路由分发 */
async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        name: 'keen-code server',
        port: PORT,
        activeSessions: agents.size,
      }),
    );
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/chat') {
    await handleChat(req, res);
    return;
  }

  const deleteMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    await handleDeleteSession(decodeURIComponent(deleteMatch[1]), res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found', path: pathname }));
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: (e as Error).message }));
  });
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请设置 KEEN_CODE_PORT 更换端口`);
  } else {
    console.error(`keen-code server 启动失败: ${error.message}`);
  }
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`keen-code server 已启动: http://127.0.0.1:${PORT}`);
  console.log(`  POST   /v1/chat              (SSE 流式对话)`);
  console.log(`  DELETE /v1/sessions/:id      (删除会话数据)`);
  console.log(`  GET    /v1/health`);
  console.log(`  真实模式使用 .env 中的 DEEPSEEK 配置；body.mock=true 走 MockLLM`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const controller of activeRuns.values()) controller.abort();
  activeRuns.clear();
  server.close();
  server.closeAllConnections();

  const runtimes = [...agents.values()].map((holder) => holder.runtime);
  agents.clear();
  await Promise.allSettled(runtimes.map((runtime) => disposeAgent(runtime)));
  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
