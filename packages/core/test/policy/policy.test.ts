import { describe, expect, it } from "vitest";

import {
  authorizeAdminTransition,
  authorizeAgentTransition,
  authorizeOwnerTransition,
  matchEligibleOwnerTrigger,
  matchEligibleOwnerTriggerWithAudit,
  matchTrigger,
  normalizeUtterance,
  ownerTriggerIsEligible,
  resolveMode,
  resolveRoute,
  routeMatches,
} from "../../src/policy/index.js";
import type {
  PolicyJson,
  RouteDecl,
  SetInput,
  TriggersJson,
} from "../../src/types.js";

const timestamp = "1970-01-01T00:00:00.000Z";

function route(overrides: Partial<RouteDecl> = {}): RouteDecl {
  return {
    id: "private-route",
    match: { platform: "dummy" },
    allowed_modes: ["focus"],
    switching: "explicit-and-agent",
    state_domain: "shared",
    owner_verified: true,
    ...overrides,
  };
}

function policy(routes: RouteDecl[]): PolicyJson {
  return {
    routes,
    domains: ["shared", "quarantine"],
    modes: ["public", "focus", "quiet", "sealed"],
    default_route: { state_domain: "quarantine" },
    audit_dir: "audit/",
  };
}

const triggers: TriggersJson = {
  normalization: 1,
  reserved_prefix: "/persona",
  aliases: { "switch to public": "public" },
};

describe("normalization v1 and trigger matching", () => {
  it("applies NFKC, whitespace collapse, and ASCII-only lowercasing", () => {
    expect(normalizeUtterance("  ＳＷＩＴＣＨ　ＴＯ\tＰＵＢＬＩＣ Ä  ")).toBe(
      "switch to public Ä",
    );
  });

  it("matches aliases by the entire normalized utterance only", () => {
    expect(matchTrigger("switch to public", triggers)).toBe("public");
    expect(matchTrigger("please switch to public", triggers)).toBeUndefined();
  });

  it.each(["constructor", "__proto__", "tostring", "hasownproperty"])(
    "does not match inherited alias key %s",
    (utterance) => {
      const aliasesWithoutPrototypeKeys: TriggersJson = {
        ...triggers,
        aliases: {},
      };

      expect(matchTrigger(utterance, aliasesWithoutPrototypeKeys)).toBeUndefined();
    },
  );

  it("still matches a legitimately declared string alias", () => {
    const declaredAlias: TriggersJson = {
      ...triggers,
      aliases: { "legitimate alias": "focus" },
    };

    expect(matchTrigger("legitimate alias", declaredAlias)).toBe("focus");
  });

  it("recognizes the reserved command and rejects an empty target", () => {
    expect(matchTrigger("/persona focus", triggers)).toBe("focus");
    expect(matchTrigger("/persona ", triggers)).toBeUndefined();
    expect(matchTrigger("/persona", triggers)).toBeUndefined();
    expect(matchTrigger("/personafocus", triggers)).toBeUndefined();
    expect(matchTrigger("x /persona focus", triggers)).toBeUndefined();
  });

  it.each([
    [true, "owner", "deny", false],
    [true, "owner", "explicit", true],
    [true, "owner", "explicit-and-agent", true],
    [true, "unknown", "deny", false],
    [true, "unknown", "explicit", false],
    [true, "unknown", "explicit-and-agent", false],
    [false, "owner", "deny", false],
    [false, "owner", "explicit", false],
    [false, "owner", "explicit-and-agent", false],
    [false, "unknown", "deny", false],
    [false, "unknown", "explicit", false],
    [false, "unknown", "explicit-and-agent", false],
  ] as const)(
    "enforces owner_verified=%s actor=%s switching=%s as a three-way AND",
    (ownerVerified, actor, switching, expected) => {
      const candidate = route({ owner_verified: ownerVerified, switching });
      expect(ownerTriggerIsEligible(candidate, actor)).toBe(expected);
      expect(
        matchEligibleOwnerTrigger(
          "switch to public",
          triggers,
          candidate,
          actor,
        ),
      ).toBe(expected ? "public" : undefined);
    },
  );

  it("disables aliases and reserved commands for an unsupported normalization version", () => {
    const unsupported = { ...triggers, normalization: 2 } as unknown as TriggersJson;

    expect(matchTrigger("switch to public", unsupported)).toBeUndefined();
    expect(matchTrigger("/persona focus", unsupported)).toBeUndefined();
    expect(
      matchEligibleOwnerTriggerWithAudit(
        "/persona focus",
        unsupported,
        route(),
        "owner",
        timestamp,
      ),
    ).toEqual({
      audit: [
        {
          ts: timestamp,
          event: "build_invalid",
          route_id: "private-route",
          domain: "shared",
          reason: "unsupported-normalization",
        },
      ],
    });
  });
});

