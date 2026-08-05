import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_AGENT_CAPABILITIES,
  defaultLocalAgentRoleConstraints
} from "@pwrsnap/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";

const safeStorageMock = vi.hoisted(() => {
  let available = true;
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((s: string): Buffer => {
      const b64 = Buffer.from(s, "utf8").toString("base64");
      return Buffer.from(`PWR-ENC|${b64}`, "utf8");
    }),
    decryptString: vi.fn((b: Buffer): string => {
      const text = b.toString("utf8");
      if (!text.startsWith("PWR-ENC|")) throw new Error("not a PWR-ENC blob");
      return Buffer.from(text.slice("PWR-ENC|".length), "base64").toString("utf8");
    }),
    __setAvailable(value: boolean): void {
      available = value;
    }
  };
});

vi.mock("electron", () => ({
  safeStorage: safeStorageMock
}));

import { bus } from "../../command-bus";
import { DesktopSecretStore } from "../../settings/desktop-secret-store";
import {
  DesktopSettingsService,
  defaultSettings
} from "../../settings/desktop-settings-service";
import {
  LocalAgentGrantService,
  secretNameForClient
} from "../local-agent-grants";

let workDir = "";
let settings: DesktopSettingsService;
let secrets: DesktopSecretStore;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pwrsnap-local-agent-grants-"));
  safeStorageMock.__setAvailable(true);
  settings = new DesktopSettingsService({ filePath: join(workDir, "settings.json") });
  secrets = new DesktopSecretStore({ filePath: join(workDir, "secrets.bin") });
});

function makeService(): LocalAgentGrantService {
  return new LocalAgentGrantService({
    settings,
    secrets,
    now: () => new Date("2026-06-07T12:00:00.000Z"),
    makeId: () => "lag_test",
    makeRoleId: () => "lar_test",
    makeToken: () => "pws_local_test-token"
  });
}

