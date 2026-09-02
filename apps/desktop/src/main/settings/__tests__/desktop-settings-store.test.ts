import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  BUILT_IN_ACP_STRATEGIES,
  type DiscoveredAcpAgentGroup,
  type LocalAcpDiscoveryOptions
} from "@pwrdrvr/agent-acp";

import { defaultSettings, mergeSettings } from "../desktop-settings-service";
import { DesktopSettingsStore } from "../desktop-settings-store";

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pwrsnap-settings-store-"));
});

function rawCodexSnapshot(command: string) {
  return {
    selectedCommand: command,
    selectedSource: command === "codex" ? ("path" as const) : ("config" as const),
    candidates: [
      {
        command,
        source: command === "codex" ? ("path" as const) : ("config" as const),
        executable: true,
        selected: true,
        version: "0.144.0"
      }
    ]
  };
}

function acpGroup(
  strategyId: string,
  commands: readonly string[] = [`/usr/local/bin/${strategyId}`]
): DiscoveredAcpAgentGroup {
  const strategy = BUILT_IN_ACP_STRATEGIES.find((candidate) => candidate.id === strategyId);
  if (strategy === undefined) throw new Error(`unknown ACP strategy ${strategyId}`);
  return {
    strategyId,
    backendId: strategy.backendId,
    name: strategy.displayName,
    args: [...strategy.spawn.args],
    env: {},
    instances: commands.map((command) => ({
      command,
      source: "path" as const,
      version: "1.0.0"
    })),
    discoveredAt: 1
  };
}

function rejectedAcpGroup(
  strategyId: string,
  command = `/usr/local/bin/${strategyId}`
): DiscoveredAcpAgentGroup {
  return {
    ...acpGroup(strategyId, []),
    rejectedInstances: [
      {
        command,
        source: "path",
        reason: "probe-timed-out"
      }
    ]
  };
}

