from __future__ import annotations

import errno
import json
import os
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from adapters.hermes import runtime
from adapters.hermes.runtime import report_adapter_error, set as persona_set, turn


CASES = Path(__file__).resolve().parents[3] / "spec" / "fixtures" / "runtime" / "cases"
CASE_NAMES = sorted(path.name for path in CASES.iterdir() if path.is_dir())


def _assert_iso(value: str) -> None:
    assert isinstance(value, str)
    assert value.endswith("Z")
    datetime.fromisoformat(value[:-1] + "+00:00")


def _normalize_timestamps(actual: Any, expected: Any) -> Any:
    if isinstance(actual, list) and isinstance(expected, list):
        return [
            _normalize_timestamps(value, expected[index]) if index < len(expected) else value
            for index, value in enumerate(actual)
        ]
    if isinstance(actual, dict) and isinstance(expected, dict):
        result = {}
        for key, value in actual.items():
            if key == "ts":
                _assert_iso(value)
                result[key] = expected.get(key)
            else:
                result[key] = _normalize_timestamps(value, expected.get(key))
        return result
    return actual


@pytest.mark.parametrize("case_name", CASE_NAMES)
def test_runtime_conformance(case_name: str, tmp_path: Path) -> None:
    assert len(CASE_NAMES) == 13
    install_root = tmp_path / case_name
    shutil.copytree(CASES / case_name, install_root)
    fixture = json.loads((install_root / "case.json").read_text(encoding="utf-8"))
    assert fixture["id"] == case_name
    runtime_input = dict(fixture["input"])
    if isinstance(runtime_input.get("ctx"), dict) and runtime_input["ctx"].get("platform"):
        runtime_input["ctx"] = {**runtime_input["ctx"], "session_id": "conformance-session"}

    if fixture["operation"] == "turn":
        actual = turn(runtime_input, install_root, engine_version="0.0.0")
    elif fixture["operation"] == "set":
        actual = persona_set(runtime_input, install_root, engine_version="0.0.0")
    else:
        error_type = type(fixture["input"]["error"].get("name", "Error"), (Exception,), {})
        error = error_type(fixture["input"]["error"]["message"])
        actual = report_adapter_error(error, {
            "installRoot": install_root,
            **fixture["input"]["ctx"],
        })
        audit_text = (install_root / "audit" / "audit.jsonl").read_text(encoding="utf-8")
        status_text = (install_root / "state" / "status.json").read_text(encoding="utf-8")
        assert fixture["input"]["error"]["message"] not in audit_text + status_text

    assert _normalize_timestamps(actual, fixture["expected"]) == fixture["expected"]
    if "expected_status" in fixture:
        status = json.loads((install_root / "state" / "status.json").read_text(encoding="utf-8"))
        expected_status = dict(fixture["expected_status"])
        # report_adapter_error corrects a prior status in place and therefore
        # preserves the implementation id that originally wrote that status.
        assert _normalize_timestamps(status, expected_status) == expected_status


