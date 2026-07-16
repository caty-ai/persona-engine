import type {
  AuditEvent,
  PolicyJson,
  Rejected,
  RouteDecl,
  SetInput,
  StateFile,
} from "../types.js";

import type { RouteResolution } from "./routes.js";
import { ownerTriggerIsEligible } from "./triggers.js";

export type StateSnapshot = Pick<StateFile, "v" | "revision" | "mode"> &
  Partial<Pick<StateFile, "set_by" | "set_at" | "route_id">>;

export type ModeResolution = {
  mode: string;
  downgraded: boolean;
  audit: AuditEvent[];
};

export type TransitionAuthorization = {
  allowed: boolean;
  mode: string;
  rejected?: Rejected;
  audit: AuditEvent[];
};

export function routeAllowsMode(route: RouteDecl, mode: string): boolean {
  return mode === "public" || route.allowed_modes.includes(mode);
}

export function resolveMode(
  state: StateSnapshot,
  resolution: RouteResolution,
  timestamp: string,
): ModeResolution {
  if (routeAllowsMode(resolution.route, state.mode)) {
    return { mode: state.mode, downgraded: false, audit: [] };
  }

  return {
    mode: "public",
    downgraded: true,
    audit: [
      {
        ts: timestamp,
        event: "resolve_downgrade",
        route_id: resolution.route_id,
        domain: resolution.state_domain,
        from: state.mode,
        to: "public",
      },
    ],
  };
}

function rejectedTransition(
  currentMode: string,
  requestedMode: string,
  reason: string,
  routeId: string,
  domain: string,
  timestamp: string,
): TransitionAuthorization {
  const rejected: Rejected = { requested_mode: requestedMode, reason };

  return {
    allowed: false,
    mode: currentMode,
    rejected,
    audit: [
      {
        ts: timestamp,
        event: "switch_rejected",
        route_id: routeId,
        domain,
        from: currentMode,
        reason,
      },
    ],
  };
}

function allowedTransition(requestedMode: string): TransitionAuthorization {
  return { allowed: true, mode: requestedMode, audit: [] };
}

export function authorizeOwnerTransition(
  route: RouteDecl,
  currentMode: string,
  requestedMode: string,
  timestamp: string,
): TransitionAuthorization {
  if (!ownerTriggerIsEligible(route, "owner")) {
    return rejectedTransition(
      currentMode,
      requestedMode,
      "resolved route does not permit owner switching",
      route.id,
      route.state_domain,
      timestamp,
    );
  }

  if (!routeAllowsMode(route, requestedMode)) {
    return rejectedTransition(
      currentMode,
      requestedMode,
      "requested mode is not allowed by the resolved route",
      route.id,
      route.state_domain,
      timestamp,
    );
  }

  return allowedTransition(requestedMode);
}

export function authorizeAgentTransition(
  input: Extract<SetInput, { actor: "agent" }>,
  route: RouteDecl,
  currentMode: string,
  timestamp: string,
): TransitionAuthorization {
  let reason: string | undefined;
  if (route.switching !== "explicit-and-agent") {
    reason = "resolved route does not allow agent switching";
  } else if (route.owner_verified !== true) {
    reason = "resolved route is not owner verified";
  } else if (!routeAllowsMode(route, input.requested_mode)) {
    reason = "requested mode is not allowed by the resolved route";
  }

  if (reason !== undefined) {
    return rejectedTransition(
      currentMode,
      input.requested_mode,
      reason,
      route.id,
      route.state_domain,
      timestamp,
    );
  }

  return allowedTransition(input.requested_mode);
}

export function authorizeAdminTransition(
  input: Extract<SetInput, { actor: "admin" }>,
  policy: PolicyJson,
  currentMode: string,
  timestamp: string,
): TransitionAuthorization {
  const domainRoutes = policy.routes.filter(
    ({ state_domain }) => state_domain === input.domain,
  );

  let reason: string | undefined;
  if (!policy.domains.includes(input.domain)) {
    reason = "requested domain does not exist";
  } else if (
    input.requested_mode !== "public" &&
    !domainRoutes.some((route) => route.allowed_modes.includes(input.requested_mode))
  ) {
    reason = "requested mode is not allowed by any route in the domain";
  }

  if (reason !== undefined) {
    return rejectedTransition(
      currentMode,
      input.requested_mode,
      reason,
      "__admin__",
      input.domain,
      timestamp,
    );
  }

  return allowedTransition(input.requested_mode);
}
