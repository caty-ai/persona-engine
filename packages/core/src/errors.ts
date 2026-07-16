/** SPEC §4.1 — single source of truth for the 24 build error codes. */
export const BUILD_ERROR_CODES = [
  "E_PARSE",
  "E_SCHEMA_VERSION",
  "E_RESERVED_MODE",
  "E_MODE_ID",
  "E_EXTENDS_CYCLE",
  "E_EXTENDS_UNKNOWN",
  "E_EXTENDS_DEPTH",
  "E_SECTION_CONFLICT",
  "E_SECTION_UNKNOWN",
  "E_SECTION_DUP",
  "E_CATALOG_REF",
  "E_ALIAS_RESERVED",
  "E_ALIAS_COLLISION",
  "E_ALIAS_UNKNOWN_MODE",
  "E_PLACEHOLDER_UNRESOLVED",
  "E_BUDGET_EXCEEDED",
  "E_ROUTE_ID_INVALID",
  "E_ROUTE_OVERLAP",
  "E_ROUTE_UNKNOWN_MODE",
  "E_ROUTE_BAD_MATCH",
  "E_ROUTE_BAD_DOMAIN",
  "E_ROUTE_SWITCHING_UNVERIFIED",
  "E_DEFAULT_ROUTE",
  "E_AUDIT_DIR",
] as const;

/** SPEC §4.1 */
export type BuildErrorCode = (typeof BUILD_ERROR_CODES)[number];

/** SPEC §4.1 */
export interface BuildError {
  code: BuildErrorCode;
  message: string;
  path?: string;
}