describe("LocalAgentGrantService", () => {
  test("createGrant persists metadata and stores only a token hash in safeStorage", async () => {
    const service = makeService();
    const result = await service.createGrant({
      name: " PwrAgent ",
      capabilities: ["library.read", "capture.composite.read", "library.read"]
    });

    expect(result.token).toBe("pws_local_test-token");
    expect(result.grant).toMatchObject({
      id: "lag_test",
      name: "PwrAgent",
      roleId: "builtin.preview",
      capabilities: ["library.read", "capture.composite.read"],
      revokedAt: null
    });

    const reread = await settings.read();
    expect(reread.localAgents.grants).toHaveLength(1);
    expect(reread.localAgents.grants[0]?.id).toBe("lag_test");

    const stored = await secrets.getValue(secretNameForClient("lag_test"));
    expect(stored).not.toBeNull();
    expect(stored).not.toBe("pws_local_test-token");
    const onDisk = readFileSync(join(workDir, "secrets.bin"), "utf8");
    expect(onDisk.includes("pws_local_test-token")).toBe(false);
  });

  test("authenticate is read-only and recordUsage updates lastUsedAt", async () => {
    const service = makeService();
    await service.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read", "capture.composite.read"]
    });

    const auth = await service.authenticate({
      clientId: "lag_test",
      token: "pws_local_test-token",
      requiredCapabilities: ["library.read"]
    });

    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.context).toMatchObject({
      clientId: "lag_test",
      sessionName: "PwrAgent",
      roleId: "builtin.preview",
      roleName: "Search + Previews",
      capabilities: ["library.read", "capture.composite.read"]
    });
    expect(auth.grant.lastUsedAt).toBeNull();

    await service.recordUsage("lag_test");
    const reread = await service.list();
    expect(reread[0]?.lastUsedAt).toBe("2026-06-07T12:00:00.000Z");
  });

  test("OAuth authorization creates independently named sessions for one public client", async () => {
    let tokenNumber = 0;
    const service = new LocalAgentGrantService({
      settings,
      secrets,
      now: () => new Date("2026-06-07T12:00:00.000Z"),
      makeId: () => `lag_session_${tokenNumber + 1}`,
      makeToken: () => `pws_local_oauth-token-${++tokenNumber}`
    });
    const oauthClient = {
      clientId: "lag_oauth",
      clientName: "Codex Desktop",
      redirectUris: ["http://127.0.0.1:43123/callback"],
      clientUri: null,
      scope: null,
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      softwareId: null,
      softwareVersion: "1.2.3",
      registeredAt: "2026-06-07T12:00:00.000Z"
    };

    const first = await service.issueOAuthGrant({
      name: "Codex Desktop",
      capabilities: ["library.read"],
      oauthClient
    });
    expect(first.grant).toMatchObject({
      id: "lag_session_2",
      capabilities: ["library.read"],
      oauthClient
    });

    await service.revokeGrant(first.grant.id);
    const second = await service.issueOAuthGrant({
      name: "Codex Personal",
      capabilities: ["library.read", "capture.composite.read"],
      oauthClient
    });
    expect(second.grant).toMatchObject({
      id: "lag_session_3",
      capabilities: ["library.read", "capture.composite.read"],
      revokedAt: null
    });
    expect(await service.list()).toHaveLength(2);
    await expect(service.authenticate({
      clientId: first.grant.id,
      token: first.token
    })).resolves.toEqual({ ok: false, code: "revoked" });
    await expect(service.authenticate({
      clientId: second.grant.id,
      token: second.token
    })).resolves.toMatchObject({ ok: true });
  });

  test("OAuth custom access preserves an explicit all-time capture-history limit", async () => {
    const service = makeService();
    const issued = await service.issueOAuthGrant({
      name: "All Time Agent",
      capabilities: ["library.read"],
      roleId: null,
      maxCaptureAgeDays: null,
      oauthClient: {
        clientId: "lag_oauth_all_time",
        clientName: "All Time Agent",
        redirectUris: ["http://127.0.0.1:43123/callback"],
        clientUri: null,
        scope: "library.read",
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        softwareId: null,
        softwareVersion: null,
        registeredAt: "2026-06-07T12:00:00.000Z"
      }
    });

    const reread = await settings.read();
    expect(reread.localAgents.roles.find((role) => role.id === issued.grant.roleId))
      .toMatchObject({ maxCaptureAgeDays: null });
    await expect(service.authenticate({
      clientId: issued.grant.id,
      token: issued.token
    })).resolves.toMatchObject({
      ok: true,
      context: { maxCaptureAgeDays: null }
    });
  });

  test("recordUsage throttles settings writes", async () => {
    let now = new Date("2026-06-07T12:00:00.000Z");
    const service = new LocalAgentGrantService({
      settings,
      secrets,
      now: () => now,
      makeId: () => "lag_usage",
      makeToken: () => "pws_local_usage-token",
      usageWriteIntervalMs: 60_000
    });
    await service.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const write = vi.spyOn(settings, "write");

    await service.recordUsage("lag_usage");
    now = new Date("2026-06-07T12:00:30.000Z");
    await service.recordUsage("lag_usage");
    now = new Date("2026-06-07T12:01:01.000Z");
    await service.recordUsage("lag_usage");

    expect(write).toHaveBeenCalledTimes(2);
    expect((await service.list())[0]?.lastUsedAt).toBe("2026-06-07T12:01:01.000Z");
  });

  test("serializes concurrent grant mutations without dropping grants", async () => {
    let nextId = 0;
    const service = new LocalAgentGrantService({
      settings,
      secrets,
      makeId: () => `lag_${++nextId}`,
      makeToken: () => `pws_local_token_${nextId}`
    });

    await Promise.all([
      service.createGrant({ name: "Agent A", capabilities: ["library.read"] }),
      service.createGrant({ name: "Agent B", capabilities: ["capture.composite.read"] })
    ]);

    expect((await service.list()).map((grant) => grant.id)).toEqual([
      "lag_1",
      "lag_2"
    ]);
  });

  test("authenticate rejects missing, invalid, revoked, and under-scoped tokens", async () => {
    const service = makeService();
    await service.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });

    await expect(service.authenticate({
      clientId: "lag_test",
      token: null,
      requiredCapabilities: ["library.read"]
    })).resolves.toEqual({ ok: false, code: "missing_token" });

    await expect(service.authenticate({
      clientId: "lag_test",
      token: "wrong",
      requiredCapabilities: ["library.read"]
    })).resolves.toEqual({ ok: false, code: "invalid_token" });

    await expect(service.authenticate({
      clientId: "lag_test",
      token: "pws_local_test-token",
      requiredCapabilities: ["capture.original.read"]
    })).resolves.toEqual({ ok: false, code: "missing_capability" });

    await service.revokeGrant("lag_test");
    await expect(service.authenticate({
      clientId: "lag_test",
      token: "pws_local_test-token",
      requiredCapabilities: ["library.read"]
    })).resolves.toEqual({ ok: false, code: "revoked" });
    await expect(secrets.getValue(secretNameForClient("lag_test"))).resolves.toBeNull();
  });

  test("custom roles are reusable, immediately effective, and built-ins are immutable", async () => {
    const service = makeService();
    await service.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const custom = await service.createRole({
      name: "Careful editor",
      description: "Can search and edit without reading originals.",
      permissions: ["library.read", "capture.edit"],
      ...defaultLocalAgentRoleConstraints(["library.read", "capture.edit"])
    });
    expect(custom).toMatchObject({
      id: "lar_test",
      builtIn: false,
      permissions: ["library.read", "capture.edit"]
    });

    const assigned = await service.assignRole("lag_test", custom.id);
    expect(assigned).toMatchObject({
      roleId: "lar_test",
      capabilities: ["library.read", "capture.edit"]
    });
    await expect(service.authenticate({
      clientId: "lag_test",
      token: "pws_local_test-token",
      requiredCapabilities: ["capture.edit"]
    })).resolves.toMatchObject({
      ok: true,
      context: { roleId: "lar_test", roleName: "Careful editor" }
    });

    await service.updateRole(custom.id, {
      permissions: ["library.read"]
    });
    await expect(service.authenticate({
      clientId: "lag_test",
      token: "pws_local_test-token",
      requiredCapabilities: ["capture.edit"]
    })).resolves.toEqual({ ok: false, code: "missing_capability" });
    await expect(service.updateRole("builtin.search", { name: "Changed" }))
      .rejects.toMatchObject({ code: "builtin_role_immutable" });
    await expect(service.deleteRole(custom.id))
      .rejects.toMatchObject({ code: "role_assigned" });
  });

  test("an unassigned or missing role fails authentication closed", async () => {
    const service = makeService();
    const issued = await service.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const raw = await settings.read();
    await settings.write({
      localAgents: {
        grants: raw.localAgents.grants.map((item) =>
          item.id === issued.grant.id
            ? { ...item, roleId: "custom.missing", capabilities: [...LOCAL_AGENT_CAPABILITIES] }
            : item
        )
      }
    });

    await expect(service.authenticate({
      clientId: "lag_test",
      token: "pws_local_test-token"
    })).resolves.toEqual({ ok: false, code: "invalid_role" });
  });

  test("default settings include empty local-agent grants", () => {
    expect(defaultSettings().localAgents.enabled).toBe(false);
    expect(defaultSettings().localAgents.grants).toEqual([]);
    expect(defaultSettings().localAgents.roles.map((role) => role.id)).toEqual([
      "builtin.search",
      "builtin.preview",
      "builtin.full-media",
      "builtin.editor",
      "builtin.sizzle",
      "builtin.full-access"
    ]);
  });

  test("settings parser quarantines malformed or duplicate grants", async () => {
    const raw = defaultSettings();
    raw.localAgents.grants = [
          {
            id: "lag_a",
            name: "Agent A",
            capabilities: ["library.read"],
            createdAt: "2026-06-07T12:00:00.000Z",
            updatedAt: "2026-06-07T12:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null
          },
          {
            id: "lag_a",
            name: "Duplicate",
            capabilities: ["capture.original.read"],
            createdAt: "2026-06-07T12:00:00.000Z",
            updatedAt: "2026-06-07T12:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null
          },
          {
            id: "lag_bad",
            name: "Bad",
            capabilities: [],
            createdAt: "2026-06-07T12:00:00.000Z",
            updatedAt: "2026-06-07T12:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null
          }
        ];
    writeFileSync(settings.getFilePath(), JSON.stringify(raw), "utf8");

    const reread = await settings.read();
    expect(reread.localAgents.grants).toEqual([]);
    expect(readdirSync(workDir).some((name) => name.includes("corrupt-"))).toBe(true);
  });

  test("settings parser quarantines malformed audit state and preserves the source file", async () => {
    const raw = defaultSettings();
    (raw.localAgents as { audit: unknown[] }).audit = [
      {
        id: "lae_valid",
        clientId: "lag_a",
        action: "capture.export",
        capability: "capture.export",
        subjectKind: "capture",
        subjectId: "cap_preserved",
        outcome: "success",
        occurredAt: "2026-06-07T12:00:00.000Z"
      },
      {
        id: "lae_invalid",
        clientId: "lag_a",
        action: "capture.original.read",
        capability: "library.read",
        subjectKind: "capture",
        subjectId: "cap_invalid",
        outcome: "success",
        occurredAt: "2026-06-07T12:00:00.000Z"
      }
    ];
    writeFileSync(settings.getFilePath(), JSON.stringify(raw), "utf8");

    expect((await settings.read()).localAgents.audit).toEqual([]);
    const quarantine = readdirSync(workDir).find((name) => name.includes("corrupt-"));
    expect(quarantine).toBeDefined();
    expect(readFileSync(join(workDir, quarantine!), "utf8")).toContain("cap_preserved");
  });

  test("settings parser preserves distinct sessions for one OAuth client", async () => {
    const baseGrant = {
      id: "lag_oauth",
      name: "Codex",
      capabilities: ["library.read" as const],
      createdAt: "2026-06-07T12:00:00.000Z",
      updatedAt: "2026-06-07T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null
    };
    const oauthClient = {
      clientId: "lag_oauth",
      clientName: "Codex",
      redirectUris: ["http://127.0.0.1:43123/callback"],
      clientUri: null,
      scope: "library.read",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      softwareId: null,
      softwareVersion: null,
      registeredAt: "2026-06-07T12:00:00.000Z"
    };
    await settings.write({
      localAgents: {
        grants: [
          { ...baseGrant, oauthClient },
          {
            ...baseGrant,
            id: "lag_other",
            oauthClient
          }
        ]
      }
    });

    const grants = (await settings.read()).localAgents.grants;
    expect(grants.map((grant) => grant.id)).toEqual(["lag_oauth", "lag_other"]);
    expect(grants.map((grant) => grant.roleId)).toEqual([
      "builtin.search",
      "builtin.search"
    ]);
    expect(grants.every((grant) => grant.oauthClient?.clientId === "lag_oauth")).toBe(true);
    expect(readdirSync(workDir).some((name) => name.includes("corrupt-"))).toBe(false);
  });

  test("command bus carries local-agent identity without affecting IPC callers", async () => {
    const command = "library:list";
    const handler = vi.fn(async (_req, ctx) => ({
      ok: true as const,
      value: {
        principal: ctx.principal,
        localAgent: ctx.localAgent ?? null
      }
    }));
    // Register a one-off command name by bypassing the compile-time
    // command map. This test only verifies CommandBus context plumbing.
    bus.installLocalAgentAuthorizer(async (clientId) => ({
      clientId,
      capabilities: ["library.read"]
    }));
    bus.register(command, handler as never);
    const withAgent = await bus.dispatch(command as never, {} as never, {
      principal: "mcp",
      localAgent: {
        clientId: "lag_test",
        capabilities: ["library.read"]
      }
    });
    expect(withAgent.ok).toBe(true);
    if (!withAgent.ok) throw new Error("unreachable");
    expect(withAgent.value).toEqual({
      principal: "mcp",
      localAgent: {
        clientId: "lag_test",
        capabilities: ["library.read"]
      }
    });

    bus.unregister(command);
    bus.uninstallLocalAgentAuthorizerForTests();
  });
});
