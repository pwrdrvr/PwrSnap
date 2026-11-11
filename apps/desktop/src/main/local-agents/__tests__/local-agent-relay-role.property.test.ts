import fc from "fast-check";
import { expect, test } from "vitest";
import {
  LOCAL_AGENT_BUILT_IN_ROLES,
  type LocalAgentRoleProfile
} from "@pwrsnap/shared";
import { DEFAULT_RELAY_ROLE_ID, resolveRelayRole } from "../local-agent-relay-role";

const builtIns: LocalAgentRoleProfile[] = LOCAL_AGENT_BUILT_IN_ROLES.map((role) => ({
  ...role,
  permissions: [...role.permissions],
  budgets: structuredClone(role.budgets)
}));
const roleId = fc.stringMatching(/^[A-Za-z0-9._-]{1,64}$/);
const customRoles = fc.uniqueArray(
  roleId.map((id): LocalAgentRoleProfile => ({
    ...builtIns[0]!,
    id,
    name: `Custom ${id}`,
    builtIn: false
  })),
  { selector: (role) => role.id, maxLength: 6 }
).map((roles) => roles.filter((role) => !builtIns.some((builtIn) => builtIn.id === role.id)));

test("a relay gets exactly the role it named, Full Access by default, and never a substitute", () => {
  fc.assert(fc.property(customRoles, fc.option(roleId, { nil: null }), (custom, requested) => {
    const roles = [...builtIns, ...custom];
    const resolved = resolveRelayRole(roles, requested);
    const id = requested ?? DEFAULT_RELAY_ROLE_ID;
    const exact = roles.find((role) => role.id === id);
    const shorthand = id.startsWith("builtin.")
      ? undefined
      : builtIns.find((role) => role.id === `builtin.${id}`);
    // The named role, or the built-in it abbreviates, or nothing at all.
    expect(resolved).toBe(exact ?? shorthand);
    if (resolved !== undefined) {
      expect(resolved.id === id || resolved.id === `builtin.${id}`).toBe(true);
    }
  }));
});

test("no command-line role is Full Access, and every built-in answers to its short name", () => {
  expect(resolveRelayRole(builtIns, null)?.id).toBe("builtin.full-access");
  for (const role of builtIns) {
    expect(resolveRelayRole(builtIns, role.id)).toBe(role);
    expect(resolveRelayRole(builtIns, role.id.slice("builtin.".length))).toBe(role);
  }
  // A role a client cannot see is never granted in its place.
  expect(resolveRelayRole(builtIns.filter((role) => role.id !== "builtin.full-access"), null))
    .toBeUndefined();
});
