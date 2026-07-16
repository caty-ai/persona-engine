from __future__ import annotations

import copy
import json
import shutil
import threading
from pathlib import Path
from typing import Any

import pytest

from adapters.hermes import plugin


CASES = Path(__file__).resolve().parents[3] / "spec" / "fixtures" / "runtime" / "cases"


class Logger:
    def __init__(self) -> None:
        self.messages: list[str] = []

    def warning(self, message: str) -> None:
        self.messages.append(message)


class Host:
    def __init__(self, install_root: Path) -> None:
        self.persona_engine_install_root = str(install_root)
        self.logger = Logger()
        self.middleware: dict[str, Any] = {}
        self.hooks: dict[str, Any] = {}
        self.tools: dict[str, dict[str, Any]] = {}

    def register_middleware(self, name: str, callback: Any) -> None:
        self.middleware[name] = callback

    def register_hook(self, name: str, callback: Any) -> None:
        self.hooks[name] = callback

    def register_tool(self, **kwargs: Any) -> None:
        self.tools[kwargs["name"]] = kwargs


def _registered(tmp_path: Path, case_name: str = "agent-switch-accept") -> tuple[Host, plugin.HermesAdapter]:
    root = tmp_path / case_name
    shutil.copytree(CASES / case_name, root)
    host = Host(root)
    plugin.register(host)
    adapter = host.middleware["llm_request"].__self__
    return host, adapter


def _middleware_kwargs(**overrides: Any) -> dict[str, Any]:
    values = {
        "original_request": {},
        "task_id": "task",
        "turn_id": "turn",
        "api_request_id": "request-id",
        "session_id": "session",
        "platform": "dummy",
        "model": "dummy-model",
        "provider": "dummy-provider",
        "api_mode": "chat",
        "api_call_count": 1,
        "telemetry_schema_version": "1",
        "middleware_schema_version": "1",
    }
    values.update(overrides)
    return values


def _request_from_callback(callback: Any, request: Any, **kwargs: Any) -> Any:
    """Mirror Hermes: only a dict result containing a dict request is applied."""
    result = callback(request=request, **_middleware_kwargs(**kwargs))
    if not isinstance(result, dict) or not isinstance(result.get("request"), dict):
        return request
    return result["request"]


def _assert_no_active_tracking(adapter: plugin.HermesAdapter) -> None:
    assert adapter._inflight_keys == {}
    assert adapter._resolution_flights == {}


def test_registers_verified_surfaces_and_mode_only_schema(tmp_path: Path) -> None:
    host, _ = _registered(tmp_path)
    assert list(host.middleware) == ["llm_request"]
    assert list(host.hooks) == ["pre_tool_call"]
    assert list(host.tools) == ["persona_set"]
    tool = host.tools["persona_set"]
    assert tool["toolset"] == "persona-engine"
    assert tool["schema"]["name"] == "persona_set"
    assert tool["schema"]["parameters"]["properties"] == {"mode": {"type": "string"}}
    assert tool["schema"]["parameters"]["additionalProperties"] is False
    assert tool["description"] == tool["schema"]["description"]
    assert tool["is_async"] is False


def test_chat_returns_request_envelope_and_caches_first_call(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    first = {
        "messages": [
            {"role": "user", "content": "/persona public"},
            {"role": "assistant", "content": "ignored"},
            {"role": "tool", "content": "/persona public"},
            {"role": "user", "content": "/persona focus"},
        ],
        "tools": [{"type": "function", "function": {"name": "persona_set"}}],
    }
    result = callback(request=first, **_middleware_kwargs(new_future_kwarg="accepted"))
    assert result["source"] == "persona-engine"
    assert isinstance(result["request"], dict)
    assert result["request"]["messages"][0]["role"] == "system"
    block = result["request"]["messages"][0]["content"]
    assert block

    second = {"messages": [{"role": "user", "content": "/persona public"}], "tools": first["tools"]}
    reinjected = callback(request=second, **_middleware_kwargs(api_call_count=2))
    assert reinjected["request"]["messages"][0]["content"] == block


def test_responses_extraction_and_instruction_injection(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path)
    payload = {
        "instructions": "stable base",
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "/persona public"}]},
            {"type": "function_call_output", "output": "/persona public"},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "/persona focus"}]},
        ],
    }
    result = host.middleware["llm_request"](
        request=payload, **_middleware_kwargs(api_mode="responses", turn_id="responses-turn"),
    )
    assert result["request"]["instructions"].startswith("stable base\n\n")
    assert "<persona-mode" in result["request"]["instructions"]


def test_codex_responses_extraction_and_instruction_injection(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path)
    payload = {
        "instructions": "stable base",
        "input": [
            {"role": "user", "content": "/persona focus"},
            {"type": "function_call_output", "call_id": "call-1", "output": "synthetic"},
        ],
    }
    result = host.middleware["llm_request"](
        request=payload,
        **_middleware_kwargs(api_mode="codex_responses", turn_id="codex-responses-turn"),
    )
    assert result["request"]["instructions"].startswith("stable base\n\n")
    assert "<persona-mode" in result["request"]["instructions"]
    assert result["request"]["input"] == payload["input"]


def test_codex_responses_top_level_persona_tool_is_filtered(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path, "minimal-turn")
    payload = {
        "input": "hello",
        "tools": [
            {"type": "function", "name": "persona_set"},
            {"type": "function", "name": "safe_tool"},
        ],
    }
    result = host.middleware["llm_request"](
        request=payload,
        **_middleware_kwargs(
            api_mode="codex_responses", platform="unknown", turn_id="codex-responses-tools",
        ),
    )
    assert [tool["name"] for tool in result["request"]["tools"]] == ["safe_tool"]
    assert result["request"]["input"] == payload["input"]


