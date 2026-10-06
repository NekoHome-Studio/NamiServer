# Nami Linux 验收实测记录

> 执行者：DSH agent（deepseek-flash）
> 时间：2026-10-06
> 仓库：`NekoHome-Studio/NamiServer` @ `e7a3409`（工作区 `/home/nekoseek-dsh/nami`）
> 范围：`HANDOVER.md` §1 清单 ①—④ 全跑；⑤ Docker 无法执行（见 §5），改为静态审计

## 0. 环境

| 项目 | 实测值 | 要求 | 结论 |
| --- | --- | --- | --- |
| OS | Linux | — | — |
| Node.js | **v22.23.2** | >= 22.6.0（推荐 24.x） | ✅ 满足下限 |
| Python | 3.10.12 | 3.x 标准库 | ✅ |
| npm | 10.9.8 | — | ✅ |
| Docker | CLI 存在，daemon **不可达** | — | ❌ 见 §5 |

`npm install` 只装了 3 个包（typescript + @types/node），10s。

## 1. 逐项结果（①—④ 全部通过）

| # | 命令 | 文档写的期望 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| ① | `node -v` | >= 22.6 | v22.23.2 | ✅ |
| ②a | `npx tsc --noEmit` | 0 错误 | 0 错误，无输出 | ✅ |
| ②b | `npm run check:portability` | 324 项 | **574 项 0 问题**（70 源文件 / 98 文本文件 / 93 图标全覆盖） | ✅ 数字已更正 |
| ②c | `npm run smoke` | 407 项 | **482 项全过，~1.9s** | ✅ 数字已更正 |
| ② | `npm test` | ✗ 0 项失败 | 退出码 **0** | ✅ |
| ③ | `python3 integrations/selftest_plugin_nami.py` | 448 项 | `✓ 全部通过 448 项断言` | ✅ 与文档一致 |
| ④ | 真实启动 + curl | 有 JSON + 日志有 run finished | 见 §2 | ✅ |

### 2. ④ 真实启动细节

启动横幅正确：`provider mock`、`tools 8 enabled / 16 registered`、`database …/data/nami.sqlite`、`rate limit 60 burst, 1/s`。

| 请求 | 结果 |
| --- | --- |
| `GET /healthz` | 200 `{"status":"ok","version":"1.0.0","node":"v22.23.2","pid":…}` |
| `GET /v1/models`（带 key） | 200，列出 `nami-mock-1`、`nami-mock-echo` |
| `GET /v1/models`（无 key） | **401**，鉴权生效 |
| `POST /v1/agent/run`（`echo 你好`） | 200，`rounds:2 toolCalls:1`，`echo` 返回 `{"echo":"你好","length":2}`，149ms |
| `POST /v1/agent/run`（`计算 12*(3+4)`） | 200，`calc` 返回 `result:84` |
| `POST /v1/chat/completions` | 200，OpenAI 形状正确 |
| `POST /v1/agent/run`（`现在几点`, stream=true） | SSE 序列完整：`run.start` → `delta`×4 → `tool.call` → `tool.result`（`now` 真执行，ok:true） |
| `GET /openapi.json` | 200，OpenAPI 3.1.0 |
| `GET /admin` + 4 个产物资源 | 全部 200（177561 / 106658 / 61936 / 310517 字节） |
| `GET /admin/classic` | 200，71025 字节 |
| 日志 | `run finished {"rounds":2,"toolCalls":1,"ms":149}` ✅ |

### 端口冲突（非缺陷）

宿主 8787 已被一个**无关服务**占用（`/healthz` 报 `v1.1.7`，页面是「返回申请页」）。用默认端口启动 Nami 时它**正确检测冲突、以退出码 1 退出**并提示 `set NAMI_PORT to a free port`——没有静默失败，行为正确。实测因此改用 18787。

## 3. 实测发现的两个缺陷 —— 均已修复并复验

