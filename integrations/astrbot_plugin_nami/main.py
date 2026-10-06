"""AstrBot ↔ Nami 直连插件（astrbot_plugin_nami）。

Nami 是一个自托管的、OpenAI 兼容的 AI Agent 服务。本插件把 AstrBot 和它接起来，
提供三块能力：

1. ``/nami`` 指令组：状态、模型目录、提问、工具列表、会话重置、连通性诊断。
2. 可选的自动回复监听：命中触发条件时把消息转发给 Nami（默认关闭，会消耗 token）。
3. Dashboard Page（``pages/nami``）：把 Nami 的运行状态、模型、工具、会话呈现在
   AstrBot WebUI 里。页面只和本插件的后端路由通信，API Key 永远不会进入浏览器。

设计要点：

* 所有网络 I/O 都走模块级函数 :func:`_http_json`，全异步（aiohttp），
  并且集中在一处，方便离线自测时打桩。
* ``aiohttp`` 在函数体内延迟导入，因此本模块只用标准库就能被 import。
* 任何密钥都只用于拼装请求头，绝不写日志、绝不出现在任何返回给页面的数据里。
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any
from urllib.parse import quote

from astrbot.api import AstrBotConfig
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.api.web import error_response, json_response, request

#: 插件名，必须与目录名、metadata.yaml 的 name 保持一致。
PLUGIN_NAME = "astrbot_plugin_nami"

#: 指令组里「提问」与「重置」等子指令的中文别名。
ASK_ALIASES = frozenset({"ask", "问", "提问"})
STATUS_ALIASES = frozenset({"status", "状态"})
MODELS_ALIASES = frozenset({"models", "模型"})
TOOLS_ALIASES = frozenset({"tools", "工具"})
RESET_ALIASES = frozenset({"reset", "重置"})
DIAG_ALIASES = frozenset({"diag", "诊断"})

#: 模型列表最多渲染多少条，超出部分只报数量。
MODEL_LIST_LIMIT = 25

#: 自动回复监听器的优先级：数值越大越靠后，保证内置指令先跑完。
AUTO_REPLY_PRIORITY = 100


# --------------------------------------------------------------------------- #
# 错误模型与文案
# --------------------------------------------------------------------------- #


class NamiError(Exception):
    """一次 Nami 调用失败。

    ``code`` 与 Nami 返回体里的 ``error.code`` 对齐（例如 ``invalid_api_key``），
    网络层失败则使用本插件自定义的 ``connection_refused`` / ``timeout``。
    """

    def __init__(self, code: str, message: str = "", status: int | None = None) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.status = status


#: 错误码 → 可执行的中文处置建议。指令输出全部是纯文本，不用 Markdown 标记。
ERROR_GUIDANCE: dict[str, str] = {
    "connection_refused": (
        "Nami 没在跑，先执行 npm start；确认 nami_host_root 的端口是否正确。"
    ),
    "timeout": "请求超时：模型可能正在加载，或 request_timeout 设得太小。",
    "missing_api_key": "没填 nami_api_key。",
    "invalid_api_key": "key 不匹配 NAMI_API_KEYS。",
    "admin_required": "管理接口需要 nami_admin_token。",
    "model_not_found": "模型名不存在，用 /nami 模型 查。",
    "model_not_allowed": "模型没在 Nami 的 NAMI_MODELS_EXPOSE 白名单里。",
    "rate_limited": "触发限流，稍后再试或调大 NAMI_RATE_LIMIT_BURST。",
    "session_not_found": "会话已不存在，先执行 /nami 重置。",
    "invalid_request_error": "请求体被 Nami 拒绝，检查模型名与消息格式。",
    "http_500": "Nami 内部错误，查看 Nami 控制台日志。",
    "http_502": "上游模型服务不可用，检查 Nami 侧的 provider 配置。",
    "http_503": "Nami 尚未就绪，先执行 /nami 诊断。",
}

#: HTTP 状态码 → 未给出 error.code 时的兜底错误码。
_STATUS_TO_CODE: dict[int, str] = {
    400: "invalid_request_error",
    401: "missing_api_key",
    403: "admin_required",
    404: "model_not_found",
    429: "rate_limited",
    500: "http_500",
    502: "http_502",
    503: "http_503",
}


def _status_code_of(status: int) -> str:
    """把 HTTP 状态码翻译成错误码。"""
    return _STATUS_TO_CODE.get(status, f"http_{status}")


def guidance_for(code: str, status: int | None = None) -> str:
    """返回错误码对应的处置建议，找不到时给出兜底文案。"""
    if code in ERROR_GUIDANCE:
        return ERROR_GUIDANCE[code]
    if status is not None and _status_code_of(status) in ERROR_GUIDANCE:
        return ERROR_GUIDANCE[_status_code_of(status)]
    return "请查看 Nami 服务端日志确认原因。"


def _error_code_of(payload: Any, status: int) -> str:
    """从 Nami 的错误返回体里取 ``error.code``，取不到就按状态码推断。"""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("code"), str) and error["code"]:
            return error["code"]
        if isinstance(error, str) and error:
            return "invalid_request_error"
    return _status_code_of(status)


def _error_message_of(payload: Any, status: int) -> str:
    """从 Nami 的错误返回体里取人类可读的 message。"""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]
        if isinstance(error, str):
            return error
        if isinstance(payload.get("message"), str):
            return payload["message"]
    return f"Nami 返回 HTTP {status}"


# --------------------------------------------------------------------------- #
# 唯一的网络出口（自测会 monkeypatch 它）
# --------------------------------------------------------------------------- #


async def _http_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    json_body: Any | None = None,
    timeout: float = 60.0,
    allow_status: tuple[int, ...] = (),
) -> tuple[int, Any]:
    """发起一次 HTTP 请求，返回 ``(status_code, parsed_json)``。

    这是插件里唯一的网络出口，所有 Nami 调用都经过它，因此离线自测只需要替换
    这一个函数即可完全避免真实 socket。

    ``aiohttp`` 在函数内部延迟导入：AstrBot 本体自带该依赖，而离线自测只用标准库。

    :param allow_status: 这些 HTTP 状态不视为错误（例如 /readyz 未就绪时返回 503，
        但我们仍想读到它的 ``checks``）。
    :raises NamiError: 网络失败或 HTTP 状态码 >= 400 且不在 ``allow_status`` 中。
    """
    import aiohttp  # noqa: PLC0415 - 延迟导入，保证无 aiohttp 也能 import 本模块

    client_timeout = aiohttp.ClientTimeout(total=timeout)
    try:
        async with (
            aiohttp.ClientSession(timeout=client_timeout) as session,
            session.request(method.upper(), url, headers=headers, json=json_body) as resp,
        ):
            raw = await resp.text()
            status = resp.status
    except asyncio.TimeoutError as exc:
        raise NamiError("timeout", f"请求超时（{timeout:g} 秒）") from exc
    except aiohttp.ClientError as exc:
        # ClientConnectorError / ClientOSError / ServerDisconnectedError 都落在这里。
        raise NamiError("connection_refused", f"{type(exc).__name__}: {exc}") from exc
    except OSError as exc:
        raise NamiError("connection_refused", f"{type(exc).__name__}: {exc}") from exc

    try:
        payload: Any = json.loads(raw) if raw else {}
    except ValueError:
        payload = {"raw": raw[:500]}

    if status >= 400 and status not in allow_status:
        raise NamiError(
            _error_code_of(payload, status),
            _error_message_of(payload, status),
            status=status,
        )
    return status, payload


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #


def _as_dict(value: Any) -> dict[str, Any]:
    """把任意值安全地当作 dict 使用。"""
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    """把任意值安全地当作 list 使用。"""
    return value if isinstance(value, list) else []


def _human_size(size_bytes: Any) -> str:
    """把字节数渲染成人类可读的体积字符串；无效输入返回空串。"""
    try:
        size = float(size_bytes)
    except (TypeError, ValueError):
        return ""
    if size <= 0:
        return ""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f}{unit}" if unit != "B" else f"{int(size)}B"
        size /= 1024
    return ""


def _human_uptime(seconds: Any) -> str:
    """把秒数渲染成 ``1 天 2 小时 3 分 4 秒`` 形式的中文时长。"""
    try:
        total = int(float(seconds))
    except (TypeError, ValueError):
        return "未知"
    if total < 0:
        return "未知"
    days, rest = divmod(total, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days} 天")
    if hours:
        parts.append(f"{hours} 小时")
    if minutes:
        parts.append(f"{minutes} 分")
    if secs or not parts:
        parts.append(f"{secs} 秒")
    return " ".join(parts)


def _strip_leading_command(text: str) -> str:
    """去掉消息开头的 ``/``、``!``、``！`` 以及空白。"""
    return (text or "").strip().lstrip("/!！").strip()


def _command_argument(
    event: AstrMessageEvent,
    aliases: frozenset[str],
    fallback: str = "",
) -> str:
    """从原始消息里取出子指令后面的整段文本。

    不同平台/不同 AstrBot 版本对 ``message_str`` 的处理不完全一致：有时保留
    ``nami 问 xxx``，有时只剩 ``问 xxx``。这里两种形态都兼容，并且始终返回完整
    的剩余文本（而不是只取第一个词），这样多词问题不会被截断。
    """
    text = _strip_leading_command(getattr(event, "message_str", "") or "")
    if not text:
        return (fallback or "").strip()
    tokens = text.split(None, 2)
    if len(tokens) >= 3 and tokens[0].lower() == "nami" and tokens[1] in aliases:
        return tokens[2].strip()
    if len(tokens) >= 2 and tokens[0] in aliases:
        return text.split(None, 1)[1].strip()
    return (fallback or "").strip()


def _auto_reply_hook() -> Any:
    """返回自动回复监听器的装饰器，并把它排在常规处理器之后。

    较新的 AstrBot 允许给过滤器传 ``priority``；极旧版本不接受该关键字，
    这时退回到不带优先级的注册方式，保证插件仍能加载。
    """
    try:
        return filter.event_message_type(filter.EventMessageType.ALL, priority=AUTO_REPLY_PRIORITY)
    except TypeError:  # pragma: no cover - 仅为兼容旧版 AstrBot
        return filter.event_message_type(filter.EventMessageType.ALL)


# --------------------------------------------------------------------------- #
# 插件主体
# --------------------------------------------------------------------------- #


class NamiPlugin(Star):
    """把 AstrBot 的指令 / 事件 / WebUI 接到 Nami 服务上。"""

    def __init__(self, context: Context, config: AstrBotConfig) -> None:
        super().__init__(context)
        self.config = config
        # 作用域键 -> Nami 会话 id。Nami 用 x-nami-session 头把同一段对话聚成一个
        # 持久化会话，这里记住服务端「分配/确认」过的 id，后续轮次继续复用。
        self._nami_sessions: dict[str, str] = {}
        self._register_web_apis(context)

    async def terminate(self) -> None:
        """插件卸载时清掉内存里的会话映射。"""
        self._nami_sessions.clear()

    # ------------------------------------------------------------------ #
    # 配置读取
    # ------------------------------------------------------------------ #

    def _conf_str(self, key: str, default: str = "") -> str:
        value = self.config.get(key, default)
        if value is None:
            return default
        return str(value).strip()

    def _conf_int(self, key: str, default: int) -> int:
        value = self.config.get(key, default)
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def _conf_bool(self, key: str, default: bool) -> bool:
        value = self.config.get(key, default)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    def _base_url(self) -> str:
        """``/v1`` 前缀的 OpenAI 兼容地址。"""
        return (self._conf_str("nami_base_url", "http://127.0.0.1:8787/v1") or "").rstrip("/")

    def _host_root(self) -> str:
        """服务根地址，用于 /healthz、/readyz 与 /admin/api/*。"""
        root = (self._conf_str("nami_host_root", "http://127.0.0.1:8787") or "").rstrip("/")
        # 兜底：用户误把 /v1 填进来时自动去掉，避免出现 /v1/healthz 这种 404。
        if root.endswith("/v1"):
            root = root[: -len("/v1")].rstrip("/")
        return root

    def _auth_headers(self, *, admin: bool = False) -> dict[str, str]:
        """拼装请求头。密钥只出现在这里，绝不外泄到日志或页面。"""
        headers = {"Accept": "application/json"}
        api_key = self._conf_str("nami_api_key")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        admin_token = self._conf_str("nami_admin_token")
        if admin and admin_token:
            headers["X-Admin-Token"] = admin_token
        return headers

    # ------------------------------------------------------------------ #
    # 会话作用域
    # ------------------------------------------------------------------ #

    def _sender_id(self, event: AstrMessageEvent) -> str:
        getter = getattr(event, "get_sender_id", None)
        if callable(getter):
            try:
                value = getter()
                if value:
                    return str(value)
            except Exception:  # noqa: BLE001 - 平台适配器行为不一致，必须兜住
                pass
        sender = getattr(getattr(event, "message_obj", None), "sender", None)
        user_id = getattr(sender, "user_id", None)
        return str(user_id) if user_id else "unknown"

    def _group_id(self, event: AstrMessageEvent) -> str:
        """群号；私聊时返回空串（``get_group_id`` 可能抛异常或返回 None）。"""
        getter = getattr(event, "get_group_id", None)
        if callable(getter):
            try:
                value = getter()
                if value:
                    return str(value)
            except Exception:  # noqa: BLE001 - 私聊下部分适配器会直接抛异常
                pass
        group_id = getattr(getattr(event, "message_obj", None), "group_id", None)
        return str(group_id) if group_id else ""

    def _bot_self_id(self, event: AstrMessageEvent) -> str:
        """机器人自己的 id，用于过滤自己发的消息与识别 @。"""
        for source in (getattr(event, "message_obj", None), event):
            if source is None:
                continue
            for attr in ("self_id", "selfId"):
                value = getattr(source, attr, None)
                if value:
                    return str(value)
        getter = getattr(event, "get_self_id", None)
        if callable(getter):
            try:
                return str(getter() or "")
            except Exception:  # noqa: BLE001
                return ""
        return ""

    def _scope_key(self, event: AstrMessageEvent) -> str:
        """按 ``session_scope`` 推导出作用域键，它同时是 Nami 会话 id 的默认值。"""
        scope = (self._conf_str("session_scope", "group") or "group").lower()
        if scope == "user":
            return f"astrbot:user:{self._sender_id(event)}"
        if scope == "global":
            return "astrbot:global"
        group_id = self._group_id(event)
        if group_id:
            return f"astrbot:group:{group_id}"
        # 私聊没有群号，回退到用户作用域，避免所有私聊共用一个会话。
        return f"astrbot:user:{self._sender_id(event)}"

    def _session_id(self, scope_key: str) -> str:
        """当前作用域真正要发给 Nami 的会话 id。"""
        return self._nami_sessions.get(scope_key) or scope_key

    def _remember_session(self, scope_key: str, session_id: str) -> None:
        """记住服务端确认/分配的会话 id（为空时保留推导值）。"""
        self._nami_sessions[scope_key] = session_id or scope_key

    # ------------------------------------------------------------------ #
    # Nami 调用封装
    # ------------------------------------------------------------------ #

    async def _request(
        self,
        method: str,
        url: str,
        *,
        body: Any | None = None,
        extra_headers: dict[str, str] | None = None,
        admin: bool = False,
        allow_status: tuple[int, ...] = (),
        timeout: float | None = None,
    ) -> tuple[int, Any]:
        """带上鉴权头调用 :func:`_http_json`。"""
        headers = self._auth_headers(admin=admin)
        if body is not None:
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        effective_timeout = float(timeout or self._conf_int("request_timeout", 60))
        return await _http_json(
            method,
            url,
            headers=headers,
            json_body=body,
            timeout=effective_timeout,
            allow_status=tuple(allow_status),
        )

    async def _fetch(
        self,
        path: str,
        *,
        admin: bool = False,
        allow_status: tuple[int, ...] = (),
    ) -> tuple[bool, Any, str]:
        """GET ``host_root + path``，永不抛异常。

        返回 ``(ok, payload, error_code)``：``ok=False`` 时 ``payload`` 是错误说明。
        """
        url = f"{self._host_root()}{path}"
        try:
            _status, payload = await self._request(
                "GET", url, admin=admin, allow_status=allow_status
            )
        except NamiError as exc:
            return False, exc.message, exc.code
        return True, payload, ""

    def _chat_body(self, prompt: str) -> dict[str, Any]:
        """构造 OpenAI 形状的请求体。``default_model`` 为空时不带 model 字段，
        由 Nami 自己挑默认模型。"""
        messages: list[dict[str, str]] = []
        system_prompt = self._conf_str("system_prompt")
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        body: dict[str, Any] = {"messages": messages, "stream": False}
        model = self._conf_str("default_model")
        if model:
            body["model"] = model
        return body

    async def _chat(self, prompt: str, *, session_id: str) -> dict[str, Any]:
        """调用 ``POST /v1/chat/completions``，返回归一化后的结果。"""
        started = time.monotonic()
        _status, payload = await self._request(
            "POST",
            f"{self._base_url()}/chat/completions",
            body=self._chat_body(prompt),
            extra_headers={"X-Nami-Session": session_id},
        )
        data = _as_dict(payload)
        content = ""
        choices = _as_list(data.get("choices"))
        if choices:
            message = _as_dict(_as_dict(choices[0]).get("message"))
            content = message.get("content") or ""
        # Nami 目前不额外回传会话 id；如果将来回传了就优先采用服务端的分配结果。
        assigned = data.get("session_id") or data.get("sessionId") or session_id
        return {
            "content": str(content),
            "model": str(data.get("model") or self._conf_str("default_model") or "nami"),
            "usage": _as_dict(data.get("usage")),
            "session_id": str(assigned),
            "elapsed": time.monotonic() - started,
        }

    def _truncate(self, text: str) -> str:
        """按 ``max_reply_chars`` 截断回复。"""
        limit = self._conf_int("max_reply_chars", 1500)
        if limit <= 0 or len(text) <= limit:
            return text
        return f"{text[:limit]}\n…（内容过长已截断，原始长度 {len(text)} 字符）"

    @staticmethod
    def _error_reply(exc: NamiError) -> str:
        """把异常渲染成「说明 + 处置建议」的纯文本。"""
        head = f"Nami 调用失败：{exc.message}"
        if exc.status:
            head += f"（HTTP {exc.status} / {exc.code}）"
        else:
            head += f"（{exc.code}）"
        return f"{head}\n处置建议：{guidance_for(exc.code, exc.status)}"

    # ------------------------------------------------------------------ #
    # 指令的公共守卫
    # ------------------------------------------------------------------ #

    def _permission_problem(self, event: AstrMessageEvent) -> str:
        """返回不允许执行的原因，允许时返回空串。"""
        if not self._conf_bool("enable_commands", True):
            return "Nami 指令已在插件配置中关闭（enable_commands = false）。"
        if self._conf_bool("admin_only", False) and not self._is_admin(event):
            return "该指令已设置为仅管理员可用（admin_only = true）。"
        return ""

    @staticmethod
    def _is_admin(event: AstrMessageEvent) -> bool:
        checker = getattr(event, "is_admin", None)
        if callable(checker):
            try:
                return bool(checker())
            except Exception:  # noqa: BLE001
                return False
        role = getattr(event, "role", None)
        return str(role).lower() == "admin" if role else False

    # ------------------------------------------------------------------ #
    # 指令组：/nami
    # ------------------------------------------------------------------ #

    @filter.command_group("nami")
    def nami(self) -> None:
        """Nami 直连指令组。函数体本身不需要实现任何逻辑。"""

    @nami.command("status", alias={"状态"})
    async def nami_status(self, event: AstrMessageEvent):
        """展示 Nami 的存活状态、版本、运行时长与就绪检查项。"""
        problem = self._permission_problem(event)
        if problem:
            yield event.plain_result(problem)
            return

        lines = ["Nami 状态"]
        health_ok, health_raw, health_err = await self._fetch("/healthz")
        if health_ok:
            health = _as_dict(health_raw)
            lines.append(f"服务: 在线（status={health.get('status', 'unknown')}）")
            lines.append(f"版本: {health.get('version', '未知')}")
            lines.append(f"运行时长: {_human_uptime(health.get('uptimeSeconds'))}")
            lines.append(f"Node: {health.get('node', '未知')} · PID: {health.get('pid', '未知')}")
        else:
            lines.append("服务: 不可用")
            lines.append(f"原因: {health_raw}")
            lines.append(f"诊断: {guidance_for(health_err)}")

        ready_ok, ready_raw, ready_err = await self._fetch("/readyz", allow_status=(503,))
        if ready_ok:
            ready = _as_dict(ready_raw)
            checks = _as_dict(ready.get("checks"))
            lines.append(f"就绪: {'就绪' if ready.get('ready') else '未就绪'}")
            lines.append(f"Provider: {checks.get('provider', '未知')}")
            lines.append(f"模型: {checks.get('model', '未知')}")
            if checks:
                lines.append("检查项:")
                for key, value in checks.items():
                    lines.append(f"  · {key}: {value}")
            lines.extend(self._readiness_hints(checks, bool(ready.get("ready"))))
        else:
            lines.append("就绪: 查询失败")
            lines.append(f"原因: {ready_raw}")
            lines.append(f"诊断: {guidance_for(ready_err)}")

        yield event.plain_result(self._truncate("\n".join(lines)))

    @nami.command("models", alias={"模型"})
    async def nami_models(self, event: AstrMessageEvent):
        """列出 ``GET /v1/models`` 的模型目录，标注别名与元信息。"""
        problem = self._permission_problem(event)
        if problem:
            yield event.plain_result(problem)
            return

        try:
            _status, payload = await self._request("GET", f"{self._base_url()}/models")
        except NamiError as exc:
            yield event.plain_result(self._error_reply(exc))
            return

        models = _as_list(_as_dict(payload).get("data"))
        if not models:
            yield event.plain_result("Nami 没有返回任何模型。请先在 Nami 侧准备模型，再执行 /nami 诊断。")
            return

        shown = models[:MODEL_LIST_LIMIT]
        lines = [f"Nami 模型（共 {len(models)} 个，展示前 {len(shown)} 个）"]
        for index, item in enumerate(shown, start=1):
            entry = _as_dict(item)
            meta = _as_dict(entry.get("nami"))
            detail: list[str] = []
            if meta.get("aliasOf"):
                detail.append(f"别名 → {meta['aliasOf']}")
            if meta.get("parameters"):
                detail.append(f"参数 {meta['parameters']}")
            if meta.get("quantization"):
                detail.append(f"量化 {meta['quantization']}")
            size = _human_size(meta.get("sizeBytes"))
            if size:
                detail.append(f"体积 {size}")
            suffix = f" · {' · '.join(detail)}" if detail else ""
            lines.append(f"{index}. {entry.get('id', '未知')}{suffix}")
        if len(models) > len(shown):
            lines.append(f"… 还有 {len(models) - len(shown)} 个未显示（完整列表见 GET /v1/models）")

        yield event.plain_result(self._truncate("\n".join(lines)))

    @nami.command("ask", alias={"问", "提问"})
    async def nami_ask(self, event: AstrMessageEvent, prompt: str = ""):
        """把问题发给 Nami，并保持同一作用域内的会话连续性。"""
        problem = self._permission_problem(event)
        if problem:
            yield event.plain_result(problem)
            return

        text = _command_argument(event, ASK_ALIASES, prompt).strip()
        if not text:
            yield event.plain_result("用法：/nami 问 <你的问题>")
            return

        scope_key = self._scope_key(event)
        session_id = self._session_id(scope_key)
        try:
            result = await self._chat(text, session_id=session_id)
        except NamiError as exc:
            yield event.plain_result(self._error_reply(exc))
            return

        self._remember_session(scope_key, result["session_id"])
        usage = result["usage"]
        tail = f"用时 {result['elapsed']:.1f}s"
        if usage.get("total_tokens") is not None:
            tail += f" · tokens {usage['total_tokens']}"
        answer = result["content"].strip() or "（Nami 返回了空内容）"
        reply = (
            f"Nami 回答（模型 {result['model']} · 会话 {result['session_id']} · {tail}）\n\n{answer}"
        )
        yield event.plain_result(self._truncate(reply))

    @nami.command("tools", alias={"工具"})
    async def nami_tools(self, event: AstrMessageEvent):
        """列出 ``GET /admin/api/tools`` 中启用的工具及其危险等级。"""
        problem = self._permission_problem(event)
        if problem:
            yield event.plain_result(problem)
            return

        try:
            _status, payload = await self._request(
                "GET", f"{self._host_root()}/admin/api/tools", admin=True
            )
        except NamiError as exc:
            yield event.plain_result(self._error_reply(exc))
            return

        tools = _as_list(_as_dict(payload).get("data"))
        if not tools:
            yield event.plain_result("Nami 没有返回任何工具。")
            return

        enabled = [tool for tool in tools if _as_dict(tool).get("enabled", True)]
        danger_labels = {"safe": "安全", "caution": "需注意", "dangerous": "危险"}
        lines = [f"Nami 工具（启用 {len(enabled)}/{len(tools)}）"]
        for tool in tools:
            entry = _as_dict(tool)
            mark = "✓" if entry.get("enabled", True) else "✗"
            danger = str(entry.get("danger", "safe"))
            label = danger_labels.get(danger, danger)
            state = "" if entry.get("implemented", True) else " · 未实现"
            lines.append(f"{mark} {entry.get('name', '未知')} · 危险等级 {label}{state}")
        yield event.plain_result(self._truncate("\n".join(lines)))

    @nami.command("reset", alias={"重置"})
    async def nami_reset(self, event: AstrMessageEvent):
        """忘掉当前作用域记住的 Nami 会话，下一轮将开启新会话。"""
        problem = self._permission_problem(event)
        if problem:
            yield event.plain_result(problem)
            return

        scope_key = self._scope_key(event)
        previous = self._session_id(scope_key)
        self._nami_sessions.pop(scope_key, None)
        scope = self._conf_str("session_scope", "group") or "group"
        lines = [
            "Nami 会话已重置",
            f"作用域: {scope}",
            f"会话键: {scope_key}",
            f"原会话 id: {previous}",
            f"新会话 id: {scope_key}（回到默认值，下一轮提问即生效）",
        ]
        yield event.plain_result("\n".join(lines))

    @nami.command("diag", alias={"诊断"})
    async def nami_diag(self, event: AstrMessageEvent):
        """逐项体检：配置 → /healthz → /readyz → /v1/models → 一次最小对话探测。"""
        problem = self._permission_problem(event)
        if problem:
            yield event.plain_result(problem)
            return

        lines = ["Nami 诊断"]
        base_url = self._base_url()
        host_root = self._host_root()
        api_key = self._conf_str("nami_api_key")

        # 步骤 1：配置
        config_ok = bool(base_url) and bool(host_root) and bool(api_key)
        lines.append(f"[1/5] 配置检查: {'✓' if config_ok else '✗'}")
        lines.append(f"  接口地址: {base_url or '（空）'}")
        lines.append(f"  服务根地址: {host_root or '（空）'}")
        lines.append(f"  api key: {'已配置' if api_key else '未配置'}")
        if not config_ok:
            if not api_key:
                lines.append(f"  → 下一步: {ERROR_GUIDANCE['missing_api_key']}")
            else:
                lines.append("  → 下一步: 在插件配置里填写 nami_base_url 与 nami_host_root。")
            yield event.plain_result(self._truncate("\n".join(lines)))
            return

        # 步骤 2：存活
        health_ok, health_raw, health_err = await self._fetch("/healthz")
        if health_ok:
            health = _as_dict(health_raw)
            lines.append(f"[2/5] /healthz 连通性: ✓ 版本 {health.get('version', '未知')}")
        else:
            lines.append(f"[2/5] /healthz 连通性: ✗ {health_raw}")
            lines.append(f"  → 下一步: {guidance_for(health_err)}")
            lines.append("结论: Nami 不可达，后续步骤已跳过。")
            yield event.plain_result(self._truncate("\n".join(lines)))
            return

        # 步骤 3：就绪
        ready_ok, ready_raw, ready_err = await self._fetch("/readyz", allow_status=(503,))
        if ready_ok:
            ready = _as_dict(ready_raw)
            checks = _as_dict(ready.get("checks"))
            is_ready = bool(ready.get("ready"))
            lines.append(f"[3/5] /readyz 就绪: {'✓' if is_ready else '✗ 未就绪（HTTP 503）'}")
            for key, value in checks.items():
                lines.append(f"  · {key}: {value}")
            hints = self._readiness_hints(checks, is_ready)
            for hint in hints:
                lines.append(f"  → 下一步: {hint}")
        else:
            lines.append(f"[3/5] /readyz 就绪: ✗ {ready_raw}")
            lines.append(f"  → 下一步: {guidance_for(ready_err)}")

        # 步骤 4：模型目录
        try:
            _status, payload = await self._request("GET", f"{base_url}/models")
            models = _as_list(_as_dict(payload).get("data"))
            if models:
                lines.append(f"[4/5] /v1/models: ✓ 共 {len(models)} 个模型")
            else:
                lines.append("[4/5] /v1/models: ✗ 返回为空")
                lines.append(
                    "  → 下一步: Nami 侧没有发现模型，在那台机器上执行 npm run ollama -- --write。"
                )
        except NamiError as exc:
            lines.append(f"[4/5] /v1/models: ✗ {exc.message}")
            lines.append(f"  → 下一步: {guidance_for(exc.code, exc.status)}")

        # 步骤 5：最小对话探测
        scope_key = self._scope_key(event)
        try:
            result = await self._chat("ping", session_id=self._session_id(scope_key))
            self._remember_session(scope_key, result["session_id"])
            preview = (result["content"].strip() or "（空内容）").replace("\n", " ")[:60]
            lines.append(f"[5/5] 对话探测: ✓ 模型 {result['model']} 返回 {preview!r}")
            lines.append("结论: 全部通过，Nami 可用。")
        except NamiError as exc:
            lines.append(f"[5/5] 对话探测: ✗ {exc.message}")
            lines.append(f"  → 下一步: {guidance_for(exc.code, exc.status)}")
            lines.append("结论: Nami 可达但对话失败，请按上面的建议处理。")

        yield event.plain_result(self._truncate("\n".join(lines)))

    @staticmethod
    def _readiness_hints(checks: dict[str, Any], is_ready: bool) -> list[str]:
        """根据 /readyz 的 checks 生成具体的下一步建议。"""
        hints: list[str] = []
        if str(checks.get("model", "")).strip() == "none selected":
            hints.append(
                "Nami 侧没有可用模型（checks.model = none selected）："
                "在 Nami 那台机器上执行 npm run ollama -- --write。"
            )
        if str(checks.get("apiKeys", "")).strip() == "missing":
            hints.append("Nami 侧没有配置 API Key：设置 NAMI_API_KEYS 后重启 Nami。")
        if str(checks.get("database", "")).strip() not in {"", "ok"}:
            hints.append("Nami 的数据库不可用，检查 NAMI_DB_PATH 与目录权限。")
        if not is_ready and not hints:
            hints.append("先执行 /nami 状态 查看完整检查项，再对照 README 的排查表处理。")
        return hints

    # ------------------------------------------------------------------ #
    # 可选：自动回复监听
    # ------------------------------------------------------------------ #

    @_auto_reply_hook()
    async def on_auto_reply(self, event: AstrMessageEvent):
        """把命中的消息转发给 Nami 并回复。

        这是独立的事件监听函数（不与其他过滤器混用）。即使功能关闭也会被注册，
        进入后立刻返回，因此关闭时没有任何额外开销。
        """
        if not self._conf_bool("auto_reply_enabled", False):
            return

        text = (getattr(event, "message_str", "") or "").strip()
        if not text:
            return
        if self._is_self_message(event):
            return
        # 不要把 /nami 指令本身再喂给 Nami，否则会重复回答。
        if _strip_leading_command(text).lower().startswith("nami"):
            return

        trigger = (self._conf_str("auto_reply_trigger", "mention") or "mention").lower()
        prompt = text
        if trigger == "prefix":
            prefix = self._conf_str("auto_reply_prefix", "/ai") or "/ai"
            if not text.startswith(prefix):
                return
            prompt = text[len(prefix) :].strip()
        elif trigger == "mention":
            if not self._is_mentioned(event, text):
                return
            prompt = self._strip_mention(text)
        # trigger == "all"：所有非空消息都会转发。

        if not prompt:
            return

        scope_key = self._scope_key(event)
        try:
            result = await self._chat(prompt, session_id=self._session_id(scope_key))
        except NamiError as exc:
            await event.send(event.plain_result(self._truncate(self._error_reply(exc))))
        else:
            self._remember_session(scope_key, result["session_id"])
            answer = result["content"].strip() or "（Nami 返回了空内容）"
            await event.send(event.plain_result(self._truncate(answer)))

        # 已经由 Nami 回答，阻止这条消息继续走 AstrBot 自己的 LLM 流程。
        stopper = getattr(event, "stop_event", None)
        if callable(stopper):
            stopper()

    def _is_self_message(self, event: AstrMessageEvent) -> bool:
        """判断消息是不是机器人自己发的，避免自问自答死循环。"""
        bot_id = self._bot_self_id(event)
        return bool(bot_id) and self._sender_id(event) == bot_id

    def _is_mentioned(self, event: AstrMessageEvent, text: str) -> bool:
        """是否被 @ / 命中关键词。"""
        keyword = self._conf_str("mention_keyword")
        if keyword and keyword in text:
            return True
        bot_id = self._bot_self_id(event)
        if not bot_id:
            return False
        if bot_id in self._raw_text(event):
            return True
        message_obj = getattr(event, "message_obj", None)
        for segment in _as_list(getattr(message_obj, "message", None)):
            if str(getattr(segment, "qq", "")) == bot_id:
                return True
        return False

    @staticmethod
    def _raw_text(event: AstrMessageEvent) -> str:
        """原始消息的字符串形态（OneBot 下是 CQ 码，@ 会以 qq=xxx 出现）。"""
        raw = getattr(getattr(event, "message_obj", None), "raw_message", None)
        if raw is None:
            return ""
        if isinstance(raw, str):
            return raw
        return str(raw)

    def _strip_mention(self, text: str) -> str:
        """去掉消息里的 @ 片段与提及关键词，得到真正要问的内容。"""
        cleaned = text
        keyword = self._conf_str("mention_keyword")
        if keyword:
            cleaned = cleaned.replace(keyword, " ")
        # OneBot 的 @ 段会以 [CQ:at,qq=...] 出现在 message_str 里。
        while "[CQ:at" in cleaned:
            head, _, rest = cleaned.partition("[CQ:at")
            _, _, tail = rest.partition("]")
            cleaned = f"{head} {tail}"
        return cleaned.strip()

    # ------------------------------------------------------------------ #
    # Dashboard Page 的后端路由（路径必须带插件名前缀）
    # ------------------------------------------------------------------ #

    def _register_web_apis(self, context: Context) -> None:
        """注册页面用到的全部后端接口。"""
        routes: tuple[tuple[str, Any, list[str], str], ...] = (
            (f"/{PLUGIN_NAME}/status", self.page_status, ["GET"], "Nami 状态汇总"),
            (f"/{PLUGIN_NAME}/models", self.page_models, ["GET"], "Nami 模型目录"),
            (f"/{PLUGIN_NAME}/tools", self.page_tools, ["GET"], "Nami 工具列表"),
            (f"/{PLUGIN_NAME}/sessions", self.page_sessions, ["GET"], "Nami 会话列表"),
            (
                f"/{PLUGIN_NAME}/sessions/delete",
                self.page_session_delete,
                ["POST", "DELETE"],
                "删除 Nami 会话",
            ),
            (f"/{PLUGIN_NAME}/ask", self.page_ask, ["POST"], "直接向 Nami 提问"),
        )
        for route, handler, methods, desc in routes:
            context.register_web_api(route, handler, methods, desc)

    def _public_settings(self) -> dict[str, Any]:
        """可以安全暴露给浏览器的配置摘要——只有布尔值，永远没有密钥本身。"""
        return {
            "plugin_name": PLUGIN_NAME,
            "base_url": self._base_url(),
            "host_root": self._host_root(),
            "api_key_configured": bool(self._conf_str("nami_api_key")),
            "admin_token_configured": bool(self._conf_str("nami_admin_token")),
            "default_model": self._conf_str("default_model"),
            "session_scope": self._conf_str("session_scope", "group"),
            "auto_reply_enabled": self._conf_bool("auto_reply_enabled", False),
            "auto_reply_trigger": self._conf_str("auto_reply_trigger", "mention"),
            "enable_commands": self._conf_bool("enable_commands", True),
            "request_timeout": self._conf_int("request_timeout", 60),
            "max_reply_chars": self._conf_int("max_reply_chars", 1500),
        }

    async def page_status(self):
        """GET 状态汇总：健康、就绪、概览、指标。"""
        health_ok, health_raw, health_err = await self._fetch("/healthz")
        ready_ok, ready_raw, ready_err = await self._fetch("/readyz", allow_status=(503,))
        overview_ok, overview_raw, overview_err = await self._fetch(
            "/admin/api/overview", admin=True
        )
        metrics_ok, metrics_raw, metrics_err = await self._fetch("/admin/api/metrics", admin=True)

        health = _as_dict(health_raw)
        ready = _as_dict(ready_raw)
        overview = _as_dict(overview_raw)
        metrics = _as_dict(metrics_raw)
        store_counts = _as_dict(_as_dict(overview.get("store")).get("counts"))
        tools = _as_dict(overview.get("tools"))
        requests_info = _as_dict(metrics.get("requests"))

        ready_checks = _as_dict(ready.get("checks"))
        return json_response(
            {
                "settings": self._public_settings(),
                "health": {
                    "ok": health_ok,
                    "error": "" if health_ok else str(health_raw),
                    "error_code": health_err,
                    "status": health.get("status"),
                    "version": health.get("version"),
                    "uptime_seconds": health.get("uptimeSeconds"),
                    "node": health.get("node"),
                    "pid": health.get("pid"),
                },
                "readiness": {
                    "ok": ready_ok,
                    "error": "" if ready_ok else str(ready_raw),
                    "error_code": ready_err,
                    "ready": bool(ready.get("ready")),
                    "checks": _as_dict(ready.get("checks")),
                    "uptime_seconds": ready.get("uptimeSeconds"),
                },
                "provider": {
                    "name": overview.get("provider") or ready_checks.get("provider"),
                    "model": overview.get("model") or ready_checks.get("model"),
                    "discovered": _as_dict(overview.get("models")).get("discovered"),
                    "aliases": len(_as_list(_as_dict(overview.get("models")).get("aliases"))),
                },
                "tools": {
                    "ok": overview_ok,
                    "enabled": tools.get("enabled"),
                    "total": tools.get("total"),
                    "error": "" if overview_ok else str(overview_raw),
                },
                "sessions": {
                    "total": store_counts.get("sessions"),
                    "messages": store_counts.get("messages"),
                    "tracked_scopes": len(self._nami_sessions),
                },
                "requests": {
                    "ok": metrics_ok,
                    "total": requests_info.get("total"),
                    "errors": requests_info.get("errors"),
                    "error": "" if metrics_ok else str(metrics_raw),
                },
                "errors": {
                    "health": health_err,
                    "readiness": ready_err,
                    "overview": overview_err,
                    "metrics": metrics_err,
                },
            }
        )

    async def page_models(self):
        """GET 模型目录（代理 /v1/models）。"""
        try:
            _status, payload = await self._request("GET", f"{self._base_url()}/models")
        except NamiError as exc:
            return error_response(
                f"{exc.message}｜{guidance_for(exc.code, exc.status)}", status_code=502
            )

        entries = []
        for item in _as_list(_as_dict(payload).get("data")):
            entry = _as_dict(item)
            meta = _as_dict(entry.get("nami"))
            entries.append(
                {
                    "id": entry.get("id"),
                    "owned_by": entry.get("owned_by"),
                    "alias_of": meta.get("aliasOf"),
                    "parameters": meta.get("parameters"),
                    "quantization": meta.get("quantization"),
                    "size_bytes": meta.get("sizeBytes"),
                    "size_human": _human_size(meta.get("sizeBytes")),
                }
            )
        return json_response({"models": entries, "count": len(entries)})

    async def page_tools(self):
        """GET 工具列表（代理 /admin/api/tools）。"""
        try:
            _status, payload = await self._request(
                "GET", f"{self._host_root()}/admin/api/tools", admin=True
            )
        except NamiError as exc:
            return error_response(
                f"{exc.message}｜{guidance_for(exc.code, exc.status)}", status_code=502
            )

        tools = []
        for item in _as_list(_as_dict(payload).get("data")):
            entry = _as_dict(item)
            tools.append(
                {
                    "name": entry.get("name"),
                    "description": entry.get("description"),
                    "danger": entry.get("danger") or "safe",
                    "enabled": bool(entry.get("enabled", True)),
                    "implemented": bool(entry.get("implemented", True)),
                }
            )
        enabled = sum(1 for tool in tools if tool["enabled"])
        return json_response({"tools": tools, "count": len(tools), "enabled": enabled})

    async def page_sessions(self):
        """GET 会话列表（代理 /admin/api/sessions）。"""
        limit = 50
        raw_limit = request.query.get("limit")
        if raw_limit is not None:
            try:
                limit = max(1, min(200, int(raw_limit)))
            except (TypeError, ValueError):
                limit = 50
        try:
            _status, payload = await self._request(
                "GET", f"{self._host_root()}/admin/api/sessions?limit={limit}", admin=True
            )
        except NamiError as exc:
            return error_response(
                f"{exc.message}｜{guidance_for(exc.code, exc.status)}", status_code=502
            )

        sessions = []
        for item in _as_list(_as_dict(payload).get("data")):
            entry = _as_dict(item)
            sessions.append(
                {
                    "id": entry.get("id"),
                    "title": entry.get("title"),
                    "message_count": entry.get("messageCount"),
                    "created_at": entry.get("createdAt"),
                    "updated_at": entry.get("updatedAt"),
                }
            )
        return json_response({"sessions": sessions, "count": len(sessions)})

    async def page_session_delete(self):
        """POST/DELETE 删除一个会话（代理 DELETE /admin/api/sessions/{id}）。"""
        session_id = request.query.get("id")
        if not session_id:
            payload = await request.json(default={})
            if isinstance(payload, dict):
                session_id = payload.get("id") or payload.get("session_id")
        session_id = str(session_id or "").strip()
        if not session_id:
            return error_response("缺少会话 id", status_code=400)

        url = f"{self._host_root()}/admin/api/sessions/{quote(session_id, safe='')}"
        try:
            _status, payload = await self._request("DELETE", url, admin=True)
        except NamiError as exc:
            status = 404 if exc.code == "session_not_found" else 502
            return error_response(
                f"{exc.message}｜{guidance_for(exc.code, exc.status)}", status_code=status
            )

        deleted = bool(_as_dict(payload).get("deleted"))
        # 本地也忘掉这个 id，避免下次还拿一个已删除的会话去提问。
        for scope_key, remembered in list(self._nami_sessions.items()):
            if remembered == session_id:
                self._nami_sessions.pop(scope_key, None)
        return json_response({"id": session_id, "deleted": deleted})

    async def page_ask(self):
        """POST 向 Nami 提一个问题。"""
        payload = await request.json(default={})
        if not isinstance(payload, dict):
            return error_response("请求体必须是 JSON 对象", status_code=400)
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            return error_response("问题不能为空", status_code=400)

        session_id = str(payload.get("session_id") or "").strip() or "astrbot:web"
        model = str(payload.get("model") or "").strip() or None
        try:
            _status, response = await self._request(
                "POST",
                f"{self._base_url()}/chat/completions",
                body=self._chat_body(prompt),
                extra_headers={"X-Nami-Session": session_id},
                timeout=float(self._conf_int("request_timeout", 60)) * 2,
            )
        except NamiError as exc:
            return error_response(
                f"{exc.message}｜{guidance_for(exc.code, exc.status)}", status_code=502
            )

        data = _as_dict(response)
        content = ""
        choices = _as_list(data.get("choices"))
        if choices:
            content = _as_dict(_as_dict(choices[0]).get("message")).get("content") or ""
        return json_response(
            {
                "answer": str(content),
                "model": data.get("model") or model or self._conf_str("default_model") or "nami",
                "session_id": data.get("session_id") or session_id,
                "usage": _as_dict(data.get("usage")),
            }
        )