def test_public_zero_bytes_returns_none_and_hides_disallowed_tool(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path, "minimal-turn")
    callback = host.middleware["llm_request"]
    payload = {"messages": [{"role": "user", "content": "hello"}]}
    assert callback(request=payload, **_middleware_kwargs(platform="unknown", turn_id="public")) is None
    assert _request_from_callback(callback, payload, platform="unknown", turn_id="public") == payload

    with_tools = {
        **payload,
        "tools": [
            {"type": "function", "function": {"name": "persona_set"}},
            {"type": "function", "function": {"name": "safe_tool"}},
        ],
    }
    result = callback(request=with_tools, **_middleware_kwargs(platform="unknown", turn_id="public-tools"))
    assert [tool["function"]["name"] for tool in result["request"]["tools"]] == ["safe_tool"]
    assert result["request"]["messages"] == payload["messages"]


@pytest.mark.parametrize(
    ("platform", "session_id"),
    [("dummy", ""), ("", "session"), ("", "")],
)
def test_missing_required_route_context_is_unresolved(
    tmp_path: Path, platform: str, session_id: str,
) -> None:
    host, adapter = _registered(tmp_path)
    assert plugin.set(
        {"actor": "admin", "domain": "shared", "requested_mode": "focus"},
        adapter.install_root, engine_version=plugin.VERSION,
    )["ok"] is True
    payload = {"messages": [{"role": "user", "content": "/persona focus"}]}
    result = host.middleware["llm_request"](
        request=payload,
        **_middleware_kwargs(platform=platform, session_id=session_id, turn_id="missing-context"),
    )
    assert result is None
    audit = (Path(adapter.install_root) / "audit" / "audit.jsonl").read_text(encoding="utf-8")
    assert '"event":"route_unresolved"' in audit


def test_required_context_loss_cannot_reuse_private_turn_cache(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    private = callback(
        request={"messages": [{"role": "user", "content": "/persona focus"}]},
        **_middleware_kwargs(turn_id="same-turn", session_id="session"),
    )
    assert "<persona-mode" in private["request"]["messages"][0]["content"]
    missing = callback(
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id="same-turn", session_id="", api_call_count=2),
    )
    assert missing is None


@pytest.mark.parametrize("ctx", [{"platform": "dummy"}, {"session_id": "session"}, {}])
def test_partial_runtime_context_cannot_match_route(tmp_path: Path, ctx: dict[str, str]) -> None:
    host, adapter = _registered(tmp_path)
    del host
    policy_path = Path(adapter.install_root) / "build" / "policy.json"
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    policy["routes"][0]["match"] = {}
    policy_path.write_text(json.dumps(policy), encoding="utf-8")
    resolution = plugin.resolve_route_context(ctx, adapter.install_root, engine_version=plugin.VERSION)
    assert resolution["route_id"] == "__default__"
    assert resolution["audit"][0]["event"] == "route_unresolved"


def test_pre_tool_uses_middleware_cache_and_block_always_has_message(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path, "agent-switch-reject-explicit-only")
    hook = host.hooks["pre_tool_call"]
    base = {
        "args": {"mode": "focus"}, "task_id": "task", "session_id": "session",
        "tool_call_id": "tool-call", "turn_id": "denied", "api_request_id": "api-request",
        "middleware_trace": [],
    }
    missing = hook(tool_name="persona_set", **base)
    assert missing == {"action": "block", "message": "persona_set is unavailable on this route"}
    assert hook(tool_name="safe_tool", **base) is None

    host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id="denied"),
    )
    denied = hook(tool_name="persona_set", **base)
    assert denied["action"] == "block"
    assert isinstance(denied["message"], str) and denied["message"]


def test_pre_tool_session_fallback_and_handler_returns_json_string(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path)
    host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id="middleware-turn", session_id="session-fallback"),
    )
    allowed = host.hooks["pre_tool_call"](
        tool_name="persona_set", args={"mode": "focus"}, task_id="task",
        session_id="session-fallback", tool_call_id="call", turn_id="",
        api_request_id="request", middleware_trace=[],
    )
    assert allowed is None

    output = host.tools["persona_set"]["handler"](
        {"mode": "focus"}, session_id="session-fallback", task_id="task",
    )
    assert isinstance(output, str)
    assert json.loads(output)["ok"] is True


