import type {
  AuditEvent,
  RouteDecl,
  TriggersJson,
  TurnInput,
} from "../types.js";

export type TriggerMatchResult = {
  requested_mode?: string;
  audit: AuditEvent[];
};

export function matchTrigger(
  normalizedUtterance: string,
  triggers: TriggersJson,
): string | undefined {
  if (triggers.normalization !== 1) {
    return undefined;
  }

  const commandPrefix = `${triggers.reserved_prefix} `;
  if (normalizedUtterance.startsWith(commandPrefix)) {
    const requestedMode = normalizedUtterance.slice(commandPrefix.length).trim();
    return requestedMode === "" ? undefined : requestedMode;
  }

  if (
    !Object.prototype.hasOwnProperty.call(
      triggers.aliases,
      normalizedUtterance,
    )
  ) {
    return undefined;
  }

  const alias = triggers.aliases[normalizedUtterance];
  return typeof alias === "string" ? alias : undefined;
}

export function ownerTriggerIsEligible(
  route: RouteDecl,
  actor: TurnInput["actor"],
): boolean {
  return (
    route.owner_verified === true &&
    actor === "owner" &&
    (route.switching === "explicit" ||
      route.switching === "explicit-and-agent")
  );
}

export function matchEligibleOwnerTrigger(
  normalizedUtterance: string,
  triggers: TriggersJson,
  route: RouteDecl,
  actor: TurnInput["actor"],
): string | undefined {
  if (!ownerTriggerIsEligible(route, actor)) {
    return undefined;
  }

  return matchTrigger(normalizedUtterance, triggers);
}

export function matchEligibleOwnerTriggerWithAudit(
  normalizedUtterance: string,
  triggers: TriggersJson,
  route: RouteDecl,
  actor: TurnInput["actor"],
  timestamp: string,
): TriggerMatchResult {
  if (triggers.normalization !== 1) {
    return {
      audit: [
        {
          ts: timestamp,
          event: "build_invalid",
          route_id: route.id,
          domain: route.state_domain,
          reason: "unsupported-normalization",
        },
      ],
    };
  }

  const requestedMode = matchEligibleOwnerTrigger(
    normalizedUtterance,
    triggers,
    route,
    actor,
  );
  return requestedMode === undefined
    ? { audit: [] }
    : { requested_mode: requestedMode, audit: [] };
}
