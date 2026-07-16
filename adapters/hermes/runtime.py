"""Stdlib-only Python runtime for compiled persona-engine installs.

This module deliberately consumes only compiled JSON, compiled mode blocks,
and state files. It is the Python counterpart of the TS turn/state runtime.
"""

from __future__ import annotations

import hashlib
import builtins
import errno
import json
import os
import re
import stat
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .version import VERSION

IMPLEMENTATION = "py"
STATE_VERSION = 1
LOCK_TIMEOUT_SECONDS = 2.0
STALE_LOCK_SECONDS = 5.0
LOCK_RETRY_SECONDS = 0.02
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MODE_ID = re.compile(r"^[a-z0-9-]+$")
DOMAIN_ID = re.compile(r"^[a-z0-9_-]{1,64}$")
SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
WHITESPACE = re.compile(
    "[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680"
    "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+"
)

Now = Callable[[], datetime]
Warn = Callable[[str], None]


class BuildArtifactInvalid(Exception):
    """A compiled trust root is not the regular file the runtime opened."""


def _now(now: Now | None = None) -> datetime:
    value = (now or (lambda: datetime.now(timezone.utc)))()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(now: Now | None = None) -> str:
    return _now(now).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _warn(warn: Warn | None, message: str) -> None:
    try:
        if warn is not None:
            warn(message)
    except Exception:
        pass


def _record(value: Any) -> bool:
    return isinstance(value, dict)


def _integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _open_anchored_directory(path: Path, *, dir_fd: int | None = None) -> int:
    """Open a directory without following links and verify its anchored identity."""
    before = os.stat(path.name if dir_fd is not None else path, dir_fd=dir_fd, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode):
        raise BuildArtifactInvalid("build directory is not a regular directory")
    directory_flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        directory_flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        directory_flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path.name if dir_fd is not None else path, directory_flags, dir_fd=dir_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise BuildArtifactInvalid("build directory changed during open") from error
        raise
    try:
        try:
            opened = os.fstat(descriptor)
            verified = os.stat(
                path.name if dir_fd is not None else path,
                dir_fd=dir_fd,
                follow_symlinks=False,
            )
        except OSError as error:
            raise BuildArtifactInvalid("build directory changed during open") from error
        if (
            not stat.S_ISDIR(opened.st_mode)
            or not stat.S_ISDIR(verified.st_mode)
            or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            or (opened.st_dev, opened.st_ino) != (verified.st_dev, verified.st_ino)
        ):
            raise BuildArtifactInvalid("build directory changed during open")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _anchored_bytes(parent_descriptor: int, leaf: str) -> bytes:
    """Read one regular-file leaf through an already-open parent directory."""
    before = os.stat(leaf, dir_fd=parent_descriptor, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode):
        raise BuildArtifactInvalid("build artifact is not a regular file")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(leaf, flags, dir_fd=parent_descriptor)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise BuildArtifactInvalid("build artifact changed during open") from error
        try:
            verified = os.stat(leaf, dir_fd=parent_descriptor, follow_symlinks=False)
            if not stat.S_ISREG(verified.st_mode):
                raise BuildArtifactInvalid("build artifact changed during open") from error
        except FileNotFoundError:
            pass
        except OSError as verification_error:
            if verification_error.errno in (errno.ELOOP, errno.ENOTDIR):
                raise BuildArtifactInvalid("build artifact changed during open") from error
        raise
    try:
        try:
            opened = os.fstat(descriptor)
            verified = os.stat(leaf, dir_fd=parent_descriptor, follow_symlinks=False)
        except OSError as error:
            raise BuildArtifactInvalid("build artifact changed during open") from error
        identity = (opened.st_dev, opened.st_ino)
        if (
            not stat.S_ISREG(opened.st_mode)
            or not stat.S_ISREG(verified.st_mode)
            or identity != (before.st_dev, before.st_ino)
            or identity != (verified.st_dev, verified.st_ino)
        ):
            raise BuildArtifactInvalid("build artifact changed during open")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = -1
            return handle.read()
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _build_json(path: Path, parent_descriptor: int | None = None) -> Any:
    """Read a compiled JSON trust root through an anchored build directory."""
    owns_parent = parent_descriptor is None
    if parent_descriptor is None:
        parent_descriptor = _open_anchored_directory(path.parent)
    try:
        text = _anchored_bytes(parent_descriptor, path.name).decode("utf-8", errors="strict")
        if text.startswith("\ufeff"):
            raise ValueError("compiled JSON must not start with a byte-order mark")
        return json.loads(text)
    finally:
        if owns_parent:
            os.close(parent_descriptor)


