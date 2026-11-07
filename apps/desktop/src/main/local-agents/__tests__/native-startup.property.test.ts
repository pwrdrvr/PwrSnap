import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
vi.mock("electron", () => ({ app: { getVersion: () => "fixture" }, safeStorage: {} }));
import { DesktopSettingsService } from "../../settings/desktop-settings-service";
import { DesktopSecretStore } from "../../settings/desktop-secret-store";
import { LocalAgentGrantService } from "../local-agent-grants";
import { LocalAgentMcpServer } from "../mcp-server";
import { LocalAgentMcpLifecycle } from "../local-agent-mcp-lifecycle";
import { NativeMcpBridge } from "../../ai/mcp/native-mcp-bridge";

test("boot expires every native survivor in one persisted, broadcast write and preserves legacy grants", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (count) => {
    const dir = mkdtempSync(join(tmpdir(), "ps-boot-"));
    try {
      const filePath = join(dir, "settings.json");
      const settings = new DesktopSettingsService({ filePath });
      const secrets = new DesktopSecretStore({ filePath: join(dir, "secrets.bin") });
      const changed = vi.fn();
      const grants = new LocalAgentGrantService({ settings, secrets, onSettingsChanged: changed });
      for (let i = 0; i < count; i++) await grants.openNativeSession({ name: `Survivor ${i}`, capabilities: ["library.read"] });
      const snapshot = await settings.read();
      const { nativeConsent: _ceiling, ...legacy } = snapshot.localAgents.grants[0];
      await settings.write({ localAgents: { grants: [...snapshot.localAgents.grants, { ...legacy, id: "legacy", name: "Legacy" }] } });
      changed.mockClear();
      await grants.expireNativeSessions();
      const disk = JSON.parse(readFileSync(filePath, "utf8"));
      expect(disk.localAgents.grants.filter((grant: { nativeConsent?: unknown; revokedAt: unknown }) => grant.nativeConsent !== undefined)
        .every((grant: { revokedAt: unknown }) => typeof grant.revokedAt === "string")).toBe(true);
      expect(disk.localAgents.grants.find((grant: { id: string }) => grant.id === "legacy").revokedAt).toBeNull();
      expect(changed).toHaveBeenCalledOnce();
      await grants.expireNativeSessions();
      expect(changed).toHaveBeenCalledOnce();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }), { numRuns: 15 });
  // Pin production ordering as well as the cleanup implementation.
  const main = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  const wiring = main.slice(main.indexOf("async function wireLocalAgentMcpLifecycle"));
  expect(wiring.indexOf("expireNativeSessions()")).toBeGreaterThan(0);
  expect(wiring.indexOf("expireNativeSessions()")).toBeLessThan(wiring.indexOf("onSettingsChanged("));
});

test("startup never awaits a revocation broadcast queued behind its own lifecycle transition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-start-model-"));
  const settings = new DesktopSettingsService({ filePath: join(dir, "settings.json") });
  const secrets = new DesktopSecretStore({ filePath: join(dir, "secrets.bin") });
  let lifecycle: LocalAgentMcpLifecycle | undefined;
  const changed = vi.fn(async () => { await lifecycle?.setEnabled(true); });
  const grants = new LocalAgentGrantService({ settings, secrets, onSettingsChanged: changed });
  await grants.openNativeSession({ name: "Crash survivor", capabilities: ["library.read"] });
  changed.mockClear();
  const bridge = new NativeMcpBridge({ onConnection: () => undefined });
  vi.spyOn(bridge, "start").mockResolvedValue();
  vi.spyOn(bridge, "isRunning").mockReturnValue(true);
  const server = new LocalAgentMcpServer({ settings, secrets, grantService: grants, bridgeFactory: () => bridge, tools: [] });
  lifecycle = new LocalAgentMcpLifecycle({ createServer: () => server });
  let settled = false;
  const starting = lifecycle.setEnabled(true).then(() => { settled = true; });
  try {
    // All non-I/O model transitions can settle through microtasks. A revoke
    // here would enter a circular wait through the real grant notifier.
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(settled).toBe(true);
    await starting;
    expect(changed).not.toHaveBeenCalled();
    expect(lifecycle.getStatus()).toEqual({ state: "listening" });
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
