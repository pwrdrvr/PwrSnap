import {
  LOCAL_AGENT_CAPABILITIES,
  isLocalAgentCapability,
  type LocalAgentCapability,
  type LocalAgentClientGrant,
  type LocalAgentRoleBudgets,
  type LocalAgentRoleProfile,
  type LocalAgentUsageAction,
  type Settings
} from "./protocol";

export const LOCAL_AGENT_BUILT_IN_ROLES = [
  {
    id: "builtin.search",
    name: "Search Only",
    description: "Search capture metadata without reading image pixels.",
    builtIn: true,
    permissions: ["library.read"],
    maxCaptureAgeDays: 7,
    budgets: budgets(50, 1, 1, 1, 1)
  },
  {
    id: "builtin.preview",
    name: "Search + Previews",
    description: "Search and read edited composites with visible redactions applied.",
    builtIn: true,
    permissions: ["library.read", "capture.composite.read"],
    maxCaptureAgeDays: 7,
    budgets: budgets(50, 200, 1, 1, 1)
  },
  {
    id: "builtin.full-media",
    name: "Full Media",
    description: "Search, read edited and original pixels, and create exports.",
    builtIn: true,
    permissions: [
      "library.read",
      "capture.composite.read",
      "capture.original.read",
      "capture.export"
    ],
    maxCaptureAgeDays: 30,
    budgets: budgets(500, 2_000, 250, 1, 1)
  },
  {
    id: "builtin.editor",
    name: "Image Editor",
    description: "Full media access plus PwrSnap-owned image edits.",
    builtIn: true,
    permissions: [
      "library.read",
      "capture.composite.read",
      "capture.original.read",
      "capture.export",
      "capture.edit"
    ],
    maxCaptureAgeDays: 30,
    budgets: budgets(500, 2_000, 250, 100, 1)
  },
  {
    id: "builtin.sizzle",
    name: "Sizzle Producer",
    description: "Search, read edited previews, and compose preview Sizzle renders.",
    builtIn: true,
    permissions: [
      "library.read",
      "capture.composite.read",
      "sizzle.compose",
      "sizzle.preview.read"
    ],
    maxCaptureAgeDays: 30,
    budgets: budgets(500, 2_000, 1, 100, 1)
  },
  {
    id: "builtin.full-access",
    name: "Full Access",
    description: "Every local-agent permission, including originals, Trash, and full renders.",
    builtIn: true,
    permissions: [...LOCAL_AGENT_CAPABILITIES],
    maxCaptureAgeDays: null,
    budgets: budgets(1_000, 2_000, 250, 200, 100)
  }
] as const satisfies readonly LocalAgentRoleProfile[];

export type LocalAgentPermissionDanger = "standard" | "sensitive" | "destructive";

export const LOCAL_AGENT_CAPABILITY_DANGER: Record<
  LocalAgentCapability,
  LocalAgentPermissionDanger
> = {
  "library.read": "standard",
  "capture.composite.read": "standard",
  "capture.original.read": "sensitive",
  "capture.export": "sensitive",
  "capture.edit": "sensitive",
  "trash.write": "destructive",
  "sizzle.compose": "sensitive",
  "sizzle.preview.read": "sensitive",
  "sizzle.full.read": "destructive"
};

export type ResolvedLocalAgentPolicy = {
  sessionId: string;
  sessionName: string;
  roleId: string;
  roleName: string;
  capabilities: readonly LocalAgentCapability[];
  maxCaptureAgeDays: number | null;
  budgets: LocalAgentRoleBudgets;
};

export type LocalAgentPolicyRejectionCode =
  | "session_missing"
  | "session_revoked"
  | "role_unassigned"
  | "role_missing"
  | "role_invalid"
  | "builtin_role_drift";

export type LocalAgentPolicyResolution =
  | { ok: true; policy: ResolvedLocalAgentPolicy }
  | { ok: false; code: LocalAgentPolicyRejectionCode };

/** Pure, fail-closed policy resolver. Every transport re-resolves a Session
 *  before dispatch so revocation and role edits take effect immediately. */
export function resolveLocalAgentPolicy(
  localAgents: Settings["localAgents"],
  sessionId: string
): LocalAgentPolicyResolution {
  const session = localAgents.grants.find((grant) => grant.id === sessionId);
  if (session === undefined) return { ok: false, code: "session_missing" };
  if (session.revokedAt !== null) return { ok: false, code: "session_revoked" };
  if (session.roleId === undefined || session.roleId.length === 0) {
    return { ok: false, code: "role_unassigned" };
  }
  const roles = localAgents.roles.filter((role) => role.id === session.roleId);
  if (roles.length !== 1) return { ok: false, code: "role_missing" };
  const role = roles[0];
  if (!isValidRole(role)) return { ok: false, code: "role_invalid" };
  if (role.builtIn && !matchesCanonicalBuiltIn(role)) {
    return { ok: false, code: "builtin_role_drift" };
  }
  return {
    ok: true,
    policy: {
      sessionId: session.id,
      sessionName: session.name,
      roleId: role.id,
      roleName: role.name,
      capabilities: [...role.permissions],
      maxCaptureAgeDays: role.maxCaptureAgeDays,
      budgets: cloneBudgets(role.budgets)
    }
  };
}

