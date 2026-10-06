# Nami

**自托管的 AI Agent 服务器载体（agent server carrier）** —— 可插拔 LLM 适配器、带沙箱的工具调用循环，以及 OpenAI 兼容 REST + 原生 SSE + WebSocket 三通道网关，运行时零依赖。

- 🦙 **一键接入 Ollama**：`npm run ollama -- --write` 自动探测、列模型、拉取、写 `.env`；走原生 `/api/chat`，可控制 `num_ctx` / `keep_alive`
- 🌐 **像 OpenAI 一样托管**：按请求 `model` 路由、别名映射（`gpt-4o-mini=qwen2.5:7b`）、模型白名单、上游不可达时优雅降级
- 💬 **接入 QQ**：内置 OneBot v11 连接器，对接 SnowLuma / NapCat / LLOneBot；入站按 @ 或前缀触发、每个群独立会话，出站工具带发送白名单
- 🤖 **接入 AstrBot**：附完整插件 `integrations/astrbot_plugin_nami/`（指令直连 + Dashboard 控制台 + 448 项离线自检）；也可以不装插件，直接把 Nami 配成 AstrBot 的 OpenAI 兼容提供商
- 🧩 **可插拔 LLM 适配器**：`ollama` 原生适配器、`openai` 兼容任意 `/chat/completions` 端点、`mock` 完全离线可用
- 🛠️ **带沙箱的工具调用循环**：JSON Schema 参数校验、超时、结果截断、危险工具默认关闭
- 🔌 **三通道接入**：OpenAI 兼容 REST、原生 SSE 事件流、WebSocket 双向控制
- 💾 **SQLite 会话持久化**：会话、消息、运行记录、工具调用、会话级 KV
- 🔐 **控制台账号密码登录**：账号存 SQLite、密码 scrypt 哈希、登录态走 HttpOnly Cookie；连续失败按用户名与来源地址分别锁定。程序化调用继续用 **API Key**（常量时间比较 + 令牌桶限流）。
- ♻️ **配置热重载 + 原地重启**：监听 `.env`，改动后自动原地重建全部服务（进程不退出）；顶栏有重启按钮。**先建新实例、成功才切换**，所以写错配置不会把服务弄挂。只重读**配置**——改了 `.ts` 源文件仍需重启进程
- 🖥️ **Web 管理面板** + **OpenAPI 3.1 规范**（`/openapi.json`、`/docs`）
- 📦 **运行时零依赖**：`dependencies` 为 `{}`，无构建步骤，直接 `node src/index.ts`
- 🐳 **Docker 一键部署**：非 root 运行，`/app/data` 数据卷（**本项目未使用，镜像未构建/未验证**）

> 🚚 **要把这份代码搬到 Linux 上部署或继续开发？** 先读 **[HANDOVER.md](HANDOVER.md)**。
> 它写明了哪些内容已经在真实环境验证过、哪些只有静态检查、哪些从未验证，以及一份 15 分钟的验收清单。
> 一句话（2026-10-06 更新）：**这份代码已在真实 Linux 上跑通验收清单的 ①—④**（类型检查 / smoke / 插件自检 / 真实启动与全部通道），
> 详细记录见 `HANDOVER.md` 与 `docs/linux-acceptance-2026-10-06.md`；
> **本项目不使用 Docker**，故 Docker 相关章节（下文的「Docker 部署」与仓库里的 `Dockerfile`）保留但**未经验证**。

---

## WebUI 控制台

浏览器打开 **`http://<主机>:8787/admin`**，用**账号密码**登录。

首次启动且数据库里还没有账号时，Nami 会自动建一个：`NAMI_ADMIN_USER`（默认 `admin`）配 `NAMI_ADMIN_PASSWORD`；没设密码就随机生成一把并**只在启动横幅里打印一次**。忘了密码或想加账号，在服务器上执行：

```bash
npm run passwd -- --list                        # 看看有哪些账号
npm run passwd -- --user admin --generate       # 重置密码（打印一次）
npm run passwd -- --add alice --password '...'  # 新建普通账号（加 --admin 建管理员）
```

登录态保存在 **HttpOnly Cookie** 里（`SameSite=Strict`，页面脚本读不到），所以控制台不再把任何长期凭证放进 `localStorage`。没有账号时也可以在登录页切到「API Key」用 `NAMI_API_KEYS` 进入；`/v1/*` 始终可以用 API Key。

十个页面：**登录 · 仪表盘 · 对话 · 会话 · 模型 · 工具 · OneBot/QQ · 配置 · 日志 · API 文档**。

技术上与 [AstrBot 的 dashboard](https://github.com/AstrBotDevs/AstrBot) 同类：**Vue 3 + Vuetify 3 + Vite**，深色为默认主题，MDI 图标走 SVG 路径（可摇树，不下载字体）。

**一个刻意的设计：UI 是构建期依赖，不是运行时依赖。**

```
webui/                  ← Vue 源码与构建工具链（devDependencies，不进镜像）
└── ...                    运行 `npm --prefix webui install && npm --prefix webui run build`

src/web/app/            ← 编译产物，已提交进仓库
└── index.html + assets/   Nami 直接静态托管它
```

因此 **`npm start` 依然不需要 `npm install`，Dockerfile 依然是单阶段**——镜像里没有 Node 构建工具链，`webui/` 被 `.dockerignore` 排除，`COPY src/` 顺带带走编译好的 bundle。

<details>
<summary>几个页面值得单独说明</summary>

- **对话**：流式对话，并且把**工具调用循环可视化**——`tool.call` 到达时插入一张可展开的卡片显示工具名、危险等级与参数，`tool.result` 到达时在同一张卡片上补上成功/失败、耗时与返回内容。这是 Nami 与普通聊天界面真正拉开差距的地方。
- **配置**：从服务器下发的 schema 动态渲染表单，写回 `.env`。三条硬约束：必须显式确认、只允许写 `NAMI_*`、**任一非法值则整体拒绝**（不会部分写入）。密钥永远读不回——只告诉你"已配置"，写入后回显 `***`。**保存后默认自动热重载**：Nami 监听 `.env`，文件一变就在原地重建全部服务（约 1 秒，进程不退出），因此绝大多数改动保存即生效；`NAMI_HOST`/`NAMI_PORT` 的变化会重新绑定监听，需要用新地址重连。关掉 `NAMI_HOT_RELOAD` 后改用顶栏的**重启按钮**。
- **日志**：内存环形缓冲 + SSE 实时流，支持 `Last-Event-ID` 断线续传。**日志在进入缓冲前就已完成脱敏**（按字段名递归屏蔽 `token`/`apiKey`/`authorization` 等），因为一旦进了缓冲，下游每个消费者都已经泄露了。`NAMI_LOG_CAPTURE_LEVEL` 与控制台级别独立——把控制台调安静不应该让日志页也空掉。
- **OneBot/QQ**：除连接状态与网桥计数外，提供一个**同步模拟事件**面板，不需要真实 QQ 账号就能验证整条入站链路，并直接告诉你被哪一步拦下（`no-trigger` / `from-self` / `group-not-allowed` / `busy` …）。

</details>

> 旧版单文件面板保留在 **`/admin/classic`**，既是逃生通道，也是 `src/web/app` 缺失时的自动回退。

---

## 特性

- **一键接入 Ollama**：`scripts/ollama.ts` 纯走 HTTP（不依赖 `ollama` CLI 是否可用），探测守护进程、列出模型（含参数量/量化/大小/是否已载入显存）、按需拉取并写 `.env`；写入时保留注释与无关配置，可重复执行。
- **原生 Ollama 适配器**：`llm/ollama.ts` 直接对接 `/api/chat`（NDJSON 流式），而非 OpenAI 兼容层——只有这样才能控制 `num_ctx`、`num_predict` 与 `keep_alive`，且不依赖较新的 Ollama 版本。原生 tool calling 少一层翻译。
- **像 OpenAI 一样托管**：`llm/router.ts` 让客户端按名字选模型，支持别名映射（把硬编码 `gpt-4o-mini` 的工具指向本地模型）、客户端可见名白名单、自动发现与缓存；探测失败时**不拦截**请求，而是原样转发。
- **OneBot v11 连接器**：`onebot/` 把 Nami 接到 SnowLuma（或任何 OneBot 实现）。入站端点在过滤后才花钱——`decideEvent` 是个纯函数，因为这里判错要么是「机器人装死」，要么是账单失控。出站发送工具双开关 + 白名单。
- **AstrBot 插件**：`integrations/astrbot_plugin_nami/` 是独立于本仓库运行时的 Python 插件，带自己的 448 项离线自检；Nami 侧的端到端测试里有一组「外部集成契约」断言钉住它依赖的调用约定。
- **可插拔 LLM 适配器**：`ollama` / `openai`（适配 OpenAI / DeepSeek / Groq / vLLM / LM Studio 等）/ `mock`（离线、确定性、会真的发起工具调用）三种 provider，新增适配器只需实现 `LLMProvider` 接口。
- **带沙箱的工具调用循环**：`core/agent.ts` 驱动「模型 → 工具 → 回灌 → 再问」的多轮循环，每次工具调用都经过 `tools/sandbox.ts`：启用检查、JSON Schema 参数校验、独立超时（可用运行信号取消）、结果按字节截断。
- **三通道接入**：OpenAI 兼容 REST（`/v1/chat/completions`、`/v1/models`）+ 原生 SSE（`/v1/agent/run` 事件流）+ WebSocket（`/ws` 双向控制，支持运行中取消）。
- **SQLite 会话持久化**：基于 Node 内置 `node:sqlite`（WAL 模式），落库会话、消息、运行、工具调用与会话级 KV 记忆，无需任何原生驱动或第三方 ORM。
- **API Key 鉴权 + 令牌桶限流**：Bearer Token 常量时间比较，按 key 计费的令牌桶（容量 + 每秒补充），超限返回 `429` 与 `Retry-After`。
- **Web 管理面板 + API 契约**：`/admin` 可视化面板；`/openapi.json` 是完整的 OpenAPI 3.1 规范，`/docs` 是它的实时渲染，且**由端到端测试校验与实现一致**。
- **运行时零依赖**：`package.json` 的 `dependencies` 为 `{}`，只用 devDependencies 做类型检查；TypeScript 由 Node 内置的类型剥离直接执行。
- **Docker 部署**：`node:24-alpine`、非 root 用户、`/app/data` 命名卷、内置 `HEALTHCHECK`。**本项目未使用 Docker，镜像未构建、容器内未运行**。

---

## 快速开始

### 要求

- **Node.js >= 22.6.0**（推荐 Node 24）
  - 需要 Node 的 **内置类型剥离** 来直接运行 `.ts`（`node src/index.ts`，无构建步骤）
  - 需要 **内置 `node:sqlite`** 模块做持久化
- 无需 `npm install`：**运行时依赖为 0**，仓库里只有 `typescript` / `@types/node` 两个 devDependencies，供 `npm run typecheck` 使用。

### 启动

```bash
# 无需 install，直接启动（默认 mock provider，完全离线可用）
npm start
# 等价于：node --disable-warning=ExperimentalWarning src/index.ts
```

启动后：

1. 打开 **Web 管理面板**：<http://127.0.0.1:8787/admin>
2. **首次启动生成的 API Key 会打印在日志里**（形如 `nami_xxxxxxxx...`），从终端复制即可使用。
   想固定 Key，就在 `.env` 里设置 `NAMI_API_KEYS`；留空则每次首启自动生成。
3. 默认 `NAMI_LLM_PROVIDER=mock`，**不需要任何 API Key 也不需要联网**，就能把鉴权、限流、SSE/WS、工具循环、持久化整条链路跑通。

```bash
# 也可以先用一个固定的 key 启动
NAMI_API_KEYS=nami_dev_key npm start
```

### 复制即用的 curl 示例

**1) OpenAI 兼容接口**（默认 mock 模型，会自动挑出最后一条 user 消息进入智能体循环）：

