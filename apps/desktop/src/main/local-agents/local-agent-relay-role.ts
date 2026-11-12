import type { LocalAgentRoleProfile } from "@pwrsnap/shared";

/**
 * The role a relay connection gets when its command line names none.
 *
 * A relay connection is never asked about. The client chooses its own role
 * with `pwrsnap-mcp --role <id>`, and PwrSnap grants exactly that role. A
 * client the operator does not trust with everything is connected with a
 * lower role; one that is not trusted at all belongs in a contained
 * environment, not on this machine's PwrSnap.
 */
export const DEFAULT_RELAY_ROLE_ID = "builtin.full-access";

const BUILT_IN_PREFIX = "builtin.";

/**
 * The role a relay asked for, or `undefined` when no role has that id.
 *
 * A built-in role may be named without its `builtin.` prefix. An unknown id
 * never falls back to another role: the connection is refused instead.
 */
export function resolveRelayRole(
  roles: readonly LocalAgentRoleProfile[],
  requested: string | null
): LocalAgentRoleProfile | undefined {
  const id = requested ?? DEFAULT_RELAY_ROLE_ID;
  const exact = roles.find((role) => role.id === id);
  if (exact !== undefined || id.startsWith(BUILT_IN_PREFIX)) return exact;
  return roles.find((role) => role.builtIn && role.id === `${BUILT_IN_PREFIX}${id}`);
}

/** Why a relay's role was refused, naming the ids it may use instead. */
export function unknownRelayRoleMessage(
  roles: readonly LocalAgentRoleProfile[],
  requested: string | null
): string {
  const ids = roles.map((role) => role.id).join(", ");
  return `PwrSnap has no role "${requested ?? DEFAULT_RELAY_ROLE_ID}". ` +
    `Start pwrsnap-mcp with --role set to one of: ${ids}, then reconnect manually.`;
}
