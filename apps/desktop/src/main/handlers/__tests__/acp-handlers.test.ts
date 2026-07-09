// Unit tests for the ACP discovery handler (`acp:discover`). The kit's
// multi-instance local discovery + the settings read are injected via
// `registerAcpHandlers({ discover, readSettings })` so the handler runs as pure
// orchestration:
//
//   • installed agents from the kit are mapped onto the protocol entry shape
//     (installed + instances + active command/version);
//   • every NOT-returned built-in strategy is surfaced as a not-installed
//     entry with an install hint — so a probe that throws (which the kit
//     isolates into "no result for that strategy") reads as not-installed
//     rather than failing the whole list;
//   • the user's per-agent preference picks the active instance;
//   • a list-wide discovery throw surfaces as a Result.err.

import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

// Stub electron so module-load of the bus / dependencies succeeds.
vi.mock("electron", (): Partial<typeof import("electron")> => ({
  shell: { openExternal: vi.fn() } as unknown as typeof import("electron").shell
}));

// The persisted model cache reaches for app.getPath; mock it so the `acp:models`
// freshness tests can drive the cached list directly without a real userData dir.
vi.mock("../../ai/acp-model-cache", () => ({
  loadAcpModelCacheEntry: vi.fn(),
  saveAcpModelCacheEntry: vi.fn()
}));

import {
  BUILT_IN_ACP_STRATEGIES,
  type DiscoveredAcpAgentGroup
} from "@pwrdrvr/agent-acp";
import type { AcpAgentModelOption, AcpAgentPreference, Settings } from "@pwrsnap/shared";
import { bus } from "../../command-bus";
import { loadAcpModelCacheEntry } from "../../ai/acp-model-cache";
import { registerAcpHandlers } from "../acp-handlers";

const discover = vi.fn<(options?: unknown) => Promise<DiscoveredAcpAgentGroup[]>>();
let agentsPref: Record<string, AcpAgentPreference> = {};
let enabledAgentIds: string[] = [];
const readSettings = vi.fn(
  async (): Promise<Settings> =>
    ({ ai: { acp: { enabledAgentIds, agents: agentsPref } } }) as unknown as Settings
);

// Register once — the bus throws on duplicate register and vitest reuses the
// module across tests in this file. Inject the fakes.
registerAcpHandlers({ discover, readSettings });

const KNOWN_IDS = BUILT_IN_ACP_STRATEGIES.map((s) => s.id);

beforeEach(() => {
  agentsPref = {};
  enabledAgentIds = [];
  discover.mockReset();
  readSettings.mockClear();
  vi.mocked(loadAcpModelCacheEntry).mockReset();
});

function makeGroup(
  strategyId: string,
  instances: DiscoveredAcpAgentGroup["instances"]
): DiscoveredAcpAgentGroup {
  const strategy = BUILT_IN_ACP_STRATEGIES.find((s) => s.id === strategyId);
  if (strategy === undefined) throw new Error(`unknown strategy ${strategyId}`);
  return {
    strategyId: strategy.id,
    backendId: strategy.backendId,
    name: strategy.displayName,
    args: [...strategy.spawn.args],
    env: {},
    instances,
    discoveredAt: 1
  };
}