describe("DesktopSettingsStore provider publications", () => {
  test("Codex UI, runtime, and concurrent readers share one discovery pass", async () => {
    const release = deferredSignal();
    const discoverCodex = vi.fn(async ({ configuredCommand } = {}) => {
      await release.promise;
      return rawCodexSnapshot(configuredCommand ?? "codex");
    });
    const probeCodexAuthentication = vi.fn(async () => ({
      status: "authenticated" as const,
      testedAt: "2026-09-01T00:00:00.000Z",
      durationMs: 1,
      detail: "authenticated"
    }));
    const readTextFile = vi.fn(async () => JSON.stringify(defaultSettings()));
    const executeAgentCommand = vi.fn();
    const store = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      readTextFile,
      discoverCodex,
      probeCodexAuthentication,
      executeAgentCommand,
      env: { PATH: "/usr/bin" }
    });

    const uiA = store.getCodexDiscoverySnapshot();
    const uiB = store.getCodexDiscoverySnapshot();
    const runtime = store.resolveCompatibleCodexCommand({ command: "codex" });
    expect(discoverCodex).toHaveBeenCalledTimes(1);
    release.resolve();

    const [snapshotA, snapshotB, resolved] = await Promise.all([uiA, uiB, runtime]);
    expect(snapshotA).toBe(snapshotB);
    expect(resolved.command).toBe("codex");
    expect(probeCodexAuthentication).toHaveBeenCalledTimes(1);

    await store.getCodexDiscoverySnapshot();
    await store.resolveCompatibleCodexCommand({ command: "codex" });
    expect(discoverCodex).toHaveBeenCalledTimes(1);
    expect(executeAgentCommand).not.toHaveBeenCalled();
    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(store.readDiagnostics()).toMatchObject({
      settingsFileReads: 1,
      settingsAtomicWrites: 0,
      codexDiscoveryRuns: 1,
      codexDiscoveryDedupeHits: 1
    });
  });

  test("a missing runtime command fails from discovery without a second probe", async () => {
    const discoverCodex = vi.fn(async () => ({ candidates: [] }));
    const executeAgentCommand = vi.fn();
    const store = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      readTextFile: async () => JSON.stringify(defaultSettings()),
      discoverCodex,
      executeAgentCommand
    });

    await expect(
      store.resolveCompatibleCodexCommand({
        command: "/stale/pinned/codex"
      })
    ).rejects.toThrow(/Codex CLI not found: \/stale\/pinned\/codex.*Settings → AI/);
    expect(discoverCodex).toHaveBeenCalledTimes(1);
    expect(executeAgentCommand).not.toHaveBeenCalled();
  });

  test("concurrent explicit Codex refreshes remain single-flight", async () => {
    const discoverCodex = vi.fn(async ({ configuredCommand } = {}) =>
      rawCodexSnapshot(configuredCommand ?? "codex")
    );
    const store = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      readTextFile: async () => JSON.stringify(defaultSettings()),
      discoverCodex,
      probeCodexAuthentication: async () => ({
        status: "authenticated",
        testedAt: "2026-09-01T00:00:00.000Z",
        durationMs: 1
      })
    });
    await store.getCodexDiscoverySnapshot();

    await Promise.all([
      store.refreshCodexDiscoveryForUserRequest(),
      store.refreshCodexDiscoveryForUserRequest()
    ]);

    expect(discoverCodex).toHaveBeenCalledTimes(2);
  });

  test("a split Library adopts refreshed Codex state without rediscovery", async () => {
    const settingsText = JSON.stringify(defaultSettings());
    const libraryDiscover = vi.fn(async () => ({ candidates: [] }));
    const libraryStore = new DesktopSettingsStore({
      filePath: join(workDir, "library-settings.json"),
      readTextFile: async () => settingsText,
      discoverCodex: libraryDiscover,
      env: { PATH: "/usr/bin" }
    });
    await expect(
      libraryStore.resolveCompatibleCodexCommand({ command: "codex" })
    ).rejects.toThrow(/Codex CLI not found/);

    const agentDiscover = vi.fn(async () =>
      rawCodexSnapshot("/opt/codex/bin/codex")
    );
    const agentStore = new DesktopSettingsStore({
      filePath: join(workDir, "agent-settings.json"),
      readTextFile: async () => settingsText,
      discoverCodex: agentDiscover,
      probeCodexAuthentication: async () => ({
        status: "authenticated",
        testedAt: "2026-09-02T00:00:00.000Z",
        durationMs: 1
      }),
      env: { PATH: "/usr/bin" }
    });
    await agentStore.refreshCodexDiscoveryForUserRequest();
    const publication = agentStore.getCurrentCodexDiscoveryPublication();

    expect(publication).not.toBeNull();
    expect(
      libraryStore.adoptTrustedPeerDiscoveryPublication(publication)
    ).toBe(true);
    await expect(
      libraryStore.resolveCompatibleCodexCommand({ command: "codex" })
    ).resolves.toMatchObject({ command: "/opt/codex/bin/codex" });
    await expect(libraryStore.getCodexDiscoverySnapshot()).resolves.toMatchObject({
      resolvedPath: "/opt/codex/bin/codex"
    });
    expect(libraryDiscover).toHaveBeenCalledTimes(1);
    expect(agentDiscover).toHaveBeenCalledTimes(1);
  });

  test("a Codex dependency write invalidates only the matching fingerprint", async () => {
    const commands: string[] = [];
    const discoverCodex = vi.fn(async ({ configuredCommand } = {}) => {
      const command = configuredCommand ?? "codex";
      commands.push(command);
      return rawCodexSnapshot(command);
    });
    const store = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      readTextFile: async () => JSON.stringify(defaultSettings()),
      discoverCodex,
      probeCodexAuthentication: async () => ({
        status: "authenticated",
        testedAt: "2026-09-01T00:00:00.000Z",
        durationMs: 1
      })
    });

    await store.getCodexDiscoverySnapshot();
    await store.write({ general: { developerMode: true } });
    await store.getCodexDiscoverySnapshot();
    expect(commands).toEqual(["codex"]);

    await store.write({
      codex: { mode: "pinned", pinnedPath: "/opt/pinned-codex" }
    });
    const updated = await store.getCodexDiscoverySnapshot();
    expect(updated.resolvedPath).toBe("/opt/pinned-codex");
    expect(commands).toEqual(["codex", "/opt/pinned-codex"]);

    await store.write({ codex: { mode: "auto" } });
    const cycled = await store.getCodexDiscoverySnapshot();
    expect(cycled.resolvedPath).toBe("codex");
    expect(commands).toEqual(["codex", "/opt/pinned-codex", "codex"]);
  });

  test("Settings, runtime, and repeated capture enrichment reuse ACP discovery", async () => {
    const settings = mergeSettings(defaultSettings(), {
      ai: {
        acp: {
          enabledAgentIds: ["gemini"],
          agents: {}
        }
      }
    });
    const release = deferredSignal();
    const entered = deferredSignal();
    const discoverAcp = vi.fn(async (options?: LocalAcpDiscoveryOptions) => {
      entered.resolve();
      await release.promise;
      return options?.strategies?.some((strategy) => strategy.id === "gemini")
        ? [acpGroup("gemini")]
        : [];
    });
    const readTextFile = vi.fn(async () => JSON.stringify(settings));
    const store = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      readTextFile,
      discoverAcp,
      env: { PATH: "/usr/bin" }
    });

    const settingsScan = store.getAcpDiscoveryGroups();
    const runtime = store.resolveEnabledAcpAgent("gemini");
    await entered.promise;
    expect(discoverAcp).toHaveBeenCalledTimes(1);
    release.resolve();
    const [groups, agent] = await Promise.all([settingsScan, runtime]);
    expect(groups.some((group) => group.strategyId === "gemini")).toBe(true);
    expect(agent?.command).toBe("/usr/local/bin/gemini");

    // Three captures all ask for the same enrichment provider. These are
    // synchronous store hits after the first validation, not three PATH/CLI
    // scans.
    await Promise.all([
      store.resolveEnabledAcpAgent("gemini", settings),
      store.resolveEnabledAcpAgent("gemini", settings),
      store.resolveEnabledAcpAgent("gemini", settings)
    ]);
    expect(discoverAcp).toHaveBeenCalledTimes(1);
    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(store.readDiagnostics()).toMatchObject({
      settingsFileReads: 1,
      acpDiscoveryRuns: 1
    });
  });

  test("an ACP override change probes only that provider", async () => {
    const initial = mergeSettings(defaultSettings(), {
      ai: {
        acp: {
          enabledAgentIds: ["gemini", "qwen"],
          agents: {}
        }
      }
    });
    const calls: string[][] = [];
    const discoverAcp = vi.fn(async (options?: LocalAcpDiscoveryOptions) => {
      const ids = options?.strategies?.map((strategy) => strategy.id) ?? [];
      calls.push(ids);
      return ids.map((id) => acpGroup(id));
    });
    const store = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      readTextFile: async () => JSON.stringify(initial),
      discoverAcp
    });

    await store.getAcpDiscoveryGroups();
    await store.write({
      ai: { acp: { agents: { gemini: { overridePath: "/custom/gemini" } } } }
    });
    await store.getAcpDiscoveryGroups();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.sort()).toEqual(
      BUILT_IN_ACP_STRATEGIES.map((strategy) => strategy.id).sort()
    );
    expect(calls[1]).toEqual(["gemini"]);
  });

  test("a split Library adopts refreshed ACP rows without rediscovery", async () => {
    const settings = mergeSettings(defaultSettings(), {
      ai: { acp: { enabledAgentIds: ["gemini"], agents: {} } }
    });
    const settingsText = JSON.stringify(settings);
    const libraryDiscover = vi.fn(async () => []);
    const libraryStore = new DesktopSettingsStore({
      filePath: join(workDir, "library-settings.json"),
      readTextFile: async () => settingsText,
      discoverAcp: libraryDiscover,
      env: { PATH: "/usr/bin" }
    });
    await expect(libraryStore.resolveEnabledAcpAgent("gemini")).resolves.toBeNull();

    const agentDiscover = vi.fn(async () => [
      acpGroup("gemini", ["/opt/gemini/bin/gemini"])
    ]);
    const agentStore = new DesktopSettingsStore({
      filePath: join(workDir, "agent-settings.json"),
      readTextFile: async () => settingsText,
      discoverAcp: agentDiscover,
      env: { PATH: "/usr/bin" }
    });
    await agentStore.refreshAcpDiscoveryForUserRequest();
    const publication = agentStore.getCurrentAcpDiscoveryPublication();

    expect(publication?.entries).toHaveLength(BUILT_IN_ACP_STRATEGIES.length);
    expect(
      libraryStore.adoptTrustedPeerDiscoveryPublication(publication)
    ).toBe(true);
    await expect(
      libraryStore.resolveEnabledAcpAgent("gemini")
    ).resolves.toMatchObject({ command: "/opt/gemini/bin/gemini" });
    expect(libraryDiscover).toHaveBeenCalledTimes(1);
    expect(agentDiscover).toHaveBeenCalledTimes(1);
  });

  test("peer discovery publications cannot cross dependency fingerprints", async () => {
    const agentStore = new DesktopSettingsStore({
      filePath: join(workDir, "agent-settings.json"),
      readTextFile: async () => JSON.stringify(defaultSettings()),
      discoverCodex: async () => rawCodexSnapshot("codex"),
      probeCodexAuthentication: async () => ({
        status: "authenticated",
        testedAt: "2026-09-02T00:00:00.000Z",
        durationMs: 1
      }),
      env: { PATH: "/agent/bin" }
    });
    await agentStore.getCodexDiscoverySnapshot();

    const libraryDiscover = vi.fn(async () => rawCodexSnapshot("/library/codex"));
    const libraryStore = new DesktopSettingsStore({
      filePath: join(workDir, "library-settings.json"),
      readTextFile: async () => JSON.stringify(defaultSettings()),
      discoverCodex: libraryDiscover,
      env: { PATH: "/library/bin" }
    });
    await libraryStore.read();

    expect(
      libraryStore.adoptTrustedPeerDiscoveryPublication(
        agentStore.getCurrentCodexDiscoveryPublication()
      )
    ).toBe(false);
    await expect(
      libraryStore.resolveCompatibleCodexCommand({ command: "codex" })
    ).resolves.toMatchObject({ command: "/library/codex" });
    expect(libraryDiscover).toHaveBeenCalledTimes(1);
  });

  test("failed ACP refresh retains the last successful publication", async () => {
    const settings = mergeSettings(defaultSettings(), {
      ai: { acp: { enabledAgentIds: ["gemini"], agents: {} } }
    });
    const discoverAcp = vi
      .fn<(options?: LocalAcpDiscoveryOptions) => Promise<DiscoveredAcpAgentGroup[]>>()
      .mockResolvedValueOnce([acpGroup("gemini")])
      .mockRejectedValueOnce(new Error("temporary probe failure"));
    const store = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      readTextFile: async () => JSON.stringify(settings),
      discoverAcp
    });

    const first = await store.resolveEnabledAcpAgent("gemini");
    expect(first?.command).toBe("/usr/local/bin/gemini");
    await expect(store.refreshAcpDiscoveryForUserRequest()).rejects.toThrow(
      "temporary probe failure"
    );
    const retained = await store.resolveEnabledAcpAgent("gemini");
    expect(retained?.command).toBe("/usr/local/bin/gemini");
  });

  test("soft ACP probe failures retain the matching last-known-good row", async () => {
    const settings = mergeSettings(defaultSettings(), {
      ai: { acp: { enabledAgentIds: ["gemini"], agents: {} } }
    });
    const discoverAcp = vi
      .fn<(options?: LocalAcpDiscoveryOptions) => Promise<DiscoveredAcpAgentGroup[]>>()
      .mockResolvedValueOnce([acpGroup("gemini")])
      .mockResolvedValueOnce([rejectedAcpGroup("gemini")]);
    const store = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      readTextFile: async () => JSON.stringify(settings),
      discoverAcp
    });

    expect((await store.resolveEnabledAcpAgent("gemini"))?.command).toBe(
      "/usr/local/bin/gemini"
    );
    const refreshed = await store.refreshAcpDiscoveryForUserRequest();
    expect(refreshed.find((group) => group.strategyId === "gemini")?.instances).toEqual(
      [
        expect.objectContaining({ command: "/usr/local/bin/gemini" })
      ]
    );
    expect(discoverAcp.mock.calls[1]?.[0]).toMatchObject({
      includeRejectedCandidates: true
    });
    expect((await store.resolveEnabledAcpAgent("gemini"))?.command).toBe(
      "/usr/local/bin/gemini"
    );
  });

  test("ACP discovery restarts against settings that change mid-scan", async () => {
    const settings = mergeSettings(defaultSettings(), {
      ai: { acp: { enabledAgentIds: ["gemini"], agents: {} } }
    });
    const entered = deferredSignal();
    const release = deferredSignal();
    const calls: LocalAcpDiscoveryOptions[] = [];
    const discoverAcp = vi.fn(async (options: LocalAcpDiscoveryOptions = {}) => {
      calls.push(options);
      if (calls.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return [
        acpGroup("gemini", [
          options.overrides?.gemini ?? "/usr/local/bin/gemini"
        ])
      ];
    });
    const store = new DesktopSettingsStore({
      filePath: join(workDir, "settings.json"),
      readTextFile: async () => JSON.stringify(settings),
      discoverAcp
    });

    const discovery = store.getAcpDiscoveryGroups();
    await entered.promise;
    await store.write({
      ai: { acp: { agents: { gemini: { overridePath: "/custom/gemini" } } } }
    });
    release.resolve();

    const groups = await discovery;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.strategies?.map((strategy) => strategy.id)).toEqual([
      "gemini"
    ]);
    expect(calls[1]?.overrides).toEqual({ gemini: "/custom/gemini" });
    expect(groups.find((group) => group.strategyId === "gemini")?.instances).toEqual(
      [expect.objectContaining({ command: "/custom/gemini" })]
    );
  });
});

function deferredSignal(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
