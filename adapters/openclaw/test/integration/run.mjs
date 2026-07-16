import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const adapterRoot = resolve(here, "../..");
const repoRoot = resolve(adapterRoot, "../..");
const openclawRoot = join(process.env.HOME ?? "", ".npm-global/lib/node_modules/openclaw");
const openclaw = join(openclawRoot, "openclaw.mjs");
const reportPath = join(here, "report.json");
const blockA = "<persona-mode id=\"test-mode-a\" pack=\"test-pack@1.0.0\">\nDummy integration guidance A.\n</persona-mode>";
const blockB = "<persona-mode id=\"test-mode-b\" pack=\"test-pack@1.0.0\">\nDummy integration guidance B.\n</persona-mode>";
const blockBSha256 = createHash("sha256").update(blockB).digest("hex");
const emptySha256 = createHash("sha256").update("").digest("hex");

if (!existsSync(openclaw)) throw new Error(`OpenClaw binary unavailable: ${openclaw}`);
if (!existsSync(join(adapterRoot, "dist", "index.js"))) throw new Error("build adapter before integration test");

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeReportValue(value) {
  if (typeof value === "string") {
    return [
      [openclawRoot, "<openclaw-install>"],
      [repoRoot, "<repo-root>"],
      [temp, "<temp-root>"],
    ].reduce((sanitized, [root, replacement]) => sanitized.split(root).join(replacement), value);
  }
  if (Array.isArray(value)) return value.map(sanitizeReportValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeReportValue(entry)]));
  }
  return value;
}

function writeReport(value) {
  const sanitized = sanitizeReportValue(value);
  writeJson(reportPath, sanitized);
  return sanitized;
}

function createInstall(root) {
  const build = join(root, "build");
  mkdirSync(join(build, "modes"), { recursive: true });
  writeFileSync(join(build, "modes", "test-mode-a.md"), blockA);
  writeFileSync(join(build, "modes", "test-mode-b.md"), blockB);
  writeJson(join(build, "policy.json"), {
    routes: [
      {
        id: "voice-private",
        match: { session_key_rest: { prefix: "voice-" } },
        allowed_modes: ["public", "test-mode-a", "test-mode-b"],
        switching: "explicit-and-agent",
        state_domain: "private",
        owner_verified: true,
      },
      ...["subagent:", "cron:", "explicit:"].map((prefix) => ({
        id: `reserved-override-${prefix.slice(0, -1)}`,
        match: { session_key_rest: { prefix } },
        allowed_modes: ["public", "test-mode-a", "test-mode-b"],
        switching: "explicit-and-agent",
        state_domain: "private",
        owner_verified: true,
      })),
    ],
    domains: ["private", "quarantine"],
    modes: ["public", "test-mode-a", "test-mode-b"],
    default_route: { state_domain: "quarantine" },
    audit_dir: "audit/",
  });
  writeJson(join(build, "triggers.json"), {
    normalization: 1,
    reserved_prefix: "/persona",
    aliases: { "/persona test-mode-a": "test-mode-a", "/persona test-mode-b": "test-mode-b" },
  });
  writeJson(join(build, "manifest.json"), {
    schema_version: 2,
    pack_name: "test-pack",
    pack_version: "1.0.0",
    engine_version: "0.0.0",
    engine_range: { min: "0.0.0", max: null },
    built_at: "2026-01-01T00:00:00.000Z",
    content_hash: "0".repeat(64),
    counter: "pe-count-v1",
    modes: {
      "test-mode-a": {
        bytes: Buffer.byteLength(blockA),
        tokens: 1,
        sha256: createHash("sha256").update(blockA).digest("hex"),
      },
      "test-mode-b": {
        bytes: Buffer.byteLength(blockB),
        tokens: 1,
        sha256: blockBSha256,
      },
    },
  });
}

function startMock(port, logPath) {
  const child = spawn(process.execPath, [join(here, "mock-provider.mjs"), String(port), logPath], {
    env: { ...process.env, PERSONA_TEST_BLOCK_BASE64: Buffer.from(blockB).toString("base64") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((accept, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => reject(new Error(`mock exited ${code}: ${stderr}`)));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready:")) accept(child);
    });
  });
}