```bash
export NAMI_KEY=nami_dev_key   # 换成日志里打印的 key

curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $NAMI_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nami-mock-1",
    "messages": [
      { "role": "user", "content": "现在几点？" }
    ]
  }'
```

**2) 原生智能体接口 + SSE 流式**（`stream: true` 时输出的是命名事件流）：

```bash
curl -N http://127.0.0.1:8787/v1/agent/run \
  -H "Authorization: Bearer $NAMI_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "计算 12*(3+4)",
    "stream": true
  }'
```

输出形如（每个事件一个有名字段，事件之间空行分隔，另有 `: keep-alive` 心跳注释）：

```
event: run.start
data: {"runId":"run_...","sessionId":"sess_...","provider":"mock","model":"nami-mock-1"}

event: delta
data: {"text":"好的，我来调用"}

event: tool.call
data: {"id":"call_...","name":"calc","args":{"expression":"12*(3+4)"},"danger":"safe"}

event: tool.result
data: {"id":"call_...","name":"calc","ok":true,"content":"...","durationMs":0.42}

event: run.end
data: {"runId":"run_...","sessionId":"sess_...","output":"...","usage":{...},"rounds":2,"toolCalls":1,"durationMs":312}
```

> 不需要流式时传 `"stream": false`（`/v1/agent/run` 的默认值其实是 `true`），会返回一个包含 `output`、`usage`、`rounds` 的完整 JSON。其中 `toolCalls` 是**调用次数**（与 `run.end` 事件一致），本次运行每个工具调用的明细在同一份响应里的 `toolCallDetails` 数组中。

---

## 一键接入 Ollama

```bash
npm run ollama -- --pull qwen2.5:7b --write   # 探测 → 拉取 → 写 .env
npm start
```

就这两步。向导直接跟 Ollama 的 HTTP API 对话，**不依赖 `ollama` CLI 是否在 PATH 上**，它会依次：

1. 探测 `NAMI_OLLAMA_URL`（默认 `http://127.0.0.1:11434`），读 `/api/version` 确认连上了；
2. 列出已安装模型，附带参数量、量化等级和文件大小，并标出哪些已载入显存；
3. 按需 `--pull` 拉取模型，带进度条；
4. `--write` 把结果写进 `.env`——**保留注释、保留无关配置、就地改写已有键**，可重复执行。

连不上时会直接告诉你下一步该做什么（是服务没起、还是地址不对），而不是留一个模糊的连接错误：

```
✗ 无法连接 http://127.0.0.1:11434

  检测到 ollama CLI，但服务没有在跑。启动它：

  1. 安装 Ollama（若尚未安装）
     https://ollama.com/download
  2. 启动服务
     ollama serve
```

| 选项 | 说明 |
| --- | --- |
| `--url <url>` | Ollama 地址，默认 `http://127.0.0.1:11434` |
| `--model <name>` | 指定默认模型（须已安装） |
| `--pull <name>` | 先拉取该模型再继续 |
| `--write` | 写入 `.env` |
| `--json` | 以 JSON 输出，便于脚本消费 |

向导之外，**只要设置了 `NAMI_OLLAMA_URL`，即使不写 `NAMI_LLM_PROVIDER` 也会自动选用 Ollama 适配器。** 而 `NAMI_LLM_MODEL` 留空则会在启动时自动发现并采用第一个已安装模型——启动横幅会直接告诉你连没连上、有几个模型、哪些已在显存里。

### 为什么走原生 API 而不是 Ollama 的 OpenAI 兼容层

Nami 用的是 Ollama 自己的 `/api/chat`（NDJSON 流式），而不是 `/v1/chat/completions`。原因有三：

- `options`（`num_ctx`、`num_predict`）和 `keep_alive` **只在原生 API 上生效**，这是控制本地模型显存占用的唯一手段；
- 兼容层是较新版本才有的，原生 API 覆盖面更广；
- 原生 tool calling 少一层翻译，更忠实。

Nami 对外**依然**暴露 OpenAI 兼容接口——只是上游客户端这一侧用原生协议。

---

## 像 OpenAI 一样托管

把 Nami 指向你的 Ollama，它就变成一个可以被别人接入的 OpenAI 兼容服务：

```bash
# 别人的客户端只需要改这两行
base_url = http://<你的主机>:8787/v1
api_key  = <NAMI_API_KEYS 中的某个 key>
```

### 按模型名路由

客户端传的 `model` 会被真正使用，就像 OpenAI 一样——不再是服务端写死的单一模型：

```bash
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $KEY"
# → 列出 Ollama 上所有已安装模型（带参数量/量化信息）
```

### 别名：让硬编码 `gpt-4o-mini` 的工具直接跑起来

```bash
NAMI_MODEL_ALIASES=gpt-4o-mini=qwen2.5:7b,claude-3-5-sonnet=llama3.1:8b
```

客户端发 `"model": "gpt-4o-mini"`，实际由 `qwen2.5:7b` 服务。响应里**回显客户端请求的名字**，所以调用方完全察觉不到映射。`/v1/models` 会把别名也列出来，并标注 `nami.aliasOf` 指向上游真名。

### 白名单：控制哪些模型对外开放

```bash
NAMI_MODELS_EXPOSE=gpt-4o-mini,qwen2.5:7b
NAMI_ALLOW_CLIENT_MODEL=true
```

- `NAMI_MODELS_EXPOSE` 列出**客户端可见的名字**（可以是别名）。为空则暴露全部。
- 配置了白名单后，`/v1/models` **只返回白名单里的名字**——不会因为别名而被上游真名泄漏出去。
- 请求未在白名单内 → `403 model_not_allowed`；在白名单内但上游没装 → `404 model_not_found`。
- `NAMI_ALLOW_CLIENT_MODEL=false` 则一律落到默认模型，客户端传什么都无效。

### 优雅降级

