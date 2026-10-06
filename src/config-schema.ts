/**
 * Declarative description of every editable setting.
 *
 * This is the single source of truth for the WebUI config editor: the server
 * renders the form from it, validates writes against it, and the UI never has to
 * know a key's type. Keeping it next to `config.ts` means adding a variable in
 * one place and describing it in the other is an obvious two-line change.
 *
 * Secret fields deliberately expose **no** read function. The editor can set a
 * secret and can learn whether one is configured, but can never read it back.
 */

import type { Config } from './config.ts';
import { ONEBOT_TRIGGERS } from './config.ts';
import { LOG_LEVELS } from './logger.ts';

export type ConfigFieldType = 'string' | 'int' | 'float' | 'bool' | 'list' | 'enum';

export interface ConfigFieldSpec {
  key: string;
  group: string;
  type: ConfigFieldType;
  description: string;
  /** Current effective value. Secrets return `null` and set `secret: true`. */
  read: (config: Config) => string | number | boolean | string[] | null;
  secret?: boolean;
  /** For secrets only: whether a value is currently configured. */
  isConfigured?: (config: Config) => boolean;
  options?: readonly string[];
  /**
   * Always true in this build: `loadConfig` runs once at boot, and nothing
   * hot-reloads the resulting object. Claiming otherwise would be a lie the UI
   * then repeats to the operator.
   */
  restartRequired: boolean;
}

const RESTART = true;

/** Console levels exclude `silent` only where an empty UI would be useless. */
const CONSOLE_LEVELS = LOG_LEVELS;
const CAPTURE_LEVELS = LOG_LEVELS.filter((level) => level !== 'silent');

