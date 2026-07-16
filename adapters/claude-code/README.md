# Claude Code adapter

This adapter injects the active Persona Engine block into Claude Code hooks. It is a Python 3 standard-library script and calls the local `persona` command for each hook event.

## Setup

Create and build an installation from the repository root:

```sh
node packages/core/bin/persona init --yes ./persona-install
node packages/core/bin/persona build --dir ./persona-install
```

Set `PERSONA_BIN` to an executable path that resolves from the Claude Code project's working directory. For a repository checkout, use the absolute path to this repository's `packages/core/bin/persona`.

Copy the adapter directory into the Claude Code project, then add this project-level `.claude/settings.json` configuration. Set `PERSONA_INSTALL_DIR` to the installation location relative to the project working directory.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "PERSONA_INSTALL_DIR=./persona-install python3 adapters/claude-code/claude_code_hook.py"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "PERSONA_INSTALL_DIR=./persona-install python3 adapters/claude-code/claude_code_hook.py"
          }
        ]
      }
    ]
  }
}
```

The command receives Claude Code's hook JSON on standard input. `UserPromptSubmit` emits the `hookSpecificOutput.additionalContext` JSON envelope; `SessionStart` emits plain context text.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PERSONA_INSTALL_DIR` | required | Installation containing `build/`, `state/`, and `audit/`. |
| `PERSONA_ENGINE_INSTALL_ROOT` | none | Compatibility fallback when `PERSONA_INSTALL_DIR` is unset. |
| `PERSONA_BIN` | `persona` | Persona executable to invoke. In a repository checkout, set this to the absolute path to `packages/core/bin/persona` (and ensure it is executable). |
| `PERSONA_TIMEOUT_SECONDS` | `10` | Per-subprocess timeout, greater than zero and at most 60 seconds. |

The hook maps the session ID and prompt into one `persona turn --stdin-json` request with `platform: "claude_code"`. Configure routes in the installation to apply the appropriate policy for this runtime.

## Failure behavior

The adapter is fail-safe. A missing installation, unavailable executable, timeout, non-success engine result, or malformed JSON causes no context injection and returns exit code 0, so it does not block the user prompt. It makes a best-effort `persona report-adapter-error --stdin-json` call when an installation location is available. Diagnostics are fixed messages on standard error and do not include prompts or persona blocks.
