# keen-code

一个 AI Agent Harness（框架），用 TypeScript 从零搭建，支持工具调用、沙箱隔离、记忆系统、技能加载、流式输出、会话记录和远程 MCP 接入。

---

## 目录

- [架构图](#架构图)
- [核心流程图](#核心流程图)
- [启动与组装流程](#启动与组装流程)
- [单轮请求的精确执行流程](#单轮请求的精确执行流程)
- [取消、回滚与资源回收](#取消回滚与资源回收)
- [会话恢复流程](#会话恢复流程)
- [项目结构](#项目结构)
- [模块说明](#模块说明)
- [快速开始](#快速开始)
- [常用命令](#常用命令)
- [chat 模式内置命令](#chat-模式内置命令)
- [内置工具](#内置工具)
- [沙箱](#沙箱)
- [会话记录系统](#会话记录系统)
- [记忆系统](#记忆系统)
- [技能系统](#技能系统)
- [MCP](#mcp)
- [HTTP/SSE 服务](#httpsse-服务)
- [配置说明](#配置说明)

---

## 架构图

### 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        keen-code                             │
│                                                                 │
│  ┌──────────┐    ┌──────────────────────────────────────────┐   │
│  │          │    │              AgentRun (loop)              │   │
│  │ CLI/HTTP │    │  ┌─────────────────────────────────────┐ │   │
│  │  入口层  │───▶│  │  1. 首轮注入 system prompt          │ │   │
│  │          │    │  │  2. 注入记忆 + 技能摘要               │ │   │
│  │ run      │    │  │  3. 调用 LLM (流式)                  │ │   │
│  │ chat     │    │  │  4. 解析响应 → 文本 or 工具调用       │ │   │
│  │ SSE/API  │    │  │  5. 执行工具 → 结果回传 LLM → 循环    │ │   │
│  │          │    │  │  6. finish 工具 → 结束本轮            │ │   │
│  └──────────┘    │  └─────────────────────────────────────┘ │   │
│                  └──────────────────────────────────────────┘   │
│       │              │            │            │          │     │
│       ▼              ▼            ▼            ▼          ▼     │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌───────┐  ┌───────┐ │
│  │  LLM    │  │ Context  │  │ Memory  │  │Skill  │  │ SessionRecorder│ │
│  │ Provider│  │ Manager  │  │ Manager │  │Manager│  │       │ │
│  │         │  │ (压缩)   │  │ (短期+  │  │ (加载 │  │ (JSONL │
│  │ Mock /  │  │          │  │  长期)  │  │  SKILL│  │ 记录)│ │
│  │DeepSeek │  │          │  │         │  │  .md) │  │       │ │
│  └─────────┘  └──────────┘  └─────────┘  └───────┘  └───────┘ │
│       │                                                        │
│       │              ┌────────────────────────────────┐        │
│       │              │       ToolRegistry             │        │
│       └─────────────▶│  run_shell / read_file /       │        │
│                      │  write_file / finish /         │        │
│                      │  remember / recall /           │        │
│                      │  use_skill / [MCP tools...]    │        │
│                      └───────────┬────────────────────┘        │
│                                  │                             │
│                                  ▼                             │
│                      ┌────────────────────────────┐            │
│                      │       Sandbox              │            │
│                      │  ┌──────────────────────┐  │            │
│                      │  │ LocalSandbox          │  │            │
│                      │  │ (本地 workspace 目录) │  │            │
│                      │  └──────────────────────┘  │            │
│                      │  ┌──────────────────────┐  │            │
│                      │  │ DockerSandbox         │  │            │
│                      │  │ (Docker 容器隔离)     │  │            │
│                      │  └──────────────────────┘  │            │
│                      └────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### 模块依赖关系

```
cli.ts ──────┐
             ├── agent.ts（工厂函数，创建并组装所有组件）
server.ts ───┘
        ├── llm.ts (LLM Provider)
        ├── loop.ts (Agent 主循环)
        │     ├── types.ts (类型定义)
        │     ├── context.ts (上下文管理 + 历史压缩)
        │     ├── sessions/session.ts (会话记录器)
        │     └── tools/
        │           ├── registry.ts (工具注册表 + zod→JSON Schema)
        │           └── builtin.ts (内置工具实现)
        ├── sandbox/sandbox.ts (本地沙箱)
        ├── sandbox/dockerSandbox.ts (Docker 沙箱)
        ├── memory.ts (记忆系统 + 记忆工具)
        ├── skills/skills.ts (技能系统 + 技能工具)
        ├── mcp/mcpConfig.ts (MCP JSON 配置解析)
        ├── mcp/mcp.ts (MCP 连接与工具包装)
        ├── mcp/mcpSecurity.ts (MCP 工具安全扫描)
        └── sessions/sessionView.ts (会话记录查看)
```

CLI 和 HTTP Server 只是两种交互入口，不各自实现 Agent。模型、上下文、
工具、MCP、Skill、记忆、会话记录和沙箱都由 `agent.ts` 统一组装，最后交给
`AgentRun` 驱动。资源释放也统一经过 `disposeAgent`，避免两个入口各维护一套
清理逻辑。入口可以传入不同选项：CLI 会把解析后的 MCP 和沙箱类型传给工厂；
当前 Server 只传 sessionId、mock 和恢复标记，因此使用默认本地沙箱且不加载
MCP 配置。

---

## 核心流程图

### Agent 主循环（ReAct 模式）

```
用户输入
    │
    ▼
┌─────────────────────────┐
│ 1. 构建 system prompt    │
│    注入记忆 + 技能摘要    │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ 2. 检查是否需要压缩历史   │──── 否 ────┐
│    (>20轮 → 压缩为摘要)  │             │
└────────────┬────────────┘             │
             │ 是                        │
             ▼                           │
┌─────────────────────────┐             │
│ 3. 调用 LLM 压缩旧消息   │             │
│    保留最近约 18 条消息    │             │
└────────────┬────────────┘             │
             │                           │
             ▼ ◀─────────────────────────┘
┌─────────────────────────┐
│ 4. 调用 LLM (流式)       │◀──────────────────┐
│    传入消息历史 + 工具列表│                    │
└────────────┬────────────┘                    │
             │                                  │
             ▼                                  │
        ┌────────┐                              │
        │有工具调用?│                             │
        └───┬────┘                              │
         是 │ │ 否                               │
            │ ▼                                  │
            │ ┌─────────────────────┐            │
            │ │ 返回文本回答，结束    │            │
            │ └─────────────────────┘            │
            ▼                                    │
┌─────────────────────────┐                    │
│ 5. 逐个执行工具调用       │                    │
│    onToolCall 回调通知    │                    │
│    onToolResult 回调通知  │                    │
│    结果加回消息历史       │                    │
└────────────┬────────────┘                    │
             │                                  │
             ▼                                  │
        ┌────────┐                              │
        │调了finish?│                            │
        └───┬────┘                              │
         是 │ │ 否                               │
            │ ▼                                  │
            │ ┌─────────────────────┐            │
            │ │ 返回 finish.answer   │            │
            │ │ 结束本轮             │            │
            │ └─────────────────────┘            │
            ▼                                    │
┌─────────────────────────┐                    │
│ 6. 工具调用次数 < 20？    │                    │
│    是 → 回到步骤 4 ──────┼────────────────────┘
│    否 → 返回最后一条回答  │
└─────────────────────────┘
```

### 流式输出 + 工具调用时序

```
CLI                    Loop                  LLM              Sandbox
 │                      │                    │                  │
 │  agent.run(input)    │                    │                  │
 │─────────────────────▶│                    │                  │
 │                      │  llm.chat(msgs,    │                  │
 │                      │    tools, onToken) │                  │
 │                      │───────────────────▶│                  │
 │  onToken("你")       │  delta: "你"       │                  │
 │◀─────────────────────│◀───────────────────│                  │
 │  onToken("好")       │  delta: "好"       │                  │
 │◀─────────────────────│◀───────────────────│                  │
 │                      │  返回 LLMResponse  │                  │
 │                      │  (content +        │                  │
 │                      │   tool_calls)      │                  │
 │                      │◀───────────────────│                  │
 │                      │                    │                  │
 │  onToolCall(...)     │  executeToolCall   │                  │
 │◀─────────────────────│                    │                  │
 │                      │  sandbox.runShell  │                  │
 │                      │──────────────────────────────────────▶│
 │  onToolResult(...)   │  result            │                  │
 │◀─────────────────────│◀──────────────────────────────────────│
 │                      │                    │                  │
 │                      │  再次调用 LLM...    │                  │
 │                      │───────────────────▶│                  │
 │                      │  ...               │                  │
```

### 上下文压缩流程

```
消息历史: [system] [user1] [ai1] [tool1] [user2] [ai2] ... [user20] [ai20]
                                                                  │
                                                                  ▼
                                                        超过 20 轮？
                                                         │ 是
                                                         ▼
                                              ┌─────────────────────┐
                                              │ 分离 system 消息     │
                                              │ 和对话消息           │
                                              └──────────┬──────────┘
                                                         │
                                                         ▼
                                              ┌─────────────────────┐
                                              │ 按“每轮约3条消息”估算 │
                                              │ 保留最后 18 条消息    │
                                              └──────────┬──────────┘
                                                         │
                                                         ▼
                                              ┌─────────────────────┐
                                              │ 将旧消息交给 LLM     │
                                              │ 生成压缩摘要         │
                                              └──────────┬──────────┘
                                                         │
                                                         ▼
                                              ┌─────────────────────┐
                                              │ 新消息历史:          │
                                              │ [system] [摘要]     │
                                              │ [最后18条原始消息]   │
                                              └─────────────────────┘
```

---

## 启动与组装流程

### CLI 启动流程

~~~
npm run cli -- chat
         │
         ▼
1. parseArgs 解析 command、位置参数和 flags
         │
         ▼
2. resolveMCPConfig 读取 .mcp.json
         │
         ├── 合并 --mcp 参数
         ├── 合并 --mcp-command 参数
         ├── 命令行同名配置覆盖 JSON
         └── 保留 disabled MCP 状态
         │
         ▼
3. createAgent 创建运行环境
         │
         ▼
4. 输出运行时信息
         ├── 当前模型名称
         ├── 已加载 Skill 名称
         ├── 已生效 MCP 名称
         ├── 系统工具名称
         └── 完整 System Prompt
         │
         ▼
5. 创建 readline，显示“你>”提示符
         │
         ▼
6. 等待普通消息或斜杠命令
~~~

run 命令和 chat 命令使用相同的配置解析及 createAgent。区别是 run 只执行
一次 AgentRun.run，输出记录路径后释放资源；chat 会让 AgentRun 常驻，
因此上下文、短期记忆和 workspace 能在多轮消息之间继续使用。

### MCP 配置合并顺序

~~~
.mcp.json
    │
    ├── mcpServers 中的远程 HTTP/SSE 配置
    ├── mcpServers 中的本地 stdio 配置
    └── disabled: true 的名称
             │
             ▼
--mcp / --mcp-command
             │
             ├── 同名命令行配置覆盖 JSON
             ├── 远程与 stdio 类型也可相互覆盖
             └── 同一个名称最终只能保留一种传输
             │
             ▼
RuntimeMCPConfig
    ├── mcpServers
    ├── mcpCommands
    └── disabledMCPNames
~~~

如果显式传入 --mcp-config，而文件不存在或 JSON 不合法，会直接报错。默认
.mcp.json 不存在时则视为没有 MCP，不影响普通聊天。

### createAgent 组装步骤

createAgent 是整个项目的 composition root，实际顺序如下：

1. 确定 mock、sandboxType、sessionId、MCP 配置和 AbortSignal。
2. 生成或校验 sessionId。ID 只允许字母、数字、下划线和连字符，并限制
   长度，校验发生在创建 workspace 目录之前。
3. 调用 createLLM：mock 模式创建 MockLLM，否则创建 DeepSeekLLM。
4. 创建沙箱：
   - local 创建 LocalSandbox；
   - docker 创建 DockerSandbox，但容器到第一次 run_shell 时才启动。
5. 创建 MemoryManager，并准备全局长期记忆目录。
6. 创建 SkillManager，扫描项目根目录的 _skills/*/SKILL.md。
7. 创建 SessionRecorder，为本次 AgentRun 生成新的 runId 和 JSONL 路径。
8. 创建 ToolRegistry，依次注册文件、shell、记忆、Skill 和 finish 工具。
9. 保存 systemToolNames。此时 MCP 工具尚未注册，所以该列表只包含系统工具。
10. 并行连接全部启用的 MCP，而不是逐个等待：
    - 连接成功，记录 active 并注册工具；
    - 连接失败，关闭对应客户端并记录 failed；
    - disabled 项不连接，只记录 disabled。
11. MCP 全部处理完后创建 AgentRun。工具定义在构造阶段生成并缓存。
12. 如果 resumeSession 为 true，从 JSONL 中恢复完整轮次。
13. 返回 AgentRun、Sandbox、MCP 客户端、MCP 状态和运行时名称列表。

createAgent 返回的不只是 agent，还包含需要清理的 MCP 客户端和沙箱。因此
调用方结束使用后必须把完整返回值交给 disposeAgent。

### chat 启动输出为什么在创建 Agent 之后

模型名称来自实际 LLM Provider；Skill 来自扫描结果；MCP 状态只有建立连接后
才能确定；系统工具来自 ToolRegistry；System Prompt 又依赖 workspace、
记忆和 Skill 摘要。因此这些信息必须等 createAgent 完成后才能准确输出。

System Prompt 会在首次读取时生成并缓存。chat 启动阶段打印的内容，就是后续
首轮请求实际使用的内容，不会为了第一条消息再重复读取记忆和 Skill。

---

## 单轮请求的精确执行流程

每次调用 AgentRun.run 都被视为一个事务：

~~~
run(userInput)
    │
    ├── 保存 turnCount 和 Context checkpoint
    ├── turnCount + 1
    │
    ▼
runTurn
    │
    ├── 首轮：注入缓存的 System Prompt
    ├── 首轮：记录 session_start
    ├── 每轮：记录 turn_start
    ├── 可选：注入用户选择的完整 Skill
    ├── 添加 user message
    ├── maybeCompress
    │
    ▼
LLM / Tool 循环
    │
    ├── 成功：记录 turn_end，保留新上下文
    └── 异常或取消：恢复 checkpoint 和 turnCount
~~~

### 第一阶段：准备本轮上下文

1. 在修改上下文前创建 checkpoint，保存消息数组和已有压缩摘要。
2. 第一轮加入 system message，并写入 session_start。
3. 写入 turn_start，记录原始用户输入。
4. 如果通过 /skills 选择了 Skill，将完整 SKILL.md 与原始请求组合成本轮
   user message。JSONL 的 turn_start 仍保存原始输入，便于阅读日志。
5. 将 user message 放入 ContextManager。
6. 用户轮数超过阈值时调用 maybeCompress，压缩过程共用本轮 AbortSignal。

### 第二阶段：调用 LLM

1. 从 ContextManager 取得 system、摘要和最近消息。
2. 使用 AgentRun 构造时缓存的 ToolDefinition 数组。
3. 写入 llm_call，保存消息数量和工具名称。
4. 调用 LLMProvider.chat，并传入 onToken 和 AbortSignal。
5. 每个文本增量立即交给 CLI 或 Server，不经过额外打字机队列。
6. 流结束后写入 llm_response，包括完整文本、长度和工具调用数量。

DeepSeekLLM 会优先使用流式接口。只有服务端明确返回“不支持流式”的状态，
并且还没有收到任何文本或工具调用时，才回退到非流式请求。普通网络错误不会
自动重试，已经收到部分内容时也不会重发，避免同一任务被重复执行。

### 第三阶段：处理 LLM 响应

如果没有 tool_calls：

1. 把完整 assistant 文本加入上下文。
2. 写入 turn_end。
3. 返回最终答案，本轮结束。

如果存在 tool_calls：

1. 根据本轮剩余工具额度截取可接受的调用，保证总数不超过 20。
2. 把带 tool_calls 的 assistant message 加入上下文。
3. 对每个调用触发 onToolCall，让 CLI/Server 展示名称和参数。
4. ToolRegistry 查找工具并通过 Zod 校验参数。
5. 执行工具，同时向 shell 或 MCP 继续传递 AbortSignal。
6. 写入 tool_call 和 tool_result。
7. 触发 onToolResult。
8. 把工具结果作为 tool message 加回上下文。
9. 如果其中包含 finish，读取 finish.answer，写入 turn_end 并结束。
10. 否则携带工具结果重新调用 LLM。

达到 20 个工具后不再执行新工具，返回最近的 assistant 内容或停止提示，从而
避免模型持续调用工具形成无限循环。

### 流式内容的去向

~~~
DeepSeek / Mock
      │ delta
      ▼
AgentRun.onToken
      │
      ├── CLI：直接写入 stdout
      └── Server：立即写入 SSE token 事件

工具调用
      ├── onToolCall   → CLI 提示 / SSE tool_call
      └── onToolResult → CLI 结果 / SSE tool_result

最终结果
      ├── CLI：结束当前提示并继续读取输入
      └── Server：SSE done，answer 保存完整最终文本
~~~

finish 的 answer 可能没有经过模型 token 流。Server 会只补发尚未流式发送的
剩余部分，然后发送 done，不再切成字符或人为 sleep。

---

## 取消、回滚与资源回收

### Ctrl+C 的执行路径

~~~
用户按 Ctrl+C
      │
      ├── 当前有请求
      │      └── AbortController.abort()
      │              ├── DeepSeek 请求取消
      │              ├── run_shell 子进程取消
      │              ├── MCP callTool 取消
      │              └── 上下文压缩取消
      │
      └── 当前无请求
             └── 关闭 readline 并退出
~~~

LLM Provider 即使没有及时响应 AbortSignal，AgentRun 外层的 waitWithAbort 也会
先结束当前等待。底层 Promise 随后完成或失败时会被安全接收，不会产生未处理的
Promise rejection。

### 为什么取消后需要回滚

工具调用模式下，assistant message 可能已经包含 tool_calls。如果请求恰好在
工具结果返回前中断，直接保留这段上下文会形成“有 tool_call、没有 tool
response”的非法消息序列，下次模型请求可能报错。

因此 run 在开始前保存 Context checkpoint。只要本轮抛出异常或被取消，就恢复
本轮之前的 messages、compressedSummary 和 turnCount。已经输出到终端的局部
文本不会进入下一轮模型上下文。

JSONL 中可能留下 turn_start、llm_call 或 tool_call 等诊断事件，但没有
turn_end。恢复逻辑只组合完整的 turn_start + turn_end，所以这些半截记录也
不会污染恢复后的会话。

### disposeAgent 清理顺序

1. 并行调用全部 MCP Client.close。
2. 最多等待 2 秒，防止损坏的 MCP 阻塞 CLI 退出。
3. 清除关闭等待定时器，避免正常退出额外停留。
4. 如果使用 DockerSandbox，停止并删除容器。

以下场景都会执行资源清理：

- run 命令完成或失败；
- chat 正常退出；
- /session 切换到另一个 Agent；
- Server 删除 session；
- Server 收到 SIGINT 或 SIGTERM；
- createAgent 在恢复历史阶段失败。

### 长模型响应与超时

DEEPSEEK_TIMEOUT_MS 默认为 0，表示项目不主动设置较短的业务超时，因为真实
模型确实可能长时间推理。OpenAI SDK 自动重试已关闭，避免一次网络挂起被放大
为多次等待。需要限制时间时可显式配置超时；不限制时仍可以使用 Ctrl+C 取消。

---

## 会话恢复流程

~~~
/session sess_xxx
       │
       ├── createAgent(sessionId, resumeSession: true)
       ├── 扫描 _sessions/sess_xxx/*.jsonl
       ├── 忽略损坏的 JSONL 行
       ├── 每个 run 内按 turnId 配对
       │      ├── turn_start.userInput
       │      └── turn_end.output
       ├── 丢弃未完成轮次
       ├── 按 timestamp 合并全部完整轮次
       ├── 重新生成当前 System Prompt
       ├── 恢复 user / assistant 消息
       └── 释放旧 Agent 的 MCP/Docker 资源
~~~

恢复时不重放历史工具调用，只恢复每个完整轮次的用户输入和最终回答。这样可以
避免重新执行有副作用的工具，又能让模型获得对话语义。切换后继续使用同一个
workspace/<sessionId>，但新 AgentRun 会创建新的 run_xxx.jsonl 文件。

---

## 项目结构

```
keen-code/
├── src/
│   ├── cli.ts                        # CLI 入口
│   ├── server.ts                     # HTTP/SSE 入口
│   ├── paths.ts                      # 项目路径统一解析
│   └── agent/
│       ├── agent.ts                  # Agent 工厂函数，组装所有组件
│       ├── types.ts                  # 核心类型定义（消息、工具、回调等）
│       ├── llm.ts                    # LLM 层：MockLLM + DeepSeekLLM（流式）
│       ├── loop.ts                   # Agent 主循环（ReAct 模式）
│       ├── context.ts                # 上下文管理器（消息历史 + 自动压缩）
│       ├── mcp/                      # MCP 配置、连接及安全扫描
│       ├── memory.ts                 # 记忆系统（短期 + 长期 + 3个工具）
│       ├── skills/                   # 技能系统
│       │   └── skills.ts             # 加载 SKILL.md + use_skill 工具
│       ├── sandbox/                  # 沙箱模块
│       │   ├── sandbox.ts            # 本地沙箱（workspace 目录隔离）
│       │   └── dockerSandbox.ts      # Docker 沙箱（容器隔离执行）
│       ├── sessions/                 # 会话记录模块
│       │   ├── session.ts            # 会话记录器（JSONL 格式）
│       │   └── sessionView.ts        # 会话记录查看器（list / tree）
│       └── tools/
│           ├── registry.ts           # 工具注册表（注册/执行/zod→JSON Schema）
│           └── builtin.ts            # 内置工具（run_shell/read_file/write_file/finish）
├── _skills/                           # 技能目录
│   └── example/
│       └── SKILL.md                  # 示例技能
├── workspace/                        # 沙箱工作目录（按会话隔离）
│   └── sess_xxx/                     # 每个会话一个子目录
├── _memory/                           # 长期记忆存储
│   └── long_term.json                # 长期记忆 JSON 文件
├── _sessions/                         # 会话记录目录
│   └── sess_xxx/                     # 每个会话一个目录
│       └── run_xxx.jsonl             # 每个 AgentRun 实例一个 JSONL 文件
├── package.json
├── tsconfig.json
├── .env.example                      # 环境变量模板
├── .mcp.json.example                 # MCP 配置模板
├── .env                              # 本地环境变量（不提交）
└── .mcp.json                         # 本地 MCP 配置（不提交）
```

---

## 模块说明

### 1. CLI 入口 (`cli.ts`)

命令行入口，解析用户输入的命令和参数，分发到对应的处理函数。

- **run 命令**：单轮对话模式，输入一条消息，输出 AI 回答后退出
- **chat 命令**：交互式对话模式，支持多轮对话和内置命令
- **skill add 命令**：借助 npx skills 下载，再复制到项目 `_skills/`
- **session 命令**：查看历史 会话记录

支持流式输出（`onToken` 回调逐字打印）和工具调用过程展示（`onToolCall` / `onToolResult` 回调）。

### 2. Agent 工厂 (`agent.ts`)

`createAgent()` 是核心工厂函数，负责：
1. 生成会话 ID
2. 创建 LLM 实例（Mock 或 DeepSeek）
3. 创建沙箱（按会话 ID 隔离工作目录）
4. 创建记忆管理器
5. 加载技能
6. 创建 SessionRecorder
7. 注册所有内置工具
8. 并行接入 HTTP/SSE/stdio MCP 服务
9. 缓存工具定义并组装成 `AgentRun` 实例
10. 可选恢复会话，并返回可统一释放的运行时资源

### 3. Agent 主循环 (`loop.ts`)

`AgentRun.run()` 是 Agent 的核心方法，实现 ReAct（Reason + Act）循环：

1. 首轮构建并缓存 system prompt（注入记忆、技能摘要）
2. 添加用户消息到上下文
3. 检查并执行历史压缩
4. 循环调用 LLM：
   - 如果 LLM 返回纯文本 → 直接返回
   - 如果 LLM 返回工具调用 → 执行工具 → 结果回传 LLM → 继续循环
   - 如果调用了 `finish` 工具 → 返回 finish 的 answer
   - 每轮最多执行 20 个工具，防止死循环

### 4. LLM 层 (`llm.ts`)

- **MockLLM**：不调用真实 API，逐字模拟流式输出，用于本地调试
- **DeepSeekLLM**：通过 OpenAI 兼容接口调用 DeepSeek 模型
  - 使用 `stream: true` 流式接口
  - 逐 chunk 累积文本内容和工具调用
  - 只在服务端明确不支持流式、且未收到部分结果时回退到非流式
  - 请求超时由 `DEEPSEEK_TIMEOUT_MS` 控制，SDK 自动重试关闭

### 5. 上下文管理 (`context.ts`)

管理消息历史，当用户消息超过 20 条时自动压缩：
- 按每轮约 3 条消息估算，保留最后 18 条非 system 消息
- 将旧消息交给 LLM 生成压缩摘要
- 摘要作为 system 消息注入到上下文中
- 单轮执行前创建 checkpoint，取消或异常时恢复上轮状态
- 压缩请求也会传递 AbortSignal

### 6. 沙箱 (`sandbox.ts` / `dockerSandbox.ts`)

- **LocalSandbox**：在本地 `workspace/<sessionId>/` 目录中执行命令
  - 路径穿越防护（`resolvePath` 检查路径不越界）
  - 30 秒超时，1MB 输出上限
- **DockerSandbox**：在 Docker 容器中执行命令
  - 使用 `node:22.12.0` 镜像
  - workspace 目录挂载到容器的 `/workspace`
  - 懒加载启动，结束时自动清理容器

### 7. 记忆系统 (`memory.ts`)

- **短期记忆**：Map 结构，只在当前会话内有效
- **长期记忆**：持久化到 `_memory/long_term.json`，跨会话保留
- **检索方式**：关键词匹配（后续可扩展为向量检索）
- **并发写入**：进程内排队执行读-改-写，临时文件落盘后原子替换
- 提供 3 个工具：`remember`（短期）、`remember_longterm`（长期）、`recall`（检索）

### 8. 技能系统 (`skills/skills.ts`)

自动扫描 `_skills/*/SKILL.md` 文件，加载为技能：
- 从 SKILL.md 中提取简短描述
- 优先读取 YAML frontmatter 中的 `description`，没有时再取首个普通段落
- 技能摘要注入到 system prompt
- 提供 `use_skill` 工具，AI 可主动读取技能的完整说明

### 9. 会话记录系统 (`sessions/session.ts` / `sessions/sessionView.ts`)

记录 Agent 执行的全过程到 JSONL 文件：
- `turn_start` / `turn_end`：对话轮次
- `llm_call` / `llm_response`：LLM 调用记录
- `tool_call` / `tool_result`：工具调用记录
- `session_start`：记录会话开始和首次输入

`sessionView.ts` 提供查看功能：
- `list`：列出所有 会话记录
- `tree`：以树状结构展示单个 run

恢复时只读取存在 `turn_start` 和 `turn_end` 的完整轮次。中途取消的
诊断事件会保留在 JSONL 中，但不会恢复进模型上下文。

### 10. 工具注册表 (`tools/registry.ts`)

- 注册工具（`register`）
- 执行工具时自动用 Zod 校验参数
- 将 Zod Schema 转换为 JSON Schema 供 LLM 使用
- AgentRun 创建后缓存转换结果，不在每次 LLM 循环重复转换

### 11. MCP (`mcp/`)

CLI 自动加载 `.mcp.json`，并通过 `@modelcontextprotocol/client` 连接 MCP 服务：
- 自动选择传输方式（SSE 或 StreamableHTTP）
- 支持本地 stdio MCP 服务
- 将远程工具注册到本地 ToolRegistry
- 工具名加前缀 `<服务名>__<工具名>` 避免冲突
- 多个 MCP 并行连接，单个失败不阻止其他服务启动
- 工具注册前执行安全扫描，默认跳过 critical/high 工具
- 连接、工具调用和客户端关闭都纳入统一生命周期

### 12. 路径模块 (`paths.ts`)

- 以 `src/paths.ts` 的物理位置推导项目根目录
- `_skills`、`_sessions`、`_memory` 和 `workspace` 都通过 `projectPath()` 解析
- 避免每个模块各写一套 `fileURLToPath + dirname + ../..`

### 13. HTTP/SSE 服务 (`server.ts`)

- 在进程内按 sessionId 缓存 AgentRun，保持多轮上下文
- 同一 sessionId 同时只允许一个请求，并发返回 409
- 客户端断开时 abort 当前 Agent
- 直接转发 `token`、`tool_call`、`tool_result`、`done` 和 `error`
- 删除 session 时先取消请求、释放资源，再删除记录和 workspace
- SIGINT/SIGTERM 时统一取消活动请求并清理资源

### 14. LoadingIndicator (`utils/loading.ts`)

CLI 在等待 LLM 或工具时用定时器显示状态。一旦收到 token、工具事件、
请求完成或抛错，都会停止定时器，避免 spinner 让 Node.js 进程无法退出。

---

## 快速开始

### 1. 准备运行环境

- Node.js 20 或更高版本，推荐使用 Node.js 22
- npm
- Docker（只有使用 `--sandbox docker` 时才需要）

确认版本：

```bash
node --version
npm --version
```

### 2. 安装依赖

```bash
npm install
```

主要运行依赖包括 OpenAI 兼容客户端、MCP Client、Zod、dotenv 和 tsx。安装
完成后可先运行类型检查，确认本地 TypeScript 环境正常：

```bash
npm run typecheck
```

### 3. 准备环境变量

```bash
cp .env.example .env
```

打开 `.env`，至少替换 `DEEPSEEK_API_KEY`。如果只使用 Mock 模式，可以暂时不
填写真实 Key。

### 4. 先用 Mock 模式验证基础链路

```bash
npm run cli -- run "你好" --mock
```

这个命令会依次创建 session、workspace、MockLLM、内置工具和 JSONL 记录，流式
打印一次回答，随后释放资源并退出。它不验证真实模型和模型工具调用能力。

### 5. 启动真实模型

```bash
npm run cli -- run "你好"
```

如果 API Key、Base URL 或模型名不正确，错误会直接返回，不会自动重试。请求
成功后终端会显示本次会话记录的绝对路径。

### 6. 启动多轮 chat

```bash
npm run chat
```

chat 会先完成 Skill 扫描和 MCP 连接，再输出：

```text
模型: deepseek-v4-flash
Skills: example
MCP: chrome
系统工具: run_shell, read_file, write_file, remember, remember_longterm, recall, use_skill, finish
System Prompt:
...当前实际使用的完整系统提示词...

你>
```

列表内容取决于本地配置。之后可连续输入普通消息，或使用 `/model`、`/mcp`、
`/skills`、`/session` 等内置命令。

### 7. 可选：启动 HTTP/SSE Server

```bash
npm run serve
```

看到 `keen-code server 已启动: http://127.0.0.1:8787` 后，可按后面的
HTTP/SSE 章节用 curl 或 Web 客户端接入。

---

## 常用命令

```bash
# 单轮对话
npm run cli -- run "你的消息"
npm run cli -- run "你的消息" --mock          # Mock 模式
npm run cli -- run "你的消息" --sandbox docker # Docker 沙箱

# 交互式对话
npm run chat
npm run cli -- chat --mock
npm run cli -- chat --sandbox docker
npm run cli -- chat --mcp tandem=https://example.com/mcp
npm run cli -- chat --mcp-config ./configs/mcp.json

# HTTP/SSE 服务
npm run serve
KEEN_CODE_PORT=9000 npm run serve

# 安装 Skill 到当前项目的 _skills/（不会全局安装）
npm run cli -- skill add vercel-labs/agent-skills
npm run cli -- skill add https://modelscope.cn/skills/@anthropics/skill-creator

# 会话记录查看
npm run cli -- session list
npm run cli -- session tree <sessionId> <runId>
npm run cli -- session tree sess_1788604755830_rirvgs run_1788604755834_g4ays1

# 类型检查
npm run typecheck

# 帮助
npm run cli -- help
```

在 `chat` 模式中，可以先用 `/session list` 找到会话 ID，再输入
`/session <sessionId>` 切回该会话。Agent 会恢复已记录的用户和助手消息，并切换到该会话的 workspace。

---

## chat 模式内置命令

| 命令 | 说明 |
|------|------|
| `/exit` | 退出对话 |
| `/help` | 查看可用命令 |
| `/model` | 查看当前模型名称 |
| `/mcp` | 查看全部 MCP 及生效状态 |
| `/skills` | 查看所有已加载 Skill（带序号） |
| `/skills <名称或序号>` | 选择 Skill，下一行输入聊天内容 |
| `/skills <名称或序号> <消息>` | 选择 Skill 并直接发送聊天内容 |
| `/session` | 查看当前会话记录路径 |
| `/session <sessionId>` | 切换到指定会话并恢复历史 |
| `/session list` | 列出所有 会话记录 |
| `/session tree <sid> <rid>` | 查看某个 run 的树状结构 |
| `/log` | 查看当前 session 的对话列表和每条输入摘要 |
| `/compress` | 手动压缩对话历史 |
| `/memory` | 查看当前记忆（短期 + 长期） |

聊天请求进行中按一次 `Ctrl+C` 会取消当前 LLM 请求或 shell 工具，再按一次 `Ctrl+C` 退出程序。

### 命令分发规则

1. readline 读到一行后先去掉首尾空白；空行只重新显示提示符。
2. 以 `/` 开头的内容交给内置命令处理，除 `/skills ... <消息>` 外不会发送给
   LLM，也不会增加对话轮次。
3. 普通文本调用当前 AgentRun 的 `run()`，因此沿用当前上下文、短期记忆、
   workspace 和 MCP 连接。
4. `/session <sid>` 会先尝试创建并恢复目标 Agent；成功后才释放旧 Agent，避免
   目标会话损坏时直接丢掉当前可用会话。
5. `/skills <名称或序号>` 没有附带消息时只记录一次待选择状态，并把提示符改为
   `你[skill-name]>`；下一条普通文本才真正运行 Agent。
6. 请求运行期间再次输入一行不会启动第二次 run，而是提示当前请求仍在处理。

`/model`、`/mcp` 和 `/skills` 展示的都是启动时实际创建出来的运行时状态，不是
直接回显配置文件。因此 MCP 连接失败会出现在 `/mcp`，但不会出现在启动摘要的
“已生效 MCP”名称列表里。

---

## 内置工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `run_shell` | 在沙箱中执行 shell 命令 | `command`: string |
| `read_file` | 读取工作目录内的文件 | `path`: string |
| `write_file` | 写入工作目录内的文件 | `path`: string, `content`: string |
| `finish` | 提交最终回答，结束任务 | `answer`: string |
| `remember` | 写入短期记忆（当前会话有效） | `key`: string, `value`: string |
| `remember_longterm` | 写入长期记忆（持久化） | `key`: string, `value`: string |
| `recall` | 检索长期记忆（关键词匹配） | `query`: string, `limit`?: number |
| `use_skill` | 读取技能的完整说明 | `name`: string |

---

## 沙箱

每个会话有独立的工作目录：`workspace/<sessionId>/`

```
workspace/
├── sess_1788586747294_pntui3/    # 会话 A
│   └── hello.js
├── sess_1788586800000_xxxxxx/    # 会话 B
│   └── ...
└── ...
```

- **LocalSandbox**（默认）：直接在宿主机执行，适合本地开发调试，但不提供进程隔离
- **DockerSandbox**：在容器中执行 shell 命令，只将当前会话目录挂载到 `/workspace`
  - 需要本地安装 Docker
  - 默认镜像：`node:22.12.0`
  - 禁用网络、Linux capabilities 和提权，并限制进程数、内存和 CPU
  - `read_file` / `write_file` 的路径检查不等于进程隔离
  - `run_shell` 可以访问宿主机上工作目录之外的文件
  - 不要对不可信的 Prompt、MCP 或模型使用 `--sandbox local`

Docker 只隔离 Agent 执行的 shell 命令；Agent 进程本身以及已配置的 MCP 服务仍运行在宿主机上。不要把 Docker socket、宿主机敏感目录或额外的 host mount 暴露给容器。若需要更强的生产级隔离，应使用独立虚拟机或专用 sandbox runtime。

---

## 会话记录系统

每个 `AgentRun` 实例使用一个 JSONL 文件，其中按 turn 记录多轮 `agent.run()` 的完整执行过程：

```
_sessions/
└── sess_1788586747294_pntui3/
    └── run_1788586747297_ao900q.jsonl
```

每行一个 JSON 事件，包含时间戳、事件类型、轮次 ID 和数据。

事件类型：

| 事件 | 说明 |
|------|------|
| `session_start` | 会话开始，记录用户输入 |
| `turn_start` | 一轮对话开始 |
| `llm_call` | LLM 调用，记录消息数和工具列表 |
| `llm_response` | LLM 响应，记录内容长度和工具调用数 |
| `tool_call` | 工具调用，记录工具名和参数 |
| `tool_result` | 工具结果，记录返回值（截断 1000 字符） |
| `turn_end` | 一轮对话结束，记录输出 |

`session_end` 仍保留在 TypeScript 类型和查看器中，用于读取旧版本已经生成的
记录；当前版本不再写入该事件。是否完成一轮对话以 `turn_end` 为准。

### 一轮记录的写入顺序

~~~
第一次 run
    ├── session_start  turnId=0
    └── turn_start     turnId=1
            ├── llm_call
            ├── llm_response
            ├── tool_call       可能重复多次
            ├── tool_result     与 tool_call 对应
            ├── llm_call        工具结果回传后再次推理
            ├── llm_response
            └── turn_end

第二次 run
    └── turn_start     turnId=2
            └── ...
~~~

所有记录方法都会等待 `appendFile` 完成后再进入下一步，所以同一个 AgentRun
产生的事件顺序与实际执行顺序一致。`llm_response.content` 和
`turn_end.output` 保存完整内容，便于服务端恢复完整回答；工具结果可能非常大，
因此 `tool_result.data.result` 只保存前 1000 个字符，同时用 `resultLength`
记录原始长度。

事件示例：

```json
{"timestamp":"2026-09-06T10:00:00.000Z","type":"turn_start","turnId":1,"data":{"userInput":"列出当前目录"}}
{"timestamp":"2026-09-06T10:00:01.000Z","type":"tool_call","turnId":1,"data":{"toolName":"run_shell","args":{"command":"ls -la"}}}
{"timestamp":"2026-09-06T10:00:01.100Z","type":"tool_result","turnId":1,"data":{"toolName":"run_shell","result":"{\"stdout\":\"...\"}","resultLength":32}}
{"timestamp":"2026-09-06T10:00:02.000Z","type":"turn_end","turnId":1,"data":{"output":"目录内容如下……","outputLength":8}}
```

### 查看记录

```bash
# 列出所有 session、run、事件数量、首个输入和最后输出摘要
npm run cli -- session list

# 展开一个 run 的完整事件树
npm run cli -- session tree <sessionId> <runId>
```

chat 内也可以使用 `/session list`、`/session tree <sid> <rid>` 和 `/log`。
其中 `/log` 会跨当前 session 下的所有 run 文件，按时间排序后列出每条用户
输入的摘要。

### 从记录恢复上下文

1. 校验 sessionId，禁止斜杠、点号和其他可能造成路径穿越的字符。
2. 读取 `_sessions/<sessionId>/` 下全部 JSONL 文件。
3. 忽略无法解析的单行，避免一条损坏记录阻止整个会话恢复。
4. 在每个文件中按 turnId 配对 `turn_start` 与 `turn_end`。
5. 只保留配对成功的轮次；取消、崩溃或断线留下的半截轮次会被丢弃。
6. 将所有完整轮次按开始时间排序，恢复成 `user`、`assistant` 消息。
7. 重新生成当前版本的 System Prompt，并放在恢复消息之前。

恢复过程不会重放 `tool_call`，因此不会重复执行 shell、写文件或远程 MCP 等
有副作用的操作。详细调用链见前面的“会话恢复流程”。

---

## 记忆系统

### 短期记忆

- 存储在内存 Map 中，当前 Agent 实例释放后消失
- chat 多轮对话和 Server 复用同一 Agent 时会保留；切换会话、切换 mock 模式或
  重启进程后不会从 JSONL 恢复
- 用于记录当前会话的临时信息

### 长期记忆

- 持久化到 `_memory/long_term.json`
- 跨会话保留
- 按关键词匹配检索
- 格式：

```json
[
  {
    "key": "用户偏好",
    "value": "喜欢用 TypeScript",
    "createdAt": "2026-09-05T12:00:00.000Z"
  }
]
```

### 记忆进入 System Prompt 的流程

~~~
createAgent
    └── new MemoryManager()
            └── 准备 _memory/ 目录

首次 getSystemPrompt()
    └── getMemorySummary()
            ├── 读取当前 Agent 的全部短期记忆
            ├── 读取 long_term.json
            ├── 长期记忆只选最后 10 条
            └── 生成【短期记忆】/【长期记忆】文本
                    └── 拼入 System Prompt 并缓存
~~~

System Prompt 在 Agent 生命周期内只构建一次。因此本轮通过工具新增的记忆会
立即写入 MemoryManager，但不会反向修改已经缓存的 System Prompt。模型仍能
从该工具的返回结果和当前对话上下文知道刚刚写入了什么；新建或恢复 Agent 时，
长期记忆会重新进入 Prompt。

### 三个记忆工具如何工作

| 工具 | 执行过程 | 生命周期 |
|------|----------|----------|
| `remember` | 以 key 写入当前 MemoryManager 的 Map；同名 key 覆盖 | 当前 Agent 实例 |
| `remember_longterm` | 读取 JSON → 按 key 更新或新增 → 写临时文件 → rename | 跨 Agent、跨会话 |
| `recall` | key 和 value 做不区分大小写的包含匹配，返回最近结果 | 读取长期记忆 |

`recall` 的 query 为空时直接返回最近若干条，默认 `limit=5`。当前实现是简单
字符串检索，不做分词、向量化或语义相似度计算。

### 并发写入保护

HTTP Server 可能同时运行多个不同 session，而这些 Agent 共享同一个
`long_term.json`。长期记忆写入在进程内进入同一条 Promise 队列，确保
“读 → 修改 → 写”不会相互覆盖；保存时先写同目录临时文件，再通过 rename
替换正式文件，减少进程中断造成半个 JSON 文件的风险。

这个锁只覆盖当前 Node.js 进程。如果同时启动多个 keen-code 进程并频繁写同一
份长期记忆，仍应改为数据库或增加跨进程文件锁。

---

## 技能系统

在 `_skills/` 目录下创建子目录，放置 `SKILL.md` 文件即可添加技能：

```
_skills/
└── my-skill/
    └── SKILL.md
```

推荐的 SKILL.md 格式：

```markdown
---
name: my-skill
description: 用一句话说明这个 Skill 解决什么问题
---

# 技能名称

详细的使用说明...
```

`name` 字段可以帮助其他 Skill 工具识别，但 keen-code 当前以目录名作为实际
Skill 名称。描述优先取 YAML frontmatter 的单行 `description`；没有该字段时，
才取正文中第一个非标题、非代码块的段落。描述最多保留 200 个字符。

### 启动加载流程

~~~
createAgent
    └── SkillManager.loadAll()
            ├── 扫描 <项目根目录>/_skills/
            ├── 只处理直接子目录
            ├── 查找 <skill-name>/SKILL.md
            ├── 读取完整文件
            ├── 提取最多 200 字的描述
            └── 保存为 name → Skill 的内存 Map
                    │
                    ├── 描述列表注入 System Prompt
                    └── 完整内容由 use_skill 按需返回
~~~

子目录没有 `SKILL.md`、`_skills/` 不存在或某个文件无法读取时，该项会被跳过，
不会阻止 Agent 启动。Skill 只在创建 Agent 时扫描；安装新 Skill 后，需要重新
启动 chat，或切换会话创建新的 Agent，才能进入已加载列表。

### 通过命令安装 Skill

```bash
# GitHub 的 owner/repo 形式
npm run cli -- skill add vercel-labs/agent-skills

# 完整 URL
npm run cli -- skill add https://modelscope.cn/skills/@anthropics/skill-creator
```

该命令的完整执行流程：

~~~
skill add <source>
    │
    ├── 在系统临时目录创建 keen-code-skill-* staging 目录
    ├── 以 staging 为 cwd 启动：
    │      npx skills add <source> --agent promptscript --copy
    ├── npx 自行下载并解析仓库或 URL
    ├── 从 staging/.agents/skills/ 收集安装结果
    ├── 检查项目 _skills/ 中是否有同名目录
    │      ├── 有：整体停止，不覆盖任何已有 Skill
    │      └── 无：复制到 <项目根目录>/_skills/<name>/
    └── 无论成功失败，都删除 staging 临时目录
~~~

这里调用 `npx skills` 只是借用其下载和解析能力。最终文件会复制到命令执行
目录的 `_skills/`，不会安装到用户级或系统全局 Skill 目录。使用标准的
`npm run cli -- skill add ...` 时应先进入 keen-code 项目根目录，这样安装位置
才与 Agent 扫描的 `<项目根目录>/_skills/` 一致。安装过程中 `npx` 的输出和
交互会直接显示在当前终端。

### 在 chat 中选择 Skill

先输入 `/skills` 查看带序号的已加载列表，然后可以按名称或序号选择：

```text
你> /skills
Skills (2 个):
  1. skill-creator
  2. ui-ux-pro-max

你> /skills 2 帮我设计一个开发者首页
```

也可以先选择，再在下一行发送请求：

```text
你> /skills ui-ux-pro-max
已选择 Skill: ui-ux-pro-max，请继续输入聊天内容。
你[ui-ux-pro-max]> 帮我设计一个开发者首页
```

执行时，Agent 会把所选 Skill 的完整 `SKILL.md`、约束提示和原始用户请求组合
成一条仅供本轮使用的 user message。它不会先让模型猜参数，也不需要模型调用
`use_skill` 才能看到内容。没有通过 `/skills` 显式选择时，模型仍可根据 System
Prompt 中的 Skill 摘要，自行调用 `use_skill(name: ...)` 读取完整说明。

`/skills` 只影响紧接着的一条普通聊天消息。该轮结束后提示符恢复为 `你>`，
下一轮不会自动沿用之前选择的 Skill。

---

## MCP

### JSON 配置（推荐）

`run` 和 `chat` 启动时会自动读取当前目录下的 `.mcp.json`。配置格式兼容
Claude Code 常用的 `mcpServers` 结构，同时支持远程 HTTP/SSE 和本地 stdio
服务：

```json
{
  "mcpServers": {
    "chrome": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "env": {
        "NODE_OPTIONS": "--no-warnings=ExperimentalWarning"
      }
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_TOKEN}"
      }
    }
  }
}
```

- `type` 支持 `stdio`、`http`、`streamable-http` 和 `sse`
- stdio 支持 `args`、`env`、`cwd`、`stderr`
- stdio 的 stderr 默认静默捕获，连接失败时才显示；调试时可设为 `inherit`
- HTTP/SSE 支持 `headers`
- 字符串值支持 `${ENV_VAR}` 和 `${ENV_VAR:-default}` 环境变量展开
- 设置 `"disabled": true` 可暂时禁用服务
- 可通过 `--mcp-config <path>` 指定其他 JSON 文件
- `--mcp` 和 `--mcp-command` 仍然可用，并覆盖 JSON 中的同名配置

仓库中的 `.mcp.json.example` 可以直接作为模板。

### JSON 解析与覆盖规则

1. 没有传 `--mcp-config` 时，从当前命令执行目录读取 `.mcp.json`。默认文件不存在等同于空配置。
2. 显式传了 `--mcp-config <path>` 后，文件不存在、JSON 语法错误或字段类型错误都会终止启动，并显示字段位置。
3. 每个服务必须配置 `url` 或 `command`，不能同时配置两者。
4. `cwd` 相对路径以 MCP 配置文件所在目录为基准，不以 Agent workspace 为基准。
5. `url`、`command`、`args`、`cwd`、`env` 和 `headers` 中的字符串都会做环境变量展开。没有默认值的变量未设置时会报错；写了 `:-default` 时使用默认值。
6. JSON 解析完成后再合并命令行参数。命令行同名项总是覆盖 JSON，即使一个是远程 HTTP、另一个是本地 stdio。
7. JSON 中 `disabled: true` 的名称会保留用于状态展示；如果命令行重新配置了同名服务，则视为显式启用。

环境变量展开支持 `${ENV_VAR}` 和 `${ENV_VAR:-default}` 两种写法。第一种在
变量未设置时终止启动，第二种会使用冒号后面的默认值。

### MCP 建立连接和注册工具的流程

~~~
全部启用的 MCP 配置
       │
       ├── HTTP/SSE：创建对应 ClientTransport
       └── stdio：启动 command + args 子进程
               │
               ▼
        Client.connect（全部并行）
               │
               ▼
        Client.listTools
               │
               ▼
        扫描服务地址、工具名、描述和 inputSchema
               │
               ├── critical/high：默认不注册该工具
               └── 其余：包装成本地 Tool
                         └── 注册为 <mcpName>__<remoteToolName>
               │
               ▼
        active / failed 状态汇总
~~~

远程配置显式写 `type: "sse"` 时使用 SSE；写 `http` 或
`streamable-http` 时使用 Streamable HTTP。省略 type 时，URL 含 `/sse`
则选择 SSE，否则选择 Streamable HTTP。

stdio 服务默认把 stderr 设为 `pipe`：正常启动时不把服务自己的 banner、
遥测说明和 Node warning 混到 keen-code 的启动信息里；连接失败时会附带最后
8000 个字符帮助排查。需要实时看子进程日志时，可在 JSON 中写
`"stderr": "inherit"`；完全丢弃则写 `"ignore"`。

MCP 连接失败只把该服务标记为 failed，不会阻止其他 MCP 或 Agent 启动。已经
成功连接的客户端会一直保留到 run 结束、chat 退出、会话切换或 Server 清理，
然后由 `disposeAgent` 关闭。

### `/mcp` 状态含义

| 状态 | 含义 | 是否注册工具 |
|------|------|--------------|
| `已生效` | Client 已连接且 listTools 完成 | 是，但被安全规则拦截的单个工具除外 |
| `未生效（已禁用）` | JSON 配置了 `disabled: true` | 否 |
| `未生效（连接失败）` | 启动、握手或 listTools 失败 | 否 |

chat 启动摘要中的 `MCP:` 只列出已成功连接的名称；输入 `/mcp` 才会看到全部
配置及其状态。active 表示连接成功，不保证服务返回的每个工具都通过安全扫描。
当前 HTTP/SSE Server 入口没有读取 CLI 的 `.mcp.json`，MCP 自动加载范围是
`run` 和 `chat` 命令。

当前阻断逻辑只处理能够关联到具体工具名的 critical/high 发现。服务 URL 的
HTTP/SSRF 等传输层发现会进入扫描结果，但尚未展示在 `/mcp` 中，也不会单独把
整个服务标为 failed；生产环境仍应只配置经过信任审查的 HTTPS MCP 地址。

### 命令行配置

通过 `--mcp` 参数接入远程 MCP 服务：

```bash
npm run cli -- chat --mcp tandem=https://tandem.ac/mcp

# 用真实的 MCP 服务地址
npm run cli -- chat --mcp tandem=https://your-mcp.example.com/mcp
```

- 远程工具会以 `<服务名>__<工具名>` 的格式注册
- 需要安装 `@modelcontextprotocol/client` 包
- 自动选择 SSE 或 StreamableHTTP 传输方式

### Chrome DevTools MCP

Chrome DevTools MCP 是本地 stdio 服务，不是 HTTP 服务。项目已支持通过
`--mcp-command` 启动它：

```bash
# 首次运行会由 npx 下载 chrome-devtools-mcp；也可以先手动执行预热
npx -y chrome-devtools-mcp@latest --help

# 启动 keen-code，并注册 Chrome DevTools MCP 工具
npm run cli -- chat \
  --mcp-command "chrome=npx -y chrome-devtools-mcp@latest"
```

连接成功后，工具会以 `chrome__<toolName>` 的名称注册到 Agent。需要使用本地
Chrome 和 DevTools 时，请确保 Chrome 已安装；MCP 服务启动时会按其自身配置连接或启动 Chrome。

也可以在单轮模式中使用：

```bash
npm run cli -- run "打开当前页面并检查控制台错误" \
  --mcp-command "chrome=npx -y chrome-devtools-mcp@latest"
```

`--mcp-command` 的值必须整体加引号，因为命令包含多个参数。项目使用的
`@modelcontextprotocol/client` 已提供 stdio transport，无需额外安装 MCP 客户端包。

---

## HTTP/SSE 服务

HTTP 入口把同一个 AgentRun 能力提供给浏览器或其他客户端。启动命令：

```bash
npm run serve

# 更换端口
KEEN_CODE_PORT=9000 npm run serve
```

默认监听 `8787`。端口读取顺序是 `KEEN_CODE_PORT`、`PORT`、`8787`；如果端口
已占用，进程会明确提示通过 `KEEN_CODE_PORT` 更换。

### 接口一览

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/v1/health` | 健康检查及当前缓存的 Agent session 数量 |
| `POST` | `/v1/chat` | 创建或复用 Agent，并以 SSE 返回一轮聊天 |
| `DELETE` | `/v1/sessions/:id` | 取消请求、释放 Agent，并删除会话记录和 workspace |
| `OPTIONS` | 任意路径 | CORS 预检 |

### POST /v1/chat 请求

请求体：

```json
{
  "sessionId": "sess_web_001",
  "message": "读取 package.json 并说明项目结构",
  "mock": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 客户端生成；只允许字母、数字、下划线、连字符，最长 128 字符 |
| `message` | string | 是 | 用户输入；去掉首尾空白后不能为空 |
| `mock` | boolean | 否 | 仅严格等于 `true` 时使用 MockLLM |

请求体上限为 2 MiB。JSON 不合法、字段为空或 sessionId 不合法时，服务在建立
SSE 前返回 `400 application/json`。同一个 sessionId 已有请求运行时返回
`409`；不同 sessionId 可以并行运行。

curl 示例：

```bash
curl -N http://127.0.0.1:8787/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"sess_web_001","message":"你好","mock":true}'
```

`-N` 会关闭 curl 的输出缓冲，便于实时看到 SSE 数据。

### 一次 HTTP 聊天的执行顺序

~~~
POST /v1/chat
    │
    ├── 读取并解析 JSON（最大 2 MiB）
    ├── 校验 sessionId 和 message
    ├── 检查 activeRuns
    │      └── 同 session 正在运行 → 409
    ├── 创建本次请求的 AbortController
    └── 写入 SSE 响应头和 connected 注释
~~~

建立 SSE 后，继续执行：

~~~
agents Map 中查找 sessionId
    ├── 已存在且 mock 相同 → 复用 AgentRun
    ├── 已存在但 mock 改变 → 释放旧 Agent 后重建
    └── 不存在 → createAgent(resumeSession: true)
                    └── 有 JSONL 就恢复，无记录就从空上下文开始
    │
    ▼
agent.run(message, callbacks, signal)
    ├── onToken      → SSE token
    ├── onToolCall   → SSE tool_call
    └── onToolResult → SSE tool_result
    │
    ▼
finish.answer 未经过 token 流时补发剩余文本
    │
    ├── SSE done（携带完整 answer）
    └── 删除 activeRuns 标记并结束响应
~~~

Server 在内存中的 `agents` Map 长驻每个 session 的 AgentRun，所以多次请求会
保留上下文和短期记忆。服务重启后 Map 会清空；下一次收到相同 sessionId 时，
会从 JSONL 恢复已经完成的用户/助手轮次。workspace 仍使用
`workspace/<sessionId>/`。

### SSE 事件格式

每条事件都使用默认 SSE `message` 事件名，数据位于一行 `data:` JSON 中：

```text
data: {"type":"token","content":"你"}

data: {"type":"tool_call","name":"read_file","args":{"path":"package.json"}}

data: {"type":"tool_result","name":"read_file","result":{"content":"..."}}

data: {"type":"done","answer":"完整最终回答"}
```

| type | 发送时机 | 关键字段 |
|------|----------|----------|
| `token` | 模型产生文本增量，或补发 finish 的未流式文本 | `content` |
| `tool_call` | 工具执行之前 | `name`, `args` |
| `tool_result` | 工具执行之后 | `name`, `result` |
| `done` | 本轮成功结束 | `answer`，始终是完整最终回答 |
| `error` | 本轮异常且不是客户端主动断开 | `message` |

连接建立后服务先发送 `: connected` 注释，客户端可忽略。响应头包含
`Cache-Control: no-cache, no-transform` 和 `X-Accel-Buffering: no`，降低
代理层缓冲流式响应的概率。

如果浏览器或 HTTP 客户端断开连接，Server 会 abort 当前 LLM、shell、MCP 或
压缩等待，并且不会再尝试向断开的连接发送 error。AgentRun 会回滚该轮上下文，
JSONL 中没有 `turn_end` 的半截记录也不会在下次恢复。

### 删除会话

```bash
curl -X DELETE http://127.0.0.1:8787/v1/sessions/sess_web_001
```

删除顺序如下：

1. 校验 URL 中的 sessionId。
2. 如果该 session 正在运行，先触发 AbortController。
3. 从进程内 Map 移除 Agent，并关闭 MCP、清理 DockerSandbox。
4. 删除 `_sessions/<sessionId>/`。
5. 删除 `workspace/<sessionId>/`。
6. 返回 `{ "ok": true, "sessionId": "..." }`。

这是不可恢复的物理删除接口。若客户端只想清空页面显示，不应调用该接口。

### 健康检查与关闭流程

```bash
curl http://127.0.0.1:8787/v1/health
```

示例响应：

```json
{"ok":true,"name":"keen-code server","port":8787,"activeSessions":2}
```

这里的 `activeSessions` 是当前进程已缓存的 Agent 数量，不是正在生成回答的请求
数量。进程收到 SIGINT 或 SIGTERM 后，会取消全部 active run、停止接收连接、
关闭现有 HTTP 连接，并并行释放所有 Agent 资源。

当前 Server 固定使用默认 LocalSandbox，也没有解析 CLI 的 `.mcp.json` 或
`--mcp` 参数。如果 Web 入口需要 Docker 或 MCP，应在 `server.ts` 启动阶段
加载配置并传入 `createAgent`，不要假设 CLI flags 会自动作用于 Server。

---

## 配置说明

`.env` 文件配置项：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | 必填（非 mock 模式） |
| `DEEPSEEK_BASE_URL` | OpenAI 兼容接口地址；`.env.example` 已配置 DeepSeek 地址 | 建议 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 模型名称 | `deepseek-v4-flash` |
| `DEEPSEEK_TIMEOUT_MS` | 完整模型响应超时（毫秒，`0` 表示近似不限时；不自动重试） | `0` |
| `KEEN_CODE_PORT` | HTTP/SSE Server 监听端口，优先级高于 `PORT` | 未设置时读取 `PORT` |
| `PORT` | HTTP/SSE Server 备用监听端口 | `8787` |

最小真实模式配置：

```dotenv
DEEPSEEK_API_KEY=替换成你的_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_TIMEOUT_MS=0
```

配置读取顺序：

1. CLI 或 Server 启动时由 `dotenv/config` 读取项目当前目录的 `.env`。
2. `createLLM(false)` 创建 DeepSeekLLM，并校验 API Key 不是空值或示例占位符。
3. 模型名称未设置时使用 `deepseek-v4-flash`。
4. 超时是大于 0 的有效数字时，同时作为请求超时和 AbortSignal 超时；其余值
   都按 0 处理。
5. OpenAI SDK 的自动重试次数固定为 0。普通网络错误不会在后台自动重发。

Mock 模式不需要任何 API 配置：CLI 使用 `--mock`，HTTP 请求使用
`"mock": true`。MockLLM 不生成工具调用，只用每字符约 10ms 的延迟模拟流式
文本，适合检查 CLI、SSE 和会话记录链路。
