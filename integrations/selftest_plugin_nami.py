#!/usr/bin/env python3
"""astrbot_plugin_nami 的离线自测。

设计目标：**只用标准库**，不需要 AstrBot，也不需要任何第三方包，更不会打开真实
网络连接。做法是：

1. 在 import ``main.py`` 之前，往 ``sys.modules`` 里塞一套 ``astrbot.*`` 桩模块，
   桩里的过滤器装饰器会把注册结果记到 ``REGISTRY``，于是测试可以断言「哪些指令/
   路由被注册了」，也可以直接调用这些处理器。
2. 把插件唯一的网络出口 ``main._http_json`` 换成一个假的实现，它会记录每一次调用
   （方法、URL、请求头、请求体），并按预先配置的路由返回数据或抛错。

运行：``python selftest_plugin_nami.py``，全部通过时打印 ``✓ 全部通过 N 项断言``，
否则逐条列出失败项并以非零码退出。
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_DIR = HERE / "astrbot_plugin_nami"

# 不要在插件目录里留下 __pycache__：自测只应该读文件，不应该改文件。
sys.dont_write_bytecode = True

# 中文 Windows 控制台默认代码页是 GBK，而本脚本的输出含 ✓/✗ 与中文。若不强制
# UTF-8，Python 会以 gbk 编码 stdout，最后一行汇总直接抛 UnicodeEncodeError ——
# 明明 448 项断言全过了，进程却以退出码 1 结束，看起来像失败。
# 把 stdout/stderr 切到 UTF-8，并对无法编码的字符降级为替代字符而不是崩溃。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError, OSError):  # 非常老的 Python 或已被重定向
        pass

# --------------------------------------------------------------------------- #
# 断言收集
# --------------------------------------------------------------------------- #

CHECKS: list[tuple[bool, str]] = []


def check(condition: object, label: str) -> bool:
    """记录一条断言。返回布尔值，方便继续做条件断言。"""
    ok = bool(condition)
    CHECKS.append((ok, label))
    return ok


def check_eq(actual: object, expected: object, label: str) -> bool:
    """相等断言，失败时把实际值写进标签，便于定位。"""
    ok = actual == expected
    detail = label if ok else f"{label}（期望 {expected!r}，实际 {actual!r}）"
    CHECKS.append((ok, detail))
    return ok


def check_in(needle: str, haystack: str, label: str) -> bool:
    """子串断言。"""
    ok = needle in (haystack or "")
    detail = label if ok else f"{label}（未找到 {needle!r}）"
    CHECKS.append((ok, detail))
    return ok


def check_not_in(needle: str, haystack: str, label: str) -> bool:
    """反向子串断言。"""
    ok = needle not in (haystack or "")
    detail = label if ok else f"{label}（不应出现 {needle!r}）"
    CHECKS.append((ok, detail))
    return ok


# --------------------------------------------------------------------------- #
# 1. astrbot.* 桩模块
# --------------------------------------------------------------------------- #

REGISTRY: dict[str, object] = {
    "commands": {},   # 顶层指令名 -> {"aliases": set, "func": fn, "priority": int}
    "groups": {},     # 指令组名   -> _GroupStub
    "handlers": {},   # "group.sub" -> fn
    "events": [],     # 事件监听器
    "permissions": [],  # permission_type 装饰过的函数
    "routes": [],     # register_web_api 注册的路由
}


class EventMessageType:
    """``filter.EventMessageType`` 的桩。"""

    ALL = "ALL"
    GROUP_MESSAGE = "GROUP_MESSAGE"
    PRIVATE_MESSAGE = "PRIVATE_MESSAGE"


class PermissionType:
    """``filter.PermissionType`` 的桩。"""

    ADMIN = "ADMIN"
    MEMBER = "MEMBER"


class _GroupStub:
    """``command_group`` 返回的对象，持有子指令。"""

    def __init__(self, name: str, aliases: set[str]) -> None:
        self.name = name
        self.aliases = aliases
        self.subs: dict[str, dict] = {}

    def command(self, sub_name: str, alias: set[str] | None = None, priority: int = 0):
        def decorator(func):
            self.subs[sub_name] = {"aliases": set(alias or ()), "func": func}
            REGISTRY["handlers"][f"{self.name}.{sub_name}"] = func
            return func

        return decorator

    def group(self, sub_name: str, alias: set[str] | None = None, priority: int = 0):
        def decorator(func):
            child = _GroupStub(f"{self.name}.{sub_name}", set(alias or ()))
            self.subs[sub_name] = {"group": child}
            return child

        return decorator


class _FilterStub:
    """``astrbot.api.event.filter`` 的桩。"""

    EventMessageType = EventMessageType
    PermissionType = PermissionType

    @staticmethod
    def command(name: str, alias: set[str] | None = None, priority: int = 0):
        def decorator(func):
            REGISTRY["commands"][name] = {
                "aliases": set(alias or ()),
                "func": func,
                "priority": priority,
            }
            return func

        return decorator

    @staticmethod
    def command_group(name: str, alias: set[str] | None = None, priority: int = 0):
        def decorator(func):
            group = _GroupStub(name, set(alias or ()))
            group.func = func
            REGISTRY["groups"][name] = group
            return group

        return decorator

    @staticmethod
    def event_message_type(event_type, priority: int = 0):
        def decorator(func):
            REGISTRY["events"].append(
                {"type": event_type, "priority": priority, "func": func, "name": func.__name__}
            )
            return func

        return decorator

    @staticmethod
    def permission_type(permission):
        def decorator(func):
            REGISTRY["permissions"].append({"type": permission, "func": func})
            return func

        return decorator

    @staticmethod
    def platform_adapter_type(*args, **kwargs):
        return lambda func: func


class AstrMessageEvent:  # noqa: N801 - 与 AstrBot 同名
    """``AstrMessageEvent`` 的桩基类。"""


class AstrBotConfig(dict):
    """``AstrBotConfig`` 的桩：dict 子类 + save_config。"""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.saved = False

    def save_config(self) -> None:
        self.saved = True


class Star:
    """``astrbot.api.star.Star`` 的桩。"""

    def __init__(self, context) -> None:
        self.context = context


class Context:
    """``astrbot.api.star.Context`` 的桩，记录 register_web_api。"""

    def __init__(self) -> None:
        self.routes: list[dict] = []

    def register_web_api(self, route, handler, methods, desc) -> None:
        entry = {"route": route, "handler": handler, "methods": list(methods), "desc": desc}
        self.routes.append(entry)
        REGISTRY["routes"].append(entry)
        return entry


class _Query:
    """``request.query`` 的桩。"""

    def __init__(self, data: dict | None = None) -> None:
        self._data = dict(data or {})

    def get(self, key, default=None, type=None):  # noqa: A002 - 与 AstrBot 签名一致
        value = self._data.get(key, default)
        if type is not None and value is not None:
            try:
                return type(value)
            except (TypeError, ValueError):
                return default
        return value

    def getlist(self, key):
        value = self._data.get(key)
        return list(value) if isinstance(value, list) else ([] if value is None else [value])


class _RequestStub:
    """``astrbot.api.web.request`` 的桩，测试前直接改属性即可。"""

    def __init__(self) -> None:
        self.username = "tester"
        self.method = "GET"
        self.path = "/api/v1/plugins/extensions/astrbot_plugin_nami/status"
        self.plugin_name = "astrbot_plugin_nami"
        self.headers: dict[str, str] = {}
        self.query = _Query()
        self._json: dict | None = None

    async def json(self, default=None):
        if self._json is None:
            return {} if default is None else default
        return self._json

    async def body(self) -> bytes:
        return json.dumps(self._json or {}).encode("utf-8")


class StubResponse:
    """``json_response`` / ``error_response`` 的返回值。"""

    def __init__(self, kind: str, payload=None, status_code: int = 200, message: str = "") -> None:
        self.kind = kind
        self.payload = payload
        self.status_code = status_code
        self.message = message

    def __repr__(self) -> str:  # pragma: no cover - 仅调试用
        return f"StubResponse(kind={self.kind!r}, status={self.status_code}, payload={self.payload!r})"


REQUEST_STUB = _RequestStub()


def json_response(payload=None, status_code: int = 200):
    return StubResponse("json", payload, status_code)


def error_response(message: str, status_code: int = 400, **kwargs):
    return StubResponse("error", None, status_code, message)


def install_astrbot_stubs() -> None:
    """把 astrbot.* 桩模块装进 sys.modules（必须在 import main 之前）。"""
    astrbot = types.ModuleType("astrbot")
    api = types.ModuleType("astrbot.api")
    event = types.ModuleType("astrbot.api.event")
    star = types.ModuleType("astrbot.api.star")
    web = types.ModuleType("astrbot.api.web")

    api.AstrBotConfig = AstrBotConfig
    api.__path__ = []  # 让它看起来像个包

    event.filter = _FilterStub()
    event.AstrMessageEvent = AstrMessageEvent
    event.EventMessageType = EventMessageType

    star.Context = Context
    star.Star = Star

    web.request = REQUEST_STUB
    web.json_response = json_response
    web.error_response = error_response

    astrbot.api = api
    api.event = event
    api.star = star
    api.web = web

    sys.modules.update(
        {
            "astrbot": astrbot,
            "astrbot.api": api,
            "astrbot.api.event": event,
            "astrbot.api.star": star,
            "astrbot.api.web": web,
        }
    )


install_astrbot_stubs()

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("nami_plugin_main", PLUGIN_DIR / "main.py")
main = importlib.util.module_from_spec(_spec)
sys.modules["nami_plugin_main"] = main
_spec.loader.exec_module(main)
MAIN_SOURCE = (PLUGIN_DIR / "main.py").read_text(encoding="utf-8")

# --------------------------------------------------------------------------- #
# 2. 假的 Nami
# --------------------------------------------------------------------------- #

HOST = "http://127.0.0.1:8787"
BASE = f"{HOST}/v1"

API_KEY = "sk-nami-SECRET-KEY-abc123"
ADMIN_TOKEN = "nami-admin-SECRET-TOKEN-xyz789"

_STATUS_TO_CODE = {
    400: "invalid_request_error",
    401: "missing_api_key",
    403: "admin_required",
    404: "model_not_found",
    429: "rate_limited",
    500: "http_500",
}


def error_payload(code: str, message: str = "boom") -> dict:
    """Nami 风格的结构化错误体。"""
    return {
        "error": {
            "message": message,
            "type": "invalid_request_error",
            "code": code,
            "request_id": "req_test_1",
        }
    }


class FakeNami:
    """``main._http_json`` 的替身：记录调用 + 按路由返回。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.routes: dict[tuple[str, str], dict] = {}

    def add(self, method: str, url: str, status: int = 200, payload=None, error=None) -> None:
        self.routes[(method.upper(), url)] = {"status": status, "payload": payload, "error": error}

    def add_error(self, method: str, url: str, code: str, status: int = 400, message: str = "boom"):
        self.routes[(method.upper(), url)] = {
            "status": status,
            "payload": error_payload(code, message),
            "error": None,
        }

    def calls_to(self, method: str, url: str) -> list[dict]:
        return [c for c in self.calls if c["method"] == method.upper() and c["url"] == url]

    def last(self) -> dict:
        return self.calls[-1]

    def reset_calls(self) -> None:
        self.calls.clear()

    async def __call__(
        self,
        method: str,
        url: str,
        *,
        headers=None,
        json_body=None,
        timeout: float = 60.0,
        allow_status: tuple[int, ...] = (),
    ) -> tuple[int, object]:
        self.calls.append(
            {
                "method": method.upper(),
                "url": url,
                "headers": dict(headers or {}),
                "json": json_body,
                "timeout": timeout,
            }
        )
        entry = self.routes.get((method.upper(), url))
        if entry is None:
            raise main.NamiError("connection_refused", f"没有为 {method.upper()} {url} 配置路由")
        if entry["error"] is not None:
            raise entry["error"]
        status = entry["status"]
        payload = entry["payload"] if entry["payload"] is not None else {}
        if status >= 400 and status not in allow_status:
            code = _STATUS_TO_CODE.get(status, f"http_{status}")
            body = payload if isinstance(payload, dict) else {}
            error = body.get("error")
            if isinstance(error, dict) and error.get("code"):
                code = error["code"]
            raise main.NamiError(code, f"HTTP {status}", status=status)
        return status, payload