### 缺陷 A：优雅退出在 DB 关闭后仍查询数据库（每个 SIGTERM 必现）✅ 已修

**修复前**（`kill -TERM`，进程 500ms 退出、码 0，但）：

```
INFO  [nami] shutting down {"signal":"SIGTERM","graceMs":8000}
ERROR [nami] unhandled promise rejection {"error":"database is not open"
  at one (src/store/store.ts:435:27) ← SessionStore.counts ← src/index.ts:245}
```

**根因**：`shutdown()`（`src/index.ts:192`）最后一步 `store.close()`，而信号处理里是
`void shutdown().then(() => { …; log.info('shutdown complete', { sessions: store.counts().sessions }); process.exit(0); })`。

**影响不止噪音**：回调抛出后 `process.exit(0)` **执行不到**，`shutdown complete` 也永远不打印。那次能干净退出只是事件循环恰好排空——属于运气。

**修法**（`src/index.ts`）：在 `shutdown()` **之前**取好计数（并对「库已被更早的 uncaughtException 关掉」做兜底），同时补 `.catch()` 防止退出码再被异常吞掉。

**修复后实测**（两次，含不带 key 的启动）：

```
INFO [nami] shutting down {"signal":"SIGTERM","graceMs":8000}
INFO [nami] shutdown complete {"sessions":4}
```

约 500ms 退出，退出码 0，**无** unhandled rejection。`npm test` 复跑仍 **482 项全过，退出码 0**。

### 缺陷 B：管理面板 favicon 404（每次打开页面必现）✅ 已修

- `webui/index.html:8` 声明 `<link rel="icon" href="./favicon.svg" …>`，但仓库**没有** `webui/public/`，产物里也没有该文件
- Vite 对缺失的 public 资源**不报错**，于是 404 被固化进已提交的产物
- `src/server.ts:121` 对「带扩展名的缺失文件」是**有意**返回 404 的（避免缺失的 .js 也回退成 HTML），所以这不是路由 bug

**修法**：新增 `webui/public/favicon.svg`（按 `integrations/astrbot_plugin_nami/logo.png` 的视觉重绘为矢量：深蓝圆角底 + 白色 N + 两道浅蓝波浪），并重新构建产物。

**重新构建的意义（意外收获：产物可复现）**：`vite build` 4.1s 成功，**54 个既有资源文件名与字节全部不变**（`git diff src/web/app` 对 `index.html` 为空，`git status` 只有新增的 `favicon.svg`）。这证明已提交的产物是可复现的，不是某台机器上的偶然输出。

**修复后实测**：`GET /admin/favicon.svg` → **200**，`type=image/svg+xml`，1084 字节。

### 附带发现：`webui/.npmrc` 的 cache 路径与注释相反

`cache=../.npm-cache` 注释说「把缓存留在仓库内」，但 npm 相对 **cwd**（不是 `--prefix`）解析它，
于是在仓库根执行 `npm run webui:install` 时缓存落到**仓库外面**的上一级目录。想真正做到应写 `cache=.npm-cache`。
在受限沙箱里这直接导致安装失败（本次用显式 `--cache` 绕过）。**未改动代码，仅记录**（`HANDOVER.md` §7 第 7 条）。

## 4. ④ 之外的补充部署安全检查

**忘记设 `NAMI_API_KEYS` 时不会变成匿名服务**（`src/config.ts:312`）：启动时随机生成一把并显著提示：

```
⚠  NAMI_API_KEYS was not set, so a key was generated for this run:
   nami_<32 位随机串，此处打码>
   It changes on every restart. Set NAMI_API_KEYS to keep it stable.
```

实测此时 `/v1/models` → **401**、`/admin/api/overview` → **401**，只有 SPA 外壳 `/admin` 返回 200（那是登录页，符合预期）。fail-safe 行为正确。

## 5. ⑤ Docker：本环境**结构性不可执行**，改为静态审计

