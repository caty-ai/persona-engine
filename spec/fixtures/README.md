# Conformance fixture skeleton

The fixture tree is split into the two suites required by SPEC §11:

- `compile/cases/*` contains pack inputs for the future TypeScript compiler.
- `runtime/cases/*` contains compiled `build/` inputs shared by the TypeScript core and Python thin implementation.

Every immediate child of a suite's `cases/` directory is one case. A loader should sort case directory names, parse the UTF-8 `case.json` in each directory, and resolve every path relative to that case directory. Unknown metadata keys may be ignored so the format can grow without breaking old loaders.

## Compile case format

A compile case contains `case.json`, `manifest.yml`, and any pack files needed by the case, such as `modes/<id>.yml`. Since `persona build` consumes a pack **plus** an `install.yml` (SPEC §3/§4), a case may also carry install input; the sample success case omits it, but cases covering placeholders, routes, budgets, or `audit.dir` will need one.

`case.json` has these top-level keys:

- `id`: stable case identifier matching the directory name.
- `description`: human-readable dummy-only summary.
- `input`: object with `pack_dir`, a case-relative path to the pack root, and optionally `install_file`, a case-relative path to an `install.yml` (reserved; absent means the runner supplies a minimal default install).
- `expected`: object describing the build outcome. The skeleton uses `status`, `manifest.required_fields`, `manifest.counter`, and `modes`; error cases instead use `error`, one of the 24 `E_*` codes from SPEC §4.1.

## Runtime case format

A runtime case contains `case.json` and a `build/` directory holding JSON artifacts. It may also contain a case-local `state/` directory; absence of that directory means the implicit initial state from SPEC §7.3.

`case.json` has these top-level keys:

- `id`: stable case identifier matching the directory name.
- `description`: human-readable dummy-only summary.
- `operation`: `"turn"`, `"set"`, or `"report_adapter_error"`.
- `input`: the language-neutral operation input object. For
  `report_adapter_error`, use `{ "error": { "name"?: string, "message": string },
  "ctx": { "route_id"?: string, "domain"?: string, "turn_key"?: string } }`.
  The runner supplies the case-local install root; it is never embedded in a fixture.
- `expected`: the complete language-neutral result object expected from the operation.
- `expected_status`: optional complete `state/status.json` expected after the operation;
  this is used by adapter-error cases to specify status correction.

JSON values are compared structurally, with one normative exception: every `ts` field (audit events, `status.json`) is compared by ISO 8601 well-formedness only, never by value — turn()/set() have no clock input, so timestamps are inherently nondeterministic (fixture `ts` values are illustrative dummies). Any further nondeterministic field must get an explicit rule here before a fixture uses it; conformance runners in any language implement the same comparison.