Ollama 挂了的时候，Nami **不会**跟着崩：

| 端点 | 行为 |
| --- | --- |
| `/healthz` | 仍然 `200`——进程本身是健康的 |
| `/readyz` | `503`，并在 `checks.models` 里写明原因 |
| `/v1/models` | 仍然 `200` |
| `/v1/chat/completions` | `404`，错误信息里带上 Ollama 地址和下一步操作 |

另外：如果模型发现失败（上游不可达 / 端点不支持 `/models`），路由**不会**拦截请求，而是原样转发——不会因为探测失败就整体不可用。

---

## 接入 QQ：OneBot v11（SnowLuma）

[SnowLuma](https://snowluma.github.io/zh/docs/guide/introduction) 是 NTQQ 的 **OneBot v11 远端协议框架**——它把 QQ 桥接成 HTTP / WebSocket 形式的 OneBot 接口（默认 HTTP API 在 `:3000`）。Nami 内置了 OneBot v11 连接器，两个方向都支持：

```
QQ ←→ SnowLuma (:3000, OneBot v11) ←→ Nami
                                        ├─ 入站：POST /onebot/event  (收消息 → 跑智能体 → 回发)
                                        └─ 出站：onebot_* 工具        (智能体主动发消息)
```

### 让 Nami 在群里回答问题（入站）

在 SnowLuma 里把 **HTTP 事件上报**指向 Nami，并设置上报密钥：

```
上报地址：http://<Nami 所在主机>:8787/onebot/event
密钥/token：<与下面 NAMI_ONEBOT_EVENT_TOKEN 相同的值>
```

Nami 侧：

```bash
NAMI_ONEBOT_ENABLED=true
NAMI_ONEBOT_URL=http://127.0.0.1:3000      # SnowLuma 的 OneBot HTTP API
NAMI_ONEBOT_EVENT_TOKEN=<和上报密钥一致>    # 不设则入站一律拒绝
NAMI_ONEBOT_TRIGGER=mention                 # 只在被 @ 时回答
NAMI_ONEBOT_ALLOW_GROUPS=123456789          # 只服务指定群（留空=所有群）
```

然后在群里 @ 机器人即可。

**几个关键设计：**

- **先回 204，再跑模型。** OneBot 上报方几秒就超时，而本地模型可能要跑一分钟。所以端点立刻返回 `204 No Content`，智能体在后台运行，答案通过 OneBot HTTP API 异步发回。日志里能看到完整的处理耗时。
- **只有被叫到才说话。** `NAMI_ONEBOT_TRIGGER` 支持 `mention`（默认，被 @ 才答）、`prefix`（以 `NAMI_ONEBOT_PREFIX` 开头）、`all`（每条都答，费额度）、`none`（闭麦）。私聊没有第三方可 @，所以**私聊消息一律视为对机器人说的**——否则默认模式会让机器人永远不回私聊。
- **@ 用的是真正的 `at` 消息段**，不是文本 `@123456`（后者在 QQ 里只是几个字符，不会提醒到人）。长回答会被切分成多条，只有第一条带 @。
- **每个群/人一个会话。** 会话 id 为 `qq-group-<群号>` / `qq-user-<QQ号>`，各自在 SQLite 里独立保存历史。
- **默认要求纯文本。** QQ 完全不渲染 Markdown，所以系统提示词直接要求模型别写 Markdown，另外还会再剥一层 `**`、反引号、代码围栏等残留。
- **同一会话串行。** 一个会话同时只跑一次；另有 `NAMI_ONEBOT_MAX_CONCURRENT` 全局上限。多余的事件直接丢弃（不排队），避免本地模型被刷爆。

### 让智能体主动发消息（出站）

```bash
NAMI_ONEBOT_TOOL_ENABLED=true
NAMI_ONEBOT_TOOL_ALLOW_GROUPS=123456789     # 必须显式列出可发送的目标
```

启用后智能体获得 `onebot_send_group_msg` / `onebot_send_private_msg`（发送目标必须命中白名单，否则工具调用被拒绝并说明原因）、`onebot_get_group_list`、`onebot_get_group_member_list`、`onebot_login_info`。

> ⚠️ **发送类工具默认关闭，且必须配白名单。** 一个能向任意 QQ 群发消息的智能体是滥用入口，所以这是刻意的双重开关。没配白名单时工具仍然注册（管理面板里可见），但处于禁用状态——不会静默消失。

### 不装 QQ 也能测

管理 API 提供了一个同步模拟端点，直接走完整的入站链路并把结果返回：

```bash
curl -X POST http://127.0.0.1:8787/admin/api/onebot/event \
  -H "X-Admin-Token: $NAMI_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"post_type":"message","message_type":"group","group_id":123456789,
       "user_id":10001,"self_id":20002,
       "message":[{"type":"at","data":{"qq":"20002"}},
                  {"type":"text","data":{"text":"现在几点"}}]}'
# → {"handled":true,"reason":"handled","sessionId":"qq-group-123456789","chunks":1,...}
```

未触发时返回 `reason`（`no-trigger` / `from-self` / `group-not-allowed` / `busy` / `empty`…）以及一句原因说明——排查「机器人为什么不理我」时先看这里。

`GET /admin/api/onebot/status` 会报告配置（令牌只回显布尔值）、网桥计数，以及一次实时探测（当前登录的 QQ 账号、在线状态）。

---

## 接入 AstrBot

[AstrBot](https://github.com/AstrBotDevs/AstrBot) 是多平台聊天机器人框架。Nami 附带一个完整插件 **[`integrations/astrbot_plugin_nami/`](integrations/astrbot_plugin_nami/)**，提供两种接法——可以只用其中一种，也可以都用：

### 接法一：把 Nami 当成 AstrBot 的 LLM 提供商（推荐先做这个）

AstrBot 本体就支持 OpenAI 兼容提供商，所以这一条**不需要插件**，改配置即可。在 AstrBot WebUI 里新增一个「OpenAI 兼容」类型的提供商：

| 字段 | 值 |
| --- | --- |
| API Base / 接口地址 | `http://<Nami 主机>:8787/v1` |
| API Key | `NAMI_API_KEYS` 里的任意一个 |
| 模型 | 先用 `/v1/models` 看有哪些可选（也可以用 `NAMI_MODEL_ALIASES` 把 `gpt-4o-mini` 之类的名字映射到本地模型） |

这样 AstrBot 的全部对话能力都跑在 Nami 上，并且自动获得 Nami 的工具循环与会话持久化。

### 接法二：装插件，拿到指令直连 + 控制台

```bash
# 把插件目录整体拷进 AstrBot 的插件目录
cp -r integrations/astrbot_plugin_nami  <AstrBot>/data/plugins/
# 然后到 WebUI 的插件管理里重载
```

> 注意拷贝的是 `integrations/astrbot_plugin_nami/` **目录本身**，拷完后应存在 `<AstrBot>/data/plugins/astrbot_plugin_nami/main.py`。

插件**没有任何第三方 Python 依赖**（网络走 AstrBot 自带的 `aiohttp`），也不需要 `requirements.txt`。

**指令**（`/nami` 指令组）：

| 指令 | 作用 |
| --- | --- |
| `/nami 状态` | 调 `/healthz` + `/readyz`，显示版本、运行时长、provider/model 与就绪项 |
| `/nami 模型` | 列出可选模型，标注别名与参数量/量化（超长时截断并提示剩余数量） |
| `/nami 问 <文本>` | 直接问 Nami，答案回到聊天里；按 `session_scope` 维持多轮上下文 |
| `/nami 工具` | 列出 Nami 已启用的工具及其危险等级 |
| `/nami 重置` | 清掉当前作用域的 Nami 会话，下一句重新开始 |
| `/nami 诊断` | 五步体检：配置 → `/healthz` → `/readyz` → `/v1/models` → 一次最小对话探测，每步给 ✓/✗ 和具体的下一步 |

**Dashboard 页面**（AstrBot WebUI 里的「Nami」页）：状态卡片、模型目录、工具清单、会话列表（可删除）、以及一个直接提问的输入框。页面数据全部由插件后端代理，**API Key 不会下发到浏览器**。

**配置**（15 项，在 AstrBot WebUI 的插件配置页里改）：`nami_base_url`、`nami_host_root`、`nami_api_key`(secret)、`nami_admin_token`(secret)、`default_model`、`request_timeout`、`system_prompt`、`session_scope`（`user`/`group`/`global`，决定多轮上下文按什么粒度隔离）、`enable_commands`、`admin_only`、`auto_reply_enabled`、`auto_reply_trigger`、`auto_reply_prefix`、`mention_keyword`、`max_reply_chars`。

> ⚠️ `auto_reply_enabled` **默认关闭**。打开后机器人会转发收到的消息触发 Nami 生成——这直接消耗模型额度，请先确认触发条件（`auto_reply_trigger`）足够严格。默认 `mention` 只在被 @ 时触发。

一个容易踩的坑：`nami_base_url` 要带 `/v1`，而 `nami_host_root`（用于 `/healthz`、`/readyz`、`/admin/api/*`）**不能**带 `/v1`。两个都填错时插件会自动剥掉多余的 `/v1` 兜底。

### 插件的自检

插件自带一份**不依赖 AstrBot** 的离线自检（用桩模块替换 `astrbot.*`、把唯一的网络出口换掉，因此不会开真连接、不会改插件目录）：

```bash
cd integrations
python selftest_plugin_nami.py     # ✓ 全部通过 448 项断言
```

Nami 侧的端到端测试里也有一组**外部集成契约**断言（`scripts/smoke.ts` 的 `testIntegrationContract`），钉住插件依赖的调用约定——包括带冒号的作用域会话 id、以及 URL 编码后的会话删除。改动 Nami 时若破坏了插件所依赖的行为，测试会失败而不是让插件悄悄坏掉。

---

## 架构

### 目录结构

```
src/
├── index.ts                # 进程入口：加载配置 → 打开 SQLite → 装配依赖 → 启动 HTTP/WS → 优雅关闭
├── server.ts               # HTTP 服务装配：CORS → 请求 id → 鉴权 → 限流 → 路由 → 日志/指标
├── app.ts                  # AppDeps 依赖容器，交给每个路由模块
├── config.ts               # 全部环境变量及其默认值（唯一权威来源）
├── logger.ts               # 零依赖结构化日志（pretty / json 两种格式）
├── metrics.ts              # 进程内计数器与仪表，供管理面板读取
├── ratelimit.ts            # 按 API Key 的令牌桶限流
├── core/
│   ├── agent.ts            # 智能体循环：provider 流 → 工具沙箱 → 结果回灌 → 直到无工具调用
│   └── types.ts            # 共享数据类型与 AgentEvent 事件表
├── http/
│   ├── auth.ts             # Bearer / X-Admin-Token 鉴权与常量时间比较
│   ├── body.ts             # 请求体读取（硬性大小上限）与 JSON 解析
│   ├── response.ts         # sendJson / sendText / HttpError / CORS 统一响应
│   ├── router.ts           # 约 1KB 的路径路由，支持 `:param` 占位符
│   ├── sse.ts              # SSE 写入器（命名事件、data-only 帧、心跳注释）
│   └── types.ts            # HTTP 层类型（RouteHandler / AuthInfo 等）
├── routes/
│   ├── health.ts           # GET /healthz、GET /readyz
│   ├── openai.ts           # POST /v1/chat/completions、GET /v1/models
│   ├── agent.ts            # POST /v1/agent/run（SSE 或整段 JSON）
│   ├── sessions.ts         # /v1/sessions*、/v1/runs*
│   └── admin.ts            # /admin/api/* 管理接口（密钥一律不回显）
├── llm/
│   ├── types.ts            # LLMProvider 契约、流式 chunk 类型、ModelInfo、wire 工具转换
│   ├── index.ts            # createProvider：按 NAMI_LLM_PROVIDER 选择适配器
│   ├── ollama.ts           # 原生 Ollama 适配器（/api/chat NDJSON、发现、拉取）
│   ├── openai.ts           # 任意 OpenAI 兼容端点适配器
│   ├── router.ts           # 模型目录 + 按请求路由（别名 / 白名单 / 优雅降级）
│   ├── mock.ts             # 离线确定性 Mock 模型（逐字流式，可触发真实工具调用）
│   └── collect.ts          # 把流收集成一轮完整回复 + 工具调用分片累加器
├── openapi.ts              # OpenAPI 3.1 规范（由测试校验与路由一致）
├── onebot/
│   ├── client.ts           # OneBot v11 HTTP API 客户端（消息用数组段，避免 CQ 注入）
│   └── bridge.ts           # 入站网桥：纯函数过滤 → 会话映射 → 跑智能体 → 分片回发
├── tools/
│   ├── registry.ts         # 工具注册表（可用工具的唯一真实来源）
│   ├── sandbox.ts          # 执行沙箱：启用检查 / schema 校验 / 超时 / 结果截断
│   ├── validate.ts         # JSON Schema 子集校验器
│   ├── types.ts            # Tool / ToolContext 类型
│   └── builtin/
│       ├── basic.ts        # echo、now
│       ├── calc.ts         # calc：手写递归下降求值器（不使用 eval）
│       ├── memory.ts       # memory_*：会话级 KV，落 SQLite
│       ├── net.ts          # http_get：默认关闭 + 主机白名单 + 逐跳重定向校验
│       ├── fs.ts           # fs_read / fs_list：默认关闭 + realpath 越界防护
│       └── index.ts        # 组装内置工具集（含 server_info）
├── store/
│   ├── db.ts               # node:sqlite 连接与建表（WAL、外键、busy_timeout）
│   └── store.ts            # 会话 / 消息 / 运行 / 工具调用 / KV 的持久化 API
├── ws/
│   ├── gateway.ts          # /ws 网关：升级握手、鉴权、消息分发、运行中取消
│   ├── connection.ts       # 单连接状态机（心跳、分片、关闭）
│   └── frames.ts           # RFC 6455 帧编解码与握手（手写，零依赖）
├── logbus.ts               # ★ 日志环形缓冲 + 按字段名递归脱敏
├── config-schema.ts        # ★ 可编辑配置项的声明式描述（WebUI 表单的唯一来源）
├── env-file.ts             # .env 读写（接入向导与配置编辑器共用同一实现）
└── web/
    ├── panel.ts            # 经典面板与 API 参考页的读取与兜底
    ├── panel.html          # 经典单文件面板（GET /admin/classic）
    ├── docs.html           # API 参考页（GET /docs，前端 fetch /openapi.json）
    └── app/                # ★ 已提交的 WebUI 编译产物（Vue + Vuetify）
        ├── index.html
        └── assets/         # 带哈希的 JS/CSS，命中即长期缓存

webui/                      # ★ WebUI 源码（Vue 3 + Vuetify 3 + Vite）
├── vite.config.ts          # 产物输出到 ../src/web/app，base 为 /admin/
└── src/
    ├── api/client.ts       # 类型化 API 客户端 + SSE 解析（POST 流与 EventSource）
    ├── composables/        # 凭证、Toast、格式化工具
    ├── components/         # 共享组件（PageHeader / StatCard / AsyncSection …）
    ├── plugins/vuetify.ts  # 主题与默认属性
    └── views/              # 十个页面
```

顶层还有 `scripts/smoke.ts`（端到端测试）、`scripts/check-portability.ts`（跨平台静态检查）、`scripts/ollama.ts`（一键接入向导），以及 `integrations/astrbot_plugin_nami/`（独立的 AstrBot 插件，不属于 Nami 的运行时）。

`webui/` 是**构建期**依赖：它的 `node_modules` 只在你修改界面时才需要，编译产物已提交，因此运行 Nami 仍然零安装。

### 一次请求都发生了什么

以 `POST /v1/agent/run`（`stream: true`）为例：

1. **HTTP 入口** —— `node:http` 收到请求，`http/router.ts` 按「方法 + 段数」精确匹配到 `/v1/agent/run`；`http/body.ts` 在 `NAMI_MAX_BODY_BYTES` 上限内读取并解析 JSON。
2. **鉴权与限流** —— `http/auth.ts` 从 `Authorization: Bearer`（或 `X-Admin-Token`）取出凭证，用 `timingSafeEqual` 常量时间比对 `NAMI_API_KEYS`；`ratelimit.ts` 对该 key 扣一个令牌，不足则直接返回 `429`。
3. **模型解析** —— 请求里的 `model` 先交给 `llm/router.ts`：查别名映射、比对白名单、对照发现到的模型目录，未知或未暴露的名字在这里就以 `404` / `403` 失败，**不会**把无效请求打到上游。
4. **智能体循环** —— `core/agent.ts` 的 `runAgent()` 建立/复用会话、写入 `runs` 记录（记下解析后的模型）、追加用户消息，组装上下文（system prompt + 最近 `NAMI_MAX_HISTORY_MESSAGES` 条历史），进入最多 `NAMI_MAX_TOOL_ROUNDS` 轮的循环。
5. **LLM 适配器** —— `llm/ollama.ts` / `llm/openai.ts` / `llm/mock.ts` 实现同一个 `stream()` 原语；文本分片立即以 `delta` 事件转发，工具调用分片由 `llm/collect.ts` 按 `index` 拼装成完整 `ToolCall`（Ollama 不下发 id，由适配器合成）。
6. **工具沙箱** —— 若有工具调用，先 `emit tool.call`，再由 `tools/sandbox.ts` 校验参数、以 `NAMI_TOOL_TIMEOUT_MS` 为上限执行、按 `NAMI_MAX_TOOL_RESULT_BYTES` 截断结果，然后发出 `tool.result` 并把结果作为 `tool` 角色消息回灌给模型，进入下一轮。
7. **持久化** —— 每一步都在 `core/agent.ts` 内落库：assistant 消息（含工具调用）、tool 结果、`tool_invocations` 明细；`finally` 块保证运行记录一定被收尾（即使客户端中途断开）。
8. **SSE / WS 输出** —— `http/sse.ts` 把 `AgentEvent` 写成 `event:` + `data:` 帧（含心跳注释）；WebSocket 通道则把同一个事件扁平化成 `{ "type": ..., ...data }` 的 JSON。两条通道共享完全相同的语义，因为它们转发的是同一个事件流。

---

## 接入真实模型

`NAMI_LLM_*` 变量一览：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NAMI_LLM_PROVIDER` | `mock` | `mock`（离线）或 `openai`（任意 OpenAI 兼容端点） |
| `NAMI_LLM_BASE_URL` | `https://api.openai.com/v1` | 上游 API 基地址，结尾斜杠会被去掉 |
| `NAMI_LLM_API_KEY` | *(空)* | 上游 API Key；`mock` 与 Ollama 都不需要真实值 |
| `NAMI_LLM_MODEL` | `mock` 时为 `nami-mock-1`，否则 `gpt-4o-mini` | 模型 id |
| `NAMI_LLM_TIMEOUT_MS` | `120000` | 上游请求超时（毫秒），与调用方取消信号合并 |
| `NAMI_LLM_HEADERS` | *(空)* | 附加请求头，逗号分隔的 `key=value` |
| `NAMI_MOCK_DELAY_MS` | `8` | 仅对 `mock` 生效：每个分片的延迟（毫秒），`0` 表示最快 |

Ollama 与模型托管相关的变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NAMI_OLLAMA_URL` | `http://127.0.0.1:11434` | 原生 API 基地址，**不带 `/v1`**。设置它就等于选用了 Ollama 适配器 |
| `NAMI_OLLAMA_KEEP_ALIVE` | `5m` | 模型驻留时长；`0` 立即卸载，`-1` 永久驻留 |
| `NAMI_OLLAMA_NUM_CTX` | `0` | 上下文窗口（`num_ctx`）；`0` 表示沿用 Ollama 自己的默认值（通常是 4096） |
| `NAMI_OLLAMA_PROBE_TIMEOUT_MS` | `4000` | 启动探测超时（毫秒） |
| `NAMI_ALLOW_CLIENT_MODEL` | `true` | 是否允许客户端按请求指定模型 |
| `NAMI_MODELS_EXPOSE` | *(空)* | 对外开放的**客户端可见**模型名白名单；空表示全部 |
| `NAMI_MODEL_ALIASES` | *(空)* | 别名映射，逗号分隔的 `客户端名=上游真名` |
| `NAMI_MODELS_CACHE_TTL_MS` | `30000` | 模型发现结果缓存时长（毫秒） |

### Ollama（本地，推荐）

```bash
npm run ollama -- --write      # 自动探测并写好上面这些变量
```

手动配置等价于：

```bash
NAMI_LLM_PROVIDER=ollama
NAMI_OLLAMA_URL=http://127.0.0.1:11434
NAMI_LLM_MODEL=          # 留空 = 启动时自动发现并采用第一个模型
```

> 本机直接运行时 `http://127.0.0.1:11434` 即可；Nami 跑在容器里、Ollama 跑在宿主机时用 `http://host.docker.internal:11434`（Linux 上可能需要 `--add-host=host.docker.internal:host-gateway`）。

> 想用 Ollama 自带的 OpenAI 兼容层（而不是 Nami 的原生适配器）也可以：`NAMI_LLM_PROVIDER=openai` + `NAMI_LLM_BASE_URL=http://127.0.0.1:11434/v1`。但这样会失去 `num_ctx` / `keep_alive` 控制，且依赖较新版本的 Ollama。

### OpenAI

```bash
NAMI_LLM_PROVIDER=openai
NAMI_LLM_BASE_URL=https://api.openai.com/v1
NAMI_LLM_API_KEY=sk-xxxxxxxxxxxxxxxx
NAMI_LLM_MODEL=gpt-4o-mini
```

### DeepSeek

```bash
NAMI_LLM_PROVIDER=openai
NAMI_LLM_BASE_URL=https://api.deepseek.com/v1
NAMI_LLM_API_KEY=sk-xxxxxxxxxxxxxxxx
NAMI_LLM_MODEL=deepseek-chat
```

### 其他 OpenAI 兼容端点

`vLLM` / `LM Studio` / `Groq` / `Together` 等同理：把 `NAMI_LLM_BASE_URL` 指向它的 `/v1` 即可。此时 `NAMI_LLM_MODEL` 留空也能自动发现——启动时会调用上游 `/models` 并采用第一个。

---

## API 参考

除健康探针外，所有 `/v1/*` 与 `/admin/api/*` 都需要凭证：

- `Authorization: Bearer <NAMI_API_KEYS 中的任意一个>`
- 管理接口还可使用 `X-Admin-Token: <NAMI_ADMIN_TOKEN>`；未配置 `NAMI_ADMIN_TOKEN` 时，任何有效 API Key 都可访问管理接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 无 | 存活探针：`status`、`version`、`uptimeSeconds`、`node`、`pid` |
| `GET` | `/readyz` | 无 | 就绪探针：数据库、provider、model、工具计数；未就绪返回 `503` |
| `GET` | `/v1/models` | API Key | OpenAI 兼容模型列表。列出所有**客户端可选**的模型名，包含别名（别名项带 `nami.aliasOf`）与参数量/量化信息；配置了 `NAMI_MODELS_EXPOSE` 时只返回白名单内的名字 |
| `POST` | `/v1/chat/completions` | API Key | OpenAI 兼容对话。`model` 按请求生效并支持别名与白名单；传 `tools` 走代理模式（工具调用原样返回给调用方）；不传则走服务端智能体模式。支持 `stream`、`temperature`、`max_tokens`、`stream_options.include_usage`、`session_id` / `X-Nami-Session` |
| `POST` | `/v1/agent/run` | API Key | 原生智能体入口。字段：`input`（必填）、`sessionId`、`model`、`system`、`maxRounds`、`temperature`、`maxTokens`、`stream`（默认 `true`）。流式返回完整 `AgentEvent` 事件流 |
| `GET` | `/v1/sessions` | API Key | 会话列表，`limit`（默认 50，最大 200）、`offset` |
| `POST` | `/v1/sessions` | API Key | 创建会话，字段 `title`、`metadata`；返回 `201` |
| `GET` | `/v1/sessions/:id` | API Key | 单个会话 + 消息（`limit`，默认 500，最大 2000）+ 会话记忆 |
| `DELETE` | `/v1/sessions/:id` | API Key | 删除会话及其消息 |
| `GET` | `/v1/sessions/:id/messages` | API Key | 只取会话消息列表 |
| `GET` | `/v1/runs` | API Key | 最近的运行记录（`limit`，默认 20，最大 200） |
| `GET` | `/v1/runs/:id` | API Key | 单次运行详情 + 其工具调用明细 |
| `GET` | `/admin` | 页面本身无需凭证 | Web 管理面板（HTML）。面板展示的数据全部来自 `/admin/api/*`，这些接口调用需要凭证 |
| `GET` | `/admin/api/*` | Admin Token 或 API Key | 管理接口：`overview`、`models`（模型目录，含别名与暴露状态，`?refresh=1` 强制重探）、`metrics`、`stats`、`tools`、`config`（已脱敏）、`routes`、`sessions`、`sessions/:id`（另有 `PUT` 改标题、`DELETE` 删除）、`runs`、`runs/:id` |
| `GET` | `/openapi.json` | 无 | 完整的 OpenAPI 3.1 规范。由端到端测试校验与实现一致，不会漂移 |
| `GET` | `/docs` | 无 | 由 `/openapi.json` 实时渲染的人读 API 参考页 |
| `POST` | `/onebot/event` | 上报密钥 | OneBot v11 事件上报入口。`Authorization: Bearer <NAMI_ONEBOT_EVENT_TOKEN>`、`X-OneBot-Token` 或 `?access_token=`。**先回 `204` 再后台跑智能体**；未配置 `NAMI_ONEBOT_EVENT_TOKEN` 时一律 `503` |
| `GET` | `/admin/api/onebot/status` | Admin Token 或 API Key | 连接器配置（令牌只回显布尔值）、网桥计数、以及对 OneBot 的实时探测（登录账号/在线状态） |
| `POST` | `/admin/api/onebot/event` | Admin Token 或 API Key | **同步模拟**一次入站事件并返回结果（`handled`/`reason`/`sessionId`/`chunks`），无需真实 QQ 即可验证链路 |
| `POST` | `/admin/api/onebot/send` | Admin Token 或 API Key | 手动发一条 QQ 消息（`text` + `group_id` 或 `user_id`，可选 `at`），用于诊断 |

错误响应统一为：

```json
{ "error": { "message": "...", "type": "invalid_request_error", "code": "...", "request_id": "..." } }
```

### AgentEvent 事件表

`/v1/agent/run` 的 SSE 事件名与 WebSocket 消息的 `type` 完全一致（WS 上把 `data` 的字段扁平化到顶层）。

| 事件 | payload 字段 | 说明 |
| --- | --- | --- |
| `run.start` | `runId`、`sessionId`、`provider`、`model` | 一次运行开始，此时会话与 run 记录已建立 |
| `delta` | `text` | 模型输出增量；把所有 `text` 依次拼接即为完整回答 |
| `tool.call` | `id`、`name`、`args`、`danger` | 模型请求调用工具，`args` 为已解析的 JSON 对象，`danger` 为 `safe`/`caution`/`dangerous` |
| `tool.result` | `id`、`name`、`ok`、`content`、`error?`、`durationMs` | 工具执行结果；`content` 已按 `NAMI_MAX_TOOL_RESULT_BYTES` 截断 |
| `run.end` | `runId`、`sessionId`、`output`、`usage`、`rounds`、`toolCalls`、`durationMs` | 运行成功结束；`usage` 含 `prompt_tokens`/`completion_tokens`/`total_tokens` |
| `error` | `message`、`code?` | 运行失败或被取消（`code` 可能是 `cancelled`、`run_failed`、`stream_failed` 等） |

---

## WebSocket 协议

端点：`ws://<host>:<port>/ws`（路径由 `NAMI_WS_PATH` 配置，与 HTTP 共用同一端口，通过 HTTP Upgrade 升级）。

### 如何鉴权

- **非浏览器客户端**：使用标准请求头 `Authorization: Bearer <API_KEY>`。
- **浏览器**：WebSocket 构造函数 **无法设置请求头**，因此 `/ws` 额外接受 query 参数 —— `?key=<API_KEY>`（也兼容 `?api_key=`）。
  注意这会出现在访问日志/浏览器历史里，请只在受信网络中使用，或改用服务端代理。
- 也接受 `X-Admin-Token` 请求头。

握手阶段就会被拒绝：未鉴权返回 `401`，同一 key 并发连接超过 `NAMI_WS_MAX_CONNECTIONS_PER_KEY`（默认 8）返回 `429`，路径不对返回 `404`。

### 客户端 → 服务端

| `type` | 字段 | 说明 |
| --- | --- | --- |
| `user_message` | `content`（必填，非空字符串）、`sessionId?`、`system?`、`maxRounds?` | 发起一轮智能体运行；`sessionId` 省略时复用本连接最近一次运行的会话 |
| `cancel` | — | 取消当前连接上进行中的运行，服务端回 `cancelled` |
| `ping` | — | 应用层心跳，服务端回 `pong` |
| `history` | `sessionId?`、`limit?`（默认 100，上限 500） | 拉取某会话的消息历史 |
| `sessions` | `limit?`（默认 50，上限 200） | 拉取会话列表 |

### 服务端 → 客户端

| `type` | 字段 | 说明 |
| --- | --- | --- |
| `ready` | `provider`、`model`、`tools`、`protocol`、`heartbeatMs` | 连接建立后立即推送的问候帧 |
| `run.start` | 同 AgentEvent | 运行开始 |
| `delta` | `text` | 输出增量 |
| `tool.call` | `id`、`name`、`args`、`danger` | 工具调用开始 |
| `tool.result` | `id`、`name`、`ok`、`content`、`error?`、`durationMs` | 工具调用结果 |
| `run.end` | 同 AgentEvent | 运行结束 |
| `error` | `message`、`code?` | 错误；连接空闲或消息非法时也会出现（如 `invalid_message`、`unsupported_type`、`run_in_progress`） |
| `pong` | `ts` | `ping` 的应答 |
| `cancelled` | `sessionId` | 运行已被取消 |
| `history` | `sessionId`、`messages` | 请求的历史消息 |
| `sessions` | `data` | 请求的会话列表 |

### 浏览器 JS 示例

```html
<pre id="out"></pre>
<script>
  const API_KEY = 'nami_change_me_please'; // 从启动日志复制
  const out = document.getElementById('out');

  // 浏览器无法为 WebSocket 设置请求头，所以用 ?key= 传凭证
  const ws = new WebSocket(`ws://127.0.0.1:8787/ws?key=${encodeURIComponent(API_KEY)}`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'user_message', content: '现在几点？' }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'ready':       console.log('已连接', msg.provider, msg.model, msg.tools); break;
      case 'delta':       out.textContent += msg.text; break;
      case 'tool.call':   out.textContent += `\n[tool.call] ${msg.name} ${JSON.stringify(msg.args)}\n`; break;
      case 'tool.result': out.textContent += `[tool.result] ok=${msg.ok} ${msg.content}\n`; break;
      case 'run.end':     out.textContent += `\n[run.end] ${msg.runId} rounds=${msg.rounds} tools=${msg.toolCalls}\n`; break;
      case 'error':       console.error('[error]', msg.message, msg.code); break;
    }
  });

  // 需要中断时：ws.send(JSON.stringify({ type: 'cancel' }));