function runOpenClaw(env, sessionId, message) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [
      openclaw,
      "agent",
      "--local",
      "--session-id",
      sessionId,
      "--message",
      message,
      "--json",
      "--timeout",
      "30",
    ], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => {
      if (code === 0) accept({ stdout, stderr });
      else reject(new Error(`openclaw exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function auditLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const temp = mkdtempSync(join(tmpdir(), "persona-openclaw-integration-"));
const openclawHome = join(temp, "home");
const stateDir = join(openclawHome, ".openclaw");
const configPath = join(stateDir, "openclaw.json");
const installRoot = join(temp, "persona-install");
const providerLog = join(temp, "provider.jsonl");
const workspace = join(temp, "workspace");
const sessionsPath = join(stateDir, "agents", "main", "sessions", "sessions.json");
const auditPath = join(installRoot, "audit", "audit.jsonl");
const privateStatePath = join(installRoot, "state", "private.json");
const statusPath = join(installRoot, "state", "status.json");
const port = 19000 + Math.floor(Math.random() * 1000);

mkdirSync(workspace, { recursive: true });
createInstall(installRoot);
const sessions = {
  "agent:main:voice-integration": { sessionId: randomUUID(), updatedAt: Date.now() },
  "agent:main:public-integration": { sessionId: randomUUID(), updatedAt: Date.now() },
  "subagent:main:voice-invalid": { sessionId: randomUUID(), updatedAt: Date.now() },
  "cron:main:voice-invalid": { sessionId: randomUUID(), updatedAt: Date.now() },
  "explicit:voice-invalid": { sessionId: randomUUID(), updatedAt: Date.now() },
  "agent:main:subagent:voice-reserved": { sessionId: randomUUID(), updatedAt: Date.now() },
  "agent:main:cron:voice-reserved": { sessionId: randomUUID(), updatedAt: Date.now() },
  "agent:main:explicit:voice-reserved": { sessionId: randomUUID(), updatedAt: Date.now() },
};
writeJson(sessionsPath, sessions);
writeJson(configPath, {
  agents: {
    defaults: {
      workspace,
      model: { primary: "mock/mock-1" },
      models: { "mock/mock-1": { alias: "Mock" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "integration-only",
        api: "openai-completions",
        models: [{
          id: "mock-1",
          name: "Mock",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 1024,
        }],
      },
    },
  },
  plugins: {
    enabled: true,
    allow: ["persona-engine"],
    load: { paths: [adapterRoot] },
    entries: {
      "persona-engine": { enabled: true, config: { installRoot } },
    },
  },
});
const env = {
  ...process.env,
  OPENCLAW_HOME: openclawHome,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};

let mock;
const snapshots = [];
try {
  try {
    mock = await startMock(port, providerLog);
  } catch (error) {
    writeReport({
      generatedAt: new Date().toISOString(),
      status: "blocked",
      openclaw: { version: "2026.4.5", binary: openclaw },
      isolation: { openclawHome, stateDir, configPath, tempRoot: temp },
      blocker: error instanceof Error ? error.message : String(error),
      assertions: {
        sameTurnTransition: false,
        byteStable: false,
        publicZeroBytes: false,
        toolRouteGated: false,
        invalidKeysDefault: false,
        reservedRestDefault: false,
        secondTriggerFresh: false,
      },
      evidence: null,
    });
    throw error;
  }
  const privateId = sessions["agent:main:voice-integration"].sessionId;
  await runOpenClaw(env, privateId, "/persona test-mode-a");
  snapshots.push({ label: "explicit-trigger", status: readJson(statusPath), state: readJson(privateStatePath), audit: auditLines(auditPath) });
  await runOpenClaw(env, privateId, "/persona test-mode-b");
  snapshots.push({ label: "second-explicit-trigger", status: readJson(statusPath), state: readJson(privateStatePath), audit: auditLines(auditPath) });
  await runOpenClaw(env, privateId, "stable turn one");
  snapshots.push({ label: "stable-one", status: readJson(statusPath) });
  await runOpenClaw(env, privateId, "stable turn two");
  snapshots.push({ label: "stable-two", status: readJson(statusPath) });
  await runOpenClaw(env, sessions["agent:main:public-integration"].sessionId, "public route turn");
  snapshots.push({ label: "public", status: readJson(statusPath) });
  for (const key of ["subagent:main:voice-invalid", "cron:main:voice-invalid", "explicit:voice-invalid"]) {
    await runOpenClaw(env, sessions[key].sessionId, `invalid route ${key.split(":")[0]}`);
    snapshots.push({ label: key.split(":")[0], status: readJson(statusPath) });
  }
  for (const prefix of ["subagent", "cron", "explicit"]) {
    const key = `agent:main:${prefix}:voice-reserved`;
    await runOpenClaw(env, sessions[key].sessionId, `reserved rest ${prefix}`);
    snapshots.push({ label: `reserved-${prefix}`, status: readJson(statusPath) });
  }
} finally {
  mock?.kill("SIGTERM");
}

const audit = auditLines(auditPath);
const provider = auditLines(providerLog);
const byPrompt = (prompt) => provider.find((entry) => entry.userPrompt === prompt);
const transitions = audit.filter((entry) => entry.event === "mode_transition");
const firstTransition = transitions.find((entry) => entry.from === "public" && entry.to === "test-mode-a");
const secondTransition = transitions.find((entry) => entry.from === "test-mode-a" && entry.to === "test-mode-b");
const assertions = {
  sameTurnTransition: Boolean(firstTransition) && snapshots[0].state.mode === "test-mode-a" && snapshots[0].state.revision === 1 && snapshots[0].status.mode === "test-mode-a",
  byteStable: snapshots[2].status.block_sha256 === blockBSha256 && snapshots[3].status.block_sha256 === blockBSha256 && snapshots[2].status.block_sha256 === snapshots[3].status.block_sha256,
  publicZeroBytes: snapshots[4].status.route_id === "__default__" && snapshots[4].status.block_bytes === 0 && snapshots[4].status.block_sha256 === emptySha256,
  toolRouteGated: byPrompt("stable turn one")?.toolNames.includes("persona_set") === true && byPrompt("public route turn")?.toolNames.includes("persona_set") === false,
  invalidKeysDefault: snapshots.slice(5, 8).every((entry) => entry.status.route_id === "__default__" && entry.status.block_bytes === 0) && ["subagent", "cron", "explicit"].every((prefix) => byPrompt(`invalid route ${prefix}`)?.toolNames.includes("persona_set") === false),
  reservedRestDefault: snapshots.slice(8).every((entry) => entry.status.route_id === "__default__" && entry.status.block_bytes === 0) && ["subagent", "cron", "explicit"].every((prefix) => byPrompt(`reserved rest ${prefix}`)?.toolNames.includes("persona_set") === false),
  secondTriggerFresh: Boolean(secondTransition) && snapshots[1].state.mode === "test-mode-b" && snapshots[1].state.revision === 2 && snapshots[1].status.mode === "test-mode-b",
};
const report = {
  generatedAt: new Date().toISOString(),
  openclaw: { version: "2026.4.5", binary: openclaw },
  isolation: { openclawHome, stateDir, configPath, tempRoot: temp },
  expected: { blockBytes: Buffer.byteLength(blockB), blockSha256: blockBSha256, emptySha256 },
  assertions,
  evidence: {
    modeTransitionAudit: firstTransition ?? null,
    modeTransitionAudits: transitions,
    secondTriggerFresh: {
      passed: assertions.secondTriggerFresh,
      audit: secondTransition ?? null,
      state: snapshots[1].state,
      status: snapshots[1].status,
    },
    routeUnresolvedAudit: audit.filter((entry) => entry.event === "route_unresolved"),
    privateState: snapshots[0].state,
    statusSnapshots: snapshots.map(({ label, status }) => ({ label, ...status })),
    providerRequests: provider,
    auditJsonl: audit,
  },
};
const sanitizedReport = writeReport(report);
appendFileSync(reportPath, "");
const failed = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
process.stdout.write(`${JSON.stringify(sanitizedReport, null, 2)}\n`);
if (failed.length > 0) throw new Error(`integration assertions failed: ${failed.join(", ")}`);
