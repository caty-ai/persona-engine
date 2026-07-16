import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export type InitParsedArgs = {
  positionals: string[];
  options: Map<string, string>;
};

export type InitIo = {
  interactive?: boolean;
  ask?: (prompt: string) => Promise<string>;
  writeStderr?: (message: string) => void;
  writeJson?: (value: unknown) => void;
};

const EXIT_SUCCESS = 0;
const MODE_ID = /^[a-z0-9-]+$/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/u;
const RUNTIMES = new Set(["generic", "openclaw", "hermes"]);

function rejectUnknownOptions(parsed: InitParsedArgs): void {
  const accepted = new Set(["yes", "name", "mode", "runtime", "budget"]);
  for (const name of parsed.options.keys()) {
    if (!accepted.has(name)) throw new Error(`unknown option --${name}`);
  }
}

function writeNew(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", flag: "wx" });
}

function validateName(value: string, source: string): string {
  if (value.length > 64 || !PRINTABLE_ASCII.test(value)) {
    throw new Error(`${source} must be non-empty printable ASCII and at most 64 characters`);
  }
  return value;
}

function validateMode(value: string, source: string): string {
  if (!MODE_ID.test(value)) throw new Error(`${source} must match /^[a-z0-9-]+$/`);
  return value;
}

function validateRuntime(value: string, source: string): string {
  if (!RUNTIMES.has(value)) throw new Error(`${source} must be one of generic, openclaw, hermes`);
  return value;
}

function validateBudget(value: string, source: string): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${source} must be an integer from 1 to 100000`);
  const budget = Number(value);
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 100000) {
    throw new Error(`${source} must be an integer from 1 to 100000`);
  }
  return budget;
}

async function askUntilValid<T>(
  ask: (prompt: string) => Promise<string>,
  writeStderr: (message: string) => void,
  prompt: string,
  defaultValue: string,
  validate: (value: string, source: string) => T,
): Promise<T> {
  while (true) {
    const answer = await ask(`${prompt} [${defaultValue}]: `);
    try {
      return validate(answer === "" ? defaultValue : answer, prompt);
    } catch (error) {
      writeStderr(`persona: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function valuesForInit(parsed: InitParsedArgs, io: InitIo): Promise<{
  name: string;
  mode: string;
  runtime: string;
  budget: number;
}> {
  const defaults = { name: "my-persona", mode: "default", runtime: "generic", budget: "600" };
  const fromFlag = {
    name: parsed.options.get("name"),
    mode: parsed.options.get("mode"),
    runtime: parsed.options.get("runtime"),
    budget: parsed.options.get("budget"),
  };
  const interactive = io.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

  if (!interactive || parsed.options.has("yes")) {
    return {
      name: validateName(fromFlag.name ?? defaults.name, "--name"),
      mode: validateMode(fromFlag.mode ?? defaults.mode, "--mode"),
      runtime: validateRuntime(fromFlag.runtime ?? defaults.runtime, "--runtime"),
      budget: validateBudget(fromFlag.budget ?? defaults.budget, "--budget"),
    };
  }

  const writeStderr = io.writeStderr ?? ((message: string) => process.stderr.write(message));
  let close: (() => void) | undefined;
  let ask = io.ask;
  if (ask === undefined) {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    ask = (prompt: string) => readline.question(prompt);
    close = () => readline.close();
  }
  try {
    return {
      name: fromFlag.name === undefined
        ? await askUntilValid(ask, writeStderr, "Pack name", defaults.name, validateName)
        : validateName(fromFlag.name, "--name"),
      mode: fromFlag.mode === undefined
        ? await askUntilValid(ask, writeStderr, "Initial mode id", defaults.mode, validateMode)
        : validateMode(fromFlag.mode, "--mode"),
      runtime: fromFlag.runtime === undefined
        ? await askUntilValid(ask, writeStderr, "Runtime (generic, openclaw, hermes)", defaults.runtime, validateRuntime)
        : validateRuntime(fromFlag.runtime, "--runtime"),
      budget: fromFlag.budget === undefined
        ? await askUntilValid(ask, writeStderr, "Default budget tokens", defaults.budget, validateBudget)
        : validateBudget(fromFlag.budget, "--budget"),
    };
  } finally {
    close?.();
  }
}

export async function initCommand(parsed: InitParsedArgs, io: InitIo = {}): Promise<number> {
  rejectUnknownOptions(parsed);
  if (parsed.positionals.length > 1) throw new Error("usage: persona init [directory]");
  const root = resolve(parsed.positionals[0] ?? process.cwd());
  const values = await valuesForInit(parsed, io);
  const installFile = resolve(root, "install.yml");
  const manifestFile = resolve(root, "pack", "manifest.yml");
  const modeFile = resolve(root, "pack", "modes", `${values.mode}.yml`);
  for (const path of [installFile, manifestFile, modeFile]) {
    if (existsSync(path)) throw new Error(`refusing to overwrite existing file ${path}`);
  }
  mkdirSync(resolve(root, "pack", "modes"), { recursive: true });
  mkdirSync(resolve(root, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(root, "audit"), { recursive: true, mode: 0o700 });
  writeNew(installFile, `schema_version: 2
pack: ./pack
runtime: ${values.runtime}
routes:
  - id: cli-admin
    match: {}
    allowed_modes: [public, ${values.mode}]
    switching: deny
    state_domain: default
default_route:
  state_domain: default
audit:
  dir: audit/
`);
  writeNew(manifestFile, `schema_version: 2
pack_version: "0.1.0"
name: ${JSON.stringify(values.name)}
engine:
  min: "0.0.0"
  max: null
default_budget_tokens: ${values.budget}
`);
  writeNew(modeFile, `sections:
  - id: persona
    text: |
      Replace this text with your persona instructions.
`);
  (io.writeJson ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)))({ ok: true, install_dir: root });
  if ((io.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)) && !parsed.options.has("yes")) {
    (io.writeStderr ?? ((message: string) => process.stderr.write(message)))("Next: run persona build, then persona doctor.\n");
  }
  return EXIT_SUCCESS;
}