</script>
```

---

## 内置工具

工具由 `tools/registry.ts` 统一注册，模型只能看到「已启用」的工具；被禁用的工具仍会出现在 `/admin/api/tools` 里，附带 `enabled: false`，便于排查。

| 工具 | 作用 | 危险级别 | 默认状态 |
| --- | --- | --- | --- |
| `echo` | 原样返回给定文本，用于验证工具管线是否通畅 | safe | ✅ 启用 |
| `now` | 返回服务器当前时间：ISO 8601、epoch 毫秒、UTC、本地字符串、IANA 时区 | safe | ✅ 启用 |
| `calc` | 安全算术求值：`+ - * / % ^`、括号、常量 `pi`/`e`/`tau`，函数 `sqrt`/`abs`/`round`/`floor`/`ceil`/`exp`/`ln`/`log10`/`log2`/`sin`/`cos`/`tan`/`min`/`max`/`pow` | safe | ✅ 启用 |
| `server_info` | 描述本机部署：版本、Node 版本、平台、运行时长、当前模型与能力开关 | safe | ✅ 启用 |
| `memory_write` | 在当前会话的长期记忆中写入键值（覆盖同键旧值） | safe | ✅ 启用（受 `NAMI_TOOL_MEMORY_ENABLED`，默认 `true`） |
| `memory_read` | 读取当前会话中某个键的值 | safe | ✅ 启用（同上） |
| `memory_list` | 列出当前会话记忆中的全部键与值 | safe | ✅ 启用（同上） |
| `memory_delete` | 删除当前会话记忆中的某个键 | caution | ✅ 启用（同上） |
| `http_get` | 以 HTTP GET 抓取 URL 并返回文本正文（支持 `maxBytes` 上限） | caution | ❌ **默认关闭** |
| `fs_read` | 读取服务器上的 UTF-8 文本文件（支持 `offset`、`maxBytes`） | caution | ❌ **默认关闭** |
| `fs_list` | 列出目录内容（`recursive` 时最多 500 条） | caution | ❌ **默认关闭** |
| `onebot_login_info` | 报告当前 OneBot 登录的 QQ 账号与在线状态 | safe | ❌ 默认关闭 |
| `onebot_get_group_list` | 列出机器人已加入的 QQ 群 | safe | ❌ 默认关闭 |
| `onebot_get_group_member_list` | 列出群成员：QQ 号、昵称、群名片、角色（最多 200 条） | caution | ❌ 默认关闭 |
| `onebot_send_group_msg` | 向指定 QQ 群发纯文本 | dangerous | ❌ **默认关闭 + 白名单** |
| `onebot_send_private_msg` | 向指定 QQ 用户发私聊 | dangerous | ❌ **默认关闭 + 白名单** |

### OneBot 工具需要两步才能打开

```bash
NAMI_ONEBOT_ENABLED=true
NAMI_ONEBOT_TOOL_ENABLED=true
NAMI_ONEBOT_TOOL_ALLOW_GROUPS=123456789     # 或 NAMI_ONEBOT_TOOL_ALLOW_USERS
```

前两项控制开关，第三项决定**允许发给谁**。白名单为空时发送类工具仍处于禁用状态——一个能向任意 QQ 群发消息的智能体是滥用入口，所以这里刻意做成双重开关。读类工具（登录信息、群列表）只需要 `NAMI_ONEBOT_ENABLED`。

### `http_get` 需要两步才能打开

```bash
NAMI_TOOL_HTTP_ENABLED=true
NAMI_TOOL_HTTP_ALLOW_HOSTS=api.github.com,*.wikipedia.org
```

两个条件必须同时满足，否则工具保持禁用。白名单支持精确主机（`api.github.com`、`api.github.com:8443`）、子域通配（`*.wikipedia.org`）与 `*`（放行一切，不推荐）。重定向**不会**自动跟随，而是逐跳重新校验白名单，最多 3 跳。

### `fs_read` / `fs_list` 需要两步才能打开

```bash
NAMI_TOOL_FS_ENABLED=true
NAMI_TOOL_FS_ALLOW_ROOTS=/app/data,/srv/documents
```

相对路径以进程工作目录为基准解析。校验会在 `realpath` 之后再确认一次路径仍位于允许的根目录内，因此根目录里的符号链接无法用于跳出沙箱。

---

## 安全说明

- **API Key 鉴权 + 常量时间比较**：凭证来自 `Authorization: Bearer`、`X-Admin-Token`；比较使用 `node:crypto` 的 `timingSafeEqual`，且长度不等时也会消耗一次比较，避免通过计时或长度差异推断密钥。query 凭证只在 WebSocket 握手（浏览器无法设置请求头）时被接受，普通 HTTP 请求不接受，以免密钥进入访问日志。
- **令牌桶限流**：按 API Key（无凭证时按来源）计数，容量 `NAMI_RATE_LIMIT_BURST`、每秒补充 `NAMI_RATE_LIMIT_PER_SECOND`；超限返回 `429` 并带 `Retry-After`。空闲桶会被自动回收，内存不会随 key 数量无限增长。
- **工具沙箱**：所有调用统一经过 `tools/sandbox.ts` —— ① 工具必须已启用；② 参数必须通过声明式 JSON Schema 校验（类型、枚举、范围、长度、正则、必填、`additionalProperties`）；③ 每个工具有独立超时（`NAMI_TOOL_TIMEOUT_MS`），并随运行信号一起被取消；④ 返回给模型的结果按 `NAMI_MAX_TOOL_RESULT_BYTES` 截断。
- **`http_get` 的重定向逐跳校验**：显式使用 `redirect: 'manual'`，每一跳都重新做主机白名单检查，最多 3 跳；响应体按字节流式读取并在 `NAMI_TOOL_HTTP_MAX_BYTES` 处停止，避免大响应打爆内存。
- **`fs_*` 的 realpath 越界防护**：拒绝含空字节的路径，先解析为绝对路径，再对 `realpath` 结果与字面路径**双重**做「是否位于允许根目录内」判定（`path.relative` 不以 `..` 开头且非绝对路径），符号链接无法绕出白名单。
- **`calc` 不使用 `eval`**：表达式被词法分析成 token 流后由手写递归下降求值器折叠，`eval` / `new Function` 从未出现，因此无法借表达式执行任意代码。
- **危险工具默认关闭**：`http_get`、`fs_read`、`fs_list`、`onebot_send_*` 默认关闭，且即便打开也强制要求白名单/根目录同时配置；CORS 允许头被显式限定为 `authorization,content-type,x-request-id,x-admin-token`。
- **OneBot 入站是计费触发器，因此默认关闭且必须有密钥**：`POST /onebot/event` 未配置 `NAMI_ONEBOT_EVENT_TOKEN` 时一律返回 `503`——否则任何人都能靠发消息消耗你的模型额度。密钥比较同样走常量时间；上报密钥与 OneBot 的 `access_token` 是两个独立的值，各管一个方向。
- **OneBot 出站双重开关**：发送类工具需要 `NAMI_ONEBOT_ENABLED` + `NAMI_ONEBOT_TOOL_ENABLED` + 非空目标白名单三者同时满足；白名单外的一次发送会被拒绝并在工具结果里说明原因，而不是静默失败。
- **QQ 消息用数组段而非 CQ 字符串**：发送时始终构造 `[{type:'text',...}]` 形式，用户文本永远不会被重新解释成 CQ 码（否则会形成注入通道）。
- **防自我循环**：`user_id === self_id` 的事件（机器人自己的消息）一律忽略，避免机器人和自己对话刷爆额度。
- **零依赖**：运行时没有 `node_modules`，不存在第三方包带来的供应链风险面。

> ⚠️ Nami 会执行模型提出的工具调用。请把 API Key 当作敏感凭证管理，在生产环境务必设置 `NAMI_ADMIN_TOKEN`、收窄 `NAMI_CORS_ORIGIN`，并且不要把 `fs_read` 的根目录指向系统目录。

---

## Docker 部署

> ⚠️ **2026-10-06：本项目已决定不使用 Docker 部署。** 本节与仓库里的 `Dockerfile` / `docker-compose.yml` 一并保留，
> 但**镜像从未构建过、容器内也从未运行过**——如果你要用，请把它当作全新的、未验证的东西（HANDOVER.md 第 3 节 ① 与第 5 节是那时的清单）。
> 本机运行请看上面的「快速开始」：`NAMI_API_KEYS=<key> npm start`。

镜像基于 `node:24-alpine`，**不执行 `npm install`**（运行时零依赖），只有 `package.json`、`src/`、`scripts/` 被复制进镜像，以非 root 用户运行，唯一可写路径是 `/app/data`。

### 方式一：Docker Compose（推荐）

```bash
# 可选：准备配置。不存在也能启动，服务会用 mock provider + 自动生成的 key
cp .env.example .env
vim .env

