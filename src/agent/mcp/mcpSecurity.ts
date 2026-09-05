/**
 * @file mcpSecurity.ts
 * @description MCP 服务器安全扫描模块
 *
 * 在将 MCP 服务器接入 AI 智能体前，对其进行安全扫描，
 * 参考 OWASP MCP Top 10 (2026) 标准进行检查。
 *
 * 检查类别：
 * - MCP01: 工具投毒（隐藏指令、零宽字符）
 * - MCP02: 过度权限（root、通配符权限）
 * - MCP03: 不安全传输（HTTP、SSRF）
 * - MCP04: 命令注入（shell 元字符、模板注入）
 * - MCP05: 路径遍历（..、敏感路径）
 * - MCP06: 密钥暴露（token 模式）
 * - MCP07: 不安全默认值
 * - MCP08: 输入验证缺失
 * - MCP09: 审计缺口
 * - MCP10: 权限提升（sudo、--privileged）
 */

/** 安全级别 */
export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** 单个安全发现 */
export interface SecurityFinding {
  /** OWASP MCP Top 10 编号 */
  id: string;
  /** 类别名称 */
  category: string;
  /** 安全级别 */
  severity: Severity;
  /** 发现的工具名（如果是工具级别的问题） */
  toolName?: string;
  /** 问题描述 */
  message: string;
  /** 修复建议 */
  remediation?: string;
}

/** 安全扫描结果 */
export interface SecurityScanResult {
  /** 扫描的服务器 URL */
  url: string;
  /** 扫描的工具数量 */
  toolCount: number;
  /** 发现的安全问题列表 */
  findings: SecurityFinding[];
  /** 是否有 critical 或 high 级别的问题 */
  hasCriticalOrHigh: boolean;
}

/** 安全扫描配置 */
export interface SecurityScanOptions {
  /** 阻止注册 critical/high 级别的工具，默认 true */
  blockDangerous?: boolean;
  /** 只扫描不阻止（仅警告），默认 false */
  warnOnly?: boolean;
}

// ============================================================
// 敏感路径模式（MCP05 路径遍历）
// ============================================================
const SENSITIVE_PATHS = [
  /\.ssh\//,
  /\.aws\//,
  /\.kube\//,
  /\.env/,
  /\.git\//,
  /\/etc\/passwd/,
  /\/etc\/shadow/,
  /\/root\//,
  /\/proc\//,
  /\/sys\//,
];

// ============================================================
// 密钥/Token 模式（MCP06 密钥暴露）
// ============================================================
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "AWS Secret Key", pattern: /aws_secret_access_key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/ },
  { name: "GitHub Token", pattern: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { name: "Slack Token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe Key", pattern: /sk_live_[0-9a-zA-Z]{24}/ },
  { name: "Private Key", pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: "Generic API Key", pattern: /api[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9]{16,}/i },
  { name: "Bearer Token", pattern: /bearer\s+[A-Za-z0-9\-._~+/]+=*/i },
];

// ============================================================
// 危险命令模式（MCP04 命令注入、MCP08 输入验证）
// ============================================================
const DANGEROUS_COMMAND_PATTERNS = [
  { pattern: /\|\s*(sh|bash|zsh)\b/, message: "管道到 shell（curl|sh 模式）", severity: "critical" as Severity },
  { pattern: /\bexec\s*\(/, message: "使用 exec 执行命令", severity: "high" as Severity },
  { pattern: /\beval\s*\(/, message: "使用 eval 执行代码", severity: "high" as Severity },
  { pattern: /\bsudo\b/, message: "使用 sudo 提权", severity: "critical" as Severity },
  { pattern: /--privileged/, message: "Docker 特权模式", severity: "critical" as Severity },
  { pattern: /child_process\.exec/, message: "使用 child_process.exec（易注入）", severity: "high" as Severity },
  { pattern: /\$\{[^}]+\}/, message: "模板字符串注入（${...}）", severity: "medium" as Severity },
  { pattern: /\{\{[^}]+\}\}/, message: "模板注入（{{...}}）", severity: "medium" as Severity },
];

