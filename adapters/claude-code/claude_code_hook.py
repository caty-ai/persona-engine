#!/usr/bin/env python3
"""Claude Code hook bridge for a local Persona Engine installation."""

import json
import os
import subprocess
import sys
from typing import Any, Mapping


DEFAULT_TIMEOUT_SECONDS = 10.0
MAX_TIMEOUT_SECONDS = 60.0


class AdapterFailure(Exception):
    """A failure that must not inject persona context."""


def fail_safe(message: str, install_dir: str | None, context: Mapping[str, str]) -> int:
    if install_dir:
        report_adapter_error(install_dir, context)
    sys.stderr.write(f"persona Claude Code adapter: {message}; continuing without persona context\n")
    return 0


def configuration() -> tuple[str, str, float]:
    install_dir = os.environ.get("PERSONA_INSTALL_DIR") or os.environ.get("PERSONA_ENGINE_INSTALL_ROOT")
    if not install_dir:
        raise AdapterFailure("PERSONA_INSTALL_DIR is not configured")
    persona_bin = os.environ.get("PERSONA_BIN", "persona")
    try:
        timeout = float(os.environ.get("PERSONA_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)))
    except ValueError as error:
        raise AdapterFailure("PERSONA_TIMEOUT_SECONDS is invalid") from error
    if timeout <= 0 or timeout > MAX_TIMEOUT_SECONDS:
        raise AdapterFailure("PERSONA_TIMEOUT_SECONDS is outside the supported range")
    return install_dir, persona_bin, timeout


def run_persona(
    persona_bin: str,
    args: list[str],
    request: Mapping[str, Any],
    timeout: float,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [persona_bin, *args],
            input=json.dumps(request),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AdapterFailure("Persona Engine is unavailable") from error


def report_adapter_error(install_dir: str, context: Mapping[str, str]) -> None:
    try:
        persona_bin = os.environ.get("PERSONA_BIN", "persona")
        try:
            timeout = float(os.environ.get("PERSONA_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)))
        except ValueError:
            timeout = DEFAULT_TIMEOUT_SECONDS
        if not 0 < timeout <= MAX_TIMEOUT_SECONDS:
            timeout = DEFAULT_TIMEOUT_SECONDS
        run_persona(
            persona_bin,
            ["report-adapter-error", "--stdin-json", "--dir", install_dir],
            {"error": {"name": "ClaudeCodeAdapterFailure"}, "ctx": dict(context)},
            timeout,
        )
    except (AdapterFailure, ValueError):
        pass


def hook_input() -> Mapping[str, Any]:
    try:
        value = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as error:
        raise AdapterFailure("hook input is not valid JSON") from error
    if not isinstance(value, dict):
        raise AdapterFailure("hook input must be a JSON object")
    return value


def required_string(payload: Mapping[str, Any], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value:
        raise AdapterFailure(f"hook input is missing {field}")
    return value


def turn_request(event: str, payload: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    session_id = required_string(payload, "session_id")
    context = {"platform": "claude_code", "session_id": session_id}
    request: dict[str, Any] = {
        "actor": "unknown",
        "ctx": context,
        "turn_key": session_id,
    }
    if event == "UserPromptSubmit":
        request["utterance"] = required_string(payload, "prompt")
    return request, context


def result_block(result: subprocess.CompletedProcess[str]) -> str:
    if result.returncode not in (0, 2):
        raise AdapterFailure("Persona Engine returned an error")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AdapterFailure("Persona Engine returned invalid JSON") from error
    if not isinstance(value, dict) or value.get("degraded") is True:
        raise AdapterFailure("Persona Engine returned an unsafe result")
    block = value.get("block")
    if not isinstance(block, str):
        raise AdapterFailure("Persona Engine result is incomplete")
    return block


def emit_context(event: str, block: str) -> None:
    if not block:
        return
    if event == "UserPromptSubmit":
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": block,
            },
        }))
    else:
        print(block)


def main() -> int:
    install_dir = os.environ.get("PERSONA_INSTALL_DIR") or os.environ.get("PERSONA_ENGINE_INSTALL_ROOT")
    context: dict[str, str] = {}
    try:
        payload = hook_input()
        event = required_string(payload, "hook_event_name")
        if event not in {"UserPromptSubmit", "SessionStart"}:
            raise AdapterFailure("hook event is unsupported")
        request, context = turn_request(event, payload)
        install_dir, persona_bin, timeout = configuration()
        result = run_persona(
            persona_bin,
            ["turn", "--stdin-json", "--dir", install_dir],
            request,
            timeout,
        )
        emit_context(event, result_block(result))
        return 0
    except AdapterFailure as error:
        return fail_safe(str(error), install_dir, context)
    except Exception:
        return fail_safe("unexpected adapter failure", install_dir, context)


if __name__ == "__main__":
    raise SystemExit(main())