def _engine_compatible(built: str, running: str) -> bool:
    built_match = SEMVER.fullmatch(built)
    running_match = SEMVER.fullmatch(running)
    return bool(
        built_match
        and running_match
        and built_match.group(1, 2) == running_match.group(1, 2)
    )


def _parseable_datetime(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
        return True
    except ValueError:
        return False


def _valid_route(value: Any) -> bool:
    if not _record(value) or not isinstance(value.get("id"), str):
        return False
    matches = value.get("match")
    if not _record(matches):
        return False
    for match in matches.values():
        if isinstance(match, str):
            continue
        if not (_record(match) and builtins.set(match) == {"prefix"} and isinstance(match["prefix"], str)):
            return False
    allowed = value.get("allowed_modes")
    switching = value.get("switching")
    return bool(
        isinstance(allowed, list)
        and all(isinstance(mode, str) for mode in allowed)
        and switching in {"deny", "explicit", "explicit-and-agent"}
        and isinstance(value.get("state_domain"), str)
        and DOMAIN_ID.fullmatch(value["state_domain"])
        and ("owner_verified" not in value or isinstance(value["owner_verified"], bool))
        and (switching == "deny" or value.get("owner_verified") is True)
    )


def _valid_policy(value: Any) -> bool:
    if not _record(value):
        return False
    routes = value.get("routes")
    domains = value.get("domains")
    modes = value.get("modes")
    default = value.get("default_route")
    if not (
        isinstance(routes, list)
        and all(_valid_route(route) for route in routes)
        and isinstance(domains, list)
        and all(isinstance(domain, str) and DOMAIN_ID.fullmatch(domain) for domain in domains)
        and isinstance(modes, list)
        and all(isinstance(mode, str) for mode in modes)
        and _record(default)
        and isinstance(default.get("state_domain"), str)
        and isinstance(value.get("audit_dir"), str)
        and "public" in modes
        and default["state_domain"] in domains
    ):
        return False
    route_ids: set[str] = builtins.set()
    mode_set = builtins.set(modes)
    for route in routes:
        if route["id"] in route_ids or route["state_domain"] not in domains:
            return False
        route_ids.add(route["id"])
        if any(mode != "public" and mode not in mode_set for mode in route["allowed_modes"]):
            return False
    return True


def _valid_manifest(value: Any) -> bool:
    if not _record(value):
        return False
    engine_range = value.get("engine_range")
    modes = value.get("modes")
    if not (
        value.get("schema_version") == 2
        and isinstance(value.get("pack_name"), str)
        and MODE_ID.fullmatch(value["pack_name"])
        and isinstance(value.get("pack_version"), str)
        and SEMVER.fullmatch(value["pack_version"])
        and isinstance(value.get("engine_version"), str)
        and SEMVER.fullmatch(value["engine_version"])
        and _record(engine_range)
        and isinstance(engine_range.get("min"), str)
        and SEMVER.fullmatch(engine_range["min"])
        and (engine_range.get("max") is None or (
            isinstance(engine_range.get("max"), str) and SEMVER.fullmatch(engine_range["max"])
        ))
        and _parseable_datetime(value.get("built_at"))
        and value.get("counter") == "pe-count-v1"
        and isinstance(value.get("content_hash"), str)
        and re.fullmatch(r"[0-9a-f]{64}", value["content_hash"])
        and _record(modes)
    ):
        return False
    for mode, metadata in modes.items():
        if not (isinstance(mode, str) and MODE_ID.fullmatch(mode) and _record(metadata)):
            return False
        if not (
            _integer(metadata.get("bytes")) and 0 <= metadata["bytes"] <= MAX_SAFE_INTEGER
            and _integer(metadata.get("tokens")) and 0 <= metadata["tokens"] <= MAX_SAFE_INTEGER
            and isinstance(metadata.get("sha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", metadata["sha256"])
            and ("voice_hint" not in metadata or isinstance(metadata["voice_hint"], str))
        ):
            return False
    return True


def _valid_triggers(value: Any) -> bool:
    return bool(
        _record(value)
        and value.get("normalization") == 1
        and value.get("reserved_prefix") == "/persona"
        and _record(value.get("aliases"))
        and all(isinstance(mode, str) for mode in value["aliases"].values())
    )


def _default_policy() -> dict[str, Any]:
    return {
        "routes": [],
        "domains": ["quarantine"],
        "modes": ["public"],
        "default_route": {"state_domain": "quarantine"},
        "audit_dir": "audit/",
    }


def _load_build(install_root: Path, engine_version: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None]:
    build_root = install_root / "build"
    try:
        build_descriptor = _open_anchored_directory(build_root)
    except BuildArtifactInvalid:
        return None, _default_policy(), "policy-unavailable"
    except Exception:
        return None, None, "policy-unavailable"
    try:
        try:
            policy_value = _build_json(build_root / "policy.json", build_descriptor)
        except BuildArtifactInvalid:
            return None, _default_policy(), "policy-unavailable"
        except Exception:
            return None, None, "policy-unavailable"
        if not _valid_policy(policy_value):
            return None, None, "policy-invalid"
        policy = policy_value
        try:
            manifest = _build_json(build_root / "manifest.json", build_descriptor)
            triggers = _build_json(build_root / "triggers.json", build_descriptor)
        except Exception:
            return None, policy, "build-artifact-unavailable"
        if not _valid_manifest(manifest) or not _engine_compatible(manifest["engine_version"], engine_version):
            return None, policy, "manifest-incompatible"
        if not _valid_triggers(triggers):
            return None, policy, "triggers-incompatible"
        manifest_modes = builtins.set(manifest["modes"])
        policy_modes = builtins.set(policy["modes"]) - {"public"}
        if manifest_modes != policy_modes or any(
            mode != "public" and mode not in policy_modes for mode in triggers["aliases"].values()
        ):
            return None, policy, "build-artifacts-inconsistent"
        blocks: dict[str, str] = {}
        try:
            if manifest["modes"]:
                modes_descriptor = _open_anchored_directory(Path("modes"), dir_fd=build_descriptor)
                try:
                    for mode, metadata in manifest["modes"].items():
                        payload = _anchored_bytes(modes_descriptor, f"{mode}.md")
                        if len(payload) != metadata["bytes"] or hashlib.sha256(payload).hexdigest() != metadata["sha256"]:
                            raise ValueError("block does not match manifest")
                        blocks[mode] = payload.decode("utf-8")
                finally:
                    os.close(modes_descriptor)
        except Exception:
            return None, policy, "block-unavailable"
        return {"manifest": manifest, "policy": policy, "triggers": triggers, "blocks": blocks}, policy, None
    finally:
        os.close(build_descriptor)


def normalize_utterance(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    collapsed = WHITESPACE.sub(" ", normalized).strip(" ")
    return re.sub(r"[A-Z]", lambda match: chr(ord(match.group()) + 32), collapsed)


def _route_matches(ctx: Mapping[str, Any], route: Mapping[str, Any]) -> bool:
    for key, match in route["match"].items():
        if key not in ctx or not isinstance(ctx[key], str):
            return False
        if isinstance(match, str):
            if ctx[key] != match:
                return False
        elif not ctx[key].startswith(match["prefix"]):
            return False
    return True


def _resolve_route(ctx: Mapping[str, Any], policy: Mapping[str, Any], timestamp: str) -> dict[str, Any]:
    domain = policy["default_route"]["state_domain"]
    default = {
        "id": "__default__", "match": {}, "allowed_modes": ["public"],
        "switching": "deny", "state_domain": domain, "owner_verified": False,
    }
    complete = isinstance(ctx, Mapping) and all(
        isinstance(ctx.get(key), str) and ctx[key] for key in ("platform", "session_id")
    )
    try:
        matches = [route for route in policy["routes"] if _route_matches(ctx, route)] if complete else []
    except Exception:
        matches = []
    if len(matches) == 1:
        return {"route": matches[0], "route_id": matches[0]["id"], "state_domain": matches[0]["state_domain"], "audit": []}
    event = {"ts": timestamp, "event": "route_unresolved", "route_id": "__default__", "domain": domain}
    if len(matches) > 1:
        event["reason"] = "overlapping-routes"
    return {"route": default, "route_id": "__default__", "state_domain": domain, "audit": [event]}


def resolve_route_context(ctx: Mapping[str, Any], install_root: str | os.PathLike[str], *, engine_version: str = VERSION) -> dict[str, Any]:
    """Resolve trusted adapter context for tool visibility/owner binding."""
    loaded, policy, _ = _load_build(Path(install_root), engine_version)
    effective = loaded["policy"] if loaded is not None else (policy or _default_policy())
    return _resolve_route(ctx, effective, _iso())


def _initial_state() -> dict[str, Any]:
    return {"v": STATE_VERSION, "revision": 0, "mode": "public"}


def _canonical_iso(value: Any) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00").astimezone(timezone.utc)
        return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") == value
    except ValueError:
        return False


def _parse_state(value: Any) -> dict[str, Any]:
    if not _record(value):
        raise ValueError("state file must contain a JSON object")
    version, revision, mode = value.get("v"), value.get("revision"), value.get("mode")
    if not _integer(version) or version < 0 or version > STATE_VERSION:
        raise ValueError("unsupported state version")
    if not _integer(revision) or not 0 <= revision <= MAX_SAFE_INTEGER:
        raise ValueError("invalid state revision")
    if not isinstance(mode, str):
        raise ValueError("invalid state mode")
    if version == STATE_VERSION and not (
        value.get("set_by") in {"owner", "agent", "admin"}
        and _canonical_iso(value.get("set_at"))
        and isinstance(value.get("route_id"), str)
    ):
        raise ValueError("state version 1 is missing transition metadata")
    result = {"v": version, "revision": revision, "mode": mode}
    for key in ("set_by", "set_at", "route_id"):
        if key in value:
            result[key] = value[key]
    return result


def _read_state(path: Path) -> tuple[bool, dict[str, Any]]:
    try:
        return True, _parse_state(_json(path))
    except FileNotFoundError:
        return True, _initial_state()
    except Exception:
        return False, _initial_state()


def _state_error(timestamp: str, route_id: str, domain: str) -> dict[str, Any]:
    return {"ts": timestamp, "event": "state_error", "route_id": route_id, "domain": domain}


def _recover_stale_lock(lock_path: Path, stale: float) -> str:
    recovery = Path(f"{lock_path}.recovery")
    try:
        descriptor = os.open(recovery, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        try:
            if time.time() - recovery.stat().st_mtime <= stale:
                return "busy"
            recovery.unlink()
            descriptor = os.open(recovery, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except (FileExistsError, FileNotFoundError):
            return "busy"
        except OSError:
            return "error"
    except OSError:
        return "error"
    try:
        try:
            if time.time() - lock_path.stat().st_mtime > stale:
                lock_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            return "error"
        return "recovered"
    finally:
        os.close(descriptor)
        try:
            recovery.unlink()
        except OSError:
            pass


def _acquire_lock(lock_path: Path, timeout: float, stale: float) -> tuple[int, str] | None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            token = str(uuid.uuid4())
        except FileExistsError:
            try:
                if time.time() - lock_path.stat().st_mtime > stale:
                    recovery = _recover_stale_lock(lock_path, stale)
                    if recovery == "error":
                        return None
                    if recovery == "recovered":
                        continue
            except FileNotFoundError:
                continue
            if time.monotonic() >= deadline:
                return None
            time.sleep(min(LOCK_RETRY_SECONDS, max(0.0, deadline - time.monotonic())))
            continue
        except OSError:
            return None
        payload = token.encode("utf-8")
        try:
            if os.write(descriptor, payload) != len(payload):
                raise OSError("short lock token write")
            os.fsync(descriptor)
            return descriptor, token
        except OSError:
            try:
                os.close(descriptor)
            except OSError:
                pass
            try:
                lock_path.unlink()
            except OSError:
                pass
            return None


def _release_lock(lock_path: Path, descriptor: int, token: str) -> None:
    try:
        os.close(descriptor)
    except OSError:
        pass
    try:
        if lock_path.read_text(encoding="utf-8") == token:
            lock_path.unlink()
    except (OSError, UnicodeError):
        pass


def _cas(
    state_root: Path, domain: str, expected_revision: int, mode: str, set_by: str,
    route_id: str, timestamp: str, now: Now | None,
) -> dict[str, Any]:
    if not DOMAIN_ID.fullmatch(domain) or not _integer(expected_revision):
        return {"status": "state_error", "state": _initial_state(), "audit": [_state_error(timestamp, route_id, domain)]}
    try:
        state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(state_root, 0o700)
    except OSError:
        return {"status": "state_error", "state": _initial_state(), "audit": [_state_error(timestamp, route_id, domain)]}
    state_path = state_root / f"{domain}.json"
    temporary = Path(f"{state_path}.tmp")
    lock_path = state_root / f"{domain}.lock"
    held = _acquire_lock(lock_path, LOCK_TIMEOUT_SECONDS, STALE_LOCK_SECONDS)
    if held is None:
        return {"status": "state_error", "state": _initial_state(), "audit": [_state_error(timestamp, route_id, domain)]}
    descriptor, token = held
    try:
        ok, current = _read_state(state_path)
        if not ok:
            return {"status": "state_error", "state": _initial_state(), "audit": [_state_error(timestamp, route_id, domain)]}
        if current["revision"] != expected_revision:
            return {"status": "revision_mismatch", "state": current, "audit": []}
        if current["revision"] + 1 > MAX_SAFE_INTEGER:
            return {"status": "state_error", "state": current, "audit": [_state_error(timestamp, route_id, domain)]}
        next_state = {
            "v": STATE_VERSION, "revision": current["revision"] + 1, "mode": mode,
            "set_by": set_by, "set_at": _iso(now), "route_id": route_id,
        }
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(next_state, handle, ensure_ascii=False, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, state_path)
        except OSError:
            temporary.unlink(missing_ok=True)
            return {"status": "state_error", "state": _initial_state(), "audit": [_state_error(timestamp, route_id, domain)]}
        event = {
            "ts": timestamp, "event": "mode_transition", "route_id": route_id,
            "domain": domain, "from": current["mode"], "to": mode, "set_by": set_by,
        }
        return {"status": "applied", "state": next_state, "audit": [event]}
    finally:
        try:
            _release_lock(lock_path, descriptor, token)
        except Exception:
            # The state rename is already durable. As in the TS store, a
            # leftover lock is left for stale-lock recovery rather than
            # converting an applied CAS into a failure.
            pass


def _attempt_transition(
    state_root: Path, domain: str, state: dict[str, Any], mode: str, set_by: str,
    route_id: str, timestamp: str, reauthorize: Callable[[dict[str, Any]], str | None], now: Now | None,
) -> dict[str, Any]:
    first = _cas(state_root, domain, state["revision"], mode, set_by, route_id, timestamp, now)
    if first["status"] != "revision_mismatch":
        return first
    reason = reauthorize(first["state"])
    if reason is not None:
        return _transition_rejection(first["state"], mode, reason, route_id, domain, _iso(now))
    second = _cas(state_root, domain, first["state"]["revision"], mode, set_by, route_id, timestamp, now)
    if second["status"] != "revision_mismatch":
        return second
    return _transition_rejection(
        second["state"], mode, "state revision changed during the single transition retry",
        route_id, domain, _iso(now),
    )


def _transition_rejection(state: Mapping[str, Any], requested: str, reason: str, route_id: str, domain: str, timestamp: str) -> dict[str, Any]:
    return {
        "status": "rejected", "state": dict(state),
        "rejected": {"requested_mode": requested, "reason": reason},
        "audit": [{
            "ts": timestamp, "event": "switch_rejected", "route_id": route_id,
            "domain": domain, "from": state["mode"], "reason": reason,
        }],
    }


def _owner_reason(route: Mapping[str, Any], requested: str) -> str | None:
    if not (route.get("owner_verified") is True and route["switching"] in {"explicit", "explicit-and-agent"}):
        return "resolved route does not permit owner switching"
    if requested != "public" and requested not in route["allowed_modes"]:
        return "requested mode is not allowed by the resolved route"
    return None


def _agent_reason(route: Mapping[str, Any], requested: str) -> str | None:
    if route["switching"] != "explicit-and-agent":
        return "resolved route does not allow agent switching"
    if route.get("owner_verified") is not True:
        return "resolved route is not owner verified"
    if requested != "public" and requested not in route["allowed_modes"]:
        return "requested mode is not allowed by the resolved route"
    return None


def _admin_reason(policy: Mapping[str, Any], domain: str, requested: str) -> str | None:
    if domain not in policy["domains"]:
        return "requested domain does not exist"
    if requested != "public" and not any(
        route["state_domain"] == domain and requested in route["allowed_modes"] for route in policy["routes"]
    ):
        return "requested mode is not allowed by any route in the domain"
    return None


def _trigger(utterance: str, triggers: Mapping[str, Any]) -> str | None:
    normalized = normalize_utterance(utterance)
    prefix = f'{triggers["reserved_prefix"]} '
    if normalized.startswith(prefix):
        requested = normalized[len(prefix):].strip()
        return requested or None
    value = triggers["aliases"].get(normalized)
    return value if isinstance(value, str) else None


def _contained(root: Path, target: Path) -> bool:
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def _audit_root(install_root: Path, audit_dir: str) -> Path:
    if not audit_dir or Path(audit_dir).is_absolute() or re.match(r"^[A-Za-z]:[\\/]", audit_dir) or audit_dir.startswith("\\\\"):
        raise ValueError("invalid compiled audit directory")
    parts = [part for part in re.split(r"[\\/]+", audit_dir) if part not in {"", "."}]
    if not parts or ".." in parts:
        raise ValueError("invalid compiled audit directory")
    root = install_root.resolve(strict=True)
    target = install_root.joinpath(*parts)
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    resolved = target.resolve(strict=True)
    if not _contained(root, resolved):
        raise ValueError("compiled audit directory escapes install root")
    os.chmod(resolved, 0o700)
    return resolved


def _append_audit(install_root: Path, policy: Mapping[str, Any], events: list[dict[str, Any]]) -> None:
    if not events:
        return
    root = _audit_root(install_root, policy["audit_dir"])
    path = root / "audit.jsonl"
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise OSError("audit.jsonl is not a regular file")
    flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        opened = os.fstat(descriptor)
        verified_root = _audit_root(install_root, policy["audit_dir"])
        verified = (verified_root / "audit.jsonl").stat()
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (verified.st_dev, verified.st_ino):
            raise OSError("audit.jsonl changed during open")
        payload = "".join(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n" for event in events).encode("utf-8")
        if os.write(descriptor, payload) != len(payload):
            raise OSError("short audit write")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.parent / f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4()}"
    try:
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _status(timestamp: str, route_id: str, mode: str, block: str, engine_version: str, turn_key: str | None) -> dict[str, Any]:
    encoded = block.encode("utf-8")
    value: dict[str, Any] = {
        "ts": timestamp, "route_id": route_id, "mode": mode,
        "block_sha256": hashlib.sha256(encoded).hexdigest(), "block_bytes": len(encoded),
        "engine": f"{IMPLEMENTATION}@{engine_version}",
    }
    if turn_key is not None:
        value["turn_key"] = turn_key
    return value


def _valid_status(value: Any) -> bool:
    return bool(
        _record(value)
        and isinstance(value.get("ts"), str)
        and isinstance(value.get("route_id"), str)
        and isinstance(value.get("mode"), str)
        and isinstance(value.get("block_sha256"), str)
        and _integer(value.get("block_bytes"))
        and isinstance(value.get("engine"), str)
        and ("turn_key" not in value or isinstance(value["turn_key"], str))
    )


def _persist_turn(install_root: Path, policy: Mapping[str, Any] | None, audit: list[dict[str, Any]], status: Mapping[str, Any], warn: Warn | None) -> bool:
    degraded = False
    if audit:
        if policy is None:
            degraded = True
            _warn(warn, "persona: audit unavailable because compiled policy is invalid")
        else:
            try:
                _append_audit(install_root, policy, audit)
            except Exception:
                degraded = True
                _warn(warn, "persona: failed to append audit.jsonl")
    try:
        _atomic_json(install_root / "state" / "status.json", status)
    except Exception:
        degraded = True
        _warn(warn, "persona: failed to update state/status.json")
    return degraded


def _persist_set(install_root: Path, policy: Mapping[str, Any] | None, audit: list[dict[str, Any]], warn: Warn | None) -> bool:
    if not audit:
        return False
    if policy is None:
        _warn(warn, "persona: audit unavailable because compiled policy is invalid")
        return True
    try:
        _append_audit(install_root, policy, audit)
        return False
    except Exception:
        _warn(warn, "persona: failed to append audit.jsonl")
        return True


def turn(input: Mapping[str, Any], install_root: str | os.PathLike[str], *, engine_version: str = VERSION, now: Now | None = None, warn: Warn | None = None) -> dict[str, Any]:
    root = Path(install_root)
    loaded, policy, error = _load_build(root, engine_version)
    timestamp = _iso(now)
    effective = loaded["policy"] if loaded is not None else (policy or _default_policy())
    resolution = _resolve_route(input.get("ctx", {}), effective, timestamp)
    if loaded is None:
        audit = resolution["audit"] + [{
            "ts": timestamp, "event": "build_invalid", "route_id": resolution["route_id"],
            "domain": resolution["state_domain"], "reason": error,
        }]
        result = {
            "mode": "public", "block": "", "route_id": resolution["route_id"],
            "state_domain": resolution["state_domain"], "transitioned": False, "audit": audit,
        }
        degraded = _persist_turn(root, policy, audit, _status(timestamp, result["route_id"], "public", "", engine_version, input.get("turn_key")), warn)
        if degraded:
            result["degraded"] = True
        return result

    audit = list(resolution["audit"])
    state_root = root / "state"
    state_ok, snapshot = _read_state(state_root / f'{resolution["state_domain"]}.json')
    if not state_ok:
        audit.append(_state_error(timestamp, resolution["route_id"], resolution["state_domain"]))
    transitioned = False
    rejected = None
    utterance = input.get("utterance")
    if state_ok and isinstance(utterance, str):
        route = resolution["route"]
        if input.get("actor") == "owner" and route.get("owner_verified") is True and route["switching"] in {"explicit", "explicit-and-agent"}:
            requested = _trigger(utterance, loaded["triggers"])
            if requested is not None:
                reason = _owner_reason(route, requested)
                if reason is not None:
                    attempt = _transition_rejection(snapshot, requested, reason, resolution["route_id"], resolution["state_domain"], timestamp)
                else:
                    attempt = _attempt_transition(
                        state_root, resolution["state_domain"], snapshot, requested, "owner",
                        resolution["route_id"], timestamp, lambda fresh: _owner_reason(route, requested), now,
                    )
                audit.extend(attempt["audit"])
                snapshot = attempt["state"]
                transitioned = attempt["status"] == "applied"
                rejected = attempt.get("rejected")
                if attempt["status"] == "state_error":
                    state_ok = False
    mode = "public" if not state_ok else snapshot["mode"]
    if state_ok and mode != "public" and mode not in resolution["route"]["allowed_modes"]:
        audit.append({
            "ts": timestamp, "event": "resolve_downgrade", "route_id": resolution["route_id"],
            "domain": resolution["state_domain"], "from": mode, "to": "public",
        })
        mode = "public"
    block = ""
    if mode != "public":
        if not MODE_ID.fullmatch(mode) or mode not in loaded["manifest"]["modes"]:
            audit.append({
                "ts": timestamp, "event": "build_invalid", "route_id": resolution["route_id"],
                "domain": resolution["state_domain"], "reason": "mode-missing-from-manifest",
            })
            mode = "public"
        elif mode not in loaded["blocks"]:
            audit.append({
                "ts": timestamp, "event": "build_invalid", "route_id": resolution["route_id"],
                "domain": resolution["state_domain"], "reason": "block-unavailable",
            })
            mode = "public"
        else:
            block = loaded["blocks"][mode]
    result = {
        "mode": mode, "block": block, "route_id": resolution["route_id"],
        "state_domain": resolution["state_domain"], "transitioned": transitioned, "audit": audit,
    }
    if rejected is not None:
        result["rejected"] = rejected
    degraded = _persist_turn(root, loaded["policy"], audit, _status(timestamp, result["route_id"], mode, block, engine_version, input.get("turn_key")), warn)
    if degraded:
        result["degraded"] = True
    return result


def set(input: Mapping[str, Any], install_root: str | os.PathLike[str], *, engine_version: str = VERSION, now: Now | None = None, warn: Warn | None = None) -> dict[str, Any]:
    root = Path(install_root)
    loaded, policy, error = _load_build(root, engine_version)
    timestamp = _iso(now)
    requested = input.get("requested_mode")
    actor = input.get("actor")
    if loaded is None:
        resolution = _resolve_route(input.get("ctx", {}), policy or _default_policy(), timestamp) if actor == "agent" else None
        domain = input.get("domain") if actor == "admin" and isinstance(input.get("domain"), str) else (resolution or {}).get("state_domain", "quarantine")
        route_id = "__admin__" if actor == "admin" else (resolution or {}).get("route_id", "__default__")
        audit = list((resolution or {}).get("audit", [])) + [{
            "ts": timestamp, "event": "build_invalid", "route_id": route_id,
            "domain": domain, "reason": error,
        }]
        result = {
            "ok": False, "mode": "public", "transitioned": False,
            "rejected": {"requested_mode": requested, "reason": "build artifacts are unavailable or incompatible"},
            "audit": audit,
        }
        if _persist_set(root, policy, audit, warn):
            result["degraded"] = True
        return result
    policy = loaded["policy"]
    if actor not in {"agent", "admin"}:
        reason = "unsupported actor"
        domain = policy["default_route"]["state_domain"]
        audit = [{
            "ts": timestamp, "event": "switch_rejected", "route_id": "__default__",
            "domain": domain, "from": "public", "reason": reason,
        }]
        result = {
            "ok": False, "mode": "public", "transitioned": False,
            "rejected": {"requested_mode": requested, "reason": reason}, "audit": audit,
        }
        if _persist_set(root, policy, audit, warn):
            result["degraded"] = True
        return result
    if actor == "admin" and not isinstance(input.get("domain"), str):
        reason = "requested domain is required"
        audit = [{
            "ts": timestamp, "event": "switch_rejected", "route_id": "__admin__",
            "domain": policy["default_route"]["state_domain"], "from": "public", "reason": reason,
        }]
        result = {"ok": False, "mode": "public", "transitioned": False, "rejected": {"requested_mode": requested, "reason": reason}, "audit": audit}
        if _persist_set(root, policy, audit, warn): result["degraded"] = True
        return result
    resolution = _resolve_route(input.get("ctx", {}), policy, timestamp) if actor == "agent" else None
    route_id = "__admin__" if actor == "admin" else resolution["route_id"]
    domain = input["domain"] if actor == "admin" else resolution["state_domain"]
    audit = list((resolution or {}).get("audit", []))
    if actor == "admin" and domain not in policy["domains"]:
        reason = _admin_reason(policy, domain, requested)
        rejected_attempt = _transition_rejection(_initial_state(), requested, reason or "requested domain does not exist", route_id, domain, timestamp)
        audit.extend(rejected_attempt["audit"])
        result = {"ok": False, "mode": "public", "transitioned": False, "rejected": rejected_attempt["rejected"], "audit": audit}
        if _persist_set(root, policy, audit, warn): result["degraded"] = True
        return result
    state_ok, state = _read_state(root / "state" / f"{domain}.json")
    if not state_ok:
        audit.append(_state_error(timestamp, route_id, domain))
        result = {"ok": False, "mode": "public", "transitioned": False, "audit": audit}
        if _persist_set(root, policy, audit, warn): result["degraded"] = True
        return result
    route = resolution["route"] if resolution is not None else None
    reason = _admin_reason(policy, domain, requested) if actor == "admin" else _agent_reason(route, requested)
    if reason is not None:
        attempt = _transition_rejection(state, requested, reason, route_id, domain, timestamp)
    else:
        reauthorize = (lambda fresh: _admin_reason(policy, domain, requested)) if actor == "admin" else (lambda fresh: _agent_reason(route, requested))
        attempt = _attempt_transition(root / "state", domain, state, requested, actor, route_id, timestamp, reauthorize, now)
    audit.extend(attempt["audit"])
    result = {
        "ok": attempt["status"] == "applied", "mode": "public" if attempt["status"] == "state_error" else attempt["state"]["mode"],
        "transitioned": attempt["status"] == "applied", "audit": audit,
    }
    if "rejected" in attempt:
        result["rejected"] = attempt["rejected"]
    if _persist_set(root, policy, audit, warn): result["degraded"] = True
    return result


def _report_adapter_error(error: BaseException, ctx: Mapping[str, Any]) -> dict[str, Any]:
    install_root = ctx.get("installRoot") or ctx.get("install_root")
    if not isinstance(install_root, (str, os.PathLike)) or not str(install_root):
        raise TypeError("report_adapter_error requires ctx.installRoot")
    root = Path(install_root)
    now = ctx.get("now")
    warn = ctx.get("warn")
    timestamp = _iso(now)
    try:
        value = _build_json(root / "build" / "policy.json")
        policy = value if _valid_policy(value) else None
    except Exception:
        policy = None
    name = type(error).__name__
    category = name if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]{0,63}", name) else "adapter-exception"
    event = {
        "ts": timestamp, "event": "adapter_error", "route_id": "__adapter__",
        "domain": policy["default_route"]["state_domain"] if policy else "quarantine", "reason": category,
    }
    degraded = _persist_set(root, policy, [event], warn)
    if policy is not None and isinstance(ctx.get("domain"), str):
        try:
            status_path = root / "state" / "status.json"
            status_value = _json(status_path)
            if not _valid_status(status_value):
                return {"degraded": degraded, "audit": [event]}
            route_domain = policy["default_route"]["state_domain"] if status_value.get("route_id") == "__default__" else next(
                (route["state_domain"] for route in policy["routes"] if route["id"] == status_value.get("route_id")), None
            )
            matches = (
                route_domain == ctx["domain"]
                and (ctx.get("route_id") is None or status_value.get("route_id") == ctx["route_id"])
                and (ctx.get("turn_key") is None or status_value.get("turn_key") == ctx["turn_key"])
            )
            if matches:
                status_value.update({
                    "ts": timestamp, "mode": "public",
                    "block_sha256": hashlib.sha256(b"").hexdigest(), "block_bytes": 0,
                })
                _atomic_json(status_path, status_value)
        except FileNotFoundError:
            pass
        except Exception:
            degraded = True
            _warn(warn, "persona: failed to correct state/status.json after adapter error")
    return {"degraded": degraded, "audit": [event]}


def report_adapter_error(error: BaseException, ctx: Mapping[str, Any]) -> dict[str, Any]:
    """Best-effort adapter error reporting that never propagates failures."""
    warn = None
    try:
        warn = ctx.get("warn") if isinstance(ctx, Mapping) else None
        return _report_adapter_error(error, ctx)
    except Exception:
        _warn(warn if callable(warn) else None, "persona: failed to report adapter error")
        return {"degraded": True, "audit": []}