def test_successful_set_invalidates_session_fallback_cache(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    request = {"messages": [{"role": "user", "content": "hello"}]}
    assert callback(request=request, **_middleware_kwargs(turn_id="", session_id="fallback")) is None
    output = host.tools["persona_set"]["handler"]({"mode": "focus"}, session_id="fallback")
    assert json.loads(output)["ok"] is True
    injected = callback(request=request, **_middleware_kwargs(turn_id="", session_id="fallback"))
    assert "<persona-mode" in injected["request"]["messages"][0]["content"]


def test_successful_set_preserves_same_turn_snapshot_bytes(tmp_path: Path) -> None:
    host, adapter = _registered(tmp_path)
    assert plugin.set(
        {"actor": "admin", "domain": "shared", "requested_mode": "focus"},
        adapter.install_root, engine_version=plugin.VERSION,
    )["ok"] is True
    callback = host.middleware["llm_request"]
    request = {"messages": [{"role": "user", "content": "hello"}]}
    first = callback(
        request=request,
        **_middleware_kwargs(turn_id="stable-turn", session_id="stable-session"),
    )
    before = first["request"]["messages"][0]["content"].encode()
    changed = host.tools["persona_set"]["handler"](
        {"mode": "public"}, turn_id="stable-turn", session_id="stable-session",
    )
    assert json.loads(changed)["ok"] is True

    second = callback(
        request=request,
        **_middleware_kwargs(
            turn_id="stable-turn", session_id="stable-session", api_call_count=2,
        ),
    )
    after = second["request"]["messages"][0]["content"].encode()
    assert after == before
    assert adapter._turn_cache["stable-turn"].kind == "turn"


def test_turn_transition_invalidates_session_fallback_without_inserting(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    host, adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    real_turn = plugin.turn
    calls = 0

    def counted_turn(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return real_turn(*args, **kwargs)

    monkeypatch.setattr(plugin, "turn", counted_turn)
    transitioned = callback(
        request={"messages": [{"role": "user", "content": "/persona focus"}]},
        **_middleware_kwargs(turn_id="transition", session_id="fallback"),
    )
    block = transitioned["request"]["messages"][0]["content"]
    assert calls == 1
    assert adapter._session_cache == {}
    reinjected = callback(
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id="", session_id="fallback", api_call_count=2),
    )
    assert calls == 2
    assert reinjected["request"]["messages"][0]["content"] == block


def test_session_fallback_is_fresh_at_next_user_turn(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    focus = callback(
        request={"messages": [{"role": "user", "content": "/persona focus"}]},
        **_middleware_kwargs(turn_id="", session_id="fallback", api_call_count=1),
    )
    assert "<persona-mode" in focus["request"]["messages"][0]["content"]
    same_turn = callback(
        request={"messages": [{"role": "user", "content": "/persona public"}]},
        **_middleware_kwargs(turn_id="", session_id="fallback", api_call_count=2),
    )
    assert "<persona-mode" in same_turn["request"]["messages"][0]["content"]
    assert callback(
        request={"messages": [{"role": "user", "content": "/persona public"}]},
        **_middleware_kwargs(turn_id="", session_id="fallback", api_call_count=1),
    ) is None
    assert callback(
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id="", session_id="fallback", api_call_count=2),
    ) is None


def test_parallel_session_only_first_calls_resolve_independently(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    host, adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    real_turn = plugin.turn
    ready = threading.Barrier(2)
    calls: list[str | None] = []
    calls_lock = threading.Lock()

    def coordinated_turn(runtime_input: dict[str, Any], *args: Any, **kwargs: Any) -> dict[str, Any]:
        with calls_lock:
            calls.append(runtime_input.get("utterance"))
        ready.wait(5)
        return real_turn(runtime_input, *args, **kwargs)

    monkeypatch.setattr(plugin, "turn", coordinated_turn)
    results: dict[str, Any] = {}

    def invoke(name: str, utterance: str) -> None:
        results[name] = callback(
            request={"messages": [{"role": "user", "content": utterance}]},
            **_middleware_kwargs(turn_id="", session_id="shared-session", api_call_count=1),
        )

    plain = threading.Thread(target=invoke, args=("plain", "hello"))
    trigger = threading.Thread(target=invoke, args=("trigger", "/persona focus"))
    plain.start()
    trigger.start()
    plain.join(5)
    trigger.join(5)

    assert not plain.is_alive() and not trigger.is_alive()
    assert sorted(calls) == ["/persona focus", "hello"]
    assert results["trigger"] is not None
    assert "<persona-mode" in results["trigger"]["request"]["messages"][0]["content"]
    state = json.loads((Path(adapter.install_root) / "state" / "shared.json").read_text(encoding="utf-8"))
    assert state["mode"] == "focus"
    _assert_no_active_tracking(adapter)


def test_parallel_session_only_late_misses_resolve_independently_without_utterance(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    host, adapter = _registered(tmp_path)
    ready = threading.Barrier(2)
    runtime_inputs: list[dict[str, Any]] = []
    inputs_lock = threading.Lock()

    def coordinated_turn(runtime_input: dict[str, Any], *args: Any, **kwargs: Any) -> dict[str, Any]:
        del args, kwargs
        with inputs_lock:
            runtime_inputs.append(runtime_input)
        ready.wait(5)
        return {
            "mode": "public", "block": "", "route_id": "agent-route",
            "state_domain": "shared", "transitioned": False, "audit": [],
        }

    monkeypatch.setattr(plugin, "turn", coordinated_turn)
    callback = host.middleware["llm_request"]
    threads = [threading.Thread(target=lambda: callback(
        request={"messages": [{"role": "user", "content": "/persona focus"}]},
        **_middleware_kwargs(turn_id="", session_id="late-session", api_call_count=2),
    )) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
        assert not thread.is_alive()

    assert len(runtime_inputs) == 2
    assert all(runtime_input["utterance"] is None for runtime_input in runtime_inputs)
    _assert_no_active_tracking(adapter)


def test_missing_turn_and_session_keys_resolves_default_public_without_error(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    host, adapter = _registered(tmp_path)
    real_turn = plugin.turn
    captured: list[dict[str, Any]] = []
    reports: list[BaseException] = []

    def capture_turn(runtime_input: dict[str, Any], *args: Any, **kwargs: Any) -> dict[str, Any]:
        result = real_turn(runtime_input, *args, **kwargs)
        captured.append({"input": runtime_input, "result": result})
        return result

    monkeypatch.setattr(plugin, "turn", capture_turn)
    monkeypatch.setattr(plugin, "report_adapter_error", lambda error, ctx: reports.append(error) or {})
    result = host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "/persona focus"}]},
        **_middleware_kwargs(turn_id="", session_id="", platform=""),
    )

    assert result is None
    assert reports == []
    assert captured[0]["input"]["ctx"] == {}
    assert captured[0]["result"]["mode"] == "public"
    assert adapter._turn_cache == {}
    assert adapter._session_cache == {}
    _assert_no_active_tracking(adapter)


def test_session_key_is_derived_from_configured_sessions_file(tmp_path: Path) -> None:
    host, adapter = _registered(tmp_path)
    policy_path = Path(adapter.install_root) / "build" / "policy.json"
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    policy["routes"][0]["match"] = {
        "platform": "api_server", "session_key": {"prefix": "voice-"},
    }
    policy_path.write_text(json.dumps(policy), encoding="utf-8")
    sessions = tmp_path / "sessions.json"
    sessions.write_text(json.dumps({"voice-owner": {"session_id": "mapped"}}), encoding="utf-8")
    adapter.sessions_file = sessions
    assert plugin.set(
        {"actor": "admin", "domain": "shared", "requested_mode": "focus"},
        adapter.install_root, engine_version=plugin.VERSION,
    )["ok"] is True

    success = host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(platform="api_server", session_id="mapped", turn_id="mapped-turn"),
    )
    assert "<persona-mode" in success["request"]["messages"][0]["content"]
    failed = host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(platform="api_server", session_id="missing", turn_id="missing-turn"),
    )
    assert failed is None
    adapter.sessions_file = tmp_path / "unavailable.json"
    unavailable = host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(platform="api_server", session_id="unavailable", turn_id="unavailable-turn"),
    )
    assert unavailable is None
    assert "persona: Hermes session_key lookup unavailable" in host.logger.messages
    audit = (Path(adapter.install_root) / "audit" / "audit.jsonl").read_text(encoding="utf-8")
    assert '"event":"route_unresolved"' in audit


