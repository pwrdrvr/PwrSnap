import { LOCAL_AGENT_BUILT_IN_ROLES } from "@pwrsnap/shared";

const fullAccess = LOCAL_AGENT_BUILT_IN_ROLES.find(
  (role) => role.id === "builtin.full-access",
)!;
// This is a historical definition, deliberately independent of future changes
// to the canonical role. Recognizing a subset alone would accept tampering.
const previousPermissions = [
  "library.read",
  "capture.composite.read",
  "capture.original.read",
  "capture.export",
  "capture.edit",
  "trash.write",
  "sizzle.compose",
  "sizzle.preview.read",
  "sizzle.full.read",
];
const previousBudgetLimits = {
  search: 1000,
  "preview.read": 2000,
  "original.read": 250,
  edit: 200,
  delete: 100,
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Recognize only the shipped pre-import profile, not arbitrary built-in drift.
 * Existing sessions keep their original permissions and limits in a custom
 * profile; only a new operator approval can select the expanded built-in role.
 * Operate on raw rows so future fields survive the lazy settings rewrite. */
export function upgradeHistoricalLocalAgentRoles(raw: unknown): unknown {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.roles) ||
    raw.roles.length > 100 ||
    (raw.grants !== undefined && !Array.isArray(raw.grants))
  )
    return raw;
  const old = raw.roles.find(isPreviousFullAccess);
  if (!old) return raw;
  const ids = new Set(raw.roles.filter(isRecord).map((role) => role.id));
  const names = new Set(
    raw.roles
      .filter(isRecord)
      .map((role) =>
        typeof role.name === "string" ? role.name.toLowerCase() : "",
      ),
  );
  const baseId = "migrated.full-access.pre-media-import";
  const baseName = "Full Access (before media import)";
  let id = baseId,
    name = baseName,
    suffix = 1;
  while (ids.has(id)) id = `${baseId}.${suffix++}`;
  suffix = 2;
  while (names.has(name.toLowerCase())) name = `${baseName} ${suffix++}`;
  const preserved = {
    ...old,
    id,
    name,
    builtIn: false,
    description:
      "Preserves the permissions approved before Sizzle media import was added.",
  };
  const roles = raw.roles.map((role) =>
    role === old
      ? {
          ...fullAccess,
          permissions: [...fullAccess.permissions],
          budgets: structuredClone(fullAccess.budgets),
        }
      : role,
  );
  roles.push(preserved);
  return {
    ...raw,
    roles,
    ...(Array.isArray(raw.grants)
      ? {
          grants: raw.grants.map((grant) =>
            isRecord(grant) && grant.roleId === fullAccess.id
              ? { ...grant, roleId: id }
              : grant,
          ),
        }
      : {}),
  };
}

function isPreviousFullAccess(role: unknown): role is Record<string, unknown> {
  if (
    !isRecord(role) ||
    role.id !== fullAccess.id ||
    role.builtIn !== true ||
    role.name !== "Full Access" ||
    role.description !==
      "Every local-agent permission, including originals, Trash, and full renders." ||
    role.maxCaptureAgeDays !== null ||
    !Array.isArray(role.permissions) ||
    role.permissions.length !== previousPermissions.length ||
    !previousPermissions.every((permission) =>
      (role.permissions as unknown[]).includes(permission),
    ) ||
    !isRecord(role.budgets)
  )
    return false;
  const budgets = role.budgets;
  return Object.entries(previousBudgetLimits).every(([action, expected]) => {
    const budget = budgets[action];
    return (
      isRecord(budget) &&
      budget.limit === expected &&
      budget.windowSeconds === 86400
    );
  });
}
