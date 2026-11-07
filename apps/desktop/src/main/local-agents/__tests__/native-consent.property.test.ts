import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LOCAL_AGENT_CAPABILITIES, resolveLocalAgentPolicy,
  type LocalAgentRoleBudgets } from "@pwrsnap/shared";
import { DesktopSettingsService } from "../../settings/desktop-settings-service";

const budget = fc.record({ limit: fc.integer({ min: 1, max: 1000 }),
  // Settings only permits budget windows of at least 60 seconds.
  windowSeconds: fc.integer({ min: 60, max: 86400 }) });
const budgets = fc.record({ search: budget, "preview.read": budget, "original.read": budget,
  edit: budget, delete: budget });
const scope = fc.record({
  capabilities: fc.subarray([...LOCAL_AGENT_CAPABILITIES], { minLength: 1 }),
  maxCaptureAgeDays: fc.option(fc.integer({ min: 1, max: 36500 }), { nil: null }),
  budgets
});

async function expectInvalidBudget(field: "limit" | "windowSeconds", invalid: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ps-consent-corrupt-"));
  const filePath = join(directory, "settings.json");
  try {
    const settings = new DesktopSettingsService({ filePath });
    const initial = await settings.read();
    const role = initial.localAgents.roles.find((value) => value.id === "builtin.search")!;
    const ceiling = { capabilities: [...role.permissions], maxCaptureAgeDays: role.maxCaptureAgeDays,
      budgets: structuredClone(role.budgets) };
    ceiling.budgets.search[field] = invalid;
    writeFileSync(filePath, JSON.stringify({ ...initial, localAgents: { ...initial.localAgents,
      grants: [{ id: "lag_corrupt", name: "Corrupt Session", roleId: role.id,
        capabilities: role.permissions, nativeConsent: ceiling,
        createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z",
        lastUsedAt: null, revokedAt: null }] } }));
    const reopened = await new DesktopSettingsService({ filePath }).read();
    expect(resolveLocalAgentPolicy(reopened.localAgents, "lag_corrupt").ok).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test("invalid persisted consent budgets fail closed instead of becoming a usable scope ceiling", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("limit", "windowSeconds"),
    fc.integer({ min: -1000, max: 0 }),
    expectInvalidBudget
  ));
});
test("a persisted zero search limit cannot authorize a native Session", async () => {
  await expectInvalidBudget("limit", 0);
});
test("persisted role edits and reopen never exceed any dimension of native consent", async () => {
  await fc.assert(fc.asyncProperty(scope, fc.array(scope, { minLength: 1, maxLength: 5 }),
    fc.boolean(), async (ceiling, edits, revoke) => {
      const directory = mkdtempSync(join(tmpdir(), "ps-consent-property-"));
      const filePath = join(directory, "settings.json");
      try {
        const settings = new DesktopSettingsService({ filePath });
        const grant = { id: "lag_generated", name: "Generated Session", roleId: "generated-role",
          capabilities: ceiling.capabilities, nativeConsent: ceiling,
          createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z",
          lastUsedAt: null, revokedAt: null as string | null };
        for (const edit of edits) {
          await settings.write({ localAgents: { grants: [grant], roles: [{
            id: grant.roleId, name: "Generated role", description: "Property fixture", builtIn: false,
            permissions: edit.capabilities, maxCaptureAgeDays: edit.maxCaptureAgeDays, budgets: edit.budgets
          }] } });
          // The real persisted file is the oracle for an unchanged ceiling.
          const disk = JSON.parse(readFileSync(filePath, "utf8"));
          expect(disk.localAgents.grants[0].nativeConsent).toEqual(ceiling);
          const reopened = await new DesktopSettingsService({ filePath }).read();
          const result = resolveLocalAgentPolicy(reopened.localAgents, grant.id);
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error(result.code);
          expect(new Set(result.policy.capabilities)).toEqual(
            new Set(edit.capabilities.filter((capability) => ceiling.capabilities.includes(capability)))
          );
          const ages = [edit.maxCaptureAgeDays, ceiling.maxCaptureAgeDays]
            .filter((age): age is number => age !== null);
          expect(result.policy.maxCaptureAgeDays).toBe(ages.length ? Math.min(...ages) : null);
          for (const action of Object.keys(ceiling.budgets) as (keyof LocalAgentRoleBudgets)[]) {
            expect(result.policy.budgets[action]).toEqual({
              limit: Math.min(edit.budgets[action].limit, ceiling.budgets[action].limit),
              windowSeconds: Math.max(edit.budgets[action].windowSeconds, ceiling.budgets[action].windowSeconds)
            });
          }
        }
        if (revoke) {
          await settings.write({ localAgents: { grants: [{ ...grant, revokedAt: "2026-11-04T01:00:00.000Z" }] } });
          const reopened = await new DesktopSettingsService({ filePath }).read();
          expect(resolveLocalAgentPolicy(reopened.localAgents, grant.id)).toEqual({ ok: false, code: "session_revoked" });
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  ));
});