def test_session_key_lookup_skips_readme_and_non_object_entries(tmp_path: Path) -> None:
    host, adapter = _registered(tmp_path)
    sessions = tmp_path / "sessions.json"
    sessions.write_text(json.dumps({
        "_README": "schema notes",
        "victim-session": "voice-owner",
        "voice-owner": {"session_id": "mapped", "other": True},
    }), encoding="utf-8")
    adapter.sessions_file = sessions
    assert adapter._session_key("mapped") == "voice-owner"
    assert adapter._session_key("victim-session") is None
    assert host.logger.messages == []

    sessions.write_text(json.dumps({
        "_README": {"session_id": "mapped"},
    }), encoding="utf-8")
    assert adapter._session_key("mapped") is None


def test_session_key_lookup_duplicate_match_is_ambiguous(tmp_path: Path) -> None:
    host, adapter = _registered(tmp_path)
    sessions = tmp_path / "sessions.json"
    sessions.write_text(json.dumps({
        "first": {"session_id": "duplicate"},
        "second": {"session_id": "duplicate"},
    }), encoding="utf-8")
    adapter.sessions_file = sessions
    assert adapter._session_key("duplicate") is None
    assert host.logger.messages == ["persona: Hermes session_key lookup is ambiguous"]


@pytest.mark.parametrize("contents", ["[]", "not-json"])
def test_session_key_lookup_invalid_top_level_fails_closed(tmp_path: Path, contents: str) -> None:
    host, adapter = _registered(tmp_path)
    sessions = tmp_path / "sessions.json"
    sessions.write_text(contents, encoding="utf-8")
    adapter.sessions_file = sessions
    assert adapter._session_key("session") is None
    assert host.logger.messages == ["persona: Hermes session_key lookup unavailable"]


def test_sessions_file_is_read_from_plugin_config(tmp_path: Path) -> None:
    root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", root)
    host = Host(root)
    configured = tmp_path / "configured-sessions.json"
    host.config = {"persona_engine_sessions_file": str(configured)}
    plugin.register(host)
    adapter = host.middleware["llm_request"].__self__
    assert adapter.sessions_file == configured


def test_session_fallback_rechecks_session_key_mapping(tmp_path: Path) -> None:
    host, adapter = _registered(tmp_path)
    policy_path = Path(adapter.install_root) / "build" / "policy.json"
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    policy["routes"][0]["match"] = {
        "platform": "api_server", "session_key": {"prefix": "voice-"},
    }
    policy_path.write_text(json.dumps(policy), encoding="utf-8")
    sessions = tmp_path / "sessions.json"
    sessions.write_text(json.dumps({"voice-owner": {"session_id": "fallback"}}), encoding="utf-8")
    adapter.sessions_file = sessions
    assert plugin.set(
        {"actor": "admin", "domain": "shared", "requested_mode": "focus"},
        adapter.install_root, engine_version=plugin.VERSION,
    )["ok"] is True
    request = {"messages": [{"role": "user", "content": "hello"}]}
    private = host.middleware["llm_request"](
        request=request,
        **_middleware_kwargs(platform="api_server", session_id="fallback", turn_id=""),
    )
    assert "<persona-mode" in private["request"]["messages"][0]["content"]
    sessions.unlink()
    assert host.middleware["llm_request"](
        request=request,
        **_middleware_kwargs(platform="api_server", session_id="fallback", turn_id="", api_call_count=2),
    ) is None


def test_cache_miss_after_first_api_call_does_not_trigger_transition(tmp_path: Path) -> None:
    host, adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    request = {"messages": [{"role": "user", "content": "/persona focus"}]}
    assert callback(request=request, **_middleware_kwargs(turn_id="late", api_call_count=2)) is None
    assert not (Path(adapter.install_root) / "state" / "shared.json").exists()
    result = callback(request=request, **_middleware_kwargs(turn_id="first", api_call_count=1))
    assert "<persona-mode" in result["request"]["messages"][0]["content"]


