import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const casesRoot = resolve(
  import.meta.dirname,
  "../../../../spec/fixtures/runtime/cases",
);

describe("runtime policy/state fixtures", () => {
  it("conforms to the documented runtime case structure", async () => {
    const entries = await readdir(casesRoot, { withFileTypes: true });
    const caseNames = entries
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort();

    expect(caseNames.length).toBeGreaterThan(1);
    for (const caseName of caseNames) {
      const caseRoot = resolve(casesRoot, caseName);
      const metadata = JSON.parse(
        await readFile(resolve(caseRoot, "case.json"), "utf8"),
      ) as Record<string, unknown>;
      const expectedAudit = (
        metadata.expected as { audit?: Array<{ event?: unknown }> } | undefined
      )?.audit ?? [];
      const expectsBuildInvalid = expectedAudit.some(({ event }) => event === "build_invalid");

      expect(metadata).toMatchObject({ id: caseName });
      expect(metadata).toHaveProperty("description");
      expect(["turn", "set", "report_adapter_error"]).toContain(metadata.operation);
      expect(metadata).toHaveProperty("input");
      expect(metadata).toHaveProperty("expected");

      let manifest: {
        modes: Record<string, { bytes: number; sha256: string }>;
      } | undefined;
      let policy: { modes: string[] } | undefined;
      for (const artifact of ["manifest.json", "policy.json", "triggers.json"]) {
        // State may intentionally be corrupt, but build artifacts never are.
        const contents = await readFile(
          resolve(caseRoot, "build", artifact),
          "utf8",
        );
        expect(() => JSON.parse(contents)).not.toThrow();
        if (artifact === "manifest.json") {
          manifest = JSON.parse(contents) as typeof manifest;
        } else if (artifact === "policy.json") {
          policy = JSON.parse(contents) as typeof policy;
        }
      }

      expect(manifest).toBeDefined();
      expect(policy).toBeDefined();
      if (manifest === undefined || policy === undefined) {
        throw new Error(`missing parsed build artifacts for ${caseName}`);
      }

      for (const mode of policy.modes.filter((mode) => mode !== "public")) {
        const manifestMode = manifest.modes[mode];
        expect(manifestMode, `${caseName}: missing manifest mode ${mode}`).toBeDefined();
        if (manifestMode === undefined) {
          throw new Error(`${caseName}: missing manifest mode ${mode}`);
        }

        const modePath = resolve(caseRoot, "build", "modes", `${mode}.md`);
        const modeExists = await access(modePath).then(() => true, () => false);
        if (!modeExists) {
          expect(expectsBuildInvalid, `${caseName}: missing block must be an intentional F3 case`).toBe(true);
          continue;
        }
        const block = await readFile(modePath);
        expect(manifestMode.bytes).toBe(block.byteLength);
        expect(manifestMode.sha256).toBe(
          createHash("sha256").update(block).digest("hex"),
        );
      }
    }
  });
});