# --------------------------------------------------------------------------- #
# 3. 固定响应数据
# --------------------------------------------------------------------------- #

HEALTH = {
    "status": "ok",
    "version": "1.0.0",
    "uptimeSeconds": 125,
    "node": "v24.13.1",
    "pid": 4242,
}
READY = {
    "ready": True,
    "checks": {
        "database": "ok",
        "provider": "ollama",
        "model": "qwen2.5:7b",
        "models": "3 available",
        "tools": "8/11 enabled",
        "apiKeys": "configured",
    },
    "uptimeSeconds": 125,
}
MODELS = {
    "object": "list",
    "data": [
        {
            "id": "qwen2.5:7b",
            "object": "model",
            "created": 1760000000,
            "owned_by": "ollama",
            "nami": {"parameters": "7.6B", "quantization": "Q4_K_M", "sizeBytes": 4683073120},
        },
        {
            "id": "gpt-4o-mini",
            "object": "model",
            "owned_by": "ollama",
            "nami": {"aliasOf": "qwen2.5:7b"},
        },
    ],
}
CHAT = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 1760000000,
    "model": "qwen2.5:7b",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "你好呀，我是 Nami。"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 42},
}
TOOLS = {
    "object": "list",
    "data": [
        {"name": "calc", "description": "算数", "danger": "safe", "enabled": True, "implemented": True},
        {
            "name": "shell",
            "description": "执行命令",
            "danger": "dangerous",
            "enabled": True,
            "implemented": True,
        },
        {
            "name": "legacy",
            "description": "旧工具",
            "danger": "caution",
            "enabled": False,
            "implemented": False,
        },
    ],
}
SESSIONS = {
    "object": "list",
    "limit": 50,
    "offset": 0,
    "data": [
        {
            "id": "sess_a",
            "title": "群聊 A",
            "createdAt": 1760000000000,
            "updatedAt": 1760000100000,
            "metadata": {},
            "messageCount": 4,
        }
    ],
}
OVERVIEW = {
    "version": "1.0.0",
    "startedAt": 1760000000000,
    "uptimeSeconds": 125,
    "provider": "ollama",
    "model": "qwen2.5:7b",
    "models": {
        "defaultModel": "qwen2.5:7b",
        "discovered": 3,
        "discoveryOk": True,
        "exposed": ["qwen2.5:7b"],
        "aliases": ["gpt-4o-mini"],
        "allowClientModel": False,
    },
    "tools": {"total": 11, "enabled": 8, "names": ["calc"]},
    "apiKeys": {"count": 1, "generated": False},
    "rateLimit": {"enabled": True, "burst": 20, "perSecond": 5, "trackedKeys": 1},
    "websocket": {"path": "/ws", "activeConnections": 0},
    "store": {
        "counts": {"sessions": 2, "messages": 9, "runs": 3, "toolInvocations": 1},
        "dbPath": "data/nami.db",
    },
}
METRICS = {
    "uptimeSeconds": 125,
    "requests": {"total": 77, "byStatus": {"200": 74}, "errors": 3},
    "agent": {"runsStarted": 5, "runsCompleted": 4, "toolCalls": 6},
    "websocket": {"active": 0},
    "transfer": {"bytesIn": 1, "bytesOut": 2},
}
READMEY_READY = {
    "ready": False,
    "checks": {
        "database": "ok",
        "provider": "ollama",
        "model": "none selected",
        "models": "0 available",
        "tools": "8/11 enabled",
        "apiKeys": "configured",
    },
    "uptimeSeconds": 5,
}

SESSIONS_URL = f"{HOST}/admin/api/sessions?limit=50"


def happy_routes(fake: FakeNami) -> None:
    """把「一切正常」的路由装进假 Nami。"""
    fake.add("GET", f"{HOST}/healthz", payload=HEALTH)
    fake.add("GET", f"{HOST}/readyz", payload=READY)
    fake.add("GET", f"{HOST}/admin/api/overview", payload=OVERVIEW)
    fake.add("GET", f"{HOST}/admin/api/metrics", payload=METRICS)
    fake.add("GET", f"{HOST}/admin/api/tools", payload=TOOLS)
    fake.add("GET", SESSIONS_URL, payload=SESSIONS)
    fake.add("GET", f"{BASE}/models", payload=MODELS)
    fake.add("POST", f"{BASE}/chat/completions", payload=CHAT)


DEFAULT_CONFIG = {
    "nami_base_url": BASE,
    "nami_host_root": HOST,
    "nami_api_key": API_KEY,
    "nami_admin_token": ADMIN_TOKEN,
    "default_model": "",
    "request_timeout": 60,
    "system_prompt": "",
    "session_scope": "group",
    "enable_commands": True,
    "admin_only": False,
    "auto_reply_enabled": False,
    "auto_reply_trigger": "mention",
    "auto_reply_prefix": "/ai",
    "mention_keyword": "",
    "max_reply_chars": 1500,
}


def make_config(**overrides) -> AstrBotConfig:
    config = dict(DEFAULT_CONFIG)
    config.update(overrides)
    return AstrBotConfig(config)


def new_plugin(**overrides):
    """构造一个接好假网络的插件实例。"""
    fake = FakeNami()
    happy_routes(fake)
    main._http_json = fake
    context = Context()
    plugin = main.NamiPlugin(context, make_config(**overrides))
    return plugin, fake, context


# --------------------------------------------------------------------------- #
# 4. 事件与调用辅助
# --------------------------------------------------------------------------- #


class PlainResult:
    """``event.plain_result`` 的返回值。"""

    def __init__(self, text: str) -> None:
        self.text = text

    def __repr__(self) -> str:  # pragma: no cover
        return f"PlainResult({self.text!r})"


