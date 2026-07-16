import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[3]
HOOK = ROOT / "adapters" / "claude-code" / "claude_code_hook.py"
PERSONA = ROOT / "packages" / "core" / "bin" / "persona"


def persona(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(PERSONA), *args],
        cwd=cwd,
        text=True,
        capture_output=True,
        check=True,
    )


@pytest.fixture
def install(tmp_path: Path) -> Path:
    root = tmp_path / "install"
    persona("init", "--yes", str(root), cwd=tmp_path)
    persona("build", "--dir", str(root), cwd=tmp_path)
    return root


def run_hook(payload: object, install_dir: Path | None, **overrides: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PERSONA_BIN"] = str(PERSONA)
    env.update(overrides)
    if install_dir is not None:
        env["PERSONA_INSTALL_DIR"] = str(install_dir)
    else:
        env.pop("PERSONA_INSTALL_DIR", None)
    return subprocess.run(
        [sys.executable, str(HOOK)],
        cwd=ROOT,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )


def user_prompt(prompt: str = "Explain the current task") -> dict[str, str]:
    return {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "session-123",
        "prompt": prompt,
        "cwd": "project",
    }


def test_user_prompt_injects_the_active_persona_block(install: Path) -> None:
    persona("set", "default", "--domain", "default", "--dir", str(install), cwd=install)

    result = run_hook(user_prompt(), install)

    assert result.returncode == 0
    assert result.stderr == ""
    output = json.loads(result.stdout)
    hook_output = output["hookSpecificOutput"]
    assert hook_output["hookEventName"] == "UserPromptSubmit"
    assert "Replace this text with your persona instructions." in hook_output["additionalContext"]


def test_mode_switch_is_reflected_on_the_next_turn(install: Path) -> None:
    persona("set", "default", "--domain", "default", "--dir", str(install), cwd=install)
    assert run_hook(user_prompt(), install).stdout

    persona("set", "public", "--domain", "default", "--dir", str(install), cwd=install)
    result = run_hook(user_prompt("A later prompt"), install)

    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""


def test_session_start_emits_plain_context(install: Path) -> None:
    persona("set", "default", "--domain", "default", "--dir", str(install), cwd=install)

    result = run_hook({"hook_event_name": "SessionStart", "session_id": "session-123"}, install)

    assert result.returncode == 0
    assert "Replace this text with your persona instructions." in result.stdout
    assert result.stderr == ""


def test_engine_error_is_safe_and_reports_without_context(install: Path) -> None:
    manifest = install / "build" / "manifest.json"
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["pack_name"] = "Invalid_Pack"
    manifest.write_text(json.dumps(value), encoding="utf-8")

    result = run_hook(user_prompt(), install)

    assert result.returncode == 0
    assert result.stdout == ""
    assert "continuing without persona context" in result.stderr
    audit = (install / "audit" / "audit.jsonl").read_text(encoding="utf-8")
    assert '"event":"adapter_error"' in audit


def test_missing_install_is_safe(tmp_path: Path) -> None:
    result = run_hook(user_prompt(), tmp_path / "missing-install")

    assert result.returncode == 0
    assert result.stdout == ""
    assert "continuing without persona context" in result.stderr


def test_malformed_stdin_is_safe(install: Path) -> None:
    env = os.environ.copy()
    env["PERSONA_INSTALL_DIR"] = str(install)
    env["PERSONA_BIN"] = str(PERSONA)
    result = subprocess.run(
        [sys.executable, str(HOOK)],
        cwd=ROOT,
        input="{",
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )

    assert result.returncode == 0
    assert result.stdout == ""
    assert "continuing without persona context" in result.stderr


def test_timeout_is_safe(tmp_path: Path) -> None:
    slow = tmp_path / "slow-persona"
    slow.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(2)\n", encoding="utf-8")
    slow.chmod(slow.stat().st_mode | stat.S_IXUSR)

    result = run_hook(
        user_prompt(),
        tmp_path / "install",
        PERSONA_BIN=str(slow),
        PERSONA_TIMEOUT_SECONDS="0.05",
    )

    assert result.returncode == 0
    assert result.stdout == ""
    assert "continuing without persona context" in result.stderr
