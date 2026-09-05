/**
 * @file sessionView.ts
 * @description 会话记录查看工具
 *
 * 提供两个功能：
 * - list：列出所有会话和 run 文件
 * - tree：以树状结构展示单个 run 的所有事件
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionEvent } from './session.js';

// 定位 sessions 根目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const sessionsRoot = path.join(projectRoot, '_sessions');

/**
 * 列出所有会话记录
 * 遍历 _sessions/ 下的所有会话目录和 JSONL 文件
 */
export async function listSessions(): Promise<void> {
  try {
    const sessions = await fs.readdir(sessionsRoot, { withFileTypes: true });
    const sessionDirs = sessions.filter((s) => s.isDirectory());

    if (sessionDirs.length === 0) {
      console.log('暂无会话记录');
      return;
    }

    console.log('=== 会话列表 ===\n');

    for (const session of sessionDirs) {
      const sessionDir = path.join(sessionsRoot, session.name);
      const files = await fs.readdir(sessionDir);
      const runFiles = files.filter((f) => f.endsWith('.jsonl'));

      console.log(`会话: ${session.name}`);
      console.log(`  run 文件数: ${runFiles.length}`);

      for (const runFile of runFiles) {
        const runPath = path.join(sessionDir, runFile);
        const stat = await fs.stat(runPath);
        const content = await fs.readFile(runPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        // 从第一条和最后一条事件中提取摘要信息
        let firstInput = '';
        let lastOutput = '';
        let eventCount = lines.length;

        try {
          const firstEvent: SessionEvent = JSON.parse(lines[0]);
          if (firstEvent.type === 'session_start') {
            firstInput = String(
              (firstEvent.data as { userInput?: string }).userInput || '',
            ).slice(0, 50);
          }
          const lastEvent: SessionEvent = JSON.parse(lines[lines.length - 1]);
          if (lastEvent.type === 'session_end') {
            lastOutput = String(
              (lastEvent.data as { finalAnswer?: string }).finalAnswer || '',
            ).slice(0, 50);
          }
        } catch {
          // JSON 解析失败，忽略
        }

        console.log(`  - ${runFile.replace('.jsonl', '')}`);
        console.log(
          `    事件数: ${eventCount} | 修改时间: ${stat.mtime.toLocaleString()}`,
        );
        if (firstInput) console.log(`    输入: ${firstInput}...`);
        if (lastOutput) console.log(`    输出: ${lastOutput}...`);
      }
      console.log('');
    }
  } catch (e) {
    console.error('读取会话列表失败:', (e as Error).message);
  }
}

/**
 * 以树状结构展示单个 run 的所有事件
 * @param sessionId 会话 ID
 * @param runId 运行 ID
 */
export async function showSessionTree(
  sessionId: string,
  runId: string,
): Promise<void> {
  const runPath = path.join(sessionsRoot, sessionId, `${runId}.jsonl`);

  try {
    const content = await fs.readFile(runPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    if (lines.length === 0) {
      console.log('会话记录为空');
      return;
    }

    console.log(`=== 会话详情 ===`);
    console.log(`会话: ${sessionId}`);
    console.log(`Run: ${runId}`);
    console.log(`事件数: ${lines.length}\n`);

    let currentTurn = 0;
    const events: SessionEvent[] = lines.map((l) => JSON.parse(l));

    for (const event of events) {
      // turn_start/end 缩进 0，其他事件缩进 1
      const indent = '  '.repeat(
        event.type === 'turn_start' || event.type === 'turn_end' ? 0 : 1,
      );
      const symbol = getEventSymbol(event.type);
      const desc = getEventDescription(event);

      if (event.type === 'turn_start') {
        currentTurn++;
        console.log(`\n${symbol} Turn ${currentTurn}`);
      } else if (event.type === 'turn_end') {
        console.log(`${indent}${symbol} turn end — ${desc}`);
      } else {
        console.log(`${indent}${symbol} ${desc}`);
      }
    }
  } catch (e) {
    console.error('读取会话记录失败:', (e as Error).message);
    console.log('请确认 sessionId 和 runId 是否正确');
  }
}

/** 获取事件类型对应的 emoji 符号 */
function getEventSymbol(type: string): string {
  const symbols: Record<string, string> = {
    session_start: '🚀',
    session_end: '✅',
    turn_start: '🔄',
    turn_end: '↩️',
    llm_call: '🤔',
    llm_response: '💬',
    tool_call: '🔧',
    tool_result: '📦',
  };
  return symbols[type] || '•';
}

/** 根据事件类型生成可读的描述文本 */
function getEventDescription(event: SessionEvent): string {
  const d = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'session_start':
      return `开始: ${String(d.userInput || '').slice(0, 60)}`;
    case 'session_end':
      return `最终回答: ${String(d.finalAnswer || '').slice(0, 60)}`;
    case 'llm_call':
      return `LLM 调用 (${d.messageCount} 条消息, ${((d.tools as string[]) || []).length} 个工具)`;
    case 'llm_response': {
      const toolCalls = d.toolCallCount as number;
      const contentLen = d.contentLength as number;
      return `LLM 响应 (${contentLen} 字文本, ${toolCalls} 个工具调用)`;
    }
    case 'tool_call':
      return `调用工具: ${d.toolName}`;
    case 'tool_result': {
      const len = d.resultLength as number;
      return `${d.toolName} 结果 (${len} 字符)`;
    }
    case 'turn_end':
      return `输出 ${d.outputLength} 字`;
    default:
      return event.type;
  }
}