class At:
    """消息链里的 @ 段。"""

    def __init__(self, qq: str) -> None:
        self.qq = qq


class Sender:
    def __init__(self, user_id: str) -> None:
        self.user_id = user_id


class MessageObj:
    def __init__(self, self_id="10000", group_id="", sender_id="12345", raw_message="", message=None):
        self.self_id = self_id
        self.group_id = group_id
        self.sender = Sender(sender_id)
        self.raw_message = raw_message
        self.message = message or []


class FakeEvent(AstrMessageEvent):
    """AstrMessageEvent 的可用替身。"""

    RAISE_ON_GROUP = "__raise__"

    def __init__(
        self,
        message_str: str = "",
        sender_id: str = "12345",
        group_id: str = "",
        self_id: str = "10000",
        raw_message: str = "",
        message=None,
        admin: bool = False,
    ) -> None:
        self.message_str = message_str
        # 私聊：group_id 为空串，同时 get_group_id() 会抛异常。
        self._raise_group = group_id == self.RAISE_ON_GROUP
        real_group = "" if self._raise_group else group_id
        self.message_obj = MessageObj(self_id, real_group, sender_id, raw_message, message)
        self.unified_msg_origin = f"umo:{real_group or 'private'}:{sender_id}"
        self.sent: list[PlainResult] = []
        self.stopped = False
        self._admin = admin

    # --- AstrBot 事件接口 ---

    def plain_result(self, text: str) -> PlainResult:
        return PlainResult(text)

    async def send(self, result: PlainResult) -> None:
        self.sent.append(result)

    def get_sender_name(self) -> str:
        return "测试用户"

    def get_sender_id(self) -> str:
        return self.message_obj.sender.user_id

    def get_group_id(self):
        if self._raise_group:
            raise ValueError("私聊下没有群号")  # noqa: TRY003
        return self.message_obj.group_id or None

    def get_self_id(self) -> str:
        return self.message_obj.self_id

    def is_admin(self) -> bool:
        return self._admin

    def stop_event(self) -> None:
        self.stopped = True


def run_handler(func, *args) -> list:
    """驱动一个异步处理器，收集它 yield 出来的所有结果。"""

    async def runner():
        result = func(*args)
        if hasattr(result, "__aiter__"):
            return [item async for item in result]
        return [await result]

    return asyncio.run(runner())


def run_coro(coro):
    return asyncio.run(coro)


def text_of(results: list) -> str:
    """把 yield 出来的结果拼成文本。"""
    return "\n".join(item.text for item in results if isinstance(item, PlainResult))


def subcommand(name: str):
    """取指令组子指令的处理器函数。"""
    return REGISTRY["handlers"][f"nami.{name}"]


def alias_for(name: str) -> set:
    return REGISTRY["groups"]["nami"].subs[name]["aliases"]


def run_sub(name: str, plugin, event: FakeEvent, *extra):
    return run_handler(subcommand(name), plugin, event, *extra)


# --------------------------------------------------------------------------- #
# 5. 极简 YAML 解析（只够读 metadata.yaml，避免依赖 PyYAML）
# --------------------------------------------------------------------------- #


def parse_metadata_yaml(text: str) -> dict:
    data: dict[str, object] = {}
    current_list: str | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        stripped = line.lstrip()
        if stripped.startswith("- ") and current_list:
            cast = data.get(current_list)
            if isinstance(cast, list):
                cast.append(_yaml_scalar(stripped[2:].strip()))
            continue
        if not line.startswith(" ") and ":" in line:
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip()
            if value == "":
                data[key] = []
                current_list = key
            else:
                data[key] = _yaml_scalar(value)
                current_list = None
    return data