def test_turn_cache_miss_after_first_api_call_warns_and_omits_utterance(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    host, adapter = _registered(tmp_path)
    runtime_inputs: list[dict[str, Any]] = []

    def capture_turn(runtime_input: dict[str, Any], *args: Any, **kwargs: Any) -> dict[str, Any]:
        del args, kwargs
        runtime_inputs.append(runtime_input)
        return {
            "mode": "public", "block": "", "route_id": "agent-route",
            "state_domain": "shared", "transitioned": False, "audit": [],
        }

    monkeypatch.setattr(plugin, "turn", capture_turn)
    assert host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "/persona focus"}]},
        **_middleware_kwargs(turn_id="evicted-turn", api_call_count=2),
    ) is None

    assert runtime_inputs[0]["utterance"] is None
    assert host.logger.messages.count(
        "persona: turn cache miss after first API call; resolving without utterance",
    ) == 1
    _assert_no_active_tracking(adapter)


def test_turn_cache_lru_keeps_active_turn_warm_below_capacity(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    host, adapter = _registered(tmp_path)
    calls = 0

    def stable_turn(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        del args, kwargs
        calls += 1
        return {
            "mode": "focus", "block": "stable bytes", "route_id": "agent-route",
            "state_domain": "shared", "transitioned": False, "audit": [],
        }

    monkeypatch.setattr(plugin, "turn", stable_turn)
    callback = host.middleware["llm_request"]
    request = {"messages": [{"role": "user", "content": "hello"}]}
    callback(request=request, **_middleware_kwargs(turn_id="active", session_id="session"))
    for index in range(plugin._TURN_CACHE_LIMIT - 1):
        callback(
            request=request,
            **_middleware_kwargs(turn_id=f"other-{index}", session_id="session"),
        )

    before_hit = calls
    callback(
        request=request,
        **_middleware_kwargs(turn_id="active", session_id="session", api_call_count=2),
    )
    assert calls == before_hit
    assert next(reversed(adapter._turn_cache)) == "active"

    callback(request=request, **_middleware_kwargs(turn_id="newest", session_id="session"))
    assert "active" in adapter._turn_cache
    assert len(adapter._turn_cache) == plugin._TURN_CACHE_LIMIT
    assert not any(key[0] == "turn" for keys in adapter._domain_keys.values() for key in keys)
    _assert_no_active_tracking(adapter)


def test_session_invalidation_during_turn_preserves_turn_cache_insert(tmp_path: Path, monkeypatch: Any) -> None:
    host, adapter = _registered(tmp_path)

    def invalidate_during_turn(*args: Any, **kwargs: Any) -> dict[str, Any]:
        del args, kwargs
        adapter._invalidate_session_domain("shared")
        return {
            "mode": "public", "block": "", "route_id": "agent-route",
            "state_domain": "shared", "transitioned": False, "audit": [],
        }

    monkeypatch.setattr(plugin, "turn", invalidate_during_turn)
    assert host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id="in-flight", session_id="session"),
    ) is None
    cached = adapter._cached({"turn_id": "in-flight", "session_id": "session"})
    assert cached is not None and cached.kind == "turn"
    assert adapter._cached({"turn_id": "", "session_id": "session"}) is None
    assert adapter._cache_generations == {}
    assert adapter._domain_keys == {}
    assert adapter._inflight_keys == {}
    assert adapter._resolution_flights == {}


