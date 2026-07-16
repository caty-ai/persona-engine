/**
 * Apply the normalization-v1 pipeline from SPEC §2.4.
 *
 * Deliberately do not use `String.prototype.toLowerCase()` on the complete
 * value: normalization v1 lowercases ASCII A-Z only and leaves non-ASCII
 * casing untouched.
 */
export function normalizeV1(input: string): string {
  return input
    .normalize("NFKC")
    // Unicode White_Space covers characters such as NEL that JavaScript's
    // `trim()` omits; `\s` additionally retains ECMAScript's BOM treatment.
    .replace(/[\s\p{White_Space}]+/gu, " ")
    .trim()
    .replace(/[A-Z]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) + 0x20),
    );
}

/** Runtime-facing name for the shared normalization-v1 implementation. */
export const normalizeUtterance = normalizeV1;