docker compose up -d --build
docker compose logs -f nami
```

- 端口映射：`8787:8787`
- 数据卷：命名卷 `nami-data` → `/app/data`（`docker compose down` 不会丢数据；要清空用 `docker compose down -v`）
- 容器内置 healthcheck，`docker compose ps` 可看到 `healthy`
- `.env` 是可选的（Compose v2.24+ 的 `env_file: - path: .env, required: false`）

### 方式二：plain docker build / run

```bash
docker build -t nami-server:latest .

docker run -d \
  --name nami-server \
  --restart unless-stopped \
  -p 8787:8787 \
  -e NAMI_HOST=0.0.0.0 \
  -v nami-data:/app/data \
  --env-file .env \
  nami-server:latest
```

如果不想要 `.env` 文件，直接把变量逐个用 `-e` 传，例如：

```bash
docker run -d --name nami-server -p 8787:8787 -v nami-data:/app/data \
  -e NAMI_LLM_PROVIDER=openai \
  -e NAMI_LLM_BASE_URL=https://api.deepseek.com/v1 \
  -e NAMI_LLM_API_KEY=sk-xxxxxxxx \
  -e NAMI_LLM_MODEL=deepseek-chat \
  nami-server:latest
```

### 从日志里读取自动生成的 API Key

未设置 `NAMI_API_KEYS` 时，服务会在启动时生成一个随机 key 并**醒目地打印到标准输出**：

```bash
# Compose
docker compose logs nami | grep -i "api key"

