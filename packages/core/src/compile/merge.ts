export type IdItem = Record<string, unknown> & { id: string; remove?: boolean };

export type MergeIssue =
  | { kind: "conflict"; id: string }
  | { kind: "unknown"; id: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Child-priority recursive map merge. Arrays and scalars are replaced. */
export function deepMerge(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...parent };
  for (const [key, childValue] of Object.entries(child)) {
    const parentValue = result[key];
    result[key] = isPlainRecord(parentValue) && isPlainRecord(childValue)
      ? deepMerge(parentValue, childValue)
      : childValue;
  }
  return result;
}

/** SPEC §2.3 ordered id-list add/remove/replace. */
export function mergeIdList(
  parent: readonly IdItem[],
  child: readonly IdItem[],
  conflictFields: readonly string[],
): { items: IdItem[]; issues: MergeIssue[] } {
  const items = parent.map((item) => ({ ...item }));
  const issues: MergeIssue[] = [];

  for (const childItem of child) {
    const index = items.findIndex((item) => item.id === childItem.id);
    if (childItem.remove === true) {
      if (conflictFields.some((field) => Object.hasOwn(childItem, field))) {
        issues.push({ kind: "conflict", id: childItem.id });
        continue;
      }
      if (index === -1) {
        issues.push({ kind: "unknown", id: childItem.id });
      } else {
        items.splice(index, 1);
      }
      continue;
    }

    const replacement = { ...childItem };
    delete replacement.remove;
    if (index === -1) items.push(replacement);
    else items[index] = replacement;
  }

  return { items, issues };
}

export function duplicateIds(items: readonly IdItem[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}
