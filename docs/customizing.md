# Customizing guide — modes and vocabulary catalogs

This guide covers the two files you will touch most often: **mode envelopes** (one face of your agent) and **vocabulary catalogs** (the words and examples that give a face its voice). Both are plain text; growing a persona is a matter of adding and editing files, then rebuilding.

For the complete, authoritative rules see [SPEC.md](../SPEC.md) §2. The bundled [starter pack](../templates/pack-starter/) shows every pattern described here in working form.

## Adding a mode

A mode is one YAML file under `pack/modes/`. The file name (minus `.yml`) is the mode id.

```yaml
# pack/modes/cheerful.yml
budget_tokens: 200
voice_hint: bright
sections:
  - id: mood
    text: |
      Respond with light, upbeat energy. Celebrate small wins out loud,
      and let genuine enthusiasm show when something goes well.
  - id: pacing
    text: |
      Keep replies conversational and warm. Short bursts are fine;
      formality is not required here.
```

Rules:

- **Write the difference, not the identity.** A mode should describe how this face reacts — mood, pacing, vocabulary — not who the agent is. The base personality lives in your runtime's own configuration and is never modified; the mode is an additive layer on top.
- `sections` is an ordered list. Each section needs an `id` and opaque `text`; the compiler preserves order and never interprets the text.
- `budget_tokens` and `voice_hint` are optional. The effective budget is the **smaller** of the install budget (falling back to the pack default, then to 600) and the mode's own `budget_tokens`; exceeding it is a build error (`E_BUDGET_EXCEEDED`), never a silent truncation.
- `voice_hint` is passed through to the runtime as-is — adapters can map it to TTS voicing or avatar expression.
- Placeholders like `{{agent-name}}` may appear in text; every one must have a string value under `placeholders:` in `install.yml`, or the build stops with `E_PLACEHOLDER_UNRESOLVED`.
- One mode can inherit from another with `extends` — define a base mode once and let emotion variants carry only their diff (merge rules in [SPEC.md](../SPEC.md) §2.3).

After adding the file:

1. Add the mode id to `allowed_modes` of every route that may show it (`install.yml`). A mode not listed on a route can never appear there.
2. Optionally add switch phrases in `aliases.yml`.
3. Rebuild and check:

```sh
persona build
persona doctor
```

## Growing vocabulary catalogs

Catalogs are where a persona gets its depth: preferred phrases, tone notes, example exchanges — anything you would rather maintain as standalone files than inline in a mode. Any plain-text format works; the engine treats the content as opaque and includes each referenced file as one section.

A mode references catalogs with `catalog_refs`:

```yaml
# pack/modes/casual.yml (excerpt)
catalog_refs:
  - id: vocabulary
    path: catalogs/tone-vocabulary.txt
    priority: 10
  - id: examples
    path: catalogs/response-examples.txt
    priority: 20
```

Rules:

- Paths must point **inside `catalogs/`**, relative to the pack. References outside it — including `..`, absolute paths, or symlink escapes — and missing files stop the build with `E_CATALOG_REF`.
- `priority` orders catalog sections: lower sorts earlier; ties break by path.
- Catalog content counts toward the mode's token budget like any other section — keep entries short and intentional, and let them grow gradually.
- A good starting shape (see the starter pack's samples): preferred openers and acknowledgements, phrases to avoid, then two or three short example exchanges anchoring the voice.

## Switch phrases (aliases)

`aliases.yml` maps full-utterance phrases to mode ids:

```yaml
aliases:
  cheerful:
    - "switch to cheerful"
```

Aliases are exact full-message matches after normalization. Keep each phrase unambiguous, do not use the reserved `/persona` prefix, and declare aliases only for existing mode ids. Placeholders are allowed inside phrases.

## The edit loop

Every change follows the same loop:

```sh
persona build     # compile; all rules above are enforced here
persona doctor    # verify the installation end to end
persona list      # confirm what the runtime will see
```

Builds are all-or-nothing: if any rule is violated the build fails with a specific error code and `build/` is left untouched, so a running agent never sees a half-edited persona.
