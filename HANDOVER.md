# Nami 交接说明（Linux 端）

> 面向：在另一台 **Linux** 机器上接手、验证、部署 Nami 的人。
> 本文档由 Windows 开发机生成。**阅读顺序：第 1 节 → 第 2 节 → 按需查阅其余部分。**

---

## 0. 一句话现状

Nami 是一个自托管的 AI Agent 服务器载体（Node.js + TypeScript，**运行时零第三方依赖**，无构建步骤）。
功能完整、测试充分，但：

> ⚠️ **它从未在 Linux 上运行过，Docker 镜像也从未构建过。**
> 所有验证都发生在 Windows + Node 24.13.1 上。Linux 相关的结论来自**静态检查**，不是实机运行。

这不是谦虚，是交接时最需要知道的一件事。第 2 节把它拆成了表。

---

## 1. 十五分钟验收清单

在 Linux 机器上，按顺序执行。**不需要 `npm install` 就能跑前两步。**

```bash
# ── ① 运行时版本 ────────────────────────────────────────────────
node -v                     # 必须 >= 22.6，强烈推荐 24.x
                            # 低于 22.6 会直接失败：无法执行 .ts，也没有 node:sqlite
                            # 用 nvm/fnm 装：nvm install 24

# ── ② 全量测试（类型检查 + 可移植性检查 + 端到端断言）──────────
npm test                    # 期望：✗ 0 项失败
                            # 407 项断言 + 324 项可移植性检查

# ── ③ AstrBot 插件的离线自检（独立于上面那套）─────────────────
cd integrations && python3 selftest_plugin_nami.py && cd ..
                            # 期望：✓ 全部通过 448 项断言
                            # 只用标准库，不需要装 AstrBot，不联网

# ── ④ 真实启动一次 ──────────────────────────────────────────────
NAMI_API_KEYS=dev_key npm start
# 另开一个终端：
curl -s localhost:8787/healthz
curl -s -H 'Authorization: Bearer dev_key' localhost:8787/v1/models
curl -s -X POST localhost:8787/v1/agent/run \
  -H 'Authorization: Bearer dev_key' -H 'Content-Type: application/json' \
  -d '{"input":"echo 你好","stream":false}'
# 期望：能读到 JSON 输出，且日志里有一次 run finished

# ── ⑤ Docker 构建（★ 从未验证过，这是最高风险项）──────────────
docker build -t nami:handover .
docker run --rm -p 8787:8787 -v nami-data:/app/data \
  -e NAMI_API_KEYS=dev_key nami:handover
curl -s localhost:8787/healthz
```

**只要 ①②③ 通过，代码本身在 Linux 上是好的。** ④⑤ 是部署层面的验证。

---

## 2. 验证状态矩阵（交接的核心）

| 内容 | 验证方式 | Windows | Linux | 说明 |
| --- | --- | --- | --- | --- |
| 类型检查（tsc，`erasableSyntaxOnly`） | `npm run typecheck` | ✅ 0 错误 | ⚠️ 推断 | tsc 本身跨平台 |
| 端到端断言 407 项 | `npm run smoke` | ✅ 全过 | ❌ **未跑过** | 真实 HTTP / SSE / WebSocket / SQLite |
| 可移植性静态检查 324 项 | `npm run check:portability` | ✅ 0 问题 | ⚠️ 推断 | 见下方「已静态排除的风险」 |
| AstrBot 插件自检 448 项 | `python3 selftest_plugin_nami.py` | ✅ 全过 | ❌ **未跑过** | 纯标准库，跨平台风险低 |
| **Docker 镜像构建** | `docker build` | ❌ 无 docker | ❌ **从未构建** | **最高风险项** |
| **Alpine / musl 运行时** | 容器实跑 | ❌ | ❌ **从未运行** | 零原生依赖，理论上无风险 |
| **SIGTERM 优雅退出** | `docker stop` | ⚠️ 只测了 SIGINT | ❌ **未测** | 代码里已注册 SIGTERM |
| Ollama 原生协议 | 真实 0.34.4 守护进程 | ✅ `version`/`tags` 实测 | ⚠️ 推断 | `/api/chat` 用假守护进程验证（无模型可拉） |
| Ollama 真实对话 | 真实模型生成 | ❌ **未验证** | ❌ | 本机没装任何模型，未擅自拉取 GB 级模型 |
| OneBot v11 收发 | 假 OneBot 实现 | ✅ 全链路 | ⚠️ 推断 | 含真实进程级演示 |
| OneBot 真实 QQ | 真实 SnowLuma + QQ | ❌ **未验证** | ❌ | 需要 Windows 上跑 NTQQ，本机未部署 |
| AstrBot 插件被真实 AstrBot 加载 | WebUI 里加载 | ❌ **未验证** | ❌ | 环境没有 AstrBot；正确性基于桩 API + 官方文档 |
| 管理面板视觉/交互 | 浏览器 | ❌ **未目视检查** | ❌ | 只做了 JS 语法检查 + 端点一致性核对 |