def test_state_protocol_names_and_python_status_id(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    result = persona_set(
        {"actor": "agent", "ctx": {"platform": "dummy", "session_id": "session"}, "requested_mode": "focus"},
        install_root,
        engine_version="0.0.0",
    )
    assert result["ok"] is True
    state = json.loads((install_root / "state" / "shared.json").read_text(encoding="utf-8"))
    assert state == {
        "v": 1,
        "revision": 1,
        "mode": "focus",
        "set_by": "agent",
        "set_at": state["set_at"],
        "route_id": "agent-route",
    }
    _assert_iso(state["set_at"])
    assert not (install_root / "state" / "shared.lock").exists()
    assert not (install_root / "state" / "shared.json.tmp").exists()

    turn({"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown", "turn_key": "t-1"}, install_root, engine_version="0.0.0")
    status = json.loads((install_root / "state" / "status.json").read_text(encoding="utf-8"))
    assert status["engine"] == "py@0.0.0"


def test_logs_exclude_utterance_and_block(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    opaque = "OPAQUE-UTTERANCE-MUST-NOT-BE-LOGGED"
    persona_set({"actor": "agent", "ctx": {"platform": "dummy", "session_id": "session"}, "requested_mode": "focus"}, install_root, engine_version="0.0.0")
    result = turn({"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown", "utterance": opaque}, install_root, engine_version="0.0.0")
    audit = (install_root / "audit" / "audit.jsonl").read_text(encoding="utf-8")
    status = (install_root / "state" / "status.json").read_text(encoding="utf-8")
    assert opaque not in audit + status
    assert result["block"] not in audit + status


def test_stale_lock_recovery_uses_shared_protocol(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    state_root = install_root / "state"
    state_root.mkdir()
    lock = state_root / "shared.lock"
    lock.write_text("crashed-ts-token", encoding="utf-8")
    old = time.time() - runtime.STALE_LOCK_SECONDS - 1
    os.utime(lock, (old, old))
    result = persona_set({"actor": "agent", "ctx": {"platform": "dummy", "session_id": "session"}, "requested_mode": "focus"}, install_root, engine_version="0.0.0")
    assert result["ok"] is True
    assert not lock.exists()
    assert not (state_root / "shared.lock.recovery").exists()


def test_fresh_lock_times_out_fail_closed(tmp_path: Path, monkeypatch: Any) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    state_root = install_root / "state"
    state_root.mkdir()
    (state_root / "shared.lock").write_text("live-ts-token", encoding="utf-8")
    monkeypatch.setattr(runtime, "LOCK_TIMEOUT_SECONDS", 0.03)
    result = persona_set(
        {"actor": "agent", "ctx": {"platform": "dummy", "session_id": "session"}, "requested_mode": "focus"},
        install_root, engine_version="0.0.0",
    )
    assert result["ok"] is False
    assert result["mode"] == "public"
    assert result["audit"][-1]["event"] == "state_error"


def test_same_revision_concurrent_cas_has_exactly_one_winner(tmp_path: Path) -> None:
    state_root = tmp_path / "state"

    def write(mode: str) -> dict[str, Any]:
        return runtime._cas(
            state_root, "shared", 0, mode, "agent", "agent-route",
            "1970-01-01T00:00:00.000Z", None,
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(write, [f"dummy-{index}" for index in range(8)]))

    assert [result["status"] for result in results].count("applied") == 1
    assert [result["status"] for result in results].count("revision_mismatch") == 7
    state = json.loads((state_root / "shared.json").read_text(encoding="utf-8"))
    assert state["revision"] == 1
    assert not (state_root / "shared.lock").exists()


def test_lock_initialization_failure_cleans_descriptor_and_lock(tmp_path: Path, monkeypatch: Any) -> None:
    lock = tmp_path / "shared.lock"
    real_fsync = os.fsync

    def fail_fsync(descriptor: int) -> None:
        del descriptor
        raise OSError("disk failure")

    monkeypatch.setattr(os, "fsync", fail_fsync)
    assert runtime._acquire_lock(lock, 0.01, 5.0) is None
    assert not lock.exists()
    monkeypatch.setattr(os, "fsync", real_fsync)


def test_lock_release_decode_or_post_commit_failure_does_not_propagate(tmp_path: Path, monkeypatch: Any) -> None:
    lock = tmp_path / "foreign.lock"
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(descriptor, b"\xff")
    runtime._release_lock(lock, descriptor, "our-token")
    assert lock.read_bytes() == b"\xff"

    state_root = tmp_path / "state"
    monkeypatch.setattr(runtime, "_release_lock", lambda *args: (_ for _ in ()).throw(OSError("release failed")))
    result = runtime._cas(
        state_root, "shared", 0, "focus", "agent", "agent-route",
        "1970-01-01T00:00:00.000Z", None,
    )
    assert result["status"] == "applied"
    assert json.loads((state_root / "shared.json").read_text(encoding="utf-8"))["revision"] == 1


def test_short_audit_write_is_degraded(tmp_path: Path, monkeypatch: Any) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-reject-explicit-only", install_root)
    real_write = os.write

    def short_write(descriptor: int, payload: bytes) -> int:
        if payload.startswith(b'{"ts"'):
            return max(0, len(payload) - 1)
        return real_write(descriptor, payload)

    monkeypatch.setattr(os, "write", short_write)
    result = persona_set(
        {"actor": "agent", "ctx": {"platform": "dummy", "session_id": "session"}, "requested_mode": "focus"},
        install_root,
        engine_version="0.0.0",
    )
    assert result["ok"] is False
    assert result["degraded"] is True


def test_semver_rejects_unicode_digits() -> None:
    assert runtime.SEMVER.fullmatch("1.2.3")
    assert runtime.SEMVER.fullmatch("1.٢.3") is None


def test_unknown_set_actor_is_structured_rejection(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    result = persona_set(
        {"actor": "intruder", "ctx": {"platform": "dummy"}, "requested_mode": "focus"},
        install_root, engine_version="0.0.0",
    )
    assert result["ok"] is False
    assert result["transitioned"] is False
    assert result["rejected"]["reason"] == "unsupported actor"


def test_admin_set_branch_applies_allowed_mode(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    result = persona_set(
        {"actor": "admin", "domain": "shared", "requested_mode": "focus"},
        install_root, engine_version="0.0.0",
    )
    assert result["ok"] is True
    assert result["mode"] == "focus"
    assert result["audit"][-1]["set_by"] == "admin"


def test_engine_minor_mismatch_is_incompatible(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "minimal-turn", install_root)
    result = turn(
        {"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown"},
        install_root, engine_version="0.1.0",
    )
    assert result["mode"] == "public"
    assert any(event.get("reason") == "manifest-incompatible" for event in result["audit"])


def test_malformed_policy_precedes_missing_manifest(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    (install_root / "build" / "policy.json").write_text("{}\n", encoding="utf-8")
    (install_root / "build" / "manifest.json").unlink()

    loaded, policy, reason = runtime._load_build(install_root, "0.0.0")

    assert loaded is None
    assert policy is None
    assert reason == "policy-invalid"


def test_bom_prefixed_manifest_is_rejected_as_build_invalid(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    manifest_path = install_root / "build" / "manifest.json"
    manifest_path.write_bytes(b"\xef\xbb\xbf" + manifest_path.read_bytes())

    result = turn(
        {"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown"},
        install_root,
        engine_version="0.0.0",
    )

    assert result["mode"] == "public"
    assert result["block"] == ""
    assert result["audit"][-1]["event"] == "build_invalid"
    assert result["audit"][-1]["reason"] == "build-artifact-unavailable"


def test_build_json_symlink_is_rejected_fail_closed_and_audited(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    triggers_path = install_root / "build" / "triggers.json"
    replacement = tmp_path / "replacement.json"
    replacement.write_bytes(triggers_path.read_bytes())
    triggers_path.unlink()
    triggers_path.symlink_to(replacement)

    result = turn(
        {
            "ctx": {"platform": "dummy", "session_id": "session"},
            "actor": "owner",
            "utterance": "/persona focus",
        },
        install_root,
        engine_version="0.0.0",
    )

    assert result["mode"] == "public"
    assert result["block"] == ""
    assert result["transitioned"] is False
    assert result["audit"][-1]["event"] == "build_invalid"
    assert result["audit"][-1]["reason"] == "build-artifact-unavailable"
    assert not (install_root / "state" / "shared.json").exists()
    audit = (install_root / "audit" / "audit.jsonl").read_text(encoding="utf-8")
    assert '"event":"build_invalid"' in audit
    assert '"reason":"build-artifact-unavailable"' in audit


def test_manifest_json_symlink_is_rejected_fail_closed(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    manifest_path = install_root / "build" / "manifest.json"
    replacement = tmp_path / "replacement-manifest.json"
    replacement.write_bytes(manifest_path.read_bytes())
    manifest_path.unlink()
    manifest_path.symlink_to(replacement)

    result = turn(
        {"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown"},
        install_root,
        engine_version="0.0.0",
    )

    assert result["mode"] == "public"
    assert result["block"] == ""
    assert result["audit"][-1]["event"] == "build_invalid"
    assert result["audit"][-1]["reason"] == "build-artifact-unavailable"


def test_policy_json_symlink_rejection_uses_default_audit_root(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    policy_path = install_root / "build" / "policy.json"
    replacement = tmp_path / "replacement-policy.json"
    replacement.write_bytes(policy_path.read_bytes())
    policy_path.unlink()
    policy_path.symlink_to(replacement)

    result = turn(
        {
            "ctx": {"platform": "dummy", "session_id": "session"},
            "actor": "owner",
            "utterance": "/persona focus",
        },
        install_root,
        engine_version="0.0.0",
    )

    assert result["mode"] == "public"
    assert result["block"] == ""
    assert result["transitioned"] is False
    assert result["audit"][-1]["event"] == "build_invalid"
    assert result["audit"][-1]["reason"] == "policy-unavailable"
    assert not (install_root / "state" / "shared.json").exists()
    audit = (install_root / "audit" / "audit.jsonl").read_text(encoding="utf-8")
    assert '"event":"build_invalid"' in audit
    assert '"reason":"policy-unavailable"' in audit


def test_report_adapter_error_rejects_symlinked_policy_fail_closed(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    policy_path = install_root / "build" / "policy.json"
    replacement = tmp_path / "replacement-policy.json"
    replacement_policy = json.loads(policy_path.read_text(encoding="utf-8"))
    replacement_policy["default_route"]["state_domain"] = "attacker-domain"
    replacement.write_text(json.dumps(replacement_policy), encoding="utf-8")
    policy_path.unlink()
    policy_path.symlink_to(replacement)

    warnings: list[str] = []
    result = report_adapter_error(
        RuntimeError("secret detail"),
        {"installRoot": install_root, "warn": warnings.append},
    )

    assert result["audit"][0]["event"] == "adapter_error"
    assert result["audit"][0]["domain"] == "quarantine"
    assert result["degraded"] is True
    assert warnings == ["persona: audit unavailable because compiled policy is invalid"]
    assert not (install_root / "audit").exists()


def test_symlinked_build_directory_is_rejected_fail_closed(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    build_root = install_root / "build"
    external_build = tmp_path / "external-build"
    shutil.copytree(build_root, external_build)
    shutil.rmtree(build_root)
    build_root.symlink_to(external_build, target_is_directory=True)

    result = turn(
        {
            "ctx": {"platform": "dummy", "session_id": "session"},
            "actor": "owner",
            "utterance": "/persona focus",
        },
        install_root,
        engine_version="0.0.0",
    )

    assert result["mode"] == "public"
    assert result["block"] == ""
    assert result["transitioned"] is False
    assert result["audit"][-1]["event"] == "build_invalid"
    assert result["audit"][-1]["reason"] == "policy-unavailable"
    assert not (install_root / "state" / "shared.json").exists()
    audit = (install_root / "audit" / "audit.jsonl").read_text(encoding="utf-8")
    assert '"event":"build_invalid"' in audit
    assert '"reason":"policy-unavailable"' in audit


def test_build_generation_is_pinned_across_all_json_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    build_root = install_root / "build"
    old_build = install_root / "build-old"
    descriptors: list[int | None] = []
    original_build_json = runtime._build_json

    def swapping_build_json(path: Path, parent_descriptor: int | None = None) -> Any:
        value = original_build_json(path, parent_descriptor)
        descriptors.append(parent_descriptor)
        if path.name == "policy.json":
            build_root.rename(old_build)
            shutil.copytree(old_build, build_root)
            triggers_path = build_root / "triggers.json"
            triggers = json.loads(triggers_path.read_text(encoding="utf-8"))
            triggers["reserved_prefix"] = "/new-generation"
            triggers_path.write_text(json.dumps(triggers), encoding="utf-8")
        return value

    monkeypatch.setattr(runtime, "_build_json", swapping_build_json)

    loaded, _, error = runtime._load_build(install_root, "0.0.0")

    assert error is None
    assert loaded is not None
    assert loaded["triggers"]["reserved_prefix"] == "/persona"
    assert len(descriptors) == 3
    assert descriptors[0] is not None
    assert len(set(descriptors)) == 1


@pytest.mark.parametrize("target", ["parent", "leaf"])
def test_build_json_maps_enotdir_to_invalid(
    target: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    build_root = tmp_path / "build"
    build_root.mkdir()
    artifact = build_root / "policy.json"
    artifact.write_text("{}\n", encoding="utf-8")
    original_open = runtime.os.open

    def failing_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        is_target = (target == "parent" and Path(path) == build_root) or (
            target == "leaf" and path == artifact.name and dir_fd is not None
        )
        if is_target:
            raise OSError(errno.ENOTDIR, "injected non-directory race")
        return original_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(runtime.os, "open", failing_open)

    with pytest.raises(runtime.BuildArtifactInvalid) as caught:
        runtime._build_json(artifact)
    assert isinstance(caught.value.__cause__, OSError)
    assert caught.value.__cause__.errno == errno.ENOTDIR


def test_build_json_rechecks_leaf_after_non_race_open_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    build_root = tmp_path / "build"
    build_root.mkdir()
    artifact = build_root / "policy.json"
    artifact.write_text("{}\n", encoding="utf-8")
    original_open = runtime.os.open
    original_stat = runtime.os.stat
    leaf_stats = 0

    def failing_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        if path == artifact.name and dir_fd is not None:
            raise OSError(errno.EACCES, "injected access failure")
        return original_open(path, flags, mode, dir_fd=dir_fd)

    def recording_stat(path: Any, *args: Any, **kwargs: Any) -> os.stat_result:
        nonlocal leaf_stats
        if path == artifact.name and kwargs.get("dir_fd") is not None:
            leaf_stats += 1
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(runtime.os, "open", failing_open)
    monkeypatch.setattr(runtime.os, "stat", recording_stat)

    with pytest.raises(OSError) as caught:
        runtime._build_json(artifact)
    assert caught.value.errno == errno.EACCES
    assert leaf_stats == 2


def test_verification_stat_enoent_uses_default_policy_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    original_stat = runtime.os.stat
    policy_stats = 0

    def failing_verification_stat(path: Any, *args: Any, **kwargs: Any) -> os.stat_result:
        nonlocal policy_stats
        if path == "policy.json" and kwargs.get("dir_fd") is not None:
            policy_stats += 1
            if policy_stats == 2:
                raise FileNotFoundError(errno.ENOENT, "injected verification race", path)
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(runtime.os, "stat", failing_verification_stat)

    result = turn(
        {"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown"},
        install_root,
        engine_version="0.0.0",
    )

    assert policy_stats == 2
    assert result["mode"] == "public"
    assert result["block"] == ""
    assert result["audit"][-1]["event"] == "build_invalid"
    assert result["audit"][-1]["reason"] == "policy-unavailable"
    audit = (install_root / "audit" / "audit.jsonl").read_text(encoding="utf-8")
    assert '"event":"build_invalid"' in audit
    assert '"reason":"policy-unavailable"' in audit


def test_fifo_json_trust_root_is_rejected_without_opening(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    triggers_path = install_root / "build" / "triggers.json"
    triggers_path.unlink()
    os.mkfifo(triggers_path)
    original_open = runtime.os.open
    opened_fifo = False

    def recording_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal opened_fifo
        if path == triggers_path.name and dir_fd is not None:
            opened_fifo = True
        return original_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(runtime.os, "open", recording_open)

    result = turn(
        {"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown"},
        install_root,
        engine_version="0.0.0",
    )

    assert result["mode"] == "public"
    assert result["block"] == ""
    assert result["audit"][-1]["event"] == "build_invalid"
    assert result["audit"][-1]["reason"] == "build-artifact-unavailable"
    assert opened_fifo is False


def test_symlinked_mode_block_is_rejected_fail_closed(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    block_path = install_root / "build" / "modes" / "focus.md"
    replacement = tmp_path / "replacement-focus.md"
    replacement.write_bytes(block_path.read_bytes())
    block_path.unlink()
    block_path.symlink_to(replacement)

    result = turn(
        {"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown"},
        install_root,
        engine_version="0.0.0",
    )

    assert result["mode"] == "public"
    assert result["block"] == ""
    assert result["audit"][-1]["event"] == "build_invalid"
    assert result["audit"][-1]["reason"] == "block-unavailable"


def test_symlinked_modes_directory_is_rejected_fail_closed(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    modes_root = install_root / "build" / "modes"
    external_modes = tmp_path / "external-modes"
    shutil.copytree(modes_root, external_modes)
    shutil.rmtree(modes_root)
    modes_root.symlink_to(external_modes, target_is_directory=True)

    result = turn(
        {"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown"},
        install_root,
        engine_version="0.0.0",
    )

    assert result["mode"] == "public"
    assert result["block"] == ""
    assert result["audit"][-1]["event"] == "build_invalid"
    assert result["audit"][-1]["reason"] == "block-unavailable"


def test_build_json_maps_restored_leaf_eloop_to_invalid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    build_root = tmp_path / "build"
    build_root.mkdir()
    artifact = build_root / "policy.json"
    artifact.write_text("{}\n", encoding="utf-8")
    original_open = runtime.os.open

    def racing_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        if path == artifact.name and dir_fd is not None:
            raise OSError(errno.ELOOP, "injected restored-leaf race")
        return original_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(runtime.os, "open", racing_open)

    with pytest.raises(runtime.BuildArtifactInvalid) as caught:
        runtime._build_json(artifact)
    assert isinstance(caught.value.__cause__, OSError)
    assert caught.value.__cause__.errno == errno.ELOOP


def test_newer_state_version_is_public_and_not_rewritten(tmp_path: Path) -> None:
    install_root = tmp_path / "case"
    shutil.copytree(CASES / "agent-switch-accept", install_root)
    state_root = install_root / "state"
    state_root.mkdir()
    state_path = state_root / "shared.json"
    original = '{"v":2,"revision":9,"mode":"focus"}\n'
    state_path.write_text(original, encoding="utf-8")
    result = turn(
        {"ctx": {"platform": "dummy", "session_id": "session"}, "actor": "unknown"},
        install_root, engine_version="0.0.0",
    )
    assert result["mode"] == "public"
    assert result["audit"][-1]["event"] == "state_error"
    assert state_path.read_text(encoding="utf-8") == original


def test_report_adapter_error_never_raises_without_install_root() -> None:
    warnings: list[str] = []
    result = report_adapter_error(RuntimeError("opaque"), {"warn": warnings.append})
    assert result == {"degraded": True, "audit": []}
    assert warnings == ["persona: failed to report adapter error"]

    class BrokenContext(dict[str, Any]):
        def get(self, key: str, default: Any = None) -> Any:
            del key, default
            raise RuntimeError("broken mapping")

    assert report_adapter_error(RuntimeError("opaque"), BrokenContext()) == {
        "degraded": True, "audit": [],
    }


def test_timestamp_normalizer_preserves_extra_actual_events() -> None:
    actual = [{"event": "expected"}, {"event": "extra"}]
    assert _normalize_timestamps(actual, [{"event": "expected"}]) == actual
