import { describe, expect, test } from "vitest";
import {
  LOCAL_AGENT_BUILT_IN_ROLES,
  LOCAL_AGENT_CAPABILITIES,
  LOCAL_AGENT_CAPABILITY_DANGER,
  resolveLocalAgentPolicy,
  type LocalAgentClientGrant,
  type LocalAgentRoleProfile,
  type Settings
} from "../index";

const NOW = "2026-08-01T12:00:00.000Z";

function grant(overrides: Partial<LocalAgentClientGrant> = {}): LocalAgentClientGrant {
  return {
    id: "lag_codex",
    name: "Codex",
    roleId: "builtin.search",
    capabilities: ["library.read"],
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides
  };
}

function roles(): LocalAgentRoleProfile[] {
  return LOCAL_AGENT_BUILT_IN_ROLES.map((role) => ({
    ...role,
    permissions: [...role.permissions]
  }));
}

function unassignedGrant(): LocalAgentClientGrant {
  const session = grant();
  delete session.roleId;
  return session;
}

function localAgents(
  session: LocalAgentClientGrant,
  roleProfiles = roles()
): Settings["localAgents"] {
  return { grants: [session], roles: roleProfiles, audit: [] };
}

describe("local-agent RBAC policy", () => {
  test("resolves the assigned role and ignores an escalated grant snapshot", () => {
    const resolution = resolveLocalAgentPolicy(
      localAgents(grant({ capabilities: [...LOCAL_AGENT_CAPABILITIES] })),
      "lag_codex"
    );

    expect(resolution).toEqual({
      ok: true,
      policy: {
        sessionId: "lag_codex",
        sessionName: "Codex",
        roleId: "builtin.search",
        roleName: "Search Only",
        capabilities: ["library.read"]
      }
    });
  });

  test.each([
    ["missing Session", localAgents(grant()), "unknown", "session_missing"],
    ["revoked Session", localAgents(grant({ revokedAt: NOW })), "lag_codex", "session_revoked"],
    ["unassigned Session", localAgents(unassignedGrant()), "lag_codex", "role_unassigned"],
    ["missing role", localAgents(grant({ roleId: "custom.missing" })), "lag_codex", "role_missing"]
  ] as const)("fails closed for a %s", (_label, settings, sessionId, code) => {
    expect(resolveLocalAgentPolicy(settings, sessionId)).toEqual({ ok: false, code });
  });

  test("rejects built-in role drift", () => {
    const drifted = roles().map((role) =>
      role.id === "builtin.search"
        ? { ...role, permissions: ["library.read", "trash.write"] as const }
        : role
    ) as LocalAgentRoleProfile[];
    expect(resolveLocalAgentPolicy(localAgents(grant(), drifted), "lag_codex"))
      .toEqual({ ok: false, code: "builtin_role_drift" });
  });

  test("keeps permission definitions, danger tiers, and full access in lockstep", () => {
    expect(Object.keys(LOCAL_AGENT_CAPABILITY_DANGER).sort()).toEqual(
      [...LOCAL_AGENT_CAPABILITIES].sort()
    );
    expect(
      LOCAL_AGENT_BUILT_IN_ROLES.find((role) => role.id === "builtin.full-access")
        ?.permissions
    ).toEqual(LOCAL_AGENT_CAPABILITIES);
  });
});