### 已经静态排除的 Linux 风险

`npm run check:portability` 逐条查这些，当前 **324 项检查 0 问题**：

- **模块路径大小写**：Windows 上 `./Types.ts` 能找到 `types.ts`，Linux 上直接 404。检查器对每个相对导入**逐段做精确大小写比对**（`existsSync` 不够——它在 Windows 上会放行错误大小写）。
- **资源引用大小写**：`panel.html`、`docs.html`、`logo.png`、页面里的 `./app.js` / `./style.css`。
- **Windows 专有假设**：盘符路径、`path.win32`、`LOCALAPPDATA`/`APPDATA`、`os.EOL`、`process.platform === 'win32'` 分支。
- **CRLF 换行**：全部源文件已统一为 LF，并用 `.gitattributes` 锁定（`* text=auto eol=lf`）。
- **Dockerfile**：反斜杠、盘符 COPY、Windows 命令、Alpine 的 BusyBox `adduser` 参数。
- **`package.json`**：未声明 `engines.node`、依赖非空（零依赖本身就是可移植性保证）。

> 检查器支持行内抑制：在行尾写 `portability-ok` 注释。任何启发式检查器都需要这个出口——「断言某个 Windows 风格路径会被拒绝」的代码看起来和被禁的东西一模一样。

---

## 3. Linux 上最可能出问题的点（按概率排序）

### ① Docker 构建失败 —— 概率最高

`Dockerfile` 是 `node:24-alpine`，**不执行 `npm install`**（运行时零依赖），只 `COPY package.json src/ scripts/`。从未构建过，可能的问题：

- `adduser -S -u 10001 -G nami -h /app -s /sbin/nologin nami` 是 Alpine(BusyBox) 语法；如果基础镜像换了 Debian 系会失败。
- BusyBox `adduser` 对已存在的 `-h /app`（WORKDIR 已创建）有时会告警。
- `HEALTHCHECK` 用的是 Node 内置 `fetch`（alpine 没有 curl/wget），依赖容器内 Node 可用。

**处置**：直接构建，看报错。若卡在用户创建，可临时改成 `USER node`（官方镜像自带非 root 用户）验证其余部分。

### ② `node:sqlite` —— 概率低但影响大

Nami 用 Node **内置**的 `node:sqlite`，不打原生模块。这对 alpine/musl 和 arm64 是**优势**（不需要编译、不需要预编译二进制）。但它目前是 Node 的实验性模块：

- 会打印 `ExperimentalWarning` —— 已在启动脚本里用 `--disable-warning=ExperimentalWarning` 静音。
- 若你的 Node 版本行为有变化，去 `src/store/db.ts`（连接与建表）和 `src/store/store.ts`（持久化 API）。

### ③ 文件权限 —— 概率中

容器以 uid 10001 的非 root 用户运行，`/app/data` 是唯一可写路径。用 bind mount 而不是 named volume 时，宿主目录属主不对会写不进去。

**处置**：优先用 named volume（compose 里已配 `nami-data:/app/data`）；用 bind mount 就 `chown -R 10001:10001 <宿主目录>`。

### ④ SIGTERM 优雅退出 —— 未测

`src/index.ts` 注册了 `SIGINT` 和 `SIGTERM`：先关监听、再关 WebSocket、最后关数据库，超时（`NAMI_SHUTDOWN_GRACE_MS`，默认 8s）后强制退出。`docker stop` 发的正是 SIGTERM。

**验证方式**：`docker stop` 后看日志是否有 `shutdown complete`，并确认 `runs` 表里没有残留 `status='running'` 的记录（启动时也会自动把上次的僵尸 run 标记为 failed）。