def _yaml_scalar(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


# --------------------------------------------------------------------------- #
# 6. 各项测试
# --------------------------------------------------------------------------- #


def test_files() -> None:
    """文件清单与无需第三方依赖。"""
    expected = [
        "main.py",
        "metadata.yaml",
        "_conf_schema.json",
        "requirements.txt",
        "README.md",
        "logo.png",
        ".astrbot-plugin/i18n/zh-CN.json",
        ".astrbot-plugin/i18n/en-US.json",
        "pages/nami/index.html",
        "pages/nami/app.js",
        "pages/nami/style.css",
    ]
    for relative in expected:
        check((PLUGIN_DIR / relative).is_file(), f"文件存在：{relative}")

    requirements = (PLUGIN_DIR / "requirements.txt").read_text(encoding="utf-8")
    active = [ln for ln in requirements.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    check_eq(active, [], "requirements.txt 没有声明任何第三方依赖")

    readme = (PLUGIN_DIR / "README.md").read_text(encoding="utf-8")
    check_in("npm start", readme, "README 覆盖连通性排查")
    check_in("NAMI_MODELS_EXPOSE", readme, "README 覆盖模型白名单")
    check_in("npm run ollama -- --write", readme, "README 覆盖无可用模型的处置")
    check_in("token", readme, "README 提到 token 成本")

    # logo.png：直接读 IHDR，避免依赖 Pillow。
    blob = (PLUGIN_DIR / "logo.png").read_bytes()
    check(blob[:8] == b"\x89PNG\r\n\x1a\n", "logo.png 是合法 PNG")
    width = int.from_bytes(blob[16:20], "big")
    height = int.from_bytes(blob[20:24], "big")
    check_eq((width, height), (256, 256), "logo.png 尺寸为 256x256")

    for locale in ("zh-CN", "en-US"):
        raw = (PLUGIN_DIR / f".astrbot-plugin/i18n/{locale}.json").read_text(encoding="utf-8")
        try:
            data = json.loads(raw)
        except ValueError as exc:
            check(False, f"i18n {locale} 是合法 JSON（{exc}）")
            continue
        check(True, f"i18n {locale} 是合法 JSON")
        check("metadata" in data, f"i18n {locale} 含 metadata")
        check("config" in data, f"i18n {locale} 含 config")
        check("pages" in data and "nami" in data["pages"], f"i18n {locale} 含 pages.nami")


def test_metadata() -> None:
    """metadata.yaml 的字段约束。"""
    raw = (PLUGIN_DIR / "metadata.yaml").read_text(encoding="utf-8")
    meta = parse_metadata_yaml(raw)
    check(bool(meta), "metadata.yaml 可被解析")
    check_eq(meta.get("name"), "astrbot_plugin_nami", "metadata.name 正确")
    check(bool(meta.get("display_name")), "metadata.display_name 非空")
    check(bool(meta.get("desc")), "metadata.desc 非空")
    check(bool(meta.get("short_desc")), "metadata.short_desc 非空")
    check(bool(meta.get("version")), "metadata.version 非空")
    check(bool(re.match(r"^\d+\.\d+\.\d+$", str(meta.get("version", "")))), "metadata.version 是语义化版本")
    check(bool(meta.get("author")), "metadata.author 非空")
    # repo 在 AstrBot 里是可选的（只在插件详情页做跳转链接）。断言「若存在则必须是
    # URL」，而不是强制要求存在 —— 否则一个没填仓库地址的合法插件会被判失败。
    repo = meta.get("repo")
    check(repo is None or str(repo).startswith("http"), "metadata.repo 若存在则是 URL")

    version_range = str(meta.get("astrbot_version", ""))
    check(bool(version_range), "metadata.astrbot_version 非空")
    check_not_in("v", version_range, "metadata.astrbot_version 没有 v 前缀")
    check(version_range.startswith(">="), "metadata.astrbot_version 是 PEP 440 下界")
    check("<5" in version_range, "metadata.astrbot_version 限定 <5")

    platforms = meta.get("support_platforms")
    check(isinstance(platforms, list) and len(platforms) > 0, "metadata.support_platforms 是非空列表")
    check("aiocqhttp" in (platforms or []), "metadata.support_platforms 含 aiocqhttp")


def test_schema() -> None:
    """_conf_schema.json 的键、类型与默认值。"""
    schema = json.loads((PLUGIN_DIR / "_conf_schema.json").read_text(encoding="utf-8"))
    check(isinstance(schema, dict) and bool(schema), "_conf_schema.json 是 JSON 对象")

    required = {
        "nami_base_url",
        "nami_host_root",
        "nami_api_key",
        "nami_admin_token",
        "default_model",
        "request_timeout",
        "system_prompt",
        "session_scope",
        "enable_commands",
        "admin_only",
        "auto_reply_enabled",
        "auto_reply_trigger",
        "auto_reply_prefix",
        "mention_keyword",
        "max_reply_chars",
    }
    check_eq(set(schema) , required, "配置键与需求完全一致")

    allowed_types = {"string", "text", "int", "float", "bool", "object", "list", "dict", "file"}
    for key, entry in schema.items():
        check("type" in entry, f"{key} 有 type")
        check("default" in entry, f"{key} 有 default")
        check(entry.get("type") in allowed_types, f"{key} 的 type 合法（{entry.get('type')}）")
        check(bool(entry.get("description")), f"{key} 有 description")

    check_eq(schema["nami_api_key"].get("secret"), True, "nami_api_key 标记 secret")
    check_eq(schema["nami_admin_token"].get("secret"), True, "nami_admin_token 标记 secret")
    check_eq(schema["nami_api_key"].get("type"), "string", "nami_api_key 是 string")
    check_in("/v1", str(schema["nami_base_url"].get("default")), "nami_base_url 默认值带 /v1")
    check_in("/v1", str(schema["nami_base_url"].get("hint")), "nami_base_url 的 hint 说明 /v1 很重要")
    check(
        not str(schema["nami_host_root"].get("default")).rstrip("/").endswith("/v1"),
        "nami_host_root 默认值不带 /v1",
    )
    check_in("/v1", str(schema["nami_host_root"].get("hint")), "nami_host_root 的 hint 警告不要带 /v1")
    check_eq(schema["session_scope"].get("default"), "group", "session_scope 默认 group")
    check_eq(
        schema["session_scope"].get("options"),
        ["user", "group", "global"],
        "session_scope 选项为 user/group/global",
    )
    check_eq(schema["auto_reply_enabled"].get("default"), False, "auto_reply_enabled 默认关闭")
    check_eq(schema["auto_reply_trigger"].get("default"), "mention", "auto_reply_trigger 默认 mention")
    check_eq(
        schema["auto_reply_trigger"].get("options"),
        ["mention", "prefix", "all"],
        "auto_reply_trigger 选项为 mention/prefix/all",
    )
    check_eq(schema["auto_reply_prefix"].get("default"), "/ai", "auto_reply_prefix 默认 /ai")
    check_eq(schema["mention_keyword"].get("default"), "", "mention_keyword 默认空")
    check_eq(schema["max_reply_chars"].get("default"), 1500, "max_reply_chars 默认 1500")
    check_eq(schema["request_timeout"].get("default"), 60, "request_timeout 默认 60")
    check_eq(schema["enable_commands"].get("default"), True, "enable_commands 默认开启")
    check_eq(schema["admin_only"].get("default"), False, "admin_only 默认关闭")
    check_eq(schema["default_model"].get("default"), "", "default_model 默认空")


def test_source_hygiene() -> None:
    """源码层面的约束：异步、无 requests、延迟导入 aiohttp。"""
    check_not_in("import requests", MAIN_SOURCE, "main.py 不 import requests")
    check_in("async def _http_json", MAIN_SOURCE, "网络出口是 async 函数")
    check_in("import aiohttp", MAIN_SOURCE, "使用 aiohttp 做异步 I/O")
    check(
        MAIN_SOURCE.index("import aiohttp") > MAIN_SOURCE.index("async def _http_json"),
        "aiohttp 在 _http_json 内部延迟导入（无该依赖也能 import 模块）",
    )
    check_in("async def terminate", MAIN_SOURCE, "实现了 terminate()")
    check_in("self.config = config", MAIN_SOURCE, "把 AstrBotConfig 保存在 self.config 上")
    check_in("context.register_web_api", MAIN_SOURCE, "用 context.register_web_api 注册页面接口")
    check_in("PLUGIN_NAME", MAIN_SOURCE, "路由前缀来自模块常量 PLUGIN_NAME")


def test_registration() -> None:
    """指令组、子指令、事件监听与后端路由的注册情况。"""
    plugin, _fake, context = new_plugin()

    check("nami" in REGISTRY["groups"], "注册了 nami 指令组")
    group = REGISTRY["groups"]["nami"]
    check(len(group.subs) == 6, f"nami 指令组有 6 个子指令（实际 {len(group.subs)}）")
    for name in ("status", "models", "ask", "tools", "reset", "diag"):
        check(name in group.subs, f"注册了子指令 nami.{name}")

    check("状态" in alias_for("status"), "nami status 有中文别名 状态")
    check("模型" in alias_for("models"), "nami models 有中文别名 模型")
    check("问" in alias_for("ask"), "nami ask 有中文别名 问")
    check("工具" in alias_for("tools"), "nami tools 有中文别名 工具")
    check("重置" in alias_for("reset"), "nami reset 有中文别名 重置")
    check("诊断" in alias_for("diag"), "nami diag 有中文别名 诊断")

    events = REGISTRY["events"]
    check_eq(len(events), 1, "只注册了一个事件监听器")
    check_eq(events[0]["type"], EventMessageType.ALL, "监听器监听 EventMessageType.ALL")
    check(events[0]["priority"] > 0, f"监听器优先级低于常规（priority={events[0]['priority']}）")
    check_eq(events[0]["name"], "on_auto_reply", "监听器函数名为 on_auto_reply")

    routes = context.routes
    check_eq(len(routes), 6, "注册了 6 条后端路由")
    for entry in routes:
        check(
            entry["route"].startswith(f"/{main.PLUGIN_NAME}/"),
            f"路由 {entry['route']} 带插件名前缀",
        )
        check("\\" not in entry["route"], f"路由 {entry['route']} 不含反斜杠")
        check("://" not in entry["route"], f"路由 {entry['route']} 不含 URL scheme")
        check(".." not in entry["route"], f"路由 {entry['route']} 不含 ..")

    paths = {entry["route"] for entry in routes}
    for suffix in ("status", "models", "tools", "sessions", "sessions/delete", "ask"):
        check_in(f"/{main.PLUGIN_NAME}/{suffix}", " ".join(sorted(paths)) + " ", f"注册了路由 {suffix}")

    delete_route = next(e for e in routes if e["route"].endswith("/sessions/delete"))
    check("POST" in delete_route["methods"], "sessions/delete 支持 POST")
    check("DELETE" in delete_route["methods"], "sessions/delete 支持 DELETE")
    status_route = next(e for e in routes if e["route"].endswith("/status"))
    check_eq(status_route["methods"], ["GET"], "status 路由只允许 GET")
    ask_route = next(e for e in routes if e["route"].endswith("/ask"))
    check_eq(ask_route["methods"], ["POST"], "ask 路由只允许 POST")


def test_status_command() -> None:
    """/nami 状态。"""
    plugin, fake, _ = new_plugin()
    event = FakeEvent(message_str="/nami 状态", group_id="g1")
    text = text_of(run_sub("status", plugin, event))

    check_eq(len(fake.calls_to("GET", f"{HOST}/healthz")), 1, "状态指令调用了 GET /healthz")
    check_eq(len(fake.calls_to("GET", f"{HOST}/readyz")), 1, "状态指令调用了 GET /readyz")
    health_call = fake.calls_to("GET", f"{HOST}/healthz")[0]
    check_eq(health_call["headers"].get("Authorization"), f"Bearer {API_KEY}", "healthz 带 Bearer 头")
    check_in("ollama", text, "状态输出包含 provider")
    check_in("qwen2.5:7b", text, "状态输出包含模型名")
    check_in("1.0.0", text, "状态输出包含版本")
    check_in("2 分 5 秒", text, "状态输出包含可读的运行时长")
    check_in("database: ok", text, "状态输出列出就绪检查项")
    check_in("v24.13.1", text, "状态输出包含 Node 版本")

    # 私聊：get_group_id 抛异常也必须被兜住
    private_plugin, private_fake, _ = new_plugin()
    private_event = FakeEvent(message_str="/nami 状态", group_id=FakeEvent.RAISE_ON_GROUP)
    private_text = text_of(run_sub("status", private_plugin, private_event))
    check_eq(len(private_fake.calls_to("GET", f"{HOST}/healthz")), 1, "私聊下状态指令仍能工作")
    check_in("qwen2.5:7b", private_text, "私聊下状态输出正常")

    # 连通性失败
    broken_plugin, broken_fake, _ = new_plugin()
    broken_fake.routes.pop(("GET", f"{HOST}/healthz"))
    broken_event = FakeEvent(message_str="/nami 状态")
    broken_text = text_of(run_sub("status", broken_plugin, broken_event))
    check_in("不可用", broken_text, "healthz 失败时打印不可用")
    check_in("npm start", broken_text, "healthz 失败时给出 npm start 建议")

    # 未就绪
    notready_plugin, notready_fake, _ = new_plugin()
    notready_fake.add("GET", f"{HOST}/readyz", status=503, payload=READMEY_READY)
    notready_text = text_of(run_sub("status", notready_plugin, FakeEvent(message_str="/nami 状态")))
    check_in("未就绪", notready_text, "readyz 为 false 时打印未就绪")
    check_in("none selected", notready_text, "打印 checks.model 的原始值")
    check_in("npm run ollama -- --write", notready_text, "无可用模型时给出 ollama 处置建议")


def test_models_command() -> None:
    """/nami 模型 与列表截断。"""
    plugin, fake, _ = new_plugin()
    text = text_of(run_sub("models", plugin, FakeEvent(message_str="/nami 模型")))

    check_eq(len(fake.calls_to("GET", f"{BASE}/models")), 1, "模型指令调用了 GET /v1/models")
    models_call = fake.calls_to("GET", f"{BASE}/models")[0]
    check_eq(models_call["headers"].get("Authorization"), f"Bearer {API_KEY}", "models 请求带 Bearer 头")
    check_in("qwen2.5:7b", text, "输出包含真实模型 id")
    check_in("别名 → qwen2.5:7b", text, "别名条目标注 aliasOf")
    check_in("参数 7.6B", text, "输出包含 nami.parameters")
    check_in("量化 Q4_K_M", text, "输出包含 nami.quantization")
    check_in("共 2 个", text, "输出包含模型总数")
    check_not_in("还有", text, "未超限时不显示截断尾巴")

    # 长列表截断
    long_plugin, long_fake, _ = new_plugin()
    long_models = {
        "object": "list",
        "data": [{"id": f"model-{i}", "object": "model", "owned_by": "ollama"} for i in range(30)],
    }
    long_fake.add("GET", f"{BASE}/models", payload=long_models)
    long_text = text_of(run_sub("models", long_plugin, FakeEvent(message_str="/nami 模型")))
    check_in("展示前 25 个", long_text, "长列表只展示前 25 条")
    check_in("还有 5 个未显示", long_text, "长列表给出剩余数量")
    check_in("model-24", long_text, "第 25 条（下标 24）被渲染")
    check_not_in("model-25", long_text, "第 26 条被截掉")

    # 空列表
    empty_plugin, empty_fake, _ = new_plugin()
    empty_fake.add("GET", f"{BASE}/models", payload={"object": "list", "data": []})
    empty_text = text_of(run_sub("models", empty_plugin, FakeEvent(message_str="/nami 模型")))
    check_in("没有返回任何模型", empty_text, "空模型列表有明确提示")


def test_ask_command() -> None:
    """/nami 问：请求体、会话头、三种作用域。"""
    plugin, fake, _ = new_plugin(session_scope="group")
    event = FakeEvent(message_str="/nami 问 你好 世界", group_id="g1", sender_id="12345")
    text = text_of(run_sub("ask", plugin, event))

    calls = fake.calls_to("POST", f"{BASE}/chat/completions")
    check_eq(len(calls), 1, "提问调用了 POST /v1/chat/completions")
    call = calls[0]
    check_eq(call["method"], "POST", "提问使用 POST")
    check_eq(call["headers"].get("Authorization"), f"Bearer {API_KEY}", "提问带 Authorization Bearer")
    check_eq(call["headers"].get("X-Nami-Session"), "astrbot:group:g1", "group 作用域会话头正确")
    check_eq(call["headers"].get("Content-Type"), "application/json", "提问声明 JSON Content-Type")
    body = call["json"]
    check_eq(body.get("stream"), False, "提问使用非流式请求（stream=false）")
    check_eq(body["messages"][-1], {"role": "user", "content": "你好 世界"}, "多词问题完整传给 Nami")
    check("model" not in body, "default_model 为空时不发送 model 字段")
    check_in("你好呀", text, "回复包含助手内容")
    check_in("astrbot:group:g1", text, "回复里带出会话 id")
    check_in("qwen2.5:7b", text, "回复里带出模型名")

    # user 作用域
    user_plugin, user_fake, _ = new_plugin(session_scope="user")
    user_event = FakeEvent(message_str="/nami 问 hi", group_id="g1", sender_id="777")
    run_sub("ask", user_plugin, user_event)
    check_eq(
        user_fake.last()["headers"].get("X-Nami-Session"),
        "astrbot:user:777",
        "user 作用域会话头为 astrbot:user:<sender_id>",
    )

    # global 作用域
    global_plugin, global_fake, _ = new_plugin(session_scope="global")
    run_sub("ask", global_plugin, FakeEvent(message_str="/nami 问 hi", group_id="g1", sender_id="777"))
    check_eq(
        global_fake.last()["headers"].get("X-Nami-Session"),
        "astrbot:global",
        "global 作用域会话头为 astrbot:global",
    )

    # group 作用域 + 私聊 -> 回退到 user
    fallback_plugin, fallback_fake, _ = new_plugin(session_scope="group")
    run_sub(
        "ask",
        fallback_plugin,
        FakeEvent(message_str="/nami 问 hi", group_id=FakeEvent.RAISE_ON_GROUP, sender_id="888"),
    )
    check_eq(
        fallback_fake.last()["headers"].get("X-Nami-Session"),
        "astrbot:user:888",
        "私聊时 group 作用域回退到 user",
    )

    # 配置了 default_model 与 system_prompt
    rich_plugin, rich_fake, _ = new_plugin(default_model="gpt-4o-mini", system_prompt="你是娜美")
    run_sub("ask", rich_plugin, FakeEvent(message_str="/nami 问 hi", group_id="g2"))
    rich_body = rich_fake.last()["json"]
    check_eq(rich_body.get("model"), "gpt-4o-mini", "配置了 default_model 时请求体带上 model")
    check_eq(rich_body["messages"][0], {"role": "system", "content": "你是娜美"}, "system_prompt 作为首条消息")

    # prompt 通过函数参数传入（框架已剥离指令前缀）
    param_plugin, param_fake, _ = new_plugin()
    param_text = text_of(run_sub("ask", param_plugin, FakeEvent(message_str=""), "直接传参"))
    check_eq(param_fake.last()["json"]["messages"][-1]["content"], "直接传参", "支持通过参数传入问题")
    check_in("你好呀", param_text, "参数路径同样返回回答")

    # 空问题
    empty_plugin, empty_fake, _ = new_plugin()
    empty_text = text_of(run_sub("ask", empty_plugin, FakeEvent(message_str="/nami 问")))
    check_in("用法：/nami 问", empty_text, "空问题给出用法提示")
    check_eq(len(empty_fake.calls_to("POST", f"{BASE}/chat/completions")), 0, "空问题不发起请求")

    # 截断
    long_plugin, long_fake, _ = new_plugin(max_reply_chars=20)
    long_fake.add(
        "POST",
        f"{BASE}/chat/completions",
        payload={
            "model": "qwen2.5:7b",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "字" * 200}}],
        },
    )
    long_text = text_of(run_sub("ask", long_plugin, FakeEvent(message_str="/nami 问 长回答", group_id="g3")))
    check_in("已截断", long_text, "超长回复被截断")
    check(len(long_text) < 200, f"截断后总长度受控（{len(long_text)}）")


