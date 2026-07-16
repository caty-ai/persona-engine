/** SPEC §4.1 normative counter. */
export function countPeTokens(value: string | Uint8Array): number {
  const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  return Math.ceil(bytes / 3);
}

export function effectiveBudget(
  installBudget: number | undefined,
  packBudget: number | undefined,
  modeBudget: number | undefined,
): number {
  const globalBudget = installBudget ?? packBudget ?? 600;
  return Math.min(globalBudget, modeBudget ?? Number.POSITIVE_INFINITY);
}
