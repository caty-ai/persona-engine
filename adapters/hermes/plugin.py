"""Hermes plugin entry point for persona-engine v2."""

from __future__ import annotations

import builtins
import copy
import json
import logging
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Mapping, MutableMapping, NamedTuple

from .runtime import VERSION, report_adapter_error, resolve_route_context, set, turn

TOOL_NAME = "persona_set"
TOOLSET_NAME = "persona-engine"
_TURN_CACHE_LIMIT = 1024
_SESSION_CACHE_LIMIT = 256
_BLOCK_MESSAGE = "persona_set is unavailable on this route"


class _CacheEntry(NamedTuple):
    kind: str
    result: dict[str, Any]
    route_ctx: dict[str, str]
    tool_allowed: bool


def _field(value: Any, name: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(name)
    return getattr(value, name, None)


def _warn_host(host: Any, message: str) -> None:
    try:
        logger = _field(host, "logger") or _field(host, "log")
        warning = _field(logger, "warning") or _field(logger, "warn")
        if callable(warning):
            warning(message)
            return
    except Exception:
        pass
    logging.getLogger(__name__).warning(message)


def _route_ctx(context: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for key in ("platform", "session_id"):
        value = _field(context, key)
        if not isinstance(value, str) or not value:
            return {}
        result[key] = value
    api_mode = _field(context, "api_mode")
    if isinstance(api_mode, str) and api_mode:
        result["api_mode"] = api_mode
    session_key = _field(context, "session_key")
    if isinstance(session_key, str) and session_key:
        result["session_key"] = session_key
    return result


def _text_parts(content: Any, *, allow_string: bool = True) -> str | None:
    if allow_string and isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for part in content:
        if not isinstance(part, Mapping):
            continue
        part_type = part.get("type")
        text = part.get("text")
        if part_type in {"text", "input_text"} and isinstance(text, str):
            parts.append(text)
    return "".join(parts) if parts else None


def _strip_host_decoration(utterance: str | None) -> str | None:
    if utterance is None:
        return None
    marker = "\n\n<memory-context>"
    if marker in utterance:
        return utterance.split(marker, 1)[0]
    return utterance


def extract_utterance(payload: Mapping[str, Any], api_mode: str | None) -> str | None:
    """Extract only the current user utterance allowed by SPEC §10."""
    messages = payload.get("messages")
    if isinstance(messages, list):
        for message in reversed(messages):
            if isinstance(message, Mapping) and message.get("role") == "user":
                return _strip_host_decoration(_text_parts(message.get("content")))
        return None

    value = payload.get("input")
    if isinstance(value, (str, list)):
        if isinstance(value, str):
            return _strip_host_decoration(value)
        for item in reversed(value):
            item_type = item.get("type") if isinstance(item, Mapping) else None
            if not (
                isinstance(item, Mapping)
                and item.get("role") == "user"
                and (item_type is None or item_type == "message")
            ):
                continue
            content = item.get("content")
            utterance = content if isinstance(content, str) else _text_parts(content, allow_string=False)
            return _strip_host_decoration(utterance)
        return None
    return None


def _is_persona_tool(tool: Any) -> bool:
    if not isinstance(tool, Mapping):
        return False
    if tool.get("name") == TOOL_NAME:
        return True
    function = tool.get("function")
    return isinstance(function, Mapping) and function.get("name") == TOOL_NAME


def _inject(payload: MutableMapping[str, Any], api_mode: str | None, block: str) -> None:
    messages = payload.get("messages")
    if isinstance(messages, list):
        payload["messages"] = [{"role": "system", "content": block}, *messages]
        return
    if isinstance(payload.get("input"), (str, list)):
        instructions = payload.get("instructions")
        payload["instructions"] = f"{instructions}\n\n{block}" if isinstance(instructions, str) and instructions else block
        return
    raise TypeError("chat request messages must be a list")


class HermesAdapter:
    def __init__(
        self, host: Any, install_root: str | os.PathLike[str] | None,
        sessions_file: str | os.PathLike[str] | None = None,
    ) -> None:
        self.host = host
        self.install_root = str(Path(install_root).expanduser()) if install_root else ""
        self.sessions_file = Path(sessions_file).expanduser() if sessions_file else None
        self.enabled = bool(self.install_root)
        self._turn_cache: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._session_cache: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._cache_generations: dict[tuple[str, str], int] = {}
        self._domain_keys: dict[str, set[tuple[str, str]]] = {}
        self._inflight_keys: dict[tuple[str, str], int] = {}
        self._resolution_flights: dict[tuple[str, str], threading.Event] = {}
        self._cache_lock = threading.RLock()

    def _host_warn(self, message: str) -> None:
        _warn_host(self.host, message)

    def _report(self, error: BaseException, context: Any, route_ctx: Mapping[str, str] | None = None) -> None:
        if not self.enabled:
            return
        try:
            trusted = dict(route_ctx or _route_ctx(context))
            resolution = resolve_route_context(trusted, self.install_root, engine_version=VERSION)
            report_adapter_error(error, {
                "installRoot": self.install_root,
                "route_id": resolution["route_id"],
                "domain": resolution["state_domain"],
                "turn_key": self._turn_key(context),
                "warn": self._host_warn,
            })
        except Exception:
            self._host_warn("persona: failed to report adapter error")

    @staticmethod
    def _turn_key(context: Any) -> str | None:
        turn_id = _field(context, "turn_id")
        if isinstance(turn_id, str) and turn_id:
            return turn_id
        session_id = _field(context, "session_id")
        return session_id if isinstance(session_id, str) and session_id else None

    @staticmethod
    def _session_id(context: Any) -> str | None:
        session_id = _field(context, "session_id")
        return session_id if isinstance(session_id, str) and session_id else None

    def _cache_keys(self, context: Any) -> list[tuple[str, str]]:
        keys: list[tuple[str, str]] = []
        turn_id = _field(context, "turn_id")
        if isinstance(turn_id, str) and turn_id:
            keys.append(("turn", turn_id))
        session_id = self._session_id(context)
        if session_id is not None:
            keys.append(("session", session_id))
        return keys

    def _generation_snapshot(self, context: Any, domain: str) -> dict[tuple[str, str], int]:
        with self._cache_lock:
            keys = self._cache_keys(context)
            session_keys = {key for key in keys if key[0] == "session"}
            if session_keys:
                self._domain_keys.setdefault(domain, builtins.set()).update(session_keys)
            for key in keys:
                self._inflight_keys[key] = self._inflight_keys.get(key, 0) + 1
            return {key: self._cache_generations.get(key, 0) for key in keys}

    def _prune_tracking(self, key: tuple[str, str]) -> None:
        cache = self._turn_cache if key[0] == "turn" else self._session_cache
        if key in self._inflight_keys or key[1] in cache:
            return
        self._cache_generations.pop(key, None)
        if key[0] != "session":
            return
        for domain, keys in list(self._domain_keys.items()):
            keys.discard(key)
            if not keys:
                del self._domain_keys[domain]

    def _release_generations(self, generations: Mapping[tuple[str, str], int]) -> None:
        with self._cache_lock:
            for key in generations:
                remaining = self._inflight_keys.get(key, 0) - 1
                if remaining > 0:
                    self._inflight_keys[key] = remaining
                else:
                    self._inflight_keys.pop(key, None)
                self._prune_tracking(key)

    def _cache_put(
        self, context: Any, result: dict[str, Any], route_ctx: dict[str, str],
        tool_allowed: bool,
        generations: Mapping[tuple[str, str], int],
    ) -> None:
        with self._cache_lock:
            evicted: list[tuple[str, str]] = []
            for kind, identifier in self._cache_keys(context):
                if result.get("transitioned") is True and kind == "session":
                    continue
                key = (kind, identifier)
                if self._cache_generations.get(key, 0) != generations.get(key):
                    continue
                cache = self._turn_cache if kind == "turn" else self._session_cache
                cache[identifier] = _CacheEntry(kind, result, route_ctx, tool_allowed)
                cache.move_to_end(identifier)
            for kind, cache, limit in (
                ("turn", self._turn_cache, _TURN_CACHE_LIMIT),
                ("session", self._session_cache, _SESSION_CACHE_LIMIT),
            ):
                while len(cache) > limit:
                    identifier, _ = cache.popitem(last=False)
                    evicted.append((kind, identifier))
            for key in evicted:
                self._prune_tracking(key)

    def _cached(self, context: Any) -> _CacheEntry | None:
        with self._cache_lock:
            turn_id = _field(context, "turn_id")
            if isinstance(turn_id, str) and turn_id:
                cached = self._turn_cache.get(turn_id)
                if cached is not None:
                    self._turn_cache.move_to_end(turn_id)
                    return cached
                return None
            session_id = self._session_id(context)
            cached = self._session_cache.get(session_id) if session_id is not None else None
            if cached is not None and session_id is not None:
                self._session_cache.move_to_end(session_id)
            return cached

    def _invalidate_session_domain(self, domain: str) -> None:
        with self._cache_lock:
            keys = {
                key for key in self._domain_keys.get(domain, ()) if key[0] == "session"
            }
            keys.update(
                ("session", session_id) for session_id, cached in self._session_cache.items()
                if cached.result.get("state_domain") == domain
            )
            for key in keys:
                self._cache_generations[key] = self._cache_generations.get(key, 0) + 1
                self._session_cache.pop(key[1], None)
                self._prune_tracking(key)

    def _begin_resolution(self, key: tuple[str, str]) -> tuple[threading.Event, bool]:
        with self._cache_lock:
            event = self._resolution_flights.get(key)
            if event is not None:
                return event, False
            event = threading.Event()
            self._resolution_flights[key] = event
            return event, True

    def _finish_resolution(self, key: tuple[str, str], event: threading.Event) -> None:
        with self._cache_lock:
            if self._resolution_flights.get(key) is event:
                del self._resolution_flights[key]
            event.set()

    def _session_key(self, session_id: str) -> str | None:
        if self.sessions_file is None:
            return None
        try:
            value = json.loads(self.sessions_file.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError("sessions file must contain an object")
            matches = [
                key for key, record in value.items()
                if isinstance(key, str) and key != "_README" and isinstance(record, dict)
                and isinstance(record.get("session_id"), str)
                and record["session_id"] == session_id
            ]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                self._host_warn("persona: Hermes session_key lookup is ambiguous")
        except Exception:
            self._host_warn("persona: Hermes session_key lookup unavailable")
        return None

    def _trusted_for_callback(self, context: Any) -> dict[str, str]:
        cached = self._cached(context)
        return dict(cached.route_ctx) if cached is not None else _route_ctx(context)

    def _resolve_request(
        self, context: Any, route_ctx: dict[str, str], request: Mapping[str, Any],
        api_call_count: int,
    ) -> _CacheEntry:
        resolution = resolve_route_context(route_ctx, self.install_root, engine_version=VERSION)
        actor = "owner" if resolution["route"].get("owner_verified") is True else "unknown"
        tool_allowed = (
            resolution["route"].get("switching") == "explicit-and-agent"
            and resolution["route"].get("owner_verified") is True
        )
        generations = self._generation_snapshot(context, resolution["state_domain"])
        try:
            result = turn({
                "ctx": route_ctx,
                "utterance": extract_utterance(request, route_ctx.get("api_mode")) if api_call_count <= 1 else None,
                "actor": actor,
                "turn_key": self._turn_key(context),
            }, self.install_root, engine_version=VERSION, warn=self._host_warn)
            if result.get("transitioned") is True:
                self._invalidate_session_domain(result["state_domain"])
            self._cache_put(context, result, route_ctx, tool_allowed, generations)
            cache_kind = "turn" if isinstance(_field(context, "turn_id"), str) and _field(context, "turn_id") else "session"
            return _CacheEntry(cache_kind, result, route_ctx, tool_allowed)
        finally:
            self._release_generations(generations)

    def _on_llm_request(
        self, *, request: Any, turn_id: str = "", session_id: str = "",
        platform: str = "", api_mode: str = "", api_call_count: int = 0,
        **_kwargs: Any,
    ) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        context = {
            "turn_id": turn_id,
            "session_id": session_id,
            "platform": platform,
            "api_mode": api_mode,
            "api_call_count": api_call_count,
        }
        session_key = self._session_key(session_id) if session_id else None
        if isinstance(session_key, str) and session_key:
            context["session_key"] = session_key
        route_ctx: dict[str, str] | None = None
        try:
            if not isinstance(request, dict):
                raise TypeError("llm_request request must be a dict")
            route_ctx = _route_ctx(context)
            has_turn_id = isinstance(turn_id, str) and bool(turn_id)
            use_session_cache = has_turn_id or api_call_count > 1
            cached = self._cached(context) if route_ctx and use_session_cache else None
            if cached is not None and cached.route_ctx != route_ctx:
                cached = None
            cache_keys = self._cache_keys(context)
            if cached is None and (not has_turn_id or not cache_keys):
                cached = self._resolve_request(context, route_ctx, request, api_call_count)
            elif cached is None:
                resolution_key = ("turn", turn_id)
                while cached is None:
                    flight, is_leader = self._begin_resolution(resolution_key)
                    if not is_leader:
                        flight.wait()
                        cached = self._cached(context)
                        if cached is not None and cached.route_ctx != route_ctx:
                            cached = None
                        continue
                    try:
                        if api_call_count > 1:
                            self._host_warn("persona: turn cache miss after first API call; resolving without utterance")
                        cached = self._resolve_request(context, route_ctx, request, api_call_count)
                    finally:
                        self._finish_resolution(resolution_key, flight)
            result, cached_ctx, tool_allowed = cached.result, cached.route_ctx, cached.tool_allowed
            output = copy.deepcopy(request)
            changed = False
            reasons: list[str] = []
            if not tool_allowed:
                tools = output.get("tools")
                if isinstance(tools, list):
                    filtered = [tool for tool in tools if not _is_persona_tool(tool)]
                    if len(filtered) != len(tools):
                        output["tools"] = filtered
                        changed = True
                        reasons.append("persona_set hidden by route policy")
            block = result["block"]
            if block:
                _inject(output, cached_ctx.get("api_mode"), block)
                changed = True
                reasons.append("persona block injected")
            if not changed:
                return None
            return {
                "request": output,
                "source": "persona-engine",
                "reason": "; ".join(reasons),
            }
        except Exception as error:
            self._report(error, context, route_ctx)
            try:
                if not isinstance(request, dict):
                    return None
                output = copy.deepcopy(request)
                tools = output.get("tools")
                if not isinstance(tools, list):
                    return None
                filtered = [tool for tool in tools if not _is_persona_tool(tool)]
                if len(filtered) == len(tools):
                    return None
                output["tools"] = filtered
                return {
                    "request": output,
                    "source": "persona-engine",
                    "reason": "persona_set hidden after adapter error",
                }
            except Exception as fallback_error:
                self._report(fallback_error, context, route_ctx)
                return None

    def _on_pre_tool_call(
        self, *, tool_name: str, args: Any, task_id: str = "",
        session_id: str = "", tool_call_id: str = "", turn_id: str = "",
        api_request_id: str = "", middleware_trace: Any = None, **_kwargs: Any,
    ) -> dict[str, str] | None:
        del args, task_id, tool_call_id, api_request_id, middleware_trace
        if not self.enabled:
            return None
        if tool_name != TOOL_NAME:
            return None
        context = {"turn_id": turn_id, "session_id": session_id}
        try:
            cached = self._cached(context)
            cached_session_id = cached.route_ctx.get("session_id") if cached is not None else None
            if (
                cached is None or not cached.tool_allowed
                or not isinstance(cached_session_id, str) or not cached_session_id
                or not isinstance(session_id, str) or not session_id
                or cached_session_id != session_id
            ):
                return {"action": "block", "message": _BLOCK_MESSAGE}
            return None
        except Exception as error:
            self._report(error, context)
            return {"action": "block", "message": _BLOCK_MESSAGE}

    def persona_set(self, arguments: Mapping[str, Any], context: Any = None) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        try:
            if not isinstance(arguments, Mapping) or builtins.set(arguments) != {"mode"} or not isinstance(arguments.get("mode"), str):
                raise ValueError("persona_set requires exactly one string mode argument")
            trusted = self._trusted_for_callback(context)
            resolution = resolve_route_context(trusted, self.install_root, engine_version=VERSION)
            result = set({
                "actor": "agent", "ctx": trusted, "requested_mode": arguments["mode"],
            }, self.install_root, engine_version=VERSION, warn=self._host_warn)
            if result.get("ok") is True:
                self._invalidate_session_domain(resolution["state_domain"])
            return result
        except Exception as error:
            self._report(error, context)
            return {
                "ok": False, "mode": "public", "transitioned": False,
                "rejected": {"requested_mode": "", "reason": "adapter error"}, "audit": [],
            }

    def _persona_set_handler(self, args: dict[str, Any], **kwargs: Any) -> str | None:
        if not self.enabled:
            return None
        return json.dumps(
            self.persona_set(args, kwargs), ensure_ascii=False, separators=(",", ":"),
        )


def _install_root(ctx: Any) -> str:
    configured = _field(ctx, "persona_engine_install_root")
    if not isinstance(configured, str) or not configured:
        config = _field(ctx, "config")
        configured = _field(config, "persona_engine_install_root")
    if isinstance(configured, str) and configured:
        return configured
    return os.environ.get("PERSONA_ENGINE_INSTALL_ROOT", "")


def _sessions_file(ctx: Any) -> str:
    configured = _field(ctx, "persona_engine_sessions_file")
    config = _field(ctx, "config")
    if not isinstance(configured, str) or not configured:
        configured = _field(config, "persona_engine_sessions_file")
    if isinstance(configured, str) and configured:
        return configured
    environment = os.environ.get("PERSONA_ENGINE_SESSIONS_FILE")
    if environment:
        return environment
    profile = _field(ctx, "persona_engine_profile")
    if profile is None:
        profile = _field(config, "persona_engine_profile")
    if profile is None:
        profile = os.environ.get("HERMES_PROFILE", "default")
    try:
        if not isinstance(profile, str) or not profile:
            raise ValueError("invalid profile")
        profiles_root = Path("~/.hermes/profiles").expanduser().resolve()
        sessions_file = (profiles_root / profile / "sessions" / "sessions.json").resolve()
        sessions_file.relative_to(profiles_root)
    except (OSError, RuntimeError, ValueError):
        _warn_host(ctx, "persona: Hermes profile sessions lookup unavailable")
        return ""
    return str(sessions_file)


def register(ctx: Any) -> None:
    """Register the single Hermes plugin surface."""
    install_root = _install_root(ctx)
    adapter = HermesAdapter(ctx, install_root)
    if not adapter.enabled:
        adapter._host_warn("persona: adapter disabled because install root is not configured")
        return
    sessions_file = _sessions_file(ctx)
    adapter.sessions_file = Path(sessions_file).expanduser() if sessions_file else None
    ctx.register_middleware("llm_request", adapter._on_llm_request)
    ctx.register_hook("pre_tool_call", adapter._on_pre_tool_call)
    description = "Set the persona mode for the next turn."
    schema = {
        "name": TOOL_NAME,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {"mode": {"type": "string"}},
            "required": ["mode"],
            "additionalProperties": False,
        },
    }
    ctx.register_tool(
        name=TOOL_NAME,
        toolset=TOOLSET_NAME,
        schema=schema,
        handler=adapter._persona_set_handler,
        description=description,
        is_async=False,
    )
