import { createHash } from "node:crypto";

export type RawPackFile = { path: string; bytes: Uint8Array };

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

/** Hashes the exact byte stream defined by SPEC §4. */
export function contentHash(files: readonly RawPackFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => compareUtf8(a.path, b.path))) {
    hash.update(Buffer.from(file.path, "utf8"));
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
