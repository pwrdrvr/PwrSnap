import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(auth.context).toEqual({
      clientId: "lag_test",
      capabilities: ["library.read", "capture.composite.read"]
    });
    expect(auth.grant.lastUsedAt).toBeNull();

    await service.recordUsage("lag_test");
    const reread = await service.list();
    expect(reread[0]?.lastUsedAt).toBe("2026-06-07T12:00:00.000Z");
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

  test("default settings include empty local-agent grants", () => {
    expect(defaultSettings().localAgents.grants).toEqual([]);
  });

  test("settings parser drops malformed grants and dedupes valid ids", async () => {
    await settings.write({
      localAgents: {
        grants: [
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
        ]
      }
    });

    const reread = await settings.read();
    expect(reread.localAgents.grants).toEqual([
      {
        id: "lag_a",
        name: "Agent A",
        capabilities: ["library.read"],
        createdAt: "2026-06-07T12:00:00.000Z",
        updatedAt: "2026-06-07T12:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null
      }
    ]);
  });

  test("command bus carries local-agent identity without affecting IPC callers", async () => {
    const command = "__test:localAgentContext";
    const handler = vi.fn(async (_req, ctx) => ({
      ok: true as const,
      value: {
        principal: ctx.principal,
        localAgent: ctx.localAgent ?? null
      }
    }));
    // Register a one-off command name by bypassing the compile-time
    // command map. This test only verifies CommandBus context plumbing.
    bus.register(command as never, handler as never);
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

    bus.unregister(command as never);
  });
});
