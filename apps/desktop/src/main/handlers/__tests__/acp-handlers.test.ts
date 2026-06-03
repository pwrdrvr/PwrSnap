// Unit tests for the ACP discovery handler (`acp:discover`). The kit's
// local discovery is injected via `registerAcpHandlers({ discover })` so the
// handler runs as pure orchestration:
//
//   • installed agents from the kit are mapped onto the protocol entry shape
//     (installed + version + resolved command);
//   • every NOT-returned built-in strategy is surfaced as a not-installed
//     entry with an install hint — so a probe that throws (which the kit
//     isolates into "no result for that strategy") reads as not-installed
//     rather than failing the whole list;
//   • a list-wide discovery throw surfaces as a Result.err.

import { describe, expect, test, vi } from "vitest";

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

import { BUILT_IN_ACP_STRATEGIES, type DiscoveredAcpAgent } from "@pwrdrvr/agent-acp";
import { bus } from "../../command-bus";
import { registerAcpHandlers } from "../acp-handlers";

const discover = vi.fn<() => Promise<DiscoveredAcpAgent[]>>();

// Register once — the bus throws on duplicate register and vitest reuses the
// module across tests in this file. Inject the fake discovery.
registerAcpHandlers({ discover });

const KNOWN_IDS = BUILT_IN_ACP_STRATEGIES.map((s) => s.id);

function makeInstalled(strategyId: string, version?: string): DiscoveredAcpAgent {
  const strategy = BUILT_IN_ACP_STRATEGIES.find((s) => s.id === strategyId);
  if (strategy === undefined) throw new Error(`unknown strategy ${strategyId}`);
  return {
    strategyId: strategy.id,
    backendId: strategy.backendId,
    name: strategy.displayName,
    command: `/usr/local/bin/${strategy.id}`,
    args: [...strategy.spawn.args],
    env: {},
    discoveredAt: 1,
    ...(version !== undefined ? { version } : {})
  };
}

describe("acp:discover", () => {
  test("maps installed agents + surfaces every known agent (installed or not)", async () => {
    const installedId = KNOWN_IDS[0]!;
    discover.mockResolvedValue([makeInstalled(installedId, "1.2.3")]);

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
    expect(typeof installed?.displayName).toBe("string");
    expect((installed?.displayName ?? "").length).toBeGreaterThan(0);

    // Every other known agent reads as not-installed with an install hint.
    for (const id of KNOWN_IDS) {
      if (id === installedId) continue;
      const entry = result.value.agents.find((a) => a.id === id);
      expect(entry?.installed).toBe(false);
      expect(entry?.version).toBeUndefined();
      expect((entry?.detail ?? "")).toContain("Not installed");
    }
  });

  test("a throwing probe (no result for that strategy) reads as not-installed, not a list failure", async () => {
    // The kit isolates a per-strategy probe throw by returning no entry for
    // that strategy. We simulate that by simply returning fewer agents than
    // the strategy table — the missing one(s) must surface as not-installed.
    discover.mockResolvedValue([]);

    const result = await bus.dispatch("acp:discover", {}, { principal: "ipc" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.value.agents).toHaveLength(KNOWN_IDS.length);
    expect(result.value.agents.every((a) => a.installed === false)).toBe(true);
  });

  test("a list-wide discovery throw surfaces as Result.err", async () => {
    discover.mockRejectedValue(new Error("spawn EACCES"));

    const result = await bus.dispatch("acp:discover", {}, { principal: "ipc" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("settings");
    expect(result.error.code).toBe("acp_discovery_failed");
    expect(result.error.message).toContain("spawn EACCES");
  });
});