def test_delayed_transition_cannot_reinsert_stale_session_fallback(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    host, adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    real_turn = plugin.turn
    old_committed = threading.Event()
    release_old = threading.Event()
    calls: list[str] = []

    def delayed_turn(runtime_input: dict[str, Any], *args: Any, **kwargs: Any) -> dict[str, Any]:
        result = real_turn(runtime_input, *args, **kwargs)
        turn_key = runtime_input["turn_key"]
        calls.append(turn_key)
        if turn_key == "old-transition":
            old_committed.set()
            assert release_old.wait(5)
        return result

    monkeypatch.setattr(plugin, "turn", delayed_turn)
    old_results: list[Any] = []
    old_thread = threading.Thread(target=lambda: old_results.append(callback(
        request={"messages": [{"role": "user", "content": "/persona focus"}]},
        **_middleware_kwargs(turn_id="old-transition", session_id="shared-session"),
    )))
    old_thread.start()
    assert old_committed.wait(5)

    latest = callback(
        request={"messages": [{"role": "user", "content": "/persona public"}]},
        **_middleware_kwargs(turn_id="new-transition", session_id="shared-session"),
    )
    assert latest is None
    release_old.set()
    old_thread.join(5)
    assert not old_thread.is_alive()
    assert old_results and old_results[0] is not None
    old_bytes = old_results[0]["request"]["messages"][0]["content"].encode()
    repeated_old = callback(
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(
            turn_id="old-transition", session_id="shared-session", api_call_count=2,
        ),
    )
    assert repeated_old["request"]["messages"][0]["content"].encode() == old_bytes
    assert adapter._session_cache == {}

    fresh = callback(
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(
            turn_id="", session_id="shared-session", api_call_count=2,
        ),
    )
    assert fresh is None
    assert calls == ["old-transition", "new-transition", "shared-session"]
    assert adapter._session_cache["shared-session"].result["mode"] == "public"


def test_same_turn_cache_miss_is_single_flight(tmp_path: Path, monkeypatch: Any) -> None:
    host, adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    entered = threading.Event()
    waiter_arrived = threading.Event()
    release = threading.Event()
    calls = 0
    begin_resolution = adapter._begin_resolution

    def observed_begin(key: tuple[str, str]) -> tuple[threading.Event, bool]:
        flight = begin_resolution(key)
        if not flight[1]:
            waiter_arrived.set()
        return flight

    def blocking_turn(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        del args, kwargs
        calls += 1
        entered.set()
        assert release.wait(5)
        return {
            "mode": "focus", "block": "stable bytes", "route_id": "agent-route",
            "state_domain": "shared", "transitioned": False, "audit": [],
        }

    monkeypatch.setattr(plugin, "turn", blocking_turn)
    monkeypatch.setattr(adapter, "_begin_resolution", observed_begin)
    results: list[Any] = []

    def invoke() -> None:
        results.append(callback(
            request={"messages": [{"role": "user", "content": "hello"}]},
            **_middleware_kwargs(turn_id="same-flight", session_id="session"),
        ))

    first = threading.Thread(target=invoke)
    second = threading.Thread(target=invoke)
    first.start()
    assert entered.wait(5)
    second.start()
    assert waiter_arrived.wait(5)
    assert calls == 1
    release.set()
    first.join(5)
    second.join(5)
    assert not first.is_alive() and not second.is_alive()
    assert calls == 1
    injected = [result["request"]["messages"][0]["content"].encode() for result in results]
    assert injected == [b"stable bytes", b"stable bytes"]
    assert adapter._resolution_flights == {}


def test_owner_crash_wakes_waiter_and_waiter_retries_resolution(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    host, adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    owner_entered = threading.Event()
    waiter_waiting = threading.Event()
    call_lock = threading.Lock()
    calls = 0
    owner_flight: list[threading.Event] = []
    begin_resolution = adapter._begin_resolution

    class WaitObservedEvent:
        def __init__(self, event: threading.Event) -> None:
            self._event = event

        def wait(self) -> bool:
            waiter_waiting.set()
            return self._event.wait()

    def observed_begin(key: tuple[str, str]) -> tuple[Any, bool]:
        flight, is_leader = begin_resolution(key)
        if is_leader and not owner_flight:
            owner_flight.append(flight)
        if not is_leader:
            return WaitObservedEvent(flight), False
        return flight, True

    def crash_once_turn(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        del args, kwargs
        with call_lock:
            calls += 1
            call_number = calls
        if call_number == 1:
            owner_entered.set()
            assert waiter_waiting.wait(5)
            raise RuntimeError("owner resolution crashed")
        return {
            "mode": "focus", "block": "retried bytes", "route_id": "agent-route",
            "state_domain": "shared", "transitioned": False, "audit": [],
        }

    monkeypatch.setattr(plugin, "turn", crash_once_turn)
    monkeypatch.setattr(adapter, "_begin_resolution", observed_begin)
    owner_results: list[Any] = []
    waiter_results: list[Any] = []

    def invoke(results: list[Any]) -> None:
        results.append(callback(
            request={"messages": [{"role": "user", "content": "hello"}]},
            **_middleware_kwargs(turn_id="owner-crash", session_id="session"),
        ))

    owner = threading.Thread(target=invoke, args=(owner_results,))
    waiter = threading.Thread(target=invoke, args=(waiter_results,))
    owner.start()
    assert owner_entered.wait(5)
    waiter.start()
    assert waiter_waiting.wait(5)
    owner.join(5)
    waiter.join(5)

    assert not owner.is_alive() and not waiter.is_alive()
    assert owner_flight and owner_flight[0].is_set()
    assert owner_results == [None]
    assert calls == 2
    assert waiter_results[0]["request"]["messages"][0]["content"].encode() == b"retried bytes"
    assert adapter._resolution_flights == {}
    assert adapter._inflight_keys == {}


def test_different_cache_keys_resolve_concurrently(tmp_path: Path, monkeypatch: Any) -> None:
    host, _adapter = _registered(tmp_path)
    callback = host.middleware["llm_request"]
    both_entered = threading.Event()
    release = threading.Event()
    counter_lock = threading.Lock()
    calls = 0

    def blocking_turn(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        del args, kwargs
        with counter_lock:
            calls += 1
            if calls == 2:
                both_entered.set()
        assert release.wait(5)
        return {
            "mode": "public", "block": "", "route_id": "agent-route",
            "state_domain": "shared", "transitioned": False, "audit": [],
        }

    monkeypatch.setattr(plugin, "turn", blocking_turn)
    threads = [threading.Thread(target=lambda key=key: callback(
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id=key, session_id=key),
    )) for key in ("parallel-a", "parallel-b")]
    for thread in threads:
        thread.start()
    assert both_entered.wait(5)
    release.set()
    for thread in threads:
        thread.join(5)
        assert not thread.is_alive()
    assert calls == 2


def test_single_flight_tracking_is_pruned_for_many_keys(tmp_path: Path, monkeypatch: Any) -> None:
    host, adapter = _registered(tmp_path)
    monkeypatch.setattr(plugin, "turn", lambda *args, **kwargs: {
        "mode": "public", "block": "", "route_id": "agent-route",
        "state_domain": "shared", "transitioned": False, "audit": [],
    })
    callback = host.middleware["llm_request"]
    for index in range(plugin._TURN_CACHE_LIMIT * 2):
        assert callback(
            request={"messages": [{"role": "user", "content": "hello"}]},
            **_middleware_kwargs(turn_id=f"turn-{index}", session_id=f"session-{index}"),
        ) is None
    assert adapter._resolution_flights == {}


@pytest.mark.parametrize("api_mode", ["responses", "codex_responses"])
def test_responses_family_extracts_plain_string_user_content(api_mode: str) -> None:
    payload = {"input": [{"role": "user", "content": "/persona focus"}]}
    assert plugin.extract_utterance(payload, api_mode) == "/persona focus"


def test_none_input_falls_through_to_chat_paths() -> None:
    assert plugin.extract_utterance({"input": None}, "responses") is None
    with pytest.raises(TypeError):
        plugin._inject({"input": None}, "responses", "persona block")


def test_extract_utterance_strips_memory_context_decoration() -> None:
    payload = {
        "input": [{
            "role": "user",
            "content": "/persona mode-x\n\n<memory-context>synthetic memory</memory-context>",
        }],
    }
    assert plugin.extract_utterance(payload, "codex_responses") == "/persona mode-x"


def test_extract_utterance_does_not_mine_history_after_non_text_user_content() -> None:
    payload = {
        "input": [
            {"role": "user", "content": "older valid user message"},
            {"role": "user", "content": [{"type": "image", "url": "opaque"}]},
        ],
    }
    assert plugin.extract_utterance(payload, "responses") is None


def test_extract_utterance_preserves_inline_memory_context_near_match() -> None:
    content = "keep <memory-context>inline text</memory-context>"
    payload = {"input": [{"role": "user", "content": content}]}
    assert plugin.extract_utterance(payload, "codex_responses") == content


def test_extract_utterance_marker_at_start_returns_empty_string() -> None:
    payload = {"input": [{"role": "user", "content": "\n\n<memory-context>memory</memory-context>"}]}
    assert plugin.extract_utterance(payload, "responses") == ""


def test_responses_user_reasoning_item_is_not_a_message() -> None:
    payload = {"input": [{"type": "reasoning", "role": "user", "content": "synthetic"}]}
    assert plugin.extract_utterance(payload, "codex_responses") is None


def test_extract_utterance_prefers_messages_when_input_is_also_present() -> None:
    payload = {
        "messages": [{"role": "user", "content": "chat utterance"}],
        "input": "responses utterance",
    }
    assert plugin.extract_utterance(payload, "responses") == "chat utterance"


def test_inject_prefers_messages_and_preserves_responses_fields() -> None:
    payload = {
        "messages": [{"role": "user", "content": "chat utterance"}],
        "input": "responses utterance",
        "instructions": "stable instructions",
    }
    plugin._inject(payload, "responses", "persona block")
    assert payload["messages"] == [
        {"role": "system", "content": "persona block"},
        {"role": "user", "content": "chat utterance"},
    ]
    assert payload["input"] == "responses utterance"
    assert payload["instructions"] == "stable instructions"


def test_inject_uses_messages_when_input_key_is_missing() -> None:
    payload = {"messages": [{"role": "user", "content": "chat utterance"}]}
    plugin._inject(payload, "chat", "persona block")
    assert payload["messages"] == [
        {"role": "system", "content": "persona block"},
        {"role": "user", "content": "chat utterance"},
    ]


def test_codex_responses_skips_trailing_function_call_outputs() -> None:
    payload = {
        "input": [
            {"role": "user", "content": "first"},
            {"role": "user", "content": "last user"},
            {"type": "function_call_output", "call_id": "call-1", "output": "synthetic"},
            {"type": "function_call_output", "call_id": "call-2", "output": "synthetic"},
        ],
    }
    assert plugin.extract_utterance(payload, "codex_responses") == "last user"


def test_responses_extracts_plain_string_input() -> None:
    payload = {"input": "plain input\n\n<memory-context>synthetic memory</memory-context>"}
    assert plugin.extract_utterance(payload, "codex_responses") == "plain input"


@pytest.mark.parametrize("api_mode", ["chat", "anthropic_messages"])
def test_chat_family_extraction_is_unchanged(api_mode: str) -> None:
    payload = {
        "messages": [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "ignored"},
            {"role": "user", "content": "last user"},
        ],
    }
    assert plugin.extract_utterance(payload, api_mode) == "last user"


def test_chat_extraction_strips_memory_context_decoration() -> None:
    payload = {
        "messages": [{
            "role": "user",
            "content": "current utterance\n\n<memory-context>synthetic memory</memory-context>",
        }],
    }
    assert plugin.extract_utterance(payload, "anthropic_messages") == "current utterance"


def test_chat_mode_extraction_strips_memory_context_decoration() -> None:
    payload = {
        "messages": [{
            "role": "user",
            "content": "current utterance\n\n<memory-context>synthetic memory</memory-context>",
        }],
    }
    assert plugin.extract_utterance(payload, "chat") == "current utterance"


def test_callback_exception_is_no_injection_and_reported(tmp_path: Path, monkeypatch: Any) -> None:
    host, adapter = _registered(tmp_path)
    payload = {
        "messages": [{"role": "user", "content": "hello"}],
        "tools": [
            {"type": "function", "function": {"name": "persona_set"}},
            {"type": "function", "function": {"name": "safe_tool"}},
        ],
    }
    original = copy.deepcopy(payload)
    reports: list[BaseException] = []

    def explode(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("opaque callback failure")

    def capture(error: BaseException, ctx: Any) -> dict[str, Any]:
        reports.append(error)
        return {"degraded": False, "audit": []}

    monkeypatch.setattr(plugin, "turn", explode)
    monkeypatch.setattr(plugin, "report_adapter_error", capture)
    callback = host.middleware["llm_request"]
    fallback = callback(request=payload, **_middleware_kwargs(turn_id="failure"))
    assert [tool["function"]["name"] for tool in fallback["request"]["tools"]] == ["safe_tool"]
    assert fallback["request"]["messages"] == original["messages"]
    applied = _request_from_callback(callback, original, turn_id="failure-2")
    assert [tool["function"]["name"] for tool in applied["tools"]] == ["safe_tool"]
    assert len(reports) == 2
    _assert_no_active_tracking(adapter)


def test_report_and_injection_share_turn_key_fallback(tmp_path: Path, monkeypatch: Any) -> None:
    host, _adapter = _registered(tmp_path)
    captured: list[dict[str, Any]] = []
    monkeypatch.setattr(plugin, "turn", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("failure")))
    monkeypatch.setattr(plugin, "report_adapter_error", lambda error, ctx: captured.append(ctx) or {})
    host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id="", session_id="session-key"),
    )
    assert captured[0]["turn_key"] == "session-key"


def test_missing_install_root_disables_every_callback_without_writes(tmp_path: Path, monkeypatch: Any) -> None:
    host = Host(tmp_path / "unused")
    host.persona_engine_install_root = ""
    host.config = {"persona_engine_install_root": ""}
    monkeypatch.delenv("PERSONA_ENGINE_INSTALL_ROOT", raising=False)
    monkeypatch.chdir(tmp_path)
    before = sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*"))
    plugin.register(host)
    assert host.logger.messages == ["persona: adapter disabled because install root is not configured"]
    assert host.middleware == {}
    assert host.hooks == {}
    assert host.tools == {}
    after = sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*"))
    assert after == before


def test_pre_tool_blocks_cached_route_for_different_session(tmp_path: Path) -> None:
    host, _adapter = _registered(tmp_path)
    host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id="shared-turn", session_id="expected-session"),
    )
    blocked = host.hooks["pre_tool_call"](
        tool_name="persona_set", args={"mode": "focus"}, turn_id="shared-turn",
        session_id="different-session",
    )
    assert blocked == {"action": "block", "message": "persona_set is unavailable on this route"}