export const CONFIG_FIELDS: ConfigFieldSpec[] = [
  /* ----------------------------- 服务 ----------------------------- */
  {
    key: 'NAMI_HOST',
    group: '服务',
    type: 'string',
    description: '监听地址。0.0.0.0 表示所有网卡（容器内通常需要）。',
    read: (c) => c.host,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_PORT',
    group: '服务',
    type: 'int',
    description: 'HTTP 与 WebSocket 共用端口。',
    read: (c) => c.port,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_CORS_ORIGIN',
    group: '服务',
    type: 'string',
    description: 'CORS 允许来源。生产环境建议收窄为具体域名，而不是 *。',
    read: (c) => c.corsOrigin,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_MAX_BODY_BYTES',
    group: '服务',
    type: 'int',
    description: '请求体大小上限（字节），超出返回 413。',
    read: (c) => c.maxBodyBytes,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_REQUEST_TIMEOUT_MS',
    group: '服务',
    type: 'int',
    description: '单个请求的超时预算（毫秒）。',
    read: (c) => c.requestTimeoutMs,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_SHUTDOWN_GRACE_MS',
    group: '服务',
    type: 'int',
    description: '收到 SIGTERM/SIGINT 后等待在途工作完成的时间（毫秒）。',
    read: (c) => c.shutdownGraceMs,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_HOT_RELOAD',
    group: '服务',
    type: 'bool',
    description:
      '监听 .env，文件一变就自动原地重载（不必手动重启）。关掉后需要点控制台的重启按钮。NAMI_HOST/NAMI_PORT 的变化在任何情况下都会重新绑定监听。',
    read: (c) => c.hotReload,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LOG_FORMAT',
    group: '服务',
    type: 'enum',
    description: '控制台日志格式。json 便于日志采集系统解析。',
    options: ['pretty', 'json'],
    read: (c) => c.logFormat,
    restartRequired: RESTART,
  },

  /* ----------------------------- 安全 ----------------------------- */
  {
    key: 'NAMI_API_KEYS',
    group: '安全',
    type: 'list',
    description: '客户端 API Key，逗号分隔。留空则每次启动随机生成并打印到日志。',
    secret: true,
    read: () => null,
    isConfigured: (c) => c.apiKeys.length > 0 && c.generatedKey === null,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ADMIN_TOKEN',
    group: '安全',
    type: 'string',
    description: '管理接口专用令牌。配置后，普通 API Key 将无法访问 /admin/api/*。',
    secret: true,
    read: () => null,
    isConfigured: (c) => c.adminToken !== null,
    restartRequired: RESTART,
  },

  /* ------------------------ 控制台账号密码 ------------------------ */  {
    key: 'NAMI_ADMIN_USER',
    group: '安全',
    type: 'string',
    description:
      '首次启动时创建的管理员用户名。仅在用户表为空时生效——之后以数据库为准，改这里不会影响已有账号。',
    read: (c) => c.auth.bootstrapUser,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ADMIN_PASSWORD',
    group: '安全',
    type: 'string',
    description:
      '首次启动时管理员的初始密码（只在建号那一刻读取，随后以 scrypt 哈希入库，明文不落盘）。留空则随机生成并打印到日志；已有账号时此项被忽略。',
    secret: true,
    read: () => null,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_SESSION_TTL_HOURS',
    group: '安全',
    type: 'int',
    description: '控制台登录会话的有效期（小时），过期需重新登录。',
    read: (c) => c.auth.sessionTtlMs / 3_600_000,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_SESSION_COOKIE',
    group: '安全',
    type: 'string',
    description: '会话 Cookie 的名称。',
    read: (c) => c.auth.cookieName,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_COOKIE_SECURE',
    group: '安全',
    type: 'enum',
    description:
      '会话 Cookie 的 Secure 属性。auto 在识别到 HTTPS 时自动加上——Nami 自身不终止 TLS，所以直接暴露在 HTTP 上时用 auto 即可。',
    options: ['auto', 'always', 'never'],
    read: (c) => c.auth.cookieSecure,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TRUST_PROXY',
    group: '安全',
    type: 'bool',
    description:
      '是否信任 X-Forwarded-Proto 来判断请求是 HTTPS。只在你自己的反向代理后面开启；否则任何客户端都能伪造该头。',
    read: (c) => c.auth.trustProxy,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LOGIN_MAX_ATTEMPTS',
    group: '安全',
    type: 'int',
    description: '连续登录失败多少次后锁定。按用户名与来源地址分别计数。',
    read: (c) => c.auth.maxAttempts,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LOGIN_LOCKOUT_SECONDS',
    group: '安全',
    type: 'int',
    description: '触发锁定后的冷却时间（秒）。',
    read: (c) => c.auth.lockoutMs / 1000,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LOGIN_WINDOW_SECONDS',
    group: '安全',
    type: 'int',
    description: '失败计数的滑动窗口（秒）。早于窗口的失败重新开始计数，避免长期累计误锁。',
    read: (c) => c.auth.attemptWindowMs / 1000,
    restartRequired: RESTART,
  },

  /* ----------------------------- 日志 ----------------------------- */
  {
    key: 'NAMI_LOG_LEVEL',
    group: '日志',
    type: 'enum',
    description: '控制台日志级别。',
    options: CONSOLE_LEVELS,
    read: (c) => c.logLevel,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LOG_CAPTURE_LEVEL',
    group: '日志',
    type: 'enum',
    description: 'WebUI 日志页缓存的级别下限。与控制台级别独立，避免把控制台调安静后日志页也空了。',
    options: CAPTURE_LEVELS,
    read: (c) => c.logCaptureLevel,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LOG_BUFFER_SIZE',
    group: '日志',
    type: 'int',
    description: 'WebUI 日志页内存环形缓冲的条目数（最小 50）。',
    read: (c) => c.logBufferSize,
    restartRequired: RESTART,
  },

  /* ----------------------------- 存储 ----------------------------- */
  {
    key: 'NAMI_DB_PATH',
    group: '存储',
    type: 'string',
    description: 'SQLite 数据库路径。Docker 中应为 /app/data/nami.sqlite。',
    read: (c) => c.dbPath,
    restartRequired: RESTART,
  },

  /* ---------------------------- 智能体 ---------------------------- */
  {
    key: 'NAMI_SYSTEM_PROMPT',
    group: '智能体',
    type: 'string',
    description: '默认系统提示词。请求里带 system 时以请求为准。',
    read: (c) => c.agent.systemPrompt,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_MAX_TOOL_ROUNDS',
    group: '智能体',
    type: 'int',
    description: '单次运行最多几轮「模型 → 工具 → 回灌」。',
    read: (c) => c.agent.maxRounds,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TOOL_TIMEOUT_MS',
    group: '智能体',
    type: 'int',
    description: '单个工具调用的超时（毫秒）。',
    read: (c) => c.agent.toolTimeoutMs,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_MAX_TOOL_RESULT_BYTES',
    group: '智能体',
    type: 'int',
    description: '回灌给模型的工具结果字节上限，超出会被截断。',
    read: (c) => c.agent.maxToolResultBytes,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_MAX_HISTORY_MESSAGES',
    group: '智能体',
    type: 'int',
    description: '每次请求带上的历史消息条数上限。',
    read: (c) => c.agent.maxHistoryMessages,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TEMPERATURE',
    group: '智能体',
    type: 'float',
    description: '默认采样温度。',
    read: (c) => c.agent.temperature,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_MAX_TOKENS',
    group: '智能体',
    type: 'int',
    description: '默认最大生成 token 数。',
    read: (c) => c.agent.maxTokens,
    restartRequired: RESTART,
  },

  /* ------------------------------ LLM ------------------------------ */
  {
    key: 'NAMI_LLM_PROVIDER',
    group: 'LLM',
    type: 'enum',
    description: '模型来源。mock 完全离线，ollama 走本机原生 API，openai 适配任意兼容端点。',
    options: ['mock', 'ollama', 'openai'],
    read: (c) => c.llm.provider,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LLM_BASE_URL',
    group: 'LLM',
    type: 'string',
    description: 'OpenAI 兼容端点基地址。provider=ollama 时忽略（由 NAMI_OLLAMA_URL 推导）。',
    read: (c) => c.llm.baseUrl,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LLM_API_KEY',
    group: 'LLM',
    type: 'string',
    description: '上游 API Key。mock 与 ollama 不需要。',
    secret: true,
    read: () => null,
    isConfigured: (c) => c.llm.apiKey !== '',
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LLM_MODEL',
    group: 'LLM',
    type: 'string',
    description: '默认模型名。留空表示启动时自动发现。',
    read: (c) => c.llm.model,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LLM_TIMEOUT_MS',
    group: 'LLM',
    type: 'int',
    description: '上游请求超时（毫秒）。本地大模型建议放宽。',
    read: (c) => c.llm.timeoutMs,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_LLM_HEADERS',
    group: 'LLM',
    type: 'list',
    description: '附加到每个上游请求的请求头，逗号分隔的 key=value。',
    read: (c) => Object.entries(c.llm.extraHeaders).map(([k, v]) => `${k}=${v}`),
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_MOCK_DELAY_MS',
    group: 'LLM',
    type: 'int',
    description: '仅 mock provider：每个分片的延迟（毫秒），0 为最快。',
    read: (c) => c.llm.mockDelayMs,
    restartRequired: RESTART,
  },

  /* ----------------------------- Ollama ---------------------------- */
  {
    key: 'NAMI_OLLAMA_URL',
    group: 'Ollama',
    type: 'string',
    description: 'Ollama 原生 API 地址，不要带 /v1。设置它即等于选用 Ollama 适配器。',
    read: (c) => c.ollama.url,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_OLLAMA_KEEP_ALIVE',
    group: 'Ollama',
    type: 'string',
    description: '模型驻留时长。0 立即卸载，-1 永久驻留。',
    read: (c) => c.ollama.keepAlive,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_OLLAMA_NUM_CTX',
    group: 'Ollama',
    type: 'int',
    description: '上下文窗口 num_ctx。0 表示沿用 Ollama 默认值（通常 4096）。',
    read: (c) => c.ollama.numCtx ?? 0,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_OLLAMA_PROBE_TIMEOUT_MS',
    group: 'Ollama',
    type: 'int',
    description: '启动探测超时（毫秒）。',
    read: (c) => c.ollama.probeTimeoutMs,
    restartRequired: RESTART,
  },

  /* ---------------------------- 模型托管 --------------------------- */
  {
    key: 'NAMI_ALLOW_CLIENT_MODEL',
    group: '模型托管',
    type: 'bool',
    description: '是否允许客户端按请求指定模型。关闭后一律使用默认模型。',
    read: (c) => c.models.allowClientModel,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_MODELS_EXPOSE',
    group: '模型托管',
    type: 'list',
    description: '对外开放的客户端可见模型名白名单。留空表示全部暴露。',
    read: (c) => c.models.expose,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_MODEL_ALIASES',
    group: '模型托管',
    type: 'list',
    description: '别名映射，逗号分隔的 客户端名=上游真名。',
    read: (c) => Object.entries(c.models.aliases).map(([k, v]) => `${k}=${v}`),
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_MODELS_CACHE_TTL_MS',
    group: '模型托管',
    type: 'int',
    description: '模型目录缓存时长（毫秒）。',
    read: (c) => c.models.cacheTtlMs,
    restartRequired: RESTART,
  },

  /* ------------------------------ 工具 ----------------------------- */
  {
    key: 'NAMI_TOOL_MEMORY_ENABLED',
    group: '工具',
    type: 'bool',
    description: '启用会话级记忆工具 memory_*。',
    read: (c) => c.tools.memoryEnabled,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TOOL_HTTP_ENABLED',
    group: '工具',
    type: 'bool',
    description: '启用 http_get。还需同时配置主机白名单才会真正生效。',
    read: (c) => c.tools.httpEnabled,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TOOL_HTTP_ALLOW_HOSTS',
    group: '工具',
    type: 'list',
    description: 'http_get 主机白名单，支持 example.com、*.example.com、example.com:8443。',
    read: (c) => c.tools.httpAllowHosts,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TOOL_HTTP_TIMEOUT_MS',
    group: '工具',
    type: 'int',
    description: 'http_get 超时（毫秒）。',
    read: (c) => c.tools.httpTimeoutMs,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TOOL_HTTP_MAX_BYTES',
    group: '工具',
    type: 'int',
    description: 'http_get 响应体字节上限。',
    read: (c) => c.tools.httpMaxBytes,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TOOL_FS_ENABLED',
    group: '工具',
    type: 'bool',
    description: '启用 fs_read / fs_list。还需同时配置允许的根目录。',
    read: (c) => c.tools.fsEnabled,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TOOL_FS_ALLOW_ROOTS',
    group: '工具',
    type: 'list',
    description: '文件工具允许访问的根目录，逗号分隔。越界路径（含符号链接）会被拒绝。',
    read: (c) => c.tools.fsAllowRoots,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_TOOL_FS_MAX_BYTES',
    group: '工具',
    type: 'int',
    description: '单次文件读取的字节上限。',
    read: (c) => c.tools.fsMaxBytes,
    restartRequired: RESTART,
  },

  /* ---------------------------- 限流 ------------------------------ */
  {
    key: 'NAMI_RATE_LIMIT_ENABLED',
    group: '限流',
    type: 'bool',
    description: '启用按 API Key 的令牌桶限流。',
    read: (c) => c.rateLimit.enabled,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_RATE_LIMIT_BURST',
    group: '限流',
    type: 'int',
    description: '令牌桶容量，即允许的突发请求数。',
    read: (c) => c.rateLimit.capacity,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_RATE_LIMIT_PER_SECOND',
    group: '限流',
    type: 'float',
    description: '每秒补充的令牌数，即长期请求速率。',
    read: (c) => c.rateLimit.refillPerSecond,
    restartRequired: RESTART,
  },

  /* --------------------------- WebSocket --------------------------- */
  {
    key: 'NAMI_WS_PATH',
    group: 'WebSocket',
    type: 'string',
    description: 'WebSocket 端点路径。',
    read: (c) => c.ws.path,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_WS_MAX_PAYLOAD_BYTES',
    group: 'WebSocket',
    type: 'int',
    description: '单帧负载上限（字节），超出会关闭连接。',
    read: (c) => c.ws.maxPayloadBytes,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_WS_HEARTBEAT_MS',
    group: 'WebSocket',
    type: 'int',
    description: '服务端 ping 间隔（毫秒）。',
    read: (c) => c.ws.heartbeatMs,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_WS_MAX_CONNECTIONS_PER_KEY',
    group: 'WebSocket',
    type: 'int',
    description: '每个 API Key 允许的并发连接数。',
    read: (c) => c.ws.maxConnectionsPerKey,
    restartRequired: RESTART,
  },

  /* ---------------------------- OneBot ---------------------------- */
  {
    key: 'NAMI_ONEBOT_ENABLED',
    group: 'OneBot',
    type: 'bool',
    description: 'OneBot v11 连接器总开关。入站与出站默认都关闭。',
    read: (c) => c.onebot.enabled,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_URL',
    group: 'OneBot',
    type: 'string',
    description: 'OneBot HTTP API 地址，不要带路径后缀。',
    read: (c) => c.onebot.url,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_ACCESS_TOKEN',
    group: 'OneBot',
    type: 'string',
    description: 'Nami 调用 OneBot API 时使用的 access_token。',
    secret: true,
    read: () => null,
    isConfigured: (c) => c.onebot.accessToken !== '',
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_EVENT_TOKEN',
    group: 'OneBot',
    type: 'string',
    description: '别人向 Nami 上报事件时必须携带的密钥。留空则入站一律拒绝。',
    secret: true,
    read: () => null,
    isConfigured: (c) => c.onebot.eventToken !== '',
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_TIMEOUT_MS',
    group: 'OneBot',
    type: 'int',
    description: 'OneBot API 调用超时（毫秒）。',
    read: (c) => c.onebot.timeoutMs,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_INBOUND_ENABLED',
    group: 'OneBot',
    type: 'bool',
    description: '启用 POST /onebot/event 入站端点。',
    read: (c) => c.onebot.inbound.enabled,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_TRIGGER',
    group: 'OneBot',
    type: 'enum',
    description: '触发规则。mention 仅在被 @ 时回答（私聊一律视为对机器人说）；all 每条都答，费额度。',
    options: ONEBOT_TRIGGERS,
    read: (c) => c.onebot.inbound.trigger,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_PREFIX',
    group: 'OneBot',
    type: 'string',
    description: 'trigger=prefix 时使用的触发前缀。',
    read: (c) => c.onebot.inbound.prefix,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_ALLOW_GROUPS',
    group: 'OneBot',
    type: 'list',
    description: '允许触发机器人的群号，逗号分隔。留空表示所有群。',
    read: (c) => c.onebot.inbound.allowGroups,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_ALLOW_USERS',
    group: 'OneBot',
    type: 'list',
    description: '允许触发机器人的 QQ 号，逗号分隔。留空表示所有用户。',
    read: (c) => c.onebot.inbound.allowUsers,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_SESSION_PREFIX',
    group: 'OneBot',
    type: 'string',
    description: 'Nami 会话 id 前缀，实际为 <前缀>-group-<群号> / <前缀>-user-<QQ号>。',
    read: (c) => c.onebot.inbound.sessionPrefix,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_SYSTEM_PROMPT',
    group: 'OneBot',
    type: 'string',
    description: 'QQ 回复使用的系统提示词。QQ 不渲染 Markdown，默认要求纯文本。',
    read: (c) => c.onebot.inbound.systemPrompt,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_MAX_REPLY_CHARS',
    group: 'OneBot',
    type: 'int',
    description: '单条 QQ 消息字符上限，超出会分片发送。',
    read: (c) => c.onebot.inbound.maxReplyChars,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_STRIP_MARKDOWN',
    group: 'OneBot',
    type: 'bool',
    description: '发送前剥离 Markdown 标记。',
    read: (c) => c.onebot.inbound.stripMarkdown,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_MAX_CONCURRENT',
    group: 'OneBot',
    type: 'int',
    description: '并发的 QQ 触发运行数上限，超出的事件会被丢弃而不是排队。',
    read: (c) => c.onebot.inbound.maxConcurrent,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_TOOL_ENABLED',
    group: 'OneBot',
    type: 'bool',
    description: '启用出站发送工具。还需配置非空的目标白名单才会真正生效。',
    read: (c) => c.onebot.tools.enabled,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_TOOL_ALLOW_GROUPS',
    group: 'OneBot',
    type: 'list',
    description: '智能体允许主动发消息的群号。留空则禁用群发送。',
    read: (c) => c.onebot.tools.allowGroups,
    restartRequired: RESTART,
  },
  {
    key: 'NAMI_ONEBOT_TOOL_ALLOW_USERS',
    group: 'OneBot',
    type: 'list',
    description: '智能体允许主动私聊的 QQ 号。留空则禁用私聊发送。',
    read: (c) => c.onebot.tools.allowUsers,
    restartRequired: RESTART,
  },
];