def test_session_memory() -> None:
    """会话记忆与 /nami 重置。"""
    plugin, fake, _ = new_plugin(session_scope="group")
    event = FakeEvent(message_str="/nami 问 第一次", group_id="g9")
    run_sub("ask", plugin, event)
    first = fake.last()["headers"].get("X-Nami-Session")
    check_eq(first, "astrbot:group:g9", "首轮使用推导出的会话 id")

    run_sub("ask", plugin, FakeEvent(message_str="/nami 问 第二次", group_id="g9"))
    second = fake.last()["headers"].get("X-Nami-Session")
    check_eq(second, first, "后续轮次复用同一个会话 id")

    # 服务端回传 session_id 时应被记住
    assigned_plugin, assigned_fake, _ = new_plugin(session_scope="group")
    assigned_fake.add(
        "POST",
        f"{BASE}/chat/completions",
        payload={
            "model": "qwen2.5:7b",
            "session_id": "sess_server_assigned",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}}],
        },
    )
    run_sub("ask", assigned_plugin, FakeEvent(message_str="/nami 问 a", group_id="gA"))
    check_eq(
        assigned_plugin._session_id("astrbot:group:gA"),
        "sess_server_assigned",
        "记住服务端分配/回传的会话 id",
    )
    run_sub("ask", assigned_plugin, FakeEvent(message_str="/nami 问 b", group_id="gA"))
    check_eq(
        assigned_fake.last()["headers"].get("X-Nami-Session"),
        "sess_server_assigned",
        "下一轮使用服务端分配的会话 id",
    )

    # 重置
    reset_text = text_of(run_sub("reset", assigned_plugin, FakeEvent(message_str="/nami 重置", group_id="gA")))
    check_in("原会话 id: sess_server_assigned", reset_text, "重置时报告原会话 id")
    check_eq(
        assigned_plugin._session_id("astrbot:group:gA"),
        "astrbot:group:gA",
        "重置后回到推导出的默认会话 id",
    )
    run_sub("ask", assigned_plugin, FakeEvent(message_str="/nami 问 c", group_id="gA"))
    check_eq(
        assigned_fake.last()["headers"].get("X-Nami-Session"),
        "astrbot:group:gA",
        "重置后下一轮开启新会话",
    )
    check_in("作用域: group", reset_text, "重置输出包含作用域")


