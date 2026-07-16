import type {
  AuditEvent,
  MatchSpec,
  PolicyJson,
  RouteDecl,
  TurnInput,
} from "../types.js";

export type RouteResolution = {
  route: RouteDecl;
  route_id: string;
  state_domain: string;
  audit: AuditEvent[];
};

function matchValue(value: unknown, match: MatchSpec): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return typeof match === "string"
    ? value === match
    : value.startsWith(match.prefix);
}

export function routeMatches(
  ctx: TurnInput["ctx"],
  route: RouteDecl,
): boolean {
  return Object.entries(route.match).every(([key, match]) => {
    if (!Object.prototype.hasOwnProperty.call(ctx, key) || ctx[key] === undefined) {
      return false;
    }

    return matchValue(ctx[key], match);
  });
}

export function resolveRoute(
  ctx: TurnInput["ctx"],
  policy: PolicyJson,
  timestamp: string,
): RouteResolution {
  const defaultStateDomain =
    typeof policy.default_route?.state_domain === "string"
      ? policy.default_route.state_domain
      : "quarantine";
  const defaultRoute: RouteDecl = {
    id: "__default__",
    match: {},
    allowed_modes: ["public"],
    switching: "deny",
    state_domain: defaultStateDomain,
    owner_verified: false,
  };
  const unresolved = (reason?: string): RouteResolution => ({
    route: defaultRoute,
    route_id: defaultRoute.id,
    state_domain: defaultRoute.state_domain,
    audit: [
      {
        ts: timestamp,
        event: "route_unresolved",
        route_id: defaultRoute.id,
        domain: defaultRoute.state_domain,
        ...(reason === undefined ? {} : { reason }),
      },
    ],
  });

  let matches: RouteDecl[];
  try {
    matches = Array.isArray(policy.routes)
      ? policy.routes.filter((route) => routeMatches(ctx, route))
      : [];
  } catch {
    return unresolved();
  }

  if (matches.length > 1) {
    return unresolved("overlapping-routes");
  }

  const route = matches[0];
  if (route !== undefined) {
    return {
      route,
      route_id: route.id,
      state_domain: route.state_domain,
      audit: [],
    };
  }

  return unresolved();
}