@pytest.mark.parametrize("hook_session_id", ["", None, "different-session"])
def test_pre_tool_requires_nonempty_exact_hook_session_id(
    tmp_path: Path, hook_session_id: Any,
) -> None:
    host, _adapter = _registered(tmp_path)
    host.middleware["llm_request"](
        request={"messages": [{"role": "user", "content": "hello"}]},
        **_middleware_kwargs(turn_id="session-check", session_id="expected-session"),
    )
    blocked = host.hooks["pre_tool_call"](
        tool_name="persona_set", args={"mode": "focus"}, turn_id="session-check",
        session_id=hook_session_id,
    )
    assert blocked == {"action": "block", "message": "persona_set is unavailable on this route"}


@pytest.mark.parametrize("cached_session_id", ["", None])
def test_pre_tool_requires_nonempty_cached_session_id(
    tmp_path: Path, cached_session_id: Any,
) -> None:
    host, adapter = _registered(tmp_path)
    adapter._turn_cache["cached-session-check"] = plugin._CacheEntry(
        "turn",
        {"state_domain": "shared", "block": "", "transitioned": False},
        {"session_id": cached_session_id},
        True,
    )
    blocked = host.hooks["pre_tool_call"](
        tool_name="persona_set", args={"mode": "focus"},
        turn_id="cached-session-check", session_id="expected-session",
    )
    assert blocked == {"action": "block", "message": "persona_set is unavailable on this route"}