### ⑤ `host.docker.internal` —— 只在需要连通宿主服务时

Nami 跑容器、Ollama/SnowLuma 跑宿主机时，Linux **不像** Docker Desktop 那样自动提供 `host.docker.internal`。

**处置**：`docker run --add-host=host.docker.internal:host-gateway ...`，或直接用宿主的内网 IP。README 的 Docker 一节已提到。

### ⑥ 文件描述符与并发

大量并发 SSE / WebSocket 连接会消耗 fd。Linux 默认 `ulimit -n` 可能是 1024；生产容器建议 `--ulimit nofile=65535:65535`。

---

## 4. 项目地图

```
neko-NamiServer/
├── src/                        49 个 .ts，约 8.6k 行
│   ├── index.ts                入口：装配所有层 + 启动横幅 + 信号处理
│   ├── server.ts               HTTP 装配：路由、鉴权、限流、CORS、错误处理
│   ├── config.ts               ★ 所有环境变量的唯一真实来源
│   ├── core/agent.ts           ★ 智能体循环：流式 → 工具 → 回灌 → 再问
│   ├── core/types.ts           纯数据类型（无运行时依赖，避免循环引用）
│   ├── llm/                    ★ 可插拔适配器
│   │   ├── ollama.ts            原生 /api/chat（NDJSON），可控 num_ctx/keep_alive
│   │   ├── openai.ts            任意 OpenAI 兼容端点
│   │   ├── mock.ts              离线确定性桩模型
│   │   └── router.ts            模型目录 + 按请求路由（别名/白名单/降级）
│   ├── onebot/                 ★ QQ 桥
│   │   ├── client.ts            OneBot v11 HTTP API 客户端
│   │   └── bridge.ts            入站过滤（纯函数）→ 会话映射 → 跑 → 回发
│   ├── tools/                  工具注册表 + 执行沙箱 + 内置工具
│   ├── store/                  node:sqlite 持久化
│   ├── routes/                 各端点实现
│   ├── ws/                     手写 RFC 6455（Node 只有 WS 客户端，没有服务端）
│   ├── web/                    panel.html（管理面板）+ docs.html（API 参考）
│   └── openapi.ts              OpenAPI 3.1 规范（由测试校验与路由一致）
├── scripts/
│   ├── smoke.ts                端到端测试，407 项断言
│   ├── check-portability.ts    ★ 跨平台静态检查，324 项
│   └── ollama.ts               一键接入 Ollama 向导
├── integrations/               ★ 独立于运行时，不进 Docker 镜像
│   ├── astrbot_plugin_nami/    AstrBot 插件（Python，零第三方依赖）
│   └── selftest_plugin_nami.py 插件离线自检，448 项断言
├── Dockerfile / docker-compose.yml
├── .env.example                ★ 全部 66 个环境变量的清单与默认值
├── .gitattributes              强制 LF
└── README.md                   620 行中文文档（功能/配置/API/排障）
```

**★ = 接手时最需要看的文件。** 想快速理解请求流程，看 README 的「一次请求都发生了什么」。

---

## 5. 契约钉在哪里（改代码前必读）

这份代码的设计原则是：**能让机器检查的，绝不靠人记住。**

| 契约 | 钉在哪 |
| --- | --- |
| OpenAPI 规范必须覆盖全部路由 | `scripts/smoke.ts` 的 `testOpenApiSurface`：拿实时路由表和规范**双向**比对，多一条少一条都失败 |
| AstrBot 插件依赖的调用约定 | `testIntegrationContract`：带冒号的作用域会话 id、URL 编码的会话删除、`/readyz` 字段齐全 |
| OneBot 过滤逻辑的每条分支 | `testOneBotPure`：`decideEvent` 是纯函数，不启动服务器就能测 |
| 环境变量全覆盖 | `.env.example` 与 `config.ts` 逐项对齐 |
| 跨平台风险 | `scripts/check-portability.ts`，已并入 `npm test` |

**加新端点时**：`src/openapi.ts` 的 `paths` 里必须加对应条目，否则 `npm test` 会失败——这是刻意的，规范不会静默漂移。

**加新环境变量时**：改 `src/config.ts`，然后同步 `.env.example`。

---