// ============================================================
// 零宽字符（MCP01 工具投毒）
// ============================================================
const ZERO_WIDTH_CHARS = [
  /\u200B/, // 零宽空格
  /\u200C/, // 零宽非连接符
  /\u200D/, // 零宽连接符
  /\uFEFF/, // 零宽不换行空格
  /\u2060/, // 词连接符
];

// ============================================================
// 隐藏指令模式（MCP01 工具投毒）
// ============================================================
const HIDDEN_INSTRUCTION_PATTERNS = [
  /ignore (previous|above|all) instructions?/i,
  /disregard (previous|above|all) (instructions?|rules?)/i,
  /you are now/i,
  /forget (everything|all|your)/i,
  /system prompt/i,
  /<\|im_start\|>/,
  /<\|im_end\|>/,
];

/**
 * 扫描 MCP 服务器 URL 的传输安全性（MCP03）
 */
function scanTransport(url: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // 检查是否使用 HTTPS
  if (url.startsWith("http://") && !url.includes("localhost") && !url.includes("127.0.0.1")) {
    findings.push({
      id: "MCP03",
      category: "不安全传输",
      severity: "high",
      message: `MCP 服务器使用未加密的 HTTP 传输: ${url}`,
      remediation: "改用 HTTPS 传输，避免中间人攻击",
    });
  }

  // 检查 SSRF 风险（元数据端点）
  if (
    /169\.254\.169\.254/.test(url) || // AWS/GCP 元数据
    /metadata\.google\.internal/.test(url) ||
    /metadata\.azure\.com/.test(url)
  ) {
    findings.push({
      id: "MCP03",
      category: "不安全传输",
      severity: "critical",
      message: "MCP 服务器指向云元数据端点，存在 SSRF 风险",
      remediation: "禁止连接云元数据端点",
    });
  }

  return findings;
}

/**
 * 扫描单个工具的安全性
 */
function scanTool(tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const { name, description = "", inputSchema = {} } = tool;
  const combined = `${name} ${description}`.toLowerCase();

  // ---- MCP01: 工具投毒 ----
  // 检查零宽字符
  for (const zwChar of ZERO_WIDTH_CHARS) {
    if (zwChar.test(description) || zwChar.test(name)) {
      findings.push({
        id: "MCP01",
        category: "工具投毒",
        severity: "critical",
        toolName: name,
        message: `工具描述中包含零宽字符（U+${zwChar.source}），可能用于隐藏恶意指令`,
        remediation: "审查工具描述，移除不可见字符",
      });
      break;
    }
  }

  // 检查隐藏指令
  for (const pattern of HIDDEN_INSTRUCTION_PATTERNS) {
    if (pattern.test(description)) {
      findings.push({
        id: "MCP01",
        category: "工具投毒",
        severity: "critical",
        toolName: name,
        message: `工具描述包含可疑的指令覆盖语句: "${pattern.exec(description)?.[0]}"`,
        remediation: "移除工具描述中的指令覆盖语句",
      });
    }
  }

  // ---- MCP02: 过度权限 ----
  if (/\b(root|admin|superuser)\b/.test(combined)) {
    findings.push({
      id: "MCP02",
      category: "过度权限",
      severity: "high",
      toolName: name,
      message: "工具可能以 root/admin 权限运行",
      remediation: "确认工具是否需要高权限，尽量使用最小权限",
    });
  }

  // 检查通配符权限
  if (/\b(full|complete|unrestricted|wildcard)\b.*(access|permission)/.test(combined)) {
    findings.push({
      id: "MCP02",
      category: "过度权限",
      severity: "medium",
      toolName: name,
      message: "工具声称拥有完全/无限制访问权限",
      remediation: "确认权限范围是否必要",
    });
  }

  // ---- MCP04/MCP08: 命令注入 / 输入验证 ----
  for (const { pattern, message, severity } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(combined)) {
      findings.push({
        id: pattern.source.includes("sudo") || pattern.source.includes("privileged") ? "MCP10" : "MCP04",
        category: pattern.source.includes("sudo") || pattern.source.includes("privileged") ? "权限提升" : "命令注入",
        severity,
        toolName: name,
        message,
        remediation: "使用参数化命令，避免 shell 注入；如非必要移除提权操作",
      });
    }
  }

  // ---- MCP05: 路径遍历 ----
  for (const pathPattern of SENSITIVE_PATHS) {
    if (pathPattern.test(combined)) {
      findings.push({
        id: "MCP05",
        category: "路径遍历",
        severity: "high",
        toolName: name,
        message: `工具涉及敏感路径: ${pathPattern}`,
        remediation: "确认工具是否需要访问该路径，限制文件系统访问范围",
      });
    }
  }

  // 检查路径遍历模式
  if (/\.\.\//.test(combined) || /\.\.\\/.test(combined)) {
    findings.push({
      id: "MCP05",
      category: "路径遍历",
      severity: "high",
      toolName: name,
      message: "工具描述包含路径遍历模式（../）",
      remediation: "验证路径输入，防止目录穿越",
    });
  }

  // ---- MCP06: 密钥暴露 ----
  for (const { name: secretName, pattern } of SECRET_PATTERNS) {
    if (pattern.test(description)) {
      findings.push({
        id: "MCP06",
        category: "密钥暴露",
        severity: "critical",
        toolName: name,
        message: `工具描述中疑似包含 ${secretName}`,
        remediation: "立即轮换暴露的密钥，不要在工具描述中硬编码密钥",
      });
    }
  }

  // ---- MCP07: 不安全默认值 ----
  // 检查工具是否接受任意命令执行
  if (/\b(run|execute|exec)\b.*\b(command|cmd|script|code)\b/.test(combined)) {
    findings.push({
      id: "MCP07",
      category: "不安全默认值",
      severity: "high",
      toolName: name,
      message: "工具允许执行任意命令/代码",
      remediation: "限制可执行的命令范围，使用白名单",
    });
  }

  // 检查 inputSchema 是否过于宽松
  const schemaStr = JSON.stringify(inputSchema);
  if (schemaStr === "{}" || /additionalProperties["']?\s*:\s*true/.test(schemaStr)) {
    findings.push({
      id: "MCP08",
      category: "输入验证",
      severity: "medium",
      toolName: name,
      message: "工具的输入 schema 为空或允许任意额外属性，缺乏输入验证",
      remediation: "定义严格的输入 schema，限制参数类型和范围",
    });
  }

  return findings;
}