export function findRoleForCapabilities(
  roles: readonly LocalAgentRoleProfile[],
  capabilities: readonly LocalAgentCapability[]
): LocalAgentRoleProfile | undefined {
  const expected = capabilityFingerprint(capabilities);
  return roles.find((role) => capabilityFingerprint(role.permissions) === expected);
}

export function defaultLocalAgentRoleConstraints(
  capabilities: readonly LocalAgentCapability[]
): Pick<LocalAgentRoleProfile, "maxCaptureAgeDays" | "budgets"> {
  const builtIn = findRoleForCapabilities(
    LOCAL_AGENT_BUILT_IN_ROLES.map((role) => ({
      ...role,
      permissions: [...role.permissions],
      budgets: cloneBudgets(role.budgets)
    })),
    capabilities
  );
  if (builtIn !== undefined) {
    return {
      maxCaptureAgeDays: builtIn.maxCaptureAgeDays,
      budgets: cloneBudgets(builtIn.budgets)
    };
  }
  return {
    maxCaptureAgeDays: 7,
    budgets: budgets(50, 200, 25, 25, 10)
  };
}

export function capabilityFingerprint(
  capabilities: readonly LocalAgentCapability[]
): string {
  return [...new Set(capabilities)].sort().join("\n");
}

export function isValidRole(role: LocalAgentRoleProfile): boolean {
  return (
    role.id.trim().length > 0 &&
    role.id.length <= 128 &&
    role.name.trim().length > 0 &&
    role.name.length <= 200 &&
    role.description.length <= 500 &&
    role.permissions.length > 0 &&
    role.permissions.every(isLocalAgentCapability) &&
    new Set(role.permissions).size === role.permissions.length &&
    (!role.id.startsWith("builtin.") || role.builtIn) &&
    (role.maxCaptureAgeDays === null ||
      (Number.isInteger(role.maxCaptureAgeDays) &&
        role.maxCaptureAgeDays >= 1 &&
        role.maxCaptureAgeDays <= 36_500)) &&
    isValidBudgets(role.budgets)
  );
}

function matchesCanonicalBuiltIn(role: LocalAgentRoleProfile): boolean {
  const canonical = LOCAL_AGENT_BUILT_IN_ROLES.find((item) => item.id === role.id);
  return (
    canonical !== undefined &&
    role.name === canonical.name &&
    role.description === canonical.description &&
    capabilityFingerprint(role.permissions) ===
      capabilityFingerprint(canonical.permissions) &&
    role.maxCaptureAgeDays === canonical.maxCaptureAgeDays &&
    JSON.stringify(role.budgets) === JSON.stringify(canonical.budgets)
  );
}

const USAGE_ACTIONS = [
  "search",
  "preview.read",
  "original.read",
  "edit",
  "delete"
] as const satisfies readonly LocalAgentUsageAction[];

function budgets(
  search: number,
  preview: number,
  original: number,
  edit: number,
  deletion: number
): LocalAgentRoleBudgets {
  const windowSeconds = 24 * 60 * 60;
  return {
    search: { limit: search, windowSeconds },
    "preview.read": { limit: preview, windowSeconds },
    "original.read": { limit: original, windowSeconds },
    edit: { limit: edit, windowSeconds },
    delete: { limit: deletion, windowSeconds }
  };
}

function isValidBudgets(value: LocalAgentRoleBudgets): boolean {
  if (typeof value !== "object" || value === null) return false;
  return USAGE_ACTIONS.every((action) => {
    const budget = value[action];
    return (
      typeof budget === "object" &&
      budget !== null &&
      Number.isInteger(budget.limit) &&
      budget.limit >= 1 &&
      budget.limit <= 1_000_000 &&
      Number.isInteger(budget.windowSeconds) &&
      budget.windowSeconds >= 60 &&
      budget.windowSeconds <= 365 * 24 * 60 * 60
    );
  });
}

function cloneBudgets(value: LocalAgentRoleBudgets): LocalAgentRoleBudgets {
  return {
    search: { ...value.search },
    "preview.read": { ...value["preview.read"] },
    "original.read": { ...value["original.read"] },
    edit: { ...value.edit },
    delete: { ...value.delete }
  };
}

export function effectiveCapabilitiesForGrant(
  localAgents: Settings["localAgents"],
  grant: LocalAgentClientGrant
): readonly LocalAgentCapability[] {
  const resolution = resolveLocalAgentPolicy(localAgents, grant.id);
  return resolution.ok ? resolution.policy.capabilities : [];
}