@pytest.mark.parametrize("profile", ["", "../escape", "/tmp/escape", "bad\x00profile"])
def test_invalid_profile_disables_default_sessions_lookup(
    tmp_path: Path, monkeypatch: Any, profile: str,
) -> None:
    host = Host(tmp_path)
    host.persona_engine_profile = profile
    monkeypatch.delenv("PERSONA_ENGINE_SESSIONS_FILE", raising=False)
    assert plugin._sessions_file(host) == ""
    assert host.logger.messages == ["persona: Hermes profile sessions lookup unavailable"]


@pytest.mark.parametrize("profile", ["default", "nested/profile", r"nested\profile"])
def test_contained_profile_enables_default_sessions_lookup(
    tmp_path: Path, monkeypatch: Any, profile: str,
) -> None:
    host = Host(tmp_path)
    host.persona_engine_profile = profile
    monkeypatch.delenv("PERSONA_ENGINE_SESSIONS_FILE", raising=False)
    expected = (
        Path("~/.hermes/profiles").expanduser().resolve()
        / profile / "sessions" / "sessions.json"
    ).resolve()
    assert plugin._sessions_file(host) == str(expected)
    assert host.logger.messages == []


def test_invalid_profile_from_config_or_environment_disables_lookup(
    tmp_path: Path, monkeypatch: Any,
) -> None:
    host = Host(tmp_path)
    host.config = {"persona_engine_profile": "../config-escape"}
    assert plugin._sessions_file(host) == ""
    host.config = {}
    monkeypatch.setenv("HERMES_PROFILE", "/environment/escape")
    assert plugin._sessions_file(host) == ""
    assert host.logger.messages == [
        "persona: Hermes profile sessions lookup unavailable",
        "persona: Hermes profile sessions lookup unavailable",
    ]


def test_non_dict_request_is_defensively_ignored_and_reported(tmp_path: Path, monkeypatch: Any) -> None:
    host, _adapter = _registered(tmp_path)
    reports: list[BaseException] = []
    monkeypatch.setattr(plugin, "report_adapter_error", lambda error, ctx: reports.append(error) or {})
    callback = host.middleware["llm_request"]
    assert callback(request="not-a-dict", **_middleware_kwargs()) is None
    assert len(reports) == 1


def test_plugin_manifest_has_required_discovery_keys() -> None:
    path = Path(plugin.__file__).with_name("plugin.yaml")
    assert path.is_file()
    values = {
        line.split(":", 1)[0].strip(): line.split(":", 1)[1].strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith(" ") and ":" in line
    }
    assert {"name", "version", "description", "author", "kind", "platforms", "provides_tools", "hooks"} <= values.keys()
    assert values["name"] == "persona-engine"
    assert values["version"] == plugin.VERSION
    assert values["provides_tools"] == "[persona_set]"
    assert values["hooks"] == "[pre_tool_call]"