## 6. 环境变量

**不要凭记忆**，看 [`.env.example`](.env.example)，66 个变量分组齐全、带默认值与注释。最常用的：

```bash
NAMI_API_KEYS=key1,key2            # 客户端凭证；不设会随机生成并打印在日志里
NAMI_ADMIN_TOKEN=...               # 管理接口凭证
NAMI_LLM_PROVIDER=ollama           # mock（离线默认）| ollama | openai
NAMI_LLM_MODEL=                    # 留空 = 启动时自动发现
NAMI_ONEBOT_ENABLED=false          # QQ 桥，默认关
NAMI_DB_PATH=/app/data/nami.sqlite
```

三个容易配错的：
- `NAMI_OLLAMA_URL` **不带** `/v1`（那是原生 API）；`NAMI_LLM_BASE_URL` **带** `/v1`。
- `NAMI_ONEBOT_EVENT_TOKEN`（别人调 Nami）与 `NAMI_ONEBOT_ACCESS_TOKEN`（Nami 调别人）是两个方向，别配反。
- 入站端点没配 `NAMI_ONEBOT_EVENT_TOKEN` 时一律 `503`——刻意的，否则任何人都能靠发消息烧你的模型额度。

---

## 7. 已知缺口（不是 bug，是没做或没验证）

1. **Docker 从未构建**（本文档反复强调）。
2. **AstrBot 插件从未被真实 AstrBot 加载**。验证靠桩 API + 官方文档 + 对着真实 Nami 打的接口契约。
   - 其中一处是**推断**：`filter.event_message_type(..., priority=N)` 的 `priority` 参数在能取到的文档里没写，插件做了 `TypeError` 兜底，但「值越大越晚执行」这个方向未经证实。在真实 AstrBot 上加载后请确认自动回复的优先级符合预期。
   - `metadata.yaml` 的 `repo` 字段被注释掉了（原值是占位地址）。填上真实仓库再取消注释。
   - `support_platforms` 里的平台名未与 AstrBot 的 `ADAPTER_NAME_2_TYPE` 注册表核对。
3. **Ollama 未跑过真实对话生成**：本机 `{"models":[]}`，没装任何模型，也没擅自拉几个 GB。`/api/chat` 的 NDJSON 解析是对着镜像官方格式的桩验证的（并故意把一行 JSON 拆到两次 TCP 写入以测分片缓冲）。
4. **OneBot 未接过真实 QQ**：SnowLuma 需要 NTQQ 客户端，本机未部署。
5. **管理面板未目视检查**：只做了 JS 语法校验、资源引用大小写检查、9 个端点与真实路由逐一核对。
6. **`ruff` 未安装**，插件 Python 代码是手工按 ruff 风格写的（已程序化确认无超长行）。

---

## 8. 需要你确认的事项

在 Linux 上做完第 1 节后，请回填：

- [ ] `node -v` 版本：______
- [ ] `npm test` 结果：______ 项断言，失败数：______
- [ ] `python3 selftest_plugin_nami.py` 结果：______
- [ ] `npm run check:portability` 结果：______
- [ ] `docker build` 是否成功：______（失败则贴报错）
- [ ] 容器内 `curl localhost:8787/healthz` 是否正常：______
- [ ] `docker stop` 是否干净退出（日志有无 `shutdown complete`）：______
- [ ] 若装了 Ollama：`npm run ollama -- --write` 是否成功，真实对话是否正常：______

任何一项失败，请连同完整报错一起反馈——**第 2 节的表格就是用来定位「这是 Linux 特有的问题，还是原本就没验证过」的。**

---

## 9. 迁移这份代码到 Linux 机器

`node_modules/`（只有类型检查用）、`.npm-cache/`、`data/` 都不需要带。

```bash
# 在开发机上打包（Windows 自带 bsdtar）
tar --exclude=node_modules --exclude=.npm-cache --exclude=data \
    --exclude=dist --exclude=.git -czf neko-nami-server.tar.gz .

# 在 Linux 机器上
tar -xzf neko-nami-server.tar.gz -C nami/
cd nami/

# 确认换行符确实是 LF（应该是 0）
grep -rlU $'\r' --include='*.ts' --include='*.py' --include='Dockerfile' . | head

npm test
```