def test_tools_command() -> None:
    """/nami 工具。"""
    plugin, fake, _ = new_plugin()
    text = text_of(run_sub("tools", plugin, FakeEvent(message_str="/nami 工具")))

    calls = fake.calls_to("GET", f"{HOST}/admin/api/tools")
    check_eq(len(calls), 1, "工具指令调用了 GET /admin/api/tools")
    check_eq(calls[0]["headers"].get("X-Admin-Token"), ADMIN_TOKEN, "管理接口带 X-Admin-Token")
    check_eq(calls[0]["headers"].get("Authorization"), f"Bearer {API_KEY}", "管理接口同时带 Bearer")
    check_in("calc", text, "输出包含工具名")
    check_in("危险等级 安全", text, "渲染 safe 等级")
    check_in("危险等级 危险", text, "渲染 dangerous 等级")
    check_in("危险等级 需注意", text, "渲染 caution 等级")
    check_in("启用 2/3", text, "统计启用数量")
    check_in("未实现", text, "标注未实现的工具")


def test_diag_command() -> None:
    """/nami 诊断 的成功与各类失败路径。"""
    plugin, fake, _ = new_plugin()
    text = text_of(run_sub("diag", plugin, FakeEvent(message_str="/nami 诊断", group_id="g1")))
    for step in ("[1/5]", "[2/5]", "[3/5]", "[4/5]", "[5/5]"):
        check_in(step, text, f"诊断输出包含步骤 {step}")
    check_in("配置检查: ✓", text, "步骤 1 通过")
    check_in("/healthz 连通性: ✓", text, "步骤 2 通过")
    check_in("/readyz 就绪: ✓", text, "步骤 3 通过")
    check_in("/v1/models: ✓", text, "步骤 4 通过")
    check_in("对话探测: ✓", text, "步骤 5 通过")
    check_in("结论: 全部通过", text, "诊断给出通过结论")
    check_eq(len(fake.calls_to("POST", f"{BASE}/chat/completions")), 1, "诊断会做一次对话探测")
    probe = fake.calls_to("POST", f"{BASE}/chat/completions")[0]
    check_eq(probe["json"]["messages"][-1]["content"], "ping", "探测请求内容为 ping")

    # 缺少 api key
    nokey_plugin, _nokey_fake, _ = new_plugin(nami_api_key="")
    nokey_text = text_of(run_sub("diag", nokey_plugin, FakeEvent(message_str="/nami 诊断")))
    check_in("api key: 未配置", nokey_text, "诊断指出缺少 api key")
    check_in("没填 nami_api_key", nokey_text, "缺少 api key 时给出对应建议")
    check_in("[1/5] 配置检查: ✗", nokey_text, "缺配置时步骤 1 标红")

    # 连接被拒
    down_plugin, down_fake, _ = new_plugin()
    down_fake.routes.clear()
    down_text = text_of(run_sub("diag", down_plugin, FakeEvent(message_str="/nami 诊断")))
    check_in("npm start", down_text, "连接被拒时给出 npm start 建议")
    check_in("后续步骤已跳过", down_text, "连通性失败后跳过后续步骤")

    # /readyz 未就绪
    nr_plugin, nr_fake, _ = new_plugin()
    nr_fake.add("GET", f"{HOST}/readyz", status=503, payload=READMEY_READY)
    nr_text = text_of(run_sub("diag", nr_plugin, FakeEvent(message_str="/nami 诊断")))
    check_in("[3/5] /readyz 就绪: ✗", nr_text, "未就绪时步骤 3 标红")
    check_in("npm run ollama -- --write", nr_text, "model=none selected 时给出处置建议")

    # 未知模型（404 model_not_found）
    um_plugin, um_fake, _ = new_plugin(default_model="不存在:1b")
    um_fake.add_error("POST", f"{BASE}/chat/completions", "model_not_found", status=404)
    um_text = text_of(run_sub("diag", um_plugin, FakeEvent(message_str="/nami 诊断")))
    check_in("模型名不存在，用 /nami 模型 查", um_text, "404 model_not_found 映射到正确建议")

    # 401 invalid_api_key
    bad_plugin, bad_fake, _ = new_plugin()
    bad_fake.add_error("GET", f"{HOST}/healthz", "invalid_api_key", status=401)
    bad_text = text_of(run_sub("diag", bad_plugin, FakeEvent(message_str="/nami 诊断")))
    check_in("key 不匹配 NAMI_API_KEYS", bad_text, "401 invalid_api_key 映射到正确建议")

    # 403 管理接口
    admin_plugin, admin_fake, _ = new_plugin()
    admin_fake.add_error("GET", f"{HOST}/admin/api/tools", "admin_required", status=403)
    admin_text = text_of(run_sub("tools", admin_plugin, FakeEvent(message_str="/nami 工具")))
    check_in("管理接口需要 nami_admin_token", admin_text, "403 admin_required 映射到正确建议")

    # 403 model_not_allowed
    na_plugin, na_fake, _ = new_plugin(default_model="gpt-4o")
    na_fake.add_error("POST", f"{BASE}/chat/completions", "model_not_allowed", status=403)
    na_text = text_of(run_sub("ask", na_plugin, FakeEvent(message_str="/nami 问 hi")))
    check_in("NAMI_MODELS_EXPOSE", na_text, "403 model_not_allowed 映射到正确建议")

    # 429 限流
    rl_plugin, rl_fake, _ = new_plugin()
    rl_fake.add_error("POST", f"{BASE}/chat/completions", "rate_limited", status=429)
    rl_text = text_of(run_sub("ask", rl_plugin, FakeEvent(message_str="/nami 问 hi")))
    check_in("NAMI_RATE_LIMIT_BURST", rl_text, "429 rate_limited 映射到正确建议")

    # 401 missing_api_key
    mk_plugin, mk_fake, _ = new_plugin()
    mk_fake.add_error("GET", f"{BASE}/models", "missing_api_key", status=401)
    mk_text = text_of(run_sub("models", mk_plugin, FakeEvent(message_str="/nami 模型")))
    check_in("没填 nami_api_key", mk_text, "401 missing_api_key 映射到正确建议")

    # 错误映射表本身
    codes = ["connection_refused", "missing_api_key", "invalid_api_key", "admin_required",
             "model_not_found", "model_not_allowed", "rate_limited"]
    mapped = [c for c in codes if main.guidance_for(c) and main.guidance_for(c) != main.ERROR_GUIDANCE.get("__missing__")]
    check_eq(len(mapped), len(codes), "至少 7 个错误码都有专属处置建议")
    distinct = {main.guidance_for(c) for c in codes}
    check_eq(len(distinct), len(codes), "错误码映射到互不相同的建议文案")
    check(main.guidance_for("某个没见过的码").startswith("请查看"), "未知错误码有兜底文案")


def test_plain_text() -> None:
    """指令输出必须是纯文本，不能出现 Markdown 加粗或代码块。"""
    plugin, fake, _ = new_plugin()
    outputs = [
        text_of(run_sub("status", plugin, FakeEvent(message_str="/nami 状态", group_id="g1"))),
        text_of(run_sub("models", plugin, FakeEvent(message_str="/nami 模型"))),
        text_of(run_sub("ask", plugin, FakeEvent(message_str="/nami 问 hi", group_id="g1"))),
        text_of(run_sub("tools", plugin, FakeEvent(message_str="/nami 工具"))),
        text_of(run_sub("reset", plugin, FakeEvent(message_str="/nami 重置", group_id="g1"))),
        text_of(run_sub("diag", plugin, FakeEvent(message_str="/nami 诊断", group_id="g1"))),
    ]
    for index, output in enumerate(outputs):
        check_not_in("**", output, f"输出 {index + 1} 没有 ** 加粗")
        check_not_in("```", output, f"输出 {index + 1} 没有代码块围栏")
        check(bool(output.strip()), f"输出 {index + 1} 非空")
    # 失败路径同样是纯文本
    down_plugin, down_fake, _ = new_plugin()
    down_fake.routes.clear()
    failed = text_of(run_sub("status", down_plugin, FakeEvent(message_str="/nami 状态")))
    check_not_in("**", failed, "失败输出没有 Markdown")
    check_not_in("```", failed, "失败输出没有代码块")


def test_enable_and_admin_gates() -> None:
    """enable_commands 与 admin_only 开关。"""
    off_plugin, off_fake, _ = new_plugin(enable_commands=False)
    off_text = text_of(run_sub("status", off_plugin, FakeEvent(message_str="/nami 状态")))
    check_in("enable_commands", off_text, "关闭指令时给出提示")
    check_eq(len(off_fake.calls), 0, "关闭指令时不发起任何请求")

    locked_plugin, locked_fake, _ = new_plugin(admin_only=True)
    member_text = text_of(run_sub("status", locked_plugin, FakeEvent(message_str="/nami 状态", admin=False)))
    check_in("仅管理员", member_text, "非管理员被拒绝")
    check_eq(len(locked_fake.calls), 0, "非管理员不发起请求")

    admin_text = text_of(run_sub("status", locked_plugin, FakeEvent(message_str="/nami 状态", admin=True)))
    check_in("qwen2.5:7b", admin_text, "管理员可以正常使用")