> **后续决定（2026-10-06，负责人）**：**本项目不使用 Docker 部署。**
> 因此 Docker 不再列为待办缺口；`Dockerfile` / `docker-compose.yml` 留在仓库，将来要用请视为全新的、未验证的东西。
> 本节记录的是「为什么本环境做不了」以及「静态审计到哪一步」，供那时参考。

不是"没试"，是权限模型上做不到：

```
id                → uid=997, groups=997（只有自己）
getent group docker → docker:x:1002:      ← 组内没有任何成员
ls -l /var/run/docker.sock → srw-rw---- root:docker
sudo -n true      → "The 'no new privileges' flag is set"（内核挡住提权）
podman/buildah/nerdctl/kaniko → 全部不存在
```

`sandbox_permissions: danger-full-access` 也**帮不上忙**：DSH 沙箱只能收紧权限，不能把我加进 `docker` 组或清掉 `no_new_privileges`，因此没有提权申请的正当理由。**Docker 构建必须由具备 docker 权限的人执行。**

### 替代：按 Dockerfile 逐条核对它对我已实测运行时的假设

| Dockerfile 行 | 假设 | 核对结果 |
| --- | --- | --- |
| L31 `NAMI_HOST=0.0.0.0` | 必须覆盖默认的 `127.0.0.1`，否则 published port 不可达 | ✅ 必需且正确（`config.ts:363` 默认确是 `127.0.0.1`，实测封面也印证） |
| L32 `NAMI_PORT=8787` | 与 `EXPOSE`/HEALTHCHECK 一致 | ✅ 一致 |
| L33 `NAMI_DB_PATH=/app/data/nami.sqlite` | 该环境变量真实存在 | ✅ `config.ts:379` 确认存在（写错会静默落到默认路径） |
| L41 `COPY package.json` | **必需**——`"type": "module"` 决定了 `.ts` 按 ESM 解析 | ✅ 已复制（漏掉会导致 import 直接失败） |
| L42 `COPY src/` | 顺带带上 `src/web/app` 编译产物 | ✅ 实测该目录就是 favicon 与 4 个资源的来源 |
| L47-48 `addgroup -S -g` / `adduser -S -u -G -h -s` | Alpine(BusyBox) 语法 | ✅ 参数在 BusyBox 中存在（`-h /app` 已存在时 BusyBox 只告警不失败）——**仍需真实构建确认** |
| L50 `chown -R nami:nami /app` | 非 root 用户可写 `/app/data` | ✅ 归属正确；模式 `600` 的文件经 chown 后属主可读 |
| L59-60 HEALTHCHECK | alpine 无 curl/wget，用 Node 内置 `fetch` 打 `/healthz` | ✅ 已实测 `/healthz` 返回 200 **且不需要鉴权、不受限流影响** |
| L63 `CMD node src/index.ts` | 类型剥离直接执行 | ✅ 实测即为该命令，v22/v24 均可 |
| `.dockerignore` | 排除 `webui`、`node_modules`、`data`、`.env*` | ✅ 正确；`src/web/app` **未**被排除（关键） |

**静态审计未发现阻断性问题**；唯一无法离线判定的是 BusyBox `adduser` 与健康检查在真实 alpine 上的行为。

> 小提示：`.dockerignore` 里的 `*.md` 只匹配上下文根目录下的 md，所以 `docs/`（本报告所在目录）仍会进入构建上下文。
> 它不会进镜像（Dockerfile 只 `COPY package.json src/ scripts/`），只是让上下文略大；要洁癖可以在 `.dockerignore` 里加一行 `docs`。
> （本项目已不使用 Docker，这条只留给将来真要用它的人。）

## 6. 文档更正（已写入）

`HANDOVER.md` 与 `README.md` 里的断言数字与实际不符，且互不相同，已统一为实测值：

