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
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent/agent.js';
import type { ToolCall } from './agent/types.js';

const PORT = Number(process.env.KEEN_CODE_PORT || process.env.PORT || 8787);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const sessionsRoot = path.join(projectRoot, '_sessions');
const workspaceRoot = path.join(projectRoot, 'workspace');

/** 进程内长驻的 Agent 会话实例 */
interface AgentHolder {
  agent: Awaited<ReturnType<typeof createAgent>>['agent'];
  sandbox: Awaited<ReturnType<typeof createAgent>>['sandbox'];
  mock: boolean;
}
const agents = new Map<string, AgentHolder>();

/** 发送一条 SSE data 事件 */
function sendSSE(
  res: http.ServerResponse,
  obj: Record<string, unknown>,
): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** 读取请求 JSON body */
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
): Promise<AgentHolder> {
  const existing = agents.get(sessionId);
  // mock 模式切换时重建
  if (existing && existing.mock === mock) return existing;

  const created = await createAgent({
    sessionId,
    mock,
    resumeSession: true, // 有历史则恢复，无历史则为空
  });
  const holder: AgentHolder = {
    agent: created.agent,
    sandbox: created.sandbox,
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  try {
    const holder = await getOrCreateAgent(sessionId, mock);
    let finalAnswer = '';

    await holder.agent.run(message, {
      onToken: (delta: string) => {
        finalAnswer += delta;
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
    });

    sendSSE(res, { type: 'done', answer: finalAnswer });
  } catch (e) {
    sendSSE(res, { type: 'error', message: (e as Error).message });
  } finally {
    res.end();
  }
}

/** 删除一个会话在 keen-code 侧的全部数据 */
async function handleDeleteSession(
  sessionId: string,
  res: http.ServerResponse,
): Promise<void> {
  agents.delete(sessionId);
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

server.listen(PORT, () => {
  console.log(`keen-code server 已启动: http://127.0.0.1:${PORT}`);
  console.log(`  POST   /v1/chat              (SSE 流式对话)`);
  console.log(`  DELETE /v1/sessions/:id      (删除会话数据)`);
  console.log(`  GET    /v1/health`);
  console.log(`  真实模式使用 .env 中的 DEEPSEEK 配置；body.mock=true 走 MockLLM`);
});
