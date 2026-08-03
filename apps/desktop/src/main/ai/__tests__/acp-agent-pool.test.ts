// ACP agent pool warm-up semantics. Two things are pinned here:
//
//   1. `warmConfiguredAcpAgents` only warms agents actually configured as a
//      chat-surface provider AND enabled — an installed-but-unconfigured
//      agent is never spawned.
//   2. `warmConfiguredAcpAgentsOnFirstChatUse` is a one-shot latch: the
//      FIRST chat-surface use triggers the warm, every later call is free.
//      There is no boot-time warm anymore — a session that never opens a
//      chat surface must start zero ACP agent processes (the handlers are
//      the only production callers; see library/sizzle chat handlers).
//
// `pool.warm` is stubbed on the real pool singleton so no factory ever runs
// and no process is spawned.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import type { DiscoveredAcpAgentGroup } from "@pwrdrvr/agent-acp";
import {
  __resetFirstChatUseWarmupForTests,
  getAcpAgentPool,
  warmConfiguredAcpAgents,
  warmConfiguredAcpAgentsOnFirstChatUse
} from "../acp-agent-pool";

function settingsWith(input: {
  enabledAgentIds?: string[];
  libraryProvider?: string;
  sizzleProvider?: string;
}): Settings {
  return {
    ai: {
      acp: { enabledAgentIds: input.enabledAgentIds ?? [], agents: {} },
      defaults: {
        libraryChat: { provider: input.libraryProvider ?? "codex" },
        sizzleChat: { provider: input.sizzleProvider ?? "codex" }
      }
    }
  } as unknown as Settings;
}

function geminiGroup(command: string): DiscoveredAcpAgentGroup {
  return {
    strategyId: "gemini",
    backendId: "acp:gemini",
    name: "Gemini CLI",
    args: ["--acp"],
    env: {},
    instances: [{ command, source: "path" }],
    discoveredAt: 0
  };
}

let warmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetFirstChatUseWarmupForTests();
  warmSpy = vi.spyOn(getAcpAgentPool(), "warm").mockImplementation(() => undefined);
});

afterEach(() => {
  warmSpy.mockRestore();
});

describe("warmConfiguredAcpAgents", () => {
  test("warms the enabled agent configured as a chat provider", async () => {
    const discover = vi.fn(async () => [geminiGroup("/opt/bin/gemini")]);
    await warmConfiguredAcpAgents({
      settings: settingsWith({ enabledAgentIds: ["gemini"], libraryProvider: "acp:gemini" }),
      chatsDir: "/tmp/chats",
      discover
    });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(warmSpy).toHaveBeenCalledTimes(1);
    expect(warmSpy.mock.calls[0]?.[0]).toBe("gemini@/opt/bin/gemini");
  });

  test("no chat surface configured for an ACP provider → no discovery, no warm", async () => {
    const discover = vi.fn(async () => [geminiGroup("/opt/bin/gemini")]);
    await warmConfiguredAcpAgents({
      settings: settingsWith({ enabledAgentIds: ["gemini"] }),
      chatsDir: "/tmp/chats",
      discover
    });
    expect(discover).not.toHaveBeenCalled();
    expect(warmSpy).not.toHaveBeenCalled();
  });

  test("configured-but-disabled agent is skipped", async () => {
    const discover = vi.fn(async () => [geminiGroup("/opt/bin/gemini")]);
    await warmConfiguredAcpAgents({
      settings: settingsWith({ enabledAgentIds: [], libraryProvider: "acp:gemini" }),
      chatsDir: "/tmp/chats",
      discover
    });
    expect(discover).not.toHaveBeenCalled();
    expect(warmSpy).not.toHaveBeenCalled();
  });

  test("agent that fails discovery is skipped without warming", async () => {
    const discover = vi.fn(async () => []);
    await warmConfiguredAcpAgents({
      settings: settingsWith({ enabledAgentIds: ["gemini"], sizzleProvider: "acp:gemini" }),
      chatsDir: "/tmp/chats",
      discover
    });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(warmSpy).not.toHaveBeenCalled();
  });
});

describe("warmConfiguredAcpAgentsOnFirstChatUse", () => {
  test("first call warms once; later calls are no-ops", async () => {
    const resolvePath = vi.fn(async () => undefined);
    const readSettings = vi.fn(async () =>
      settingsWith({ enabledAgentIds: ["gemini"], libraryProvider: "acp:gemini" })
    );
    const discover = vi.fn(async () => [geminiGroup("/opt/bin/gemini")]);
    const trigger = (): void =>
      warmConfiguredAcpAgentsOnFirstChatUse({
        readSettings,
        chatsDir: "/tmp/chats",
        resolvePath,
        discover
      });

    trigger();
    await vi.waitFor(() => expect(warmSpy).toHaveBeenCalledTimes(1));
    expect(resolvePath).toHaveBeenCalledTimes(1);
    expect(readSettings).toHaveBeenCalledTimes(1);

    trigger();
    trigger();
    // Fire-and-forget: give any (incorrect) second warm a tick to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(warmSpy).toHaveBeenCalledTimes(1);
  });

  test("latch holds even when nothing is configured (still zero processes)", async () => {
    const readSettings = vi.fn(async () => settingsWith({}));
    const trigger = (): void =>
      warmConfiguredAcpAgentsOnFirstChatUse({
        readSettings,
        chatsDir: "/tmp/chats",
        resolvePath: async () => undefined
      });

    trigger();
    await vi.waitFor(() => expect(readSettings).toHaveBeenCalledTimes(1));
    trigger();
    await new Promise((r) => setTimeout(r, 0));
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(warmSpy).not.toHaveBeenCalled();
  });

  test("a failed warm attempt does not crash and stays latched", async () => {
    const readSettings = vi.fn(async (): Promise<Settings> => {
      throw new Error("settings unreadable");
    });
    warmConfiguredAcpAgentsOnFirstChatUse({
      readSettings,
      chatsDir: "/tmp/chats",
      resolvePath: async () => undefined
    });
    await vi.waitFor(() => expect(readSettings).toHaveBeenCalledTimes(1));
    warmConfiguredAcpAgentsOnFirstChatUse({
      readSettings,
      chatsDir: "/tmp/chats",
      resolvePath: async () => undefined
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(readSettings).toHaveBeenCalledTimes(1);
  });
});
