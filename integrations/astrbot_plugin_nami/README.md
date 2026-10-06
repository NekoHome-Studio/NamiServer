# astrbot_plugin_nami

把 [AstrBot](https://astrbot.app) 接到自建的 **Nami**（OpenAI 兼容的自托管 AI Agent 服务）上的插件。

Nami 对外暴露 `/v1/models`、`/v1/chat/completions`、`/healthz`、`/readyz` 与 `/admin/api/*`。
本插件把这些能力包装成 AstrBot 的指令、可选的事件监听，以及一个 WebUI 控制台页面。

> 本插件**没有任何第三方 Python 依赖**。网络请求使用 AstrBot 本体自带的 `aiohttp`，
> `requirements.txt` 里只有注释。唯一的可选运行时依赖是 Pillow，且只在**生成 logo** 时用到，
> 插件运行期间不需要。

---

## 1. 功能一览

| 功能 | 说明 |
| --- | --- |
| `/nami 状态` | 调用 `/healthz` 与 `/readyz`，打印状态、版本、运行时长、Provider、模型与全部就绪检查项 |
| `/nami 模型` | 列出 `/v1/models`，标注别名条目（`nami.aliasOf`）并显示参数、量化、体积 |
| `/nami 问 <文本>` | 走 `/v1/chat/completions` 提问，通过 `X-Nami-Session` 保持同一段对话的上下文 |
| `/nami 工具` | 列出 `/admin/api/tools` 中每个工具的危险等级与启用状态 |
| `/nami 重置` | 忘掉当前作用域的 Nami 会话，下一轮开启新会话 |
| `/nami 诊断` | 五步体检：配置 → `/healthz` → `/readyz` → `/v1/models` → 一次最小对话探测 |
| 自动回复（可选） | 命中触发条件时把消息转发给 Nami 并回复。**默认关闭**，见第 7 节 |
| Dashboard 页面 | `pages/nami`：状态卡片、模型目录、工具列表、会话管理、直接提问框，5 秒自动刷新 |

所有指令回复都是**纯文本**（QQ / Telegram 不渲染 Markdown），不会出现 `**加粗**` 或代码块。

---

## 2. 安装

1. 确认 AstrBot 版本满足 `astrbot_version: ">=4.10.4,<5"`。
2. 把本仓库 `integrations/astrbot_plugin_nami/` **整个目录**复制到 AstrBot 的插件目录：

   ```
   AstrBot/data/plugins/astrbot_plugin_nami/
   ```

   复制完成后目录结构应为：

   ```
   AstrBot/data/plugins/astrbot_plugin_nami/
   ├─ main.py
   ├─ metadata.yaml
   ├─ _conf_schema.json
   ├─ requirements.txt
   ├─ README.md
   ├─ logo.png
   ├─ .astrbot-plugin/i18n/{zh-CN,en-US}.json
   └─ pages/nami/{index.html,app.js,style.css}
   ```

3. 在 AstrBot WebUI 的「插件管理」里重载插件（或重启 AstrBot）。
4. 打开插件详情页 → 配置，按第 3 节填写 Nami 地址与密钥。
5. 在聊天里发送 `/nami 诊断` 确认链路可用。

> 插件**不会**把任何数据写进插件目录。插件本身是无状态的：会话映射只存在内存里，
> 真正的对话历史由 Nami 侧持久化。

---

## 3. 配置说明（`_conf_schema.json`）

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `nami_base_url` | string | `http://127.0.0.1:8787/v1` | OpenAI 兼容接口地址。**`/v1` 后缀很重要**，`/nami 问` 与自动回复都走它 |
| `nami_host_root` | string | `http://127.0.0.1:8787` | 服务根地址，用于 `/healthz`、`/readyz`、`/admin/api/*`。**结尾不要带 `/v1`**（带了也会被自动去掉） |
| `nami_api_key` | string（secret） | 空 | 对应 Nami 的 `NAMI_API_KEYS` 之一。留空时 Nami 会返回 401 `missing_api_key` |
| `nami_admin_token` | string（secret） | 空 | 对应 `NAMI_ADMIN_TOKEN`，`/admin/api/*` 需要。Nami 未配置管理令牌时留空 |
| `default_model` | string | 空 | 留空 = 由 Nami 自己选择默认模型；填写时必须出现在 `/v1/models` 里 |
| `request_timeout` | int | `60` | 单次请求超时（秒） |
| `system_prompt` | text | 空 | 可选的附加 system 提示词，会加在本轮提问之前 |
| `session_scope` | string | `group` | `user` → `astrbot:user:<sender_id>`；`group` → `astrbot:group:<group_id>`（私聊回退到 user）；`global` → `astrbot:global` |
| `enable_commands` | bool | `true` | 关闭后 `/nami` 指令组只提示已禁用 |
| `admin_only` | bool | `false` | 开启后仅 AstrBot 管理员可用 `/nami` |
| `auto_reply_enabled` | bool | `false` | 自动回复开关，**会消耗 token**，见第 7 节 |
| `auto_reply_trigger` | string | `mention` | `mention` / `prefix` / `all` |
| `auto_reply_prefix` | string | `/ai` | `auto_reply_trigger=prefix` 时生效 |
| `mention_keyword` | string | 空 | `mention` 模式下额外的关键词触发（部分平台 @ 不可靠时使用） |
| `max_reply_chars` | int | `1500` | 回复超过该长度会被截断 |

两个密钥字段都标了 `"secret": true`，WebUI 会用密码框显示。注意：**这只是界面遮罩，不会加密配置文件**，
插件也绝不会把密钥写进日志或返回给浏览器。

---

## 4. 把 AstrBot 自己的 LLM 指向 Nami（可选，但很推荐）

除了本插件的 `/nami 问`，你也可以直接让 AstrBot 的主对话走 Nami，这样人格、记忆、工具调用等
AstrBot 原生能力都能复用 Nami 背后的模型。

在 AstrBot WebUI →「模型提供商」→ 新增：

| 字段 | 填什么 |
| --- | --- |
| 类型 | **OpenAI 兼容 / OpenAI Compatible** |
| API Base / 接口地址 | `http://<nami 所在机器的地址>:8787/v1`（**必须带 `/v1`**） |
| API Key | Nami 的 `NAMI_API_KEYS` 之一（同一个 key 也能给插件用） |
| 模型名 | `/v1/models` 里列出的任意 id，例如 `qwen2.5:7b`，也可以填别名 |

注意事项：

* Nami 默认只接受白名单内的模型。若返回 403 `model_not_allowed`，请把模型名加进 Nami 的
  `NAMI_MODELS_EXPOSE`，或打开 `NAMI_ALLOW_CLIENT_MODEL`。
* Nami 的对话接口是标准 OpenAI 形状，支持流式；AstrBot 侧开启流式即可。
* 同一台 Nami 既服务 AstrBot 主对话、又服务本插件完全没问题，两边是独立的会话。

---

## 5. 指令列表

| 指令 | 别名 | 说明 |
| --- | --- | --- |
| `/nami status` | `/nami 状态` | 健康 + 就绪 + Provider/模型 |
| `/nami models` | `/nami 模型` | 模型目录，最多显示 25 条，其余只报数量 |
| `/nami ask <文本>` | `/nami 问 <文本>` | 提问；`<文本>` 可以包含空格 |
| `/nami tools` | `/nami 工具` | 工具列表与危险等级 |
| `/nami reset` | `/nami 重置` | 重置当前作用域的 Nami 会话 |
| `/nami diag` | `/nami 诊断` | 五步连通性体检 |

指令组只支持斜杠前缀（AstrBot 的默认唤醒前缀），中文别名与英文名等价。

---

## 6. Dashboard 页面

安装后，插件详情页里会出现名为 **Nami 控制台** 的页面，包含：

* 顶部凭据横幅：显示当前 `nami_base_url`、服务根地址、密钥是否已配置、会话作用域、自动回复状态；
  `/healthz` 不可达时整条横幅变红并显示具体错误。
* 8 张状态卡片：健康、就绪、Provider/模型、运行时长、工具启用数、Nami 会话数、累计请求、插件会话映射数。
* 模型目录表格：id、别名指向、参数、量化、体积、归属。
* 工具列表：启用状态圆点 + 危险等级徽章（安全 / 需注意 / 危险）。
* 会话列表：会话 id、标题、消息数、更新时间，每行一个删除按钮（二次确认由后端兜底）。
* 「直接提问」输入框：走 `POST /{plugin}/ask`，直接显示回答与 token 用量。
* 5 秒自动刷新；`document.hidden` 时暂停，切回前台立即刷新一次。

**安全**：页面只访问本插件注册的后端路由，由后端带上密钥代理 Nami。
API Key 与管理令牌永远不会下发到浏览器，只会以 `api_key_configured` 这类布尔值形式出现。
页面渲染全部使用 `textContent`，不会把服务端数据当 HTML 注入。

---

## 7. ⚠️ 自动回复功能的 token 成本警告

`auto_reply_enabled` **默认关闭**，这是刻意的。开启后：

* 每一条命中 `auto_reply_trigger` 的消息都会**立即发起一次 Nami 请求**。
* 如果 Nami 后端接的是按量计费的云端模型（OpenAI、Claude、各类中转），
  群里每次闲聊都在**直接烧钱**；用本地模型则是在持续占用 GPU/CPU，推理队列会被打满。
* `trigger = all` 最危险：群里所有非空消息都会被转发，包括别人的对话、表情包配文、机器人之间的互刷。
* 即使开启，也强烈建议配合：白名单群、`mention` 模式、`max_reply_chars` 限制长度、
  以及在 Nami 侧设置限流（`NAMI_RATE_LIMIT_BURST` / `NAMI_RATE_LIMIT_PER_SECOND`）。

插件内置的保护：跳过机器人自己发的消息、跳过空消息、跳过 `/nami` 指令本身、
回复按 `max_reply_chars` 截断、回复后调用 `event.stop_event()` 避免 AstrBot 再答一遍。

**默认值就是安全值。除非你明确知道自己在为什么付费，否则请保持关闭。**

---

## 8. 故障排查

`/nami 诊断` 会按下面的对照表给出具体建议。常见现象：

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 连接被拒绝 / `ClientConnectorError` | Nami 没在跑 | 在 Nami 那台机器上 `npm start`；确认 `nami_host_root` 的端口 |
| HTTP 401 `missing_api_key` | 没填 `nami_api_key` | 在插件配置里填 Nami 的 API Key |
| HTTP 401 `invalid_api_key` | key 不匹配 | key 必须与 Nami 的 `NAMI_API_KEYS` 完全一致 |
| HTTP 403 `admin_required` | 管理接口鉴权失败 | `/nami 工具`、会话列表需要 `nami_admin_token`（= Nami 的 `NAMI_ADMIN_TOKEN`） |
| HTTP 404 `model_not_found` | 模型名不存在 | 用 `/nami 模型` 查看可用 id，或清空 `default_model` 让 Nami 自己选 |
| HTTP 403 `model_not_allowed` | 模型不在白名单 | 把模型加进 Nami 的 `NAMI_MODELS_EXPOSE` |
| HTTP 429 `rate_limited` | 触发限流 | 稍后重试，或调大 `NAMI_RATE_LIMIT_BURST` |
| `/readyz` 返回 `ready=false`，`checks.model = none selected` | Nami 侧没有可用模型 | 在 Nami 那台机器上执行 `npm run ollama -- --write` |
| `/readyz` 返回 `checks.apiKeys = missing` | Nami 没配置 API Key | 设置 `NAMI_API_KEYS` 后重启 Nami |
| 页面红色横幅 "Nami 不可达" | 同上第一条 | 先修好连通性，页面会自动恢复 |

诊断输出示例（全部通过时）：

```
Nami 诊断
[1/5] 配置检查: ✓
[2/5] /healthz 连通性: ✓ 版本 1.0.0
[3/5] /readyz 就绪: ✓
[4/5] /v1/models: ✓ 共 3 个模型
[5/5] 对话探测: ✓ 模型 qwen2.5:7b 返回 'pong'
结论: 全部通过，Nami 可用。
```

---

## 9. 自测

仓库里 `integrations/selftest_plugin_nami.py` 是一份**只用标准库**的离线自测脚本：
它在 `sys.modules` 里注入 `astrbot.*` 桩模块，替换插件的网络出口，然后直接驱动
所有指令处理器与页面接口，断言 40+ 项行为（注册项、请求方法/URL/请求头/请求体、
错误文案映射、截断、纯文本约束、页面资源相对路径等）。

```powershell
cd integrations
python selftest_plugin_nami.py
```

通过时输出 `✓ 全部通过 N 项断言`，失败时逐条列出并以非零码退出。运行它不需要 AstrBot，
也不需要安装任何第三方包。
