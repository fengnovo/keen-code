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

/**
 * 有序 SSE 写入器：所有事件都走同一条 Promise 队列，保证
 * token / tool_call / done 等事件顺序不被打乱。
 * sendTokens 会把较大的一段文本切成小片按时间间隔下发，
 * 使「finish 一次性返回」「非流式兜底」等场景也能在页面上看到逐字流式输出。
 */
function createSSEWriter(res: http.ServerResponse) {
  let chain: Promise<void> = Promise.resolve();

  /** 队列化一个写任务（串行执行，异常不阻断后续） */
  function enqueue(task: () => Promise<void> | void): void {
    chain = chain.then(async () => {
      await task();
    }).catch(() => undefined);
  }

  return {
    /** 立即（按队列顺序）发送一个事件对象 */
    send(obj: Record<string, unknown>): void {
      enqueue(() => {
        try { sendSSE(res, obj); } catch { /* ignore */ }
      });
    },
    /**
     * 发送一段 assistant 文本：
     *  - 文本很短（<= maxPiece）：直接作为一个 token 事件，不加额外延迟；
     *  - 文本较长：切成 maxPiece 字符的小片，每片间隔 delayMs 下发，模拟流式。
     * @returns 该段文本按码点计的长度（供统计已流式输出字符数）
     */
    sendTokens(text: string, delayMs = 12, maxPiece = 8): number {
      const chars = Array.from(text); // 按码点切分，避免截断代理对
      if (chars.length === 0) return 0;
      if (chars.length <= maxPiece) {
        const payload = JSON.stringify({ type: 'token', content: text });
        enqueue(() => {
          try { res.write(`data: ${payload}\n\n`); } catch { /* ignore */ }
        });
        return chars.length;
      }
      const pieces: string[] = [];
      for (let i = 0; i < chars.length; i += maxPiece) {
        pieces.push(chars.slice(i, i + maxPiece).join(''));
      }
      let flush: Promise<void> = Promise.resolve();
      for (const piece of pieces) {
        const payload = JSON.stringify({ type: 'token', content: piece });
        flush = flush.then(
          () =>
            new Promise<void>((resolve) => {
              try { res.write(`data: ${payload}\n\n`); } catch { /* ignore */ }
              setTimeout(resolve, delayMs);
            }),
        );
      }
      enqueue(() => flush);
      return chars.length;
    },
    /** 等待队列中的全部写入完成 */
    flush(): Promise<void> {
      return chain;
    },
  };
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

  const writer = createSSEWriter(res);

  try {
    const holder = await getOrCreateAgent(sessionId, mock);
    // agent.run 的返回值才是真正的最终回答：
    //  - 模型直接流式输出文本时，返回累计的完整 content；
    //  - 模型通过 finish 工具一次性提交 answer 时（无 token 流），
    //    返回的是 finish 的 answer 参数。绝不能忽略，否则 done 事件
    //    携带的内容会残缺，导致 Web 端历史记录不全。
    let streamed = '';
    // 已以 token 形式下发的字符数（按码点计）
    let streamedChars = 0;

    const runAnswer = await holder.agent.run(message, {
      onToken: (delta: string) => {
        streamed += delta;
        streamedChars += writer.sendTokens(delta);
      },
      onToolCall: (tc: ToolCall) => {
        writer.send({
          type: 'tool_call',
          name: tc.name,
          args: tc.arguments,
        });
      },
      onToolResult: (toolName: string, result: unknown) => {
        writer.send({ type: 'tool_result', name: toolName, result });
      },
    });

    const finalAnswer = runAnswer || streamed;

    // 若最终回答中还有未流式输出的部分（例如由 finish 工具一次性返回），
    // 切成小片补发，保证页面始终能看到逐字流式效果。
    // 仅当已流式文本是最终回答的前缀时才补发，避免中间文本与最终回答
    // 内容不一致时在页面上重复拼接。
    const remaining = finalAnswer.startsWith(streamed)
      ? Array.from(finalAnswer).slice(streamedChars).join('')
      : '';
    if (remaining) {
      writer.sendTokens(remaining);
    }

    writer.send({ type: 'done', answer: finalAnswer });
    // 等待队列写空后再结束响应
    await writer.flush?.();
  } catch (e) {
    writer.send({ type: 'error', message: (e as Error).message });
    try { await writer.flush?.(); } catch { /* ignore */ }
  } finally {
    try { res.end(); } catch { /* ignore */ }
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