# plain docker
docker logs nami-server 2>&1 | grep -i "api key"
```

拿到 `nami_xxxxxxxx...` 后即可用于 curl / 面板登录。日志默认是 `pretty` 格式（人类可读）；要接入日志采集系统就设 `NAMI_LOG_FORMAT=json`，输出变成每行一个 JSON 对象。

持久化数据位于卷内：`/app/data/nami.sqlite`（外加 WAL 模式的 `-wal` / `-shm` 文件）。备份只需拷贝整个 `/app/data`。

---

## 开发

```bash
# 运行（无构建步骤，TypeScript 由 Node 直接执行）
npm start          # node --disable-warning=ExperimentalWarning src/index.ts

# 监听文件变化自动重启
npm run dev        # 同上，附加 --watch

# 一键接入本机 Ollama：探测 → 可选拉取 → 写 .env
npm run ollama -- --help
npm run ollama -- --pull qwen2.5:7b --write

# 类型检查（唯一需要 npm install 的场景）
npm run typecheck  # tsc --noEmit

# 端到端冒烟测试：以 mock/ollama provider 启动服务并打真实 HTTP 请求
npm run smoke      # node --disable-warning=ExperimentalWarning scripts/smoke.ts

# 类型检查 + 冒烟测试
npm test

# AstrBot 插件的离线自检（不需要 AstrBot、不需要联网）
cd integrations && python selftest_plugin_nami.py