describe("route resolution", () => {
  it("matches equality and prefix constraints", () => {
    const candidate = route({
      match: { platform: "dummy", session_key: { prefix: "private-" } },
    });

    expect(
      routeMatches(
        { platform: "dummy", session_key: "private-123" },
        candidate,
      ),
    ).toBe(true);
    expect(
      routeMatches(
        { platform: "dummy", session_key: "other-123" },
        candidate,
      ),
    ).toBe(false);
  });

  it("treats an empty match object as an intentional catch-all", () => {
    expect(routeMatches({}, route({ match: {} }))).toBe(true);
    expect(
      routeMatches(
        { platform: "dummy", session_id: "anything" },
        route({ match: {} }),
      ),
    ).toBe(true);
  });

  it("treats an empty-string prefix as matching any string value", () => {
    const candidate = route({ match: { platform: { prefix: "" } } });

    expect(routeMatches({ platform: "dummy" }, candidate)).toBe(true);
    expect(routeMatches({ platform: "" }, candidate)).toBe(true);
    expect(routeMatches({ platform: 42 }, candidate)).toBe(false);
  });

  it.each([{}, { platform: "dummy" }, { platform: "dummy", session_key: undefined }])(
    "treats an absent or undefined match key as a hard mismatch",
    (ctx) => {
      const candidate = route({
        match: { platform: "dummy", session_key: { prefix: "private-" } },
      });
      expect(routeMatches(ctx, candidate)).toBe(false);
    },
  );

  it("uses the default route and emits F1 when no non-empty route matches", () => {
    const result = resolveRoute(
      { platform: "dummy" },
      policy([
        route({
          match: { platform: "dummy", channel_id: "owner-channel" },
        }),
      ]),
      timestamp,
    );

    expect(result.route_id).toBe("__default__");
    expect(result.state_domain).toBe("quarantine");
    expect(result.audit).toEqual([
      {
        ts: timestamp,
        event: "route_unresolved",
        route_id: "__default__",
        domain: "quarantine",
      },
    ]);
  });

  it("does not use route order as a tie-break for an invalid overlapping policy", () => {
    const first = route({ id: "z-route", match: { platform: "dummy" } });
    const second = route({ id: "a-route", match: { platform: "dummy" } });
    const forward = resolveRoute(
      { platform: "dummy" },
      policy([first, second]),
      timestamp,
    );
    const reverse = resolveRoute(
      { platform: "dummy" },
      policy([second, first]),
      timestamp,
    );

    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({
      route: {
        id: "__default__",
        allowed_modes: ["public"],
        switching: "deny",
        state_domain: "quarantine",
      },
      route_id: "__default__",
      state_domain: "quarantine",
      audit: [
        {
          ts: timestamp,
          event: "route_unresolved",
          route_id: "__default__",
          domain: "quarantine",
          reason: "overlapping-routes",
        },
      ],
    });
  });
});

describe("resolve-time re-validation", () => {
  it("returns public with F5 without mutating a disallowed state snapshot", () => {
    const state = Object.freeze({ v: 1, revision: 7, mode: "sealed" });
    const resolvedRoute = resolveRoute(
      { platform: "dummy" },
      policy([route({ allowed_modes: ["focus"] })]),
      timestamp,
    );

    expect(resolveMode(state, resolvedRoute, timestamp)).toEqual({
      mode: "public",
      downgraded: true,
      audit: [
        {
          ts: timestamp,
          event: "resolve_downgrade",
          route_id: "private-route",
          domain: "shared",
          from: "sealed",
          to: "public",
        },
      ],
    });
    expect(state).toEqual({ v: 1, revision: 7, mode: "sealed" });
  });

  it("always treats public as implicitly allowed", () => {
    const resolvedRoute = resolveRoute(
      { platform: "dummy" },
      policy([route({ allowed_modes: [] })]),
      timestamp,
    );
    expect(resolveMode({ v: 1, revision: 0, mode: "public" }, resolvedRoute, timestamp)).toEqual({
      mode: "public",
      downgraded: false,
      audit: [],
    });
  });
});