| 位置 | 原文 | 改为 |
| --- | --- | --- |
| HANDOVER 第 1 节注释、§2 表格、§6 目录树 | smoke 407 项 | **482 项** |
| HANDOVER §2 表格、§2 静态排除、§6 目录树 | 可移植性 324 项 | **574 项** |
| README「冒烟测试共 N 项断言」 | 394 项 | **482 项** |
| README「共有 N 项可复现的断言」 | 842 项（=394+448） | **930 项**（=482+448） |

同时更新：§0 现状（不再是「从未在 Linux 上运行过」）、§2 矩阵（②③ 行的 Linux 列由 ❌/⚠️ 改为 ✅，SIGTERM 行改为已测）、§3 ④（SIGTERM 由「未测」重写为「已测 + 竞态已修」）、§7（新增 Ollama 0.33.3 事实、favicon 修复、`.npmrc` 条目）、§8（回填全部清单项）。

## 7. 仍未验证

- ~~⑤ `docker build` 与容器内实跑~~ → **不适用**：本项目已决定不使用 Docker（2026-10-06）。镜像从未构建、容器内从未运行；若将来启用，那是一条**全新未验证**的路径（§5 的静态审计只是把能离线核对的对完了）
- **Ollama 真实对话生成**：宿主 Ollama 是 **0.33.3**（比文档验证的 0.34.4 旧），且只有 `qwen3-embedding:4b`（embedding，不能对话）
- **OneBot 真实 QQ**（需 SnowLuma + NTQQ）
- **AstrBot 真实加载插件**
- **管理面板的浏览器内交互**：只验证了产物引用完整（4/4 资源 200）；**依旧没有人真正打开过页面**

## 8. 本次改动的文件

| 文件 | 改动 |
| --- | --- |
| `src/index.ts` | 缺陷 A：关闭前取计数 + `.catch()` 兜底 |
| `webui/public/favicon.svg` | 新增（缺陷 B 的源） |
| `src/web/app/favicon.svg` | 新增（重新构建产出，缺陷 B 的产物） |
| `HANDOVER.md` | 数字更正、矩阵更新、§3 ④ 重写、§7 补充、§8 回填 |
| `README.md` | 数字更正、首屏现状更新 |
| `docs/linux-acceptance-2026-10-06.md` | 本报告 |

## 9. 一句话结论

`①②③④` 在真实 Linux 上**全部通过**，代码本身在 Linux 上是好的；补测暴露的两个边界缺陷（关闭钩子、静态资源）**都已修复并复验**，且重新构建证明**提交的 WebUI 产物是可复现的**。
**Docker 已决定不使用**，故不再是缺口；本机部署路径（`NAMI_API_KEYS=<key> npm start`）已验证可用。

---

## 附：同日的后续变更（本节晚于上面各节）

上面记录的是当次验收的**原始结果**，数字保留不改。之后同一天又做了两件事，结论如下。

### 1. 用真实浏览器打开控制台，修掉 3 个缺陷

装上 headless Chromium（本机原本没有浏览器、没有 Java，Chrome 从 npmmirror 取，缺的 3 个 X11 库用 `apt-get download` + `dpkg-deb -x` 非 root 补上）后打开 `/admin`：

| 缺陷 | 现象 | 根因 |
| --- | --- | --- |
| **白屏（致命）** | `#app` 子节点 0、页面全白、控制台 3 个脚本 + 1 个样式表全被 CSP 拦截 | `src/server.ts` 给自包含页面与 SPA 共用同一套 CSP：`script-src 'unsafe-inline'` 没有 `'self'`，而 SPA 的 JS/CSS 是 `/admin/assets/` 下的外部文件。请求全是 200，curl 与状态码断言都看不见 |
| **所有 MDI 图标空白** | `<path d="mdiViewDashboardOutline">` | Vuetify 只在名字以 `$` 开头时才查 `aliases`（`lib/composables/icons.js`），裸名字直送 SVG 渲染器；生成的路径表放在 `aliases` 里，因此 399 处引用**从未生效** |
| **favicon 404** | 浏览器请求 `/favicon.svg` | 产物里是相对路径 `./favicon.svg`，而页面地址是 `/admin`（无结尾斜杠），相对路径解析到站点根 |