describe("acp:discover", () => {
  test("maps installed agents + surfaces every known agent (installed or not)", async () => {
    agentsPref = {};
    const installedId = KNOWN_IDS[0]!;
    enabledAgentIds = [installedId];
    discover.mockResolvedValue([
      makeGroup(installedId, [
        { command: `/usr/local/bin/${installedId}`, version: "1.2.3", source: "path" }
      ])
    ]);

    const result = await bus.dispatch("acp:discover", {}, { principal: "ipc" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // One entry per known built-in strategy — installed + not-installed.
    expect(result.value.agents).toHaveLength(KNOWN_IDS.length);
    expect(result.value.agents.map((a) => a.id).sort()).toEqual([...KNOWN_IDS].sort());

    const installed = result.value.agents.find((a) => a.id === installedId);
    expect(installed?.installed).toBe(true);
    expect(installed?.version).toBe("1.2.3");
    expect(installed?.detail).toBe(`/usr/local/bin/${installedId}`);
    expect(installed?.activeCommand).toBe(`/usr/local/bin/${installedId}`);
    expect(installed?.instances).toEqual([
      { command: `/usr/local/bin/${installedId}`, version: "1.2.3", source: "path" }
    ]);

    // Every other known agent reads as not-installed with an install hint.
    for (const id of KNOWN_IDS) {
      if (id === installedId) continue;
      const entry = result.value.agents.find((a) => a.id === id);
      expect(entry?.installed).toBe(false);
      expect(entry?.version).toBeUndefined();
      expect(entry?.instances).toEqual([]);
      expect(entry?.activeCommand).toBeUndefined();
      expect(entry?.detail ?? "").toContain("Not installed");
    }
  });

  test("returns every found instance and marks the user-picked one active", async () => {
    const id = KNOWN_IDS[0]!;
    const nvm = `/Users/me/.nvm/bin/${id}`;
    const brew = `/opt/homebrew/bin/${id}`;
    agentsPref = { [id]: { selectedPath: brew } };
    enabledAgentIds = [id];
    discover.mockResolvedValue([
      makeGroup(id, [
        { command: nvm, version: "0.16.1", source: "path" },
        { command: brew, version: "0.15.0", source: "path" }
      ])
    ]);

    const result = await bus.dispatch("acp:discover", {}, { principal: "ipc" });
    if (!result.ok) throw new Error("unreachable");
    const entry = result.value.agents.find((a) => a.id === id);
    expect(entry?.instances).toHaveLength(2);
    // Picked instance is active, even though it isn't first.
    expect(entry?.activeCommand).toBe(brew);
    expect(entry?.version).toBe("0.15.0");
  });

  test("passes enabled per-agent override paths into discovery", async () => {
    const id = KNOWN_IDS[0]!;
    agentsPref = { [id]: { overridePath: "/custom/path" } };
    enabledAgentIds = [id];
    discover.mockResolvedValue([]);

    await bus.dispatch("acp:discover", {}, { principal: "ipc" });
    expect(discover).toHaveBeenCalledWith({
      strategies: [expect.objectContaining({ id })],
      overrides: { [id]: "/custom/path" }
    });
  });

  test("does not pass disabled override paths into discovery", async () => {
    const disabledId = "gemini";
    const enabledId = KNOWN_IDS.find((id) => id !== disabledId) ?? KNOWN_IDS[0]!;
    agentsPref = {
      [disabledId]: { overridePath: "/custom/gemini" },
      [enabledId]: { overridePath: `/custom/${enabledId}` }
    };
    enabledAgentIds = [enabledId];
    discover.mockResolvedValue([]);

    await bus.dispatch("acp:discover", {}, { principal: "ipc" });
    expect(discover).toHaveBeenCalledWith({
      strategies: [expect.objectContaining({ id: enabledId })],
      overrides: { [enabledId]: `/custom/${enabledId}` }
    });
  });

  test("a throwing probe (no result for that strategy) reads as not-installed, not a list failure", async () => {
    agentsPref = {};
    enabledAgentIds = [];
    discover.mockResolvedValue([]);

    const result = await bus.dispatch("acp:discover", {}, { principal: "ipc" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.value.agents).toHaveLength(KNOWN_IDS.length);
    expect(result.value.agents.every((a) => a.installed === false)).toBe(true);
  });

  test("a list-wide discovery throw surfaces as Result.err", async () => {
    agentsPref = {};
    enabledAgentIds = [KNOWN_IDS[0]!];
    discover.mockRejectedValue(new Error("spawn EACCES"));

    const result = await bus.dispatch("acp:discover", {}, { principal: "ipc" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("settings");
    expect(result.error.code).toBe("acp_discovery_failed");
    expect(result.error.message).toContain("spawn EACCES");
  });
});

describe("acp:models cache freshness", () => {
  const loadEntry = vi.mocked(loadAcpModelCacheEntry);

  test("an EMPTY persisted model list is a cache MISS — the agent is re-probed", async () => {
    // A stale pre-fix `{models: []}` (written before the kit could read
    // config-option models) must NOT permanently shadow discovery. An empty
    // cached list has to fall through to a live probe — observable here as
    // discover() being called even though `refresh` is false.
    const agentId = KNOWN_IDS[0]!;
    agentsPref = {};
    enabledAgentIds = [agentId];
    loadEntry.mockReturnValue({
      models: [],
      command: `/usr/local/bin/${agentId}`,
      discoveredAt: "2026-01-01T00:00:00.000Z"
    });
    discover.mockClear();
    discover.mockResolvedValue([]); // re-probe finds nothing installed → []

    const result = await bus.dispatch(
      "acp:models",
      { agentId, refresh: false },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.models).toEqual([]);
    // The point: the empty cache did NOT short-circuit the probe.
    expect(discover).toHaveBeenCalledTimes(1);
  });

  test("a NON-empty persisted model list is served from cache — no re-probe", async () => {
    const agentId = KNOWN_IDS[1]!;
    enabledAgentIds = [];
    const cached: AcpAgentModelOption[] = [
      { id: "kimi-code/kimi-for-coding", label: "Kimi-k2.6", isDefault: true }
    ];
    loadEntry.mockReturnValue({
      models: cached,
      command: `/usr/local/bin/${agentId}`,
      discoveredAt: "2026-01-01T00:00:00.000Z"
    });
    discover.mockClear();

    const result = await bus.dispatch(
      "acp:models",
      { agentId, refresh: false },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.models).toEqual(cached);
    expect(discover).not.toHaveBeenCalled();
  });

  test("refreshing models for a disabled agent does not discover or spawn it", async () => {
    const agentId = "gemini";
    agentsPref = { [agentId]: { overridePath: "/custom/gemini" } };
    enabledAgentIds = [];
    discover.mockClear();

    const result = await bus.dispatch(
      "acp:models",
      { agentId, refresh: true },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.models).toEqual([]);
    expect(discover).not.toHaveBeenCalled();
  });
});
