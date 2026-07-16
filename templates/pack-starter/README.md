# Starter pack

This directory is a complete, buildable persona-engine v2 pack. It contains four
small SFW examples: `focus`, `casual`, `professional`, and a deliberately skeletal
`roleplay-template`. A pack defines injectable mode content; the receiving install
defines the routes and policy that may use it.

## Start here

Copy this directory to a new install location, rename `install.example.yml` to
`install.yml`, then edit the pack and install configuration for your use case.

```sh
cp -R templates/pack-starter ./my-persona
cd ./my-persona
mv install.example.yml install.yml
node ../packages/core/bin/persona build --dir .
node ../packages/core/bin/persona doctor --dir .
```

When using a source checkout, replace `../packages/core/bin/persona` with the path
to that checkout's CLI. The build creates `build/`; do not edit generated files by
hand. After each pack or policy change, run the same build-and-doctor loop.

## Layout

```text
manifest.yml                 # Pack identity, compatible engine range, default budget
modes/*.yml                  # One v2 mode envelope per mode id
aliases.yml                  # Exact-match mode-switch phrases
catalogs/*.txt               # Opaque author assets (vocabulary, examples, ...)
install.example.yml          # Copy to install.yml; routes and local placeholders
```

`modes/<id>.yml` uses the v2 envelope: optional `budget_tokens` and `voice_hint`,
then an ordered `sections:` list. Each section needs an `id` and opaque `text`.
The compiler preserves section order and does not interpret the text. See
[SPEC.md](../../SPEC.md) §2 for the complete pack schema and inheritance rules.

## Placeholders and aliases

The roleplay scaffold intentionally uses `{{agent-name}}` and `{{owner-name}}`.
Every placeholder used in mode text or in `aliases.yml` must have a string value in
`install.yml` under `placeholders:`. Missing values stop the build with
`E_PLACEHOLDER_UNRESOLVED`; values are compiled into plain-text build artifacts, so
never put secrets in them.

Aliases are full-message matches after normalization. Keep each phrase unambiguous,
do not use the reserved `/persona` prefix, and declare aliases only for existing
mode ids. The example install declares both scaffold placeholders, so this starter
builds without modification.

## Catalogs

Catalogs are where a persona gets its depth: vocabulary lists, tone notes,
example exchanges — anything you would rather maintain as standalone files than
inline in a mode. The engine treats them as opaque author assets: any plain-text
format works, nothing is interpreted, and the compiler simply includes each
referenced file as one section.

The `casual` mode shows the wiring: a `catalog_refs:` list with an `id`, a
pack-relative `path` under `catalogs/`, and a `priority` (lower sorts earlier;
ties break by path). References outside `catalogs/`, missing files, or `..`
escapes stop the build with `E_CATALOG_REF`. Catalog content counts toward the
mode budget like any other section.

Replace the two sample files with your own material and grow them over time —
modes stay small while the catalogs carry the voice. See [SPEC.md](../../SPEC.md)
§2.2 for the exact semantics.

## Budgets and routes

The effective mode budget is the smaller of the install budget and the mode budget;
the manifest supplies a default when the install does not. Exceeding it is a build
error rather than a truncation. Keep sections short and intentional.

Routes belong in `install.yml`, not in the pack. They decide which modes are allowed
on each trusted surface, whether switching is permitted, and which `state_domain`
shares state. The example has a Hermes route scoped to Slack session keys beginning
with `owner-`; contexts that do not match it use the fail-closed public mode. Start
conservatively when broadening that route policy.
See [SPEC.md](../../SPEC.md) §3 and §6 before broadening a route policy.