修法：CSP 拆成 `inlineHtmlHeaders()` / `spaHtmlHeaders()` 两套；图标改为自定义 icon set（`defaultSet: 'nami'`）在渲染前翻译名字，并给未登记的名字加 `console.warn`；favicon 改绝对路径交由 Vite 补 base。

修复后：登录页正常渲染、10 个页面逐个巡检零报错、对话页真实发消息并渲染出工具调用卡片。冒烟测试补了 9 项 CSP 断言（不再只查「头存在」，而是查 `script-src` 含 `'self'`、classic 与 SPA 两套必须不同，并实际取回入口脚本确认 MIME）。

### 2. 新增控制台账号密码登录

账号存 SQLite（`users` / `auth_sessions` / `login_attempts`），密码 scrypt 哈希，登录态走 `HttpOnly` + `SameSite=Strict` Cookie；API Key 保留给 `/v1/*` 与程序化调用。新增 `npm run passwd` 用于查看/新建/重置/停用账号。

实现中自己踩到并修掉的坑，一并记录：

- `/me` 一开始被设为「完全免鉴权」，于是服务器**根本不解析会话**，带 Cookie 也永远报未登录 → 增加 `optional` 鉴权档位（解析但不强制）。
- `/v1/*` 最初只认 API Key，导致账号登录的用户**发不出消息**（`POST /v1/agent/run` 就在 `/v1` 下）→ 让 `/v1/*` 也接受会话 Cookie（SameSite=Strict，无 CSRF 面）。
- 登录后侧栏一直显示「服务不可达」：shell 的健康轮询只在挂载时跑一次，而那时还在登录页 → 监听登录态变化后立即刷新。

### 3. 数字变化

新增测试后：smoke **541** 项断言（原 482）、可移植性 **628** 项检查（原 574）、加上插件自检 448 项共 **989** 项。`npm test` 退出码 0。

### 4. 配置热重载与原地重启（同日稍后）

新增 `src/lifecycle.ts`：保留进程、重建全部服务层再切换实例。

- **重启按钮**（顶栏）与 `POST /admin/api/restart`；`GET /admin/api/restart` 报告状态与上次结果（结果存在进程级——重载会替换实例，放在实例上会被它自己抹掉）。
- **`.env` 热重载**：监听文件所在**目录**（编辑器与 `writeFileSync` 会替换 inode，监听文件本身会失效）+ 内容哈希去抖。
- **安全顺序**：先用新配置把新实例**完整建起来**（旧实例仍在服务），建成功才切换。因此写错配置不会把控制台弄挂——重载被拒绝、旧配置继续服务、原因写进日志。
- 地址不变时先关旧监听再绑新监听（端口无法共存），间隔为毫秒级；地址变化时先绑新的再关旧的。
- `uptime` / `startedAt` 跨重载保持：实例重建不等于进程重启，否则运营者会误以为进程刚重启过。

自己踩到并修掉的两处：

- `loadConfig` 的「原始环境」快照原本只在**不带 `env` 的调用**里拍，导致带 `env` 的调用会把注入值当成既有环境，重载时不肯覆盖 → 快照改为在任何加载动作之前拍。
- 测试里用 `/proc/...` 当「写不进去的路径」会触发**文件沙箱**并阻塞等审批（沙箱拒绝不是普通异常）→ 改用工作区内「父路径是普通文件」的合法失败。

浏览器验证：点重启按钮 → 自动刷新 → 仍在登录态（会话 Cookie 存活）→ `uptime` 8→12 秒继续增长 → 控制台零报错。`.env` 外部改动实测自动生效（`maxRounds` 6→9，服务不中断）。

数字：smoke **563** 项断言、可移植性 **637** 项、加插件自检共 **1011** 项。