/** Field lookup by key, for fast validation of a write request. */
export const CONFIG_FIELD_BY_KEY: ReadonlyMap<string, ConfigFieldSpec> = new Map(
  CONFIG_FIELDS.map((field) => [field.key, field]),
);

/** Group names in declaration order, for stable UI grouping. */
export const CONFIG_GROUPS: string[] = [...new Set(CONFIG_FIELDS.map((field) => field.group))];

export interface ValidationError {
  key: string;
  message: string;
}

/**
 * Validates one raw string value against its field spec.
 *
 * Returns the normalised value to write, or an error. Rejecting rather than
 * coercing keeps a typo from silently becoming a different setting.
 */
export function validateConfigValue(
  field: ConfigFieldSpec,
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.trim();

  switch (field.type) {
    case 'bool': {
      const lowered = value.toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(lowered)) return { ok: true, value: 'true' };
      if (['0', 'false', 'no', 'off', ''].includes(lowered)) return { ok: true, value: 'false' };
      return { ok: false, message: '布尔值只能是 true/false（也接受 1/0、yes/no、on/off）' };
    }
    case 'int': {
      if (value === '') return { ok: true, value: '' };
      if (!/^-?\d+$/.test(value)) return { ok: false, message: '必须是整数' };
      return { ok: true, value };
    }
    case 'float': {
      if (value === '') return { ok: true, value: '' };
      if (!/^-?\d+(\.\d+)?$/.test(value)) return { ok: false, message: '必须是数字' };
      return { ok: true, value };
    }
    case 'enum': {
      if (value === '') return { ok: true, value: '' };
      if (field.options && !field.options.includes(value)) {
        return { ok: false, message: `只能取以下值之一：${field.options.join(', ')}` };
      }
      return { ok: true, value };
    }
    case 'list': {
      if (value === '') return { ok: true, value: '' };
      const parts = value.split(',').map((part) => part.trim());
      if (parts.some((part) => part === '')) {
        return { ok: false, message: '列表项不能为空（注意多余的逗号）' };
      }
      if (parts.some((part) => part.includes('\n'))) {
        return { ok: false, message: '列表项不能包含换行' };
      }
      return { ok: true, value: parts.join(',') };
    }
    default: {
      if (value.includes('\n') && field.key !== 'NAMI_SYSTEM_PROMPT' && field.key !== 'NAMI_ONEBOT_SYSTEM_PROMPT') {
        return { ok: false, message: '该配置项不能包含换行' };
      }
      return { ok: true, value };
    }
  }
}

/** One field as the editor receives it: spec minus the read functions, plus value. */
export interface DescribedConfigField {
  key: string;
  group: string;
  type: ConfigFieldType;
  description: string;
  secret: boolean;
  options?: readonly string[];
  restartRequired: boolean;
  /** Effective value; always `null` for secrets. */
  value: string | number | boolean | string[] | null;
  /** Present for secrets only. */
  configured?: boolean;
}

/** Projects the live config into the shape the editor consumes. */
export function describeConfig(config: Config): DescribedConfigField[] {
  return CONFIG_FIELDS.map((field) => {
    const described: DescribedConfigField = {
      key: field.key,
      group: field.group,
      type: field.type,
      description: field.description,
      secret: field.secret === true,
      restartRequired: field.restartRequired,
      // Secrets never travel to the browser; only whether one is set.
      value: field.secret ? null : field.read(config),
    };
    if (field.options) described.options = field.options;
    if (field.secret) described.configured = field.isConfigured ? field.isConfigured(config) : false;
    return described;
  });
}