def test_auto_reply() -> None:
    """自动回复监听的触发条件与安全护栏。"""
    listener = REGISTRY["events"][0]["func"]

    # 默认关闭
    plugin, fake, _ = new_plugin()
    event = FakeEvent(message_str="你好", group_id="g1", raw_message="[CQ:at,qq=10000] 你好")
    run_handler(listener, plugin, event)
    check_eq(event.sent, [], "默认关闭时不回复")
    check_eq(len(fake.calls), 0, "默认关闭时不请求 Nami")

    # mention：CQ 码里的 self_id
    plugin, fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="mention")
    event = FakeEvent(message_str="[CQ:at,qq=10000] 你好", group_id="g1", raw_message="[CQ:at,qq=10000] 你好")
    run_handler(listener, plugin, event)
    check_eq(len(event.sent), 1, "被 @ 时回复一条消息")
    check_in("你好呀", event.sent[0].text if event.sent else "", "@ 触发时返回 Nami 的回答")
    check_eq(len(fake.calls_to("POST", f"{BASE}/chat/completions")), 1, "@ 触发时请求一次 Nami")
    check_eq(
        fake.last()["json"]["messages"][-1]["content"], "你好", "@ 片段被剥离，只把正文发给 Nami"
    )
    check(event.stopped, "@ 触发后调用 stop_event 阻止重复回答")

    # mention：消息链里的 At 段
    plugin, _fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="mention")
    event = FakeEvent(message_str="你好", group_id="g1", message=[At("10000")])
    run_handler(listener, plugin, event)
    check_eq(len(event.sent), 1, "消息链里的 @ 段也能触发")

    # mention：未提及
    plugin, _fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="mention")
    event = FakeEvent(message_str="普通消息", group_id="g1")
    run_handler(listener, plugin, event)
    check_eq(event.sent, [], "未被提及时不回复")

    # mention：关键词
    plugin, _fake, _ = new_plugin(
        auto_reply_enabled=True, auto_reply_trigger="mention", mention_keyword="娜美"
    )
    event = FakeEvent(message_str="娜美 你在吗", group_id="g1")
    run_handler(listener, plugin, event)
    check_eq(len(event.sent), 1, "命中 mention_keyword 时回复")
    check_eq(
        plugin._nami_sessions.get("astrbot:group:g1") is not None,
        True,
        "自动回复也会记住会话",
    )

    # prefix
    plugin, fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="prefix")
    event = FakeEvent(message_str="/ai 讲个笑话", group_id="g1")
    run_handler(listener, plugin, event)
    check_eq(len(event.sent), 1, "prefix 模式命中前缀时回复")
    check_eq(
        fake.last()["json"]["messages"][-1]["content"],
        "讲个笑话",
        "prefix 模式剥离前缀后再发给 Nami",
    )

    plugin, _fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="prefix")
    event = FakeEvent(message_str="随便说说", group_id="g1")
    run_handler(listener, plugin, event)
    check_eq(event.sent, [], "prefix 模式未命中前缀时不回复")

    # all
    plugin, _fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="all")
    event = FakeEvent(message_str="无论在说什么", group_id="g1")
    run_handler(listener, plugin, event)
    check_eq(len(event.sent), 1, "all 模式对所有非空消息回复")

    # 自己发的消息
    plugin, fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="all")
    event = FakeEvent(message_str="我是机器人", group_id="g1", sender_id="10000", self_id="10000")
    run_handler(listener, plugin, event)
    check_eq(event.sent, [], "跳过机器人自己发的消息")
    check_eq(len(fake.calls), 0, "跳过自己消息时不请求 Nami")

    # 空消息
    plugin, fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="all")
    event = FakeEvent(message_str="   ", group_id="g1")
    run_handler(listener, plugin, event)
    check_eq(event.sent, [], "跳过空消息")
    check_eq(len(fake.calls), 0, "空消息不请求 Nami")

    # /nami 指令本身
    plugin, fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="all")
    event = FakeEvent(message_str="/nami 状态", group_id="g1")
    run_handler(listener, plugin, event)
    check_eq(event.sent, [], "跳过 /nami 指令本身")

    # 截断
    plugin, fake, _ = new_plugin(
        auto_reply_enabled=True, auto_reply_trigger="all", max_reply_chars=10
    )
    fake.add(
        "POST",
        f"{BASE}/chat/completions",
        payload={"model": "m", "choices": [{"index": 0, "message": {"content": "字" * 100}}]},
    )
    event = FakeEvent(message_str="给我一段长文本", group_id="g1")
    run_handler(listener, plugin, event)
    check_eq(len(event.sent), 1, "长回答仍然回复一条")
    check_in("已截断", event.sent[0].text, "自动回复也按 max_reply_chars 截断")

    # 出错时也要给出可读提示
    plugin, fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="all")
    fake.routes.clear()
    event = FakeEvent(message_str="你好", group_id="g1")
    run_handler(listener, plugin, event)
    check_eq(len(event.sent), 1, "Nami 不可用时也回一条说明")
    check_in("npm start", event.sent[0].text if event.sent else "", "Nami 不可用时给出排查建议")

    # 私聊场景不会因为 get_group_id 抛异常而崩
    plugin, _fake, _ = new_plugin(auto_reply_enabled=True, auto_reply_trigger="all")
    event = FakeEvent(message_str="私聊一下", group_id=FakeEvent.RAISE_ON_GROUP, sender_id="555")
    run_handler(listener, plugin, event)
    check_eq(len(event.sent), 1, "私聊下自动回复正常")
    check_eq(
        plugin._nami_sessions.get("astrbot:user:555") is not None, True, "私聊下会话键回退到 user"
    )


def fake_calls_content(fake, needle: str) -> str:
    """从假 Nami 的调用记录里找出 content == needle 的那一条。"""
    for call in fake.calls:
        body = call.get("json") or {}
        messages = body.get("messages") or []
        if messages and messages[-1].get("content") == needle:
            return needle
    return ""