或者用 git —— **仓库已经在本地初始化并提交好了**（见第 10 节），不需要再 `git init`：

```bash
# 在 Linux 机器上
git clone <你的远端地址> nami && cd nami
# 若还没推送，也可以直接从开发机拷贝这个已提交的仓库目录（含 .git/）
```

> `.gitattributes` 里的 `* text=auto eol=lf` 是为了防止这件事：Windows 上 `core.autocrlf=true` 会把 CRLF 检出回来，而 CRLF 会破坏 Dockerfile、shebang 和 `.env` 解析。Nami 的 `envStr()` 已经会 `trim()` 掉值里的 `\r`（因为 Docker Compose 的 `env_file` 用自己的解析器，不像 Node 的 `loadEnvFile` 那样剥 `\r`），但换行符统一仍然应该做对。

---

## 10. 推送到 GitHub —— 本地已就绪，但本环境推不出去

### 现状

仓库**已在本地初始化并提交完毕**，只差一次 `git push`：

```bash
# 已经做好的部分
git init -b main                          # ✅
git add -A && git commit                  # ✅ 72038d6，78 个文件，21287 行
git remote add origin \
  https://github.com/NekoHome-Studio/Namiserver.git   # ✅
```

| 检查项 | 结果 |
| --- | --- |
| 提交是否干净 | ✅ `git status` 无未跟踪/未提交内容 |
| `node_modules` / `.npm-cache` / `data` / `dist` 是否被误提交 | ✅ 均已被 `.gitignore` 排除 |
| 提交内容是否全为 LF | ✅ 78/78（`.gitattributes` 已锁定） |
| 是否含密钥/token | ✅ 无。已扫描 `sk-` / `ghp_` / `github_pat_` / `AKIA` / 私钥头，唯一命中是 README 里的占位符 `sk-xxxxxxxxxxxxxxxx` |
| 是否含个人路径（`C:\Users\...`） | ✅ 无 |
| 是否含真实 API Key | ✅ 无（运行时才生成，不落盘） |

### 为什么我推不出去

两条独立的阻塞，都已实测确认，不是推测：

1. **HTTPS 出网被沙箱按域名过滤。** 实测 `git push` 报
   `Failed to connect to github.com port 443 after 21081 ms`（curl 访问 `github.com` 与 `example.com` 同样返回 `000`，而 `registry.npmjs.org` 可通）。
   **即便提供了 token 也推不上去。**
2. **本机没有任何可用凭证**：`~/.ssh` 里只有 `known_hosts`、无私钥；没有 `gh` CLI；环境里没有 `GITHUB_TOKEN`/`GH_TOKEN`；没有存储的 GCM 凭证。

> 有意思的是 **SSH 通道是通的**：`ssh -T -p 443 git@ssh.github.com` 拿到了 GitHub 真实的 `Permission denied (publickey)` 响应（说明握手成功，只是没有密钥）。所以如果你在 GitHub 上配了 SSH key，这条路可行。

### 你需要执行的（在你的终端里，不是通过 DSH 沙箱）

```bash
cd <本仓库目录>

# 1) 确认远端仓库已存在；若不存在先在 GitHub 上建一个空仓库
#    https://github.com/organizations/NekoHome-Studio/repositories/new
#    注意：不要勾选 "Add a README"，否则会产生一次无关的合并

# 2) 推送（Git Credential Manager 会弹一次浏览器登录）
git push -u origin main
```

若走 SSH：

```bash
# 前提：已在本机生成 SSH key 并加到 GitHub 账号
git remote set-url origin git@github.com:NekoHome-Studio/Namiserver.git
# 如果 22 端口被封，改用 GitHub 的 443 端点：
#   ~/.ssh/config 里加：
#     Host github.com
#       HostName ssh.github.com
#       Port 443
#       User git
git push -u origin main
```

### 权限提醒

远端归属是 **`NekoHome-Studio` 组织**，而本机 git 身份是 `qyac`。
`qyac` 必须对该组织仓库有 **write 权限**，否则会收到 `403`。若组织启用了 SSO，token 还需额外授权该组织。

### 推送后建议

```bash
# 确认远端内容与本地一致
git ls-remote --heads origin
git log origin/main --oneline -1
```

然后在**真正的 Linux 机器**上 clone 一份，跑第 1 节的验收清单——那才是这次交接的终点。

