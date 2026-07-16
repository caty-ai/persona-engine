import { parseDocument } from "yaml";

export class SafeYamlError extends Error {}

/**
 * Uses only YAML's core schema and rejects every parse diagnostic. Unknown
 * tags are warnings in yaml v2, so warnings must be rejected as well.
 */
export function parseSafeYaml(source: string): unknown {
  const document = parseDocument(source, {
    customTags: [],
    logLevel: "silent",
    merge: false,
    prettyErrors: true,
    schema: "core",
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const diagnostic = document.errors[0] ?? document.warnings[0];
    throw new SafeYamlError(diagnostic?.message ?? "Invalid YAML");
  }
  try {
    return document.toJS({ mapAsMap: false, maxAliasCount: 100 });
  } catch (error) {
    throw new SafeYamlError(error instanceof Error ? error.message : "Invalid YAML");
  }
}