def test_page_routes() -> None:
    """页面后端路由：不泄露密钥、正确代理 Nami。"""
    plugin, fake, _ = new_plugin()
    request = REQUEST_STUB

    # --- status ---
    request.query = _Query()
    request._json = None
    response = run_coro(plugin.page_status())
    check_eq(response.kind, "json", "status 返回 JSON")
    payload = response.payload
    settings = payload["settings"]
    check_eq(settings["base_url"], BASE, "status 回显 base_url")
    check_eq(settings["api_key_configured"], True, "status 只回布尔 api_key_configured")
    check_eq(settings["admin_token_configured"], True, "status 只回布尔 admin_token_configured")
    check_eq(payload["health"]["ok"], True, "status 报告 healthz 正常")
    check_eq(payload["health"]["version"], "1.0.0", "status 带出版本")
    check_eq(payload["readiness"]["ready"], True, "status 报告就绪")
    check_eq(payload["provider"]["model"], "qwen2.5:7b", "status 带出模型")
    check_eq(payload["tools"]["enabled"], 8, "status 带出启用工具数")
    check_eq(payload["tools"]["total"], 11, "status 带出工具总数")
    check_eq(payload["sessions"]["total"], 2, "status 带出会话数")
    check_eq(payload["requests"]["total"], 77, "status 带出累计请求数")
    check_eq(payload["sessions"]["tracked_scopes"], 0, "status 带出插件记住的作用域数")
    check_eq(len(fake.calls_to("GET", f"{HOST}/admin/api/overview")), 1, "status 代理了 overview")
    check_eq(len(fake.calls_to("GET", f"{HOST}/admin/api/metrics")), 1, "status 代理了 metrics")

    # --- 密钥绝不外泄（序列化后整体检查）---
    serialized = json.dumps(payload, ensure_ascii=False)
    check_not_in(API_KEY, serialized, "status 响应不含 api key")
    check_not_in(ADMIN_TOKEN, serialized, "status 响应不含 admin token")

    # --- healthz 不可达时的红条数据 ---
    down_plugin, down_fake, _ = new_plugin()
    down_fake.routes.clear()
    down_payload = run_coro(down_plugin.page_status()).payload
    check_eq(down_payload["health"]["ok"], False, "healthz 不可达时 ok=false")
    check_eq(down_payload["health"]["error_code"], "connection_refused", "带上错误码供页面展示")
    # new_plugin 会把假网络换掉，这里换回来继续测同一个插件实例。
    main._http_json = fake

    # --- models ---
    models_payload = run_coro(plugin.page_models()).payload
    check_eq(models_payload["count"], 2, "models 路由返回 2 条")
    check_eq(models_payload["models"][0]["id"], "qwen2.5:7b", "models 路由返回 id")
    check_eq(models_payload["models"][0]["parameters"], "7.6B", "models 路由返回参数")
    check_eq(models_payload["models"][0]["quantization"], "Q4_K_M", "models 路由返回量化")
    check_eq(models_payload["models"][1]["alias_of"], "qwen2.5:7b", "models 路由返回别名指向")
    check_in("4.4GB", models_payload["models"][0]["size_human"], "models 路由格式化体积")
    check_not_in(API_KEY, json.dumps(models_payload, ensure_ascii=False), "models 响应不含 api key")

    # --- tools ---
    tools_payload = run_coro(plugin.page_tools()).payload
    check_eq(tools_payload["count"], 3, "tools 路由返回 3 条")
    check_eq(tools_payload["enabled"], 2, "tools 路由统计启用数")
    check_eq(tools_payload["tools"][1]["danger"], "dangerous", "tools 路由返回危险等级")
    check_not_in(API_KEY, json.dumps(tools_payload, ensure_ascii=False), "tools 响应不含 api key")

    # --- sessions ---
    request.query = _Query()
    sessions_payload = run_coro(plugin.page_sessions()).payload
    check_eq(sessions_payload["count"], 1, "sessions 路由返回 1 条")
    check_eq(sessions_payload["sessions"][0]["id"], "sess_a", "sessions 路由返回会话 id")
    check_eq(sessions_payload["sessions"][0]["message_count"], 4, "sessions 路由返回消息数")
    check_eq(len(fake.calls_to("GET", SESSIONS_URL)), 1, "sessions 路由带上 limit=50")
    check_not_in(API_KEY, json.dumps(sessions_payload, ensure_ascii=False), "sessions 响应不含 api key")

    # --- sessions/delete ---
    fake.add("DELETE", f"{HOST}/admin/api/sessions/sess_a", payload={"object": "session.deleted", "id": "sess_a", "deleted": True})
    request.query = _Query()
    request._json = {"id": "sess_a"}
    request.method = "POST"
    deleted = run_coro(plugin.page_session_delete())
    check_eq(deleted.kind, "json", "删除会话返回 JSON")
    check_eq(deleted.payload["deleted"], True, "删除会话返回 deleted=true")
    check_eq(len(fake.calls_to("DELETE", f"{HOST}/admin/api/sessions/sess_a")), 1, "删除走 DELETE 代理")
    delete_call = fake.calls_to("DELETE", f"{HOST}/admin/api/sessions/sess_a")[0]
    check_eq(delete_call["headers"].get("X-Admin-Token"), ADMIN_TOKEN, "删除会话带管理令牌")

    request._json = {}
    missing = run_coro(plugin.page_session_delete())
    check_eq(missing.kind, "error", "缺少会话 id 时返回错误")
    check_eq(missing.status_code, 400, "缺少会话 id 返回 400")

    notfound_fake_plugin, nf_fake, _ = new_plugin()
    nf_fake.add_error("DELETE", f"{HOST}/admin/api/sessions/ghost", "session_not_found", status=404)
    request._json = {"id": "ghost"}
    nf_response = run_coro(notfound_fake_plugin.page_session_delete())
    check_eq(nf_response.status_code, 404, "会话不存在时透传 404")
    main._http_json = fake  # 换回主插件使用的假网络

    # --- ask ---
    request._json = {"prompt": "帮我查一下"}
    asked = run_coro(plugin.page_ask())
    check_eq(asked.kind, "json", "ask 返回 JSON")
    check_in("你好呀", asked.payload["answer"], "ask 返回回答")
    check_eq(asked.payload["session_id"], "astrbot:web", "ask 使用页面会话 id")
    ask_call = fake.calls_to("POST", f"{BASE}/chat/completions")[-1]
    check_eq(ask_call["headers"].get("X-Nami-Session"), "astrbot:web", "ask 带上 X-Nami-Session 头")
    check_not_in(API_KEY, json.dumps(asked.payload, ensure_ascii=False), "ask 响应不含 api key")

    request._json = {"prompt": "   "}
    empty = run_coro(plugin.page_ask())
    check_eq(empty.status_code, 400, "空问题返回 400")

    request._json = "不是对象"
    bad = run_coro(plugin.page_ask())
    check_eq(bad.status_code, 400, "非对象请求体返回 400")

    # 代理失败时返回可读错误
    proxy_plugin, proxy_fake, _ = new_plugin()
    proxy_fake.add_error("GET", f"{BASE}/models", "invalid_api_key", status=401)
    request._json = None
    proxy_error = run_coro(proxy_plugin.page_models())
    check_eq(proxy_error.kind, "error", "代理失败时返回 error_response")
    check_in("key 不匹配 NAMI_API_KEYS", proxy_error.message, "代理失败时附上处置建议")
    check_not_in(API_KEY, proxy_error.message, "错误信息不含 api key")

    # 所有页面响应拼在一起也不能出现密钥
    everything = json.dumps(
        [
            payload,
            models_payload,
            tools_payload,
            sessions_payload,
            deleted.payload,
            asked.payload,
        ],
        ensure_ascii=False,
    )
    check_not_in(API_KEY, everything, "全部页面响应合并后仍不含 api key")
    check_not_in(ADMIN_TOKEN, everything, "全部页面响应合并后仍不含 admin token")
    check_in(API_KEY, json.dumps(fake.calls[0]["headers"], ensure_ascii=False), "对照：密钥确实被发给了 Nami")


def test_page_assets() -> None:
    """页面静态资源与前端代码约束。"""
    html = (PLUGIN_DIR / "pages/nami/index.html").read_text(encoding="utf-8")
    app_js = (PLUGIN_DIR / "pages/nami/app.js").read_text(encoding="utf-8")
    style_css = (PLUGIN_DIR / "pages/nami/style.css").read_text(encoding="utf-8")

    check_in('href="./style.css"', html, "index.html 以相对路径引用 style.css")
    check_in('type="module"', html, "index.html 用 type=module 加载脚本")
    check_in('src="./app.js"', html, "index.html 以相对路径引用 app.js")

    refs = re.findall(r'(?:src|href)="([^"]+)"', html)
    check(len(refs) >= 2, "index.html 至少有两个资源引用")
    for ref in refs:
        check(ref.startswith("./"), f"资源引用 {ref} 是相对路径")
        check(not ref.startswith("/"), f"资源引用 {ref} 不是绝对路径")
        check("://" not in ref, f"资源引用 {ref} 不含 scheme")

    check_not_in("**", app_js.replace("**", "").replace("*", "*"), "……") if False else None
    check_in("window.AstrBotPluginPage", app_js, "app.js 使用 window.AstrBotPluginPage")
    check_in("await bridge.ready()", app_js, "app.js 调用 bridge.ready()")
    check_in("textContent", app_js, "app.js 用 textContent 写入服务端数据")
    check_not_in("innerHTML", app_js, "app.js 不使用 innerHTML（XSS 安全）")
    check_in("document.hidden", app_js, "app.js 在页面隐藏时暂停刷新")
    check_in("5000", app_js, "app.js 的刷新间隔是 5 秒")
    check_in("getContext", app_js, "app.js 读取 bridge 上下文")
    check_in("isDark", app_js, "app.js 读取 isDark 主题标记")
    check_in("data-theme", app_js + html, "app.js/HTML 使用 data-theme 切换主题")
    check_in("bridge.apiGet(", app_js, "app.js 使用 bridge.apiGet")
    check_in("bridge.apiPost(", app_js, "app.js 使用 bridge.apiPost")
    check_in("onContext", app_js, "app.js 订阅主题变化")

    endpoints = re.findall(r"bridge\.api(?:Get|Post)\(\s*[\"']([^\"']+)[\"']", app_js)
    check(len(endpoints) >= 5, f"app.js 调用了至少 5 个页面接口（实际 {len(endpoints)}）")
    for endpoint in endpoints:
        check(not endpoint.startswith("/"), f"页面接口 {endpoint} 没有前导斜杠")
        check("\\" not in endpoint, f"页面接口 {endpoint} 不含反斜杠")
        check("://" not in endpoint, f"页面接口 {endpoint} 不含 scheme")
        check("?" not in endpoint and "#" not in endpoint, f"页面接口 {endpoint} 不含 query/hash")
        check(".." not in endpoint.split("/"), f"页面接口 {endpoint} 不含 ..")
        check(
            f'"{endpoint}"' in app_js or f"'{endpoint}'" in app_js,
            f"页面接口 {endpoint} 在 JS 中以字符串常量出现",
        )

    expected_endpoints = {"status", "models", "tools", "sessions", "sessions/delete", "ask"}
    check_eq(set(endpoints), expected_endpoints, "页面调用的接口集合与需求一致")
    check_in("danger", app_js, "app.js 渲染危险等级")
    check_in("badge", style_css, "style.css 定义了徽章样式")


def main_entry() -> int:
    """跑完全部测试并按结果决定退出码。"""
    test_files()
    test_metadata()
    test_schema()
    test_source_hygiene()
    test_registration()
    test_status_command()
    test_models_command()
    test_ask_command()
    test_session_memory()
    test_tools_command()
    test_diag_command()
    test_plain_text()
    test_enable_and_admin_gates()
    test_auto_reply()
    test_page_routes()
    test_page_assets()

    failures = [(ok, label) for ok, label in CHECKS if not ok]
    if failures:
        print(f"✗ {len(failures)} / {len(CHECKS)} 项断言失败：")
        for _ok, label in failures:
            print(f"  - {label}")
        return 1
    print(f"✓ 全部通过 {len(CHECKS)} 项断言")
    return 0


if __name__ == "__main__":
    sys.exit(main_entry())
