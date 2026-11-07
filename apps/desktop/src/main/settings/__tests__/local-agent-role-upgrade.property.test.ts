import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_AGENT_CAPABILITIES,
  resolveLocalAgentPolicy,
  type Settings,
} from "@pwrsnap/shared";
import {
  DesktopSettingsService,
  defaultSettings,
} from "../desktop-settings-service";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const stamp = "2026-11-05T12:00:00.000Z";
const priorPermissions = LOCAL_AGENT_CAPABILITIES.filter(
  (p) => p !== "sizzle.assets.import",
);
function historicalSettings(revoked: boolean[]): Settings {
  const raw = defaultSettings();
  raw.localAgents.enabled = true;
  raw.localAgents.roles = raw.localAgents.roles.map((role) =>
    role.id === "builtin.full-access"
      ? { ...role, permissions: [...priorPermissions] }
      : role,
  );
  raw.localAgents.grants = revoked.map((isRevoked, i) => ({
    id: `session_${i}`,
    name: `Agent ${i}`,
    roleId: "builtin.full-access",
    capabilities: [...priorPermissions],
    createdAt: stamp,
    updatedAt: stamp,
    lastUsedAt: null,
    revokedAt: isRevoked ? stamp : null,
  }));
  return raw;
}
async function fixture(
  raw: unknown,
): Promise<{ root: string; path: string; service: DesktopSettingsService }> {
  const root = await mkdtemp(join(tmpdir(), "pwrsnap-role-upgrade-"));
  roots.push(root);
  const path = join(root, "settings.json");
  await writeFile(path, JSON.stringify(raw));
  return {
    root,
    path,
    service: new DesktopSettingsService({ filePath: path }),
  };
}

describe("the pre-media-import Full Access upgrade", () => {
  it("preserves every prior authorization and revocation without granting the new permission", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        async (revoked) => {
          const raw = historicalSettings(revoked);
          const { path, service } = await fixture(raw);
          const before = JSON.stringify(raw);
          const current = await service.read();
          const canonical = current.localAgents.roles.find(
            (role) => role.id === "builtin.full-access",
          )!;
          expect(canonical.permissions).toEqual(LOCAL_AGENT_CAPABILITIES);
          for (const [i, session] of current.localAgents.grants.entries()) {
            const policy = resolveLocalAgentPolicy(
              current.localAgents,
              session.id,
            );
            expect({
              ...session,
              roleId: raw.localAgents.grants[i]!.roleId,
            }).toEqual(raw.localAgents.grants[i]);
            if (revoked[i])
              expect(policy).toEqual({ ok: false, code: "session_revoked" });
            else {
              expect(policy.ok).toBe(true);
              if (!policy.ok) throw new Error(policy.code);
              expect(policy.policy.capabilities).toEqual(priorPermissions);
              expect(policy.policy.maxCaptureAgeDays).toBeNull();
              expect(policy.policy.budgets).toEqual(canonical.budgets);
            }
          }
          expect(JSON.stringify(raw)).toBe(before);
          await service.write({ recording: { includeMicrophone: true } });
          const persisted = JSON.parse(await readFile(path, "utf8"));
          expect(persisted.localAgents).toEqual(current.localAgents);
          const restarted = await new DesktopSettingsService({
            filePath: path,
          }).read();
          expect(restarted.localAgents).toEqual(current.localAgents);
        },
      ),
      { numRuns: 20, examples: [[[false, true, false]]] },
    );
  });

  it("keeps role and session migration together when the next write changes only sessions", async () => {
    const { path, service } = await fixture(historicalSettings([false]));
    const current = await service.read();
    const fresh = {
      ...current.localAgents.grants[0]!,
      id: "fresh",
      name: "Fresh approval",
      roleId: "builtin.full-access",
      capabilities: [...LOCAL_AGENT_CAPABILITIES],
    };
    await service.write({
      localAgents: { grants: [...current.localAgents.grants, fresh] },
    });
    const restarted = await new DesktopSettingsService({
      filePath: path,
    }).read();
    for (const [id, permissions] of [
      ["session_0", priorPermissions],
      ["fresh", LOCAL_AGENT_CAPABILITIES],
    ] as const) {
      const policy = resolveLocalAgentPolicy(restarted.localAgents, id);
      expect(policy.ok).toBe(true);
      if (!policy.ok) throw new Error(policy.code);
      expect(policy.policy.capabilities).toEqual(permissions);
    }
  });

  it("preserves unknown saved fields and avoids collisions with existing custom profiles", async () => {
    const raw = historicalSettings([false]);
    const old = raw.localAgents.roles.find(
      (role) => role.id === "builtin.full-access",
    )!;
    Object.assign(old, { futureRoleField: "keep role metadata" });
    Object.assign(raw.localAgents.grants[0]!, {
      futureGrantField: "keep session metadata",
    });
    raw.localAgents.roles.push({
      ...old,
      id: "migrated.full-access.pre-media-import",
      builtIn: false,
      name: "Full Access (before media import)",
    });
    const { path, service } = await fixture(raw);
    const current = await service.read();
    expect(current.localAgents.grants[0]!.roleId).not.toBe(
      "builtin.full-access",
    );
    expect(new Set(current.localAgents.roles.map((role) => role.id)).size).toBe(
      current.localAgents.roles.length,
    );
    await service.write({ recording: { includeMicrophone: true } });
    const disk = JSON.parse(await readFile(path, "utf8"));
    expect(disk.localAgents.grants[0].futureGrantField).toBe(
      "keep session metadata",
    );
    expect(
      disk.localAgents.roles.find(
        (role: { id: string }) =>
          role.id === current.localAgents.grants[0]!.roleId,
      ).futureRoleField,
    ).toBe("keep role metadata");
  });

  it("leaves arbitrary built-in drift fail-closed", async () => {
    const raw = historicalSettings([false]);
    raw.localAgents.roles.find((role) => role.id === "builtin.full-access")!
      .budgets.edit.limit--;
    const { service } = await fixture(raw);
    const current = await service.read();
    expect(resolveLocalAgentPolicy(current.localAgents, "session_0")).toEqual({
      ok: false,
      code: "builtin_role_drift",
    });
    expect(current.localAgents.roles).toEqual(raw.localAgents.roles);
  });

  it("never quarantines or drops a full role table to make room for migration", async () => {
    const raw = historicalSettings([false]);
    while (raw.localAgents.roles.length < 100)
      raw.localAgents.roles.push({
        ...raw.localAgents.roles[0]!,
        id: `custom.${raw.localAgents.roles.length}`,
        builtIn: false,
      });
    const { root, service } = await fixture(raw);
    const current = await service.read();
    expect(current.localAgents.roles).toHaveLength(101);
    expect(
      current.localAgents.roles.filter((role) => role.id.startsWith("custom.")),
    ).toEqual(
      raw.localAgents.roles.filter((role) => role.id.startsWith("custom.")),
    );
    const policy = resolveLocalAgentPolicy(current.localAgents, "session_0");
    expect(policy.ok).toBe(true);
    if (!policy.ok) throw new Error(policy.code);
    expect(policy.policy.capabilities).toEqual(priorPermissions);
    expect((await readdir(root)).some((name) => name.includes("corrupt"))).toBe(
      false,
    );
  });
});
