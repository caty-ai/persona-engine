import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixturesRoot = resolve(repoRoot, "spec/fixtures");

function caseDirectories(suite: "compile" | "runtime"): string[] {
  const casesRoot = resolve(fixturesRoot, suite, "cases");

  return readdirSync(casesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(casesRoot, entry.name))
    .sort();
}

function loadCase(caseDirectory: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(caseDirectory, "case.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe.each([
  ["compile", ["id", "description", "input", "expected"]],
  ["runtime", ["id", "description", "operation", "input", "expected"]],
] as const)("%s fixture suite", (suite, topLevelKeys) => {
  it("contains parseable case metadata with the documented keys", () => {
    const cases = caseDirectories(suite);

    expect(cases.length).toBeGreaterThanOrEqual(1);

    for (const caseDirectory of cases) {
      const metadata = loadCase(caseDirectory);

      for (const key of topLevelKeys) {
        expect(metadata).toHaveProperty(key);
      }
    }
  });
});
