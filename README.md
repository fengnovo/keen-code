# keen-code

一个最小可用的 AI Agent Harness（框架），用 TypeScript 从零搭建，支持工具调用、沙箱隔离、记忆系统、技能加载、流式输出、会话记录和远程 MCP 接入。

---

## 目录

- [架构图](#架构图)
- [核心流程图](#核心流程图)
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
- [远程 MCP](#远程-mcp)
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
│  │  CLI     │    │  ┌─────────────────────────────────────┐ │   │
│  │ (cli.ts) │───▶│  │  1. 构建 system prompt               │ │   │
│  │          │    │  │  2. 注入记忆 + 技能摘要               │ │   │
│  │ run      │    │  │  3. 调用 LLM (流式)                  │ │   │
│  │ chat     │    │  │  4. 解析响应 → 文本 or 工具调用       │ │   │
│  │ session  │    │  │  5. 执行工具 → 结果回传 LLM → 循环    │ │   │
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
cli.ts
  └── agent.ts (工厂函数，创建并组装所有组件)
        ├── llm.ts (LLM Provider)
        ├── loop.ts (Agent 主循环)
        │     ├── types.ts (类型定义)
        │     ├── context.ts (上下文管理 + 历史压缩)
        │     ├── session.ts (会话记录器)
        │     └── tools/
        │           ├── registry.ts (工具注册表 + zod→JSON Schema)
        │           └── builtin.ts (内置工具实现)
        ├── sandbox/sandbox.ts (本地沙箱)
        ├── sandbox/dockerSandbox.ts (Docker 沙箱)
        ├── memory.ts (记忆系统 + 记忆工具)
        ├── skills/skills.ts (技能系统 + 技能工具)
        ├── mcp/mcp.ts (远程 MCP 接入)
        └── sessions/sessionView.ts (会话记录查看)
```

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
│    保留最近 6 轮          │             │
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
│ 6. 工具调用次数 < 10？    │                    │
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
                                              │ 保留最近 6 轮        │
                                              │ (约 18 条消息)       │
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
                                              │ [最近6轮对话]        │
                                              └─────────────────────┘
```

---

## 项目结构

```
keen-code/
├── src/
│   ├── cli.ts                        # 命令行入口，解析参数，分发命令
│   └── agent/
│       ├── agent.ts                  # Agent 工厂函数，组装所有组件
│       ├── types.ts                  # 核心类型定义（消息、工具、回调等）
│       ├── llm.ts                    # LLM 层：MockLLM + DeepSeekLLM（流式）
│       ├── loop.ts                   # Agent 主循环（ReAct 模式）
│       ├── context.ts                # 上下文管理器（消息历史 + 自动压缩）
│       ├── mcp.ts                    # 远程 MCP 接入（动态导入 SDK）
│       ├── memory.ts                 # 记忆系统（短期 + 长期 + 3个工具）
│       ├── skills.ts                 # 技能系统（加载 SKILL.md + use_skill 工具）
│       ├── sandbox/                  # 沙箱模块
│       │   ├── sandbox.ts            # 本地沙箱（workspace 目录隔离）
│       │   └── dockerSandbox.ts      # Docker 沙箱（容器隔离执行）
│       ├── session/                  # 会话记录模块
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
│       └── run_xxx.jsonl             # 每次 run 一个 JSONL 文件
├── package.json
├── tsconfig.json
└── .env                              # 环境变量配置
```

---

## 模块说明

### 1. CLI 入口 (`cli.ts`)

命令行入口，解析用户输入的命令和参数，分发到对应的处理函数。

- **run 命令**：单轮对话模式，输入一条消息，输出 AI 回答后退出
- **chat 命令**：交互式对话模式，支持多轮对话和内置命令
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
8. 接入远程 MCP 服务
9. 组装成 `AgentRun` 实例

### 3. Agent 主循环 (`loop.ts`)

`AgentRun.run()` 是 Agent 的核心方法，实现 ReAct（Reason + Act）循环：

1. 构建 system prompt（注入记忆、技能摘要）
2. 添加用户消息到上下文
3. 检查并执行历史压缩
4. 循环调用 LLM：
   - 如果 LLM 返回纯文本 → 直接返回
   - 如果 LLM 返回工具调用 → 执行工具 → 结果回传 LLM → 继续循环
   - 如果调用了 `finish` 工具 → 返回 finish 的 answer
   - 最多循环 10 次工具调用，防止死循环

### 4. LLM 层 (`llm.ts`)

- **MockLLM**：不调用真实 API，逐字模拟流式输出，用于本地调试
- **DeepSeekLLM**：通过 OpenAI 兼容接口调用 DeepSeek 模型
  - 使用 `stream: true` 流式接口
  - 逐 chunk 累积文本内容和工具调用
  - 流式失败时自动回退到非流式模式

### 5. 上下文管理 (`context.ts`)

管理消息历史，当对话超过 20 轮时自动压缩：
- 保留最近 6 轮原始消息
- 将旧消息交给 LLM 生成压缩摘要
- 摘要作为 system 消息注入到上下文中

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
- **长期记忆**：持久化到 `memory/long_term.json`，跨会话保留
- **检索方式**：关键词匹配（后续可扩展为向量检索）
- 提供 3 个工具：`remember`（短期）、`remember_longterm`（长期）、`recall`（检索）

### 8. 技能系统 (`skills.ts`)

自动扫描 `_skills/*/SKILL.md` 文件，加载为技能：
- 从 SKILL.md 中提取简短描述
- 技能摘要注入到 system prompt
- 提供 `use_skill` 工具，AI 可主动读取技能的完整说明

### 9. 会话记录系统 (`session.ts` / `sessionView.ts`)

记录 Agent 执行的全过程到 JSONL 文件：
- `turn_start` / `turn_end`：对话轮次
- `llm_call` / `llm_response`：LLM 调用记录
- `tool_call` / `tool_result`：工具调用记录
- `session_start` / `session_end`：会话开始和结束

`sessionView.ts` 提供查看功能：
- `list`：列出所有 会话记录
- `tree`：以树状结构展示单个 run

### 10. 工具注册表 (`tools/registry.ts`)

- 注册工具（`register`）
- 执行工具时自动用 Zod 校验参数
- 将 Zod Schema 转换为 JSON Schema 供 LLM 使用

### 11. 远程 MCP (`mcp.ts`)

动态导入 `@modelcontextprotocol/client`，连接远程 MCP 服务：
- 自动选择传输方式（SSE 或 StreamableHTTP）
- 将远程工具注册到本地 ToolRegistry
- 工具名加前缀 `<服务名>__<工具名>` 避免冲突

---

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env  # 然后编辑 .env 填入 API Key

# Mock 模式（不需要 API Key）
npm run cli -- run "你好" --mock

# 真实模式
npm run cli -- run "你好"

# 交互式对话
npm run chat
```

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
| `/session` | 查看当前会话记录路径 |
| `/session <sessionId>` | 切换到指定会话并恢复历史 |
| `/session list` | 列出所有 会话记录 |
| `/session tree <sid> <rid>` | 查看某个 run 的树状结构 |
| `/log` | 查看当前 session 的对话列表和每条输入摘要 |
| `/compress` | 手动压缩对话历史 |
| `/memory` | 查看当前记忆（短期 + 长期） |
| `/skills` | 列出可用技能 |

聊天请求进行中按一次 `Ctrl+C` 会取消当前 LLM 请求或 shell 工具，再按一次 `Ctrl+C` 退出程序。

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

每次 `agent.run()` 调用都会记录完整的执行过程到 JSONL 文件：

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
| `session_end` | 会话结束，记录最终回答 |

---

## 记忆系统

### 短期记忆

- 存储在内存 Map 中，会话结束后消失
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

---

## 技能系统

在 `_skills/` 目录下创建子目录，放置 `SKILL.md` 文件即可添加技能：

```
_skills/
└── my-skill/
    └── SKILL.md
```

SKILL.md 格式：

```markdown
# 技能名称

简短描述（第一段非标题非代码块的内容会被提取为描述）

详细的使用说明...
```

Agent 启动时自动加载所有技能，摘要注入 system prompt。AI 可通过 `use_skill` 工具读取完整说明。

---

## 远程 MCP

通过 `--mcp` 参数接入远程 MCP 服务：

```bash
npm run cli -- chat --mcp tandem=https://tandem.ac/mcp

# 用真实的 MCP 服务地址
npm run cli -- chat --mcp tandem=https:// 你的真实-mcp服务地址/mcp
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

## 配置说明

`.env` 文件配置项：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | 必填（非 mock 模式） |
| `DEEPSEEK_BASE_URL` | DeepSeek API 地址 | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 模型名称 | `deepseek-v4-flash` |
| `TAVILY_API_KEY` | Tavily 搜索 API 密钥（预留） | 可选 |