describe("transition authorization", () => {
  it("keeps the current mode and emits F6 for a rejected owner target", () => {
    const result = authorizeOwnerTransition(
      route({ allowed_modes: ["focus"] }),
      "focus",
      "sealed",
      timestamp,
    );

    expect(result.allowed).toBe(false);
    expect(result.mode).toBe("focus");
    expect(result.rejected).toEqual({
      requested_mode: "sealed",
      reason: "requested mode is not allowed by the resolved route",
    });
    expect(result.audit[0]?.event).toBe("switch_rejected");
  });

  it.each([
    ["deny switching", { switching: "deny" }],
    ["an unverified owner", { owner_verified: false }],
  ] as const)("rejects direct owner authorization for %s", (_case, overrides) => {
    const result = authorizeOwnerTransition(
      route(overrides),
      "public",
      "focus",
      timestamp,
    );

    expect(result).toMatchObject({
      allowed: false,
      mode: "public",
      rejected: {
        requested_mode: "focus",
        reason: "resolved route does not permit owner switching",
      },
      audit: [{ event: "switch_rejected" }],
    });
  });

  it("allows an agent only on an owner-verified explicit-and-agent route", () => {
    const input: Extract<SetInput, { actor: "agent" }> = {
      actor: "agent",
      ctx: { platform: "dummy" },
      requested_mode: "focus",
    };

    expect(
      authorizeAgentTransition(input, route(), "public", timestamp),
    ).toMatchObject({ allowed: true, mode: "focus", audit: [] });

    for (const candidate of [
      route({ switching: "explicit" }),
      route({ owner_verified: false }),
      route({ allowed_modes: ["quiet"] }),
    ]) {
      const rejected = authorizeAgentTransition(
        input,
        candidate,
        "sealed",
        timestamp,
      );
      expect(rejected).toMatchObject({
        allowed: false,
        mode: "sealed",
        rejected: { requested_mode: "focus" },
      });
      expect(rejected.audit[0]?.event).toBe("switch_rejected");
    }
  });

  it("allows admin targets from the domain-wide union and bypasses switching", () => {
    const routes = [
      route({
        id: "route-a",
        match: { channel: "a" },
        allowed_modes: ["focus"],
        switching: "deny",
        owner_verified: false,
      }),
      route({
        id: "route-b",
        match: { channel: "b" },
        allowed_modes: ["quiet"],
        switching: "deny",
        owner_verified: false,
      }),
    ];
    const input: Extract<SetInput, { actor: "admin" }> = {
      actor: "admin",
      ctx: null,
      requested_mode: "quiet",
      domain: "shared",
    };

    expect(authorizeAdminTransition(input, policy(routes), "focus", timestamp)).toEqual({
      allowed: true,
      mode: "quiet",
      audit: [],
    });
    expect(
      authorizeAdminTransition(
        { ...input, requested_mode: "public" },
        policy(routes),
        "focus",
        timestamp,
      ).allowed,
    ).toBe(true);
  });

  it.each([
    ["shared", "sealed", "requested mode is not allowed by any route in the domain"],
    ["unknown", "public", "requested domain does not exist"],
  ])("rejects invalid admin domain-union requests", (domain, requestedMode, reason) => {
    const result = authorizeAdminTransition(
      { actor: "admin", ctx: null, domain, requested_mode: requestedMode },
      policy([route()]),
      "focus",
      timestamp,
    );

    expect(result).toMatchObject({
      allowed: false,
      mode: "focus",
      rejected: { requested_mode: requestedMode, reason },
    });
    expect(result.audit[0]).toMatchObject({
      event: "switch_rejected",
      route_id: "__admin__",
      domain,
    });
  });

  it("allows only public in a domain reachable solely through the default route", () => {
    const defaultOnlyPolicy = policy([route()]);
    const adminInput: Extract<SetInput, { actor: "admin" }> = {
      actor: "admin",
      ctx: null,
      requested_mode: "public",
      domain: "quarantine",
    };

    expect(
      authorizeAdminTransition(adminInput, defaultOnlyPolicy, "focus", timestamp),
    ).toEqual({ allowed: true, mode: "public", audit: [] });

    const knownDomainRejection = authorizeAdminTransition(
      { ...adminInput, requested_mode: "focus" },
      defaultOnlyPolicy,
      "public",
      timestamp,
    );
    const unknownDomainRejection = authorizeAdminTransition(
      { ...adminInput, domain: "unknown" },
      defaultOnlyPolicy,
      "public",
      timestamp,
    );

    expect(knownDomainRejection.rejected?.reason).toBe(
      "requested mode is not allowed by any route in the domain",
    );
    expect(unknownDomainRejection.rejected?.reason).toBe(
      "requested domain does not exist",
    );
    expect(unknownDomainRejection.rejected?.reason).not.toBe(
      knownDomainRejection.rejected?.reason,
    );
  });
});