# WebUI：仅在你修改界面时才需要（产物已提交，平时不用管）
npm run webui:install     # npm --prefix webui install
npm run webui:dev         # 开发服务器（:5199，自动代理到本机 8787 的 Nami）
npm run webui:build       # 构建并输出到 src/web/app
```

冒烟测试共 **563 项断言**，覆盖全部通道与安全边界。其中：

- **Ollama** 部分跑在测试内启动的**假 Ollama 守护进程**上，因此不需要真装 Ollama 也能验证：`/api/tags` 发现、NDJSON 流式解析（并故意把一行 JSON 拆到两次 TCP 写入以测试分片缓冲）、原生 tool calling、`num_ctx` / `keep_alive` 透传、别名与白名单策略、以及 Ollama 不可用时的降级行为。
- **OneBot** 部分跑在测试内启动的**假 OneBot 实现**上，覆盖：入站过滤的每一条分支（@/前缀/全部/闭麦、私聊视为对机器人说话、自我循环、群与用户白名单、图片无文字）、上报密钥校验、`204` 先于模型返回、回答经真实 `at` 消息段回发、长回答分片、出站工具的白名单拒绝、以及管理端同步模拟与手动发送。
- **外部集成契约**部分把 AstrBot 插件依赖的调用约定钉死：带冒号的作用域会话 id 能原样落库与取回、URL 编码后的会话删除、`/readyz` 的 `checks` 字段齐全、以及插件据此给建议的错误码。

加上 AstrBot 插件自己的 **448 项**离线自检，这个仓库里共有 **1011 项**可复现的断言。

关于 `npm install`：**只有 `npm run typecheck`（和 `npm test` 的类型检查部分）需要它**，因为 `typescript` 与 `@types/node` 是 devDependencies。日常 `npm start` / `npm run dev` / `npm run smoke` 都不需要 `node_modules`，也不会产生 `dist/` 目录 —— 整个项目没有构建产物。

因为启用了 Node 的类型剥离，代码必须遵守 `tsconfig.json` 里的 `erasableSyntaxOnly`：只使用可擦除的 TypeScript 语法（不能用 `enum`、`namespace`、参数属性等需要代码生成的特性）。导入路径要写全 `.ts` 扩展名（`allowImportingTsExtensions`）。

---

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| **端口被占用**：`EADDRINUSE: address already in use 127.0.0.1:8787` | 8787 已被别的进程占用。换端口 `NAMI_PORT=8788 npm start`，或查出占用者：Windows `netstat -ano \| findstr :8787`，macOS/Linux `lsof -i :8787`。Docker 场景还要确认宿主机侧映射端口没被占用。 |
| **401 Unauthorized / `missing_api_key` / `invalid_api_key`** | 请求缺少凭证或 key 不对。检查是否带了 `Authorization: Bearer <key>`；key 必须与 `NAMI_API_KEYS` 中的某一项完全一致。若从未设置 `NAMI_API_KEYS`，key 是启动时随机生成的，去日志里找（`docker logs nami-server \| grep -i "api key"`），重启进程后如果没固定 `NAMI_API_KEYS` 还会再换一个 —— 生产环境请显式设置。访问 `/admin/api/*` 时若已配置 `NAMI_ADMIN_TOKEN`，用 API Key 会返回 `403 admin_required`，需要改用 `X-Admin-Token`。 |
| **429 Too Many Requests / `rate_limited`** | 触发了按 key 的令牌桶。默认容量 60、每秒回补 1 个。调大 `NAMI_RATE_LIMIT_BURST` / `NAMI_RATE_LIMIT_PER_SECOND`，或临时设 `NAMI_RATE_LIMIT_ENABLED=false`（不推荐用于公网）。WebSocket 上如果报 `too_many_connections`，那是单 key 并发连接数超过 `NAMI_WS_MAX_CONNECTIONS_PER_KEY`（默认 8）。 |
| **Node 版本过低，无法直接运行 `.ts`** | 表现为 `Unknown file extension ".ts"`、`ERR_UNKNOWN_FILE_EXTENSION`、找不到 `node:sqlite`，或类型剥离报语法错误。Nami 需要 **Node >= 22.6**，推荐 Node 24：`node -v` 确认版本，用 nvm/fnm 或从官网升级。项目**没有**构建步骤，所以不要试图 `tsc` 出 `dist/` 来跑。 |
| **启动时出现 SQLite 的 `ExperimentalWarning`** | 这是**正常现象**。`node:sqlite` 目前是 Node 的实验性模块，所以 `npm start` 里带 `--disable-warning=ExperimentalWarning` 把提示静音。如果你自己直接用 `node src/index.ts`（没加该参数）看到了它，功能完全不受影响；想安静运行就照抄 `package.json` 里的启动参数。 |
| **Mock 模式「不够智能」** | 预期行为。`NAMI_LLM_PROVIDER=mock` 是一个**离线确定性桩模型**：它会逐字流式输出、并能识别「现在几点」「计算 12*(3+4)」「echo 你好」「记住 key=value」等少量意图来真实触发工具调用，目的是在无网络、无 API Key 的情况下验证整条链路，而不是充当通用助手。要真实智能，跑 `npm run ollama -- --write`，或按「接入真实模型」一节切到 `NAMI_LLM_PROVIDER=openai`。 |
| **`Cannot reach Ollama at http://127.0.0.1:11434`** | 守护进程没在跑，或地址不对。先 `ollama serve`（Windows/macOS 装完 Ollama 后通常已作为后台服务运行），再 `npm run ollama` 确认。注意 Nami 用的是**原生 API**，所以 `NAMI_OLLAMA_URL` 不要带 `/v1`。若 Ollama 在别的机器/容器里，用 `--url` 或直接改 `NAMI_OLLAMA_URL`；容器内访问宿主机通常是 `http://host.docker.internal:11434`。 |
| **`Ollama rejected the request (404): model "x" not found`** | 该模型没装。`npm run ollama -- --pull <模型名> --write`，或 `ollama pull <模型名>`。`npm run ollama` 会列出所有已安装模型。 |
| **启动横幅显示 `model (none available)`，`/readyz` 返回 503** | Ollama 连上了但**一个模型都没有**，因此没有默认可用的模型。拉一个即可：`npm run ollama -- --pull qwen2.5:7b --write`。拉取完成后 `/readyz` 会自动恢复（模型目录有 30 秒缓存，或重启服务）。 |
| **`403 model_not_allowed` / `404 model_not_found`** | 前者是 `NAMI_MODELS_EXPOSE` 白名单没放行该名字；后者是名字在白名单里但上游没装。用 `GET /v1/models` 看当前可选的名字，或 `GET /admin/api/models`（带 admin 凭证）看完整目录，包括标注为 `notInstalled` 的别名目标 —— 通常这意味着 `NAMI_MODEL_ALIASES` 里写错了上游模型名。 |
| **本地模型显存占用过高 / 回答被截断** | 用 `NAMI_OLLAMA_NUM_CTX` 显式设定上下文窗口（默认沿用 Ollama 的 4096），用 `NAMI_OLLAMA_KEEP_ALIVE` 控制模型驻留时长（`0` 请求结束即卸载，`-1` 永久驻留）。注意这两个参数**只在原生适配器上生效**；如果你走的是 `NAMI_LLM_PROVIDER=openai` + Ollama 的 `/v1` 兼容层，它们会被忽略。 |
| **QQ 里 @ 了机器人但它不理人** | 先看 `POST /admin/api/onebot/event` 的同步模拟返回的 `reason`，它会直接告诉你是哪一步拦下的：`no-trigger`（触发规则没命中，默认是 `mention`，检查是否真的 @ 到、以及 SnowLuma 是否把 `at` 段正确上报）、`from-self`（`user_id == self_id`，被当作机器人自己的消息丢弃）、`group-not-allowed`/`user-not-allowed`（白名单）、`empty`（只有图片没有文字）、`busy`（同一会话已有一次运行在跑）。再确认 SnowLuma 的事件上报地址指向 `http://<Nami>:8787/onebot/event` 且密钥与 `NAMI_ONEBOT_EVENT_TOKEN` 一致。 |
| **`POST /onebot/event` 返回 503 `onebot_no_event_token`** | 这是刻意的：入站端点会触发模型调用，没有密钥就等于对外开放计费。设置 `NAMI_ONEBOT_EVENT_TOKEN`，并在 SnowLuma 的上报配置里填同一个值。 |
| **`POST /onebot/event` 返回 401** | 上报密钥不匹配。注意 `NAMI_ONEBOT_EVENT_TOKEN`（入站上报用）与 `NAMI_ONEBOT_ACCESS_TOKEN`（Nami 调用 OneBot API 用）是**两个不同的值**，配错方向就会 401。 |
| **`Cannot reach the OneBot implementation`** | SnowLuma 没在跑，或 `NAMI_ONEBOT_URL` 不对（默认 `http://127.0.0.1:3000`，**不要**带 `/onebot/v11` 之类的前缀）。Nami 在容器里、SnowLuma 在宿主机时用 `http://host.docker.internal:3000`。可在 Nami 那台机器上 `curl -X POST http://127.0.0.1:3000/get_login_info -H 'Content-Type: application/json' -d '{}'` 直接验证。 |
| **智能体调用了 `onebot_send_group_msg` 却报白名单错误** | 这是设计行为。确认目标群号确实写在 `NAMI_ONEBOT_TOOL_ALLOW_GROUPS` 里（逗号分隔，且是**群号**不是群名）；同时 `NAMI_ONEBOT_ENABLED` 与 `NAMI_ONEBOT_TOOL_ENABLED` 都要为 `true`。 |
| **机器人变得很吵 / 额度消耗异常** | 检查 `NAMI_ONEBOT_TRIGGER` 是否被设成了 `all`（每条消息都触发）。默认的 `mention` 只在被 @ 时回答。另外 `NAMI_ONEBOT_MAX_CONCURRENT` 限制并发运行数，多余事件会被丢弃而不是排队。 |