/**
 * 对 MCP 服务器进行安全扫描
 *
 * @param url MCP 服务器 URL
 * @param tools 工具列表
 * @returns 扫描结果
 */
export function scanMCPServer(
  url: string,
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]
): SecurityScanResult {
  const findings: SecurityFinding[] = [];

  // 1. 扫描传输层安全
  findings.push(...scanTransport(url));

  // 2. 扫描每个工具
  for (const tool of tools) {
    findings.push(...scanTool(tool));
  }

  const hasCriticalOrHigh = findings.some(
    (f) => f.severity === "critical" || f.severity === "high"
  );

  return {
    url,
    toolCount: tools.length,
    findings,
    hasCriticalOrHigh,
  };
}

/**
 * 格式化扫描结果为可读文本
 */
export function formatScanResult(result: SecurityScanResult): string {
  const lines: string[] = [];
  lines.push(`[安全扫描] ${result.url}`);
  lines.push(`  工具数: ${result.toolCount}, 发现问题: ${result.findings.length}`);

  if (result.findings.length === 0) {
    lines.push("  ✅ 未发现安全问题");
    return lines.join("\n");
  }

  // 按严重级别排序
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity]);

  for (const f of sorted) {
    const icon = f.severity === "critical" ? "🔴" : f.severity === "high" ? "🟠" : f.severity === "medium" ? "🟡" : "🔵";
    lines.push(`  ${icon} [${f.id}] ${f.category} (${f.severity})${f.toolName ? ` - ${f.toolName}` : ""}`);
    lines.push(`       ${f.message}`);
    if (f.remediation) {
      lines.push(`       修复: ${f.remediation}`);
    }
  }

  return lines.join("\n");
}

/**
 * 判断工具是否应该被阻止注册
 * 根据扫描结果中该工具的 critical/high 级别问题决定
 */
export function shouldBlockTool(
  toolName: string,
  result: SecurityScanResult,
  options: SecurityScanOptions = {}
): boolean {
  if (options.warnOnly) return false;
  if (options.blockDangerous === false) return false;

  return result.findings.some(
    (f) =>
      f.toolName === toolName &&
      (f.severity === "critical" || f.severity === "high")
  );
}
