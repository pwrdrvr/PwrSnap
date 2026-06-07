import { describe, expect, test, vi } from "vitest";
import type { DiscoveredAcpAgentGroup } from "@pwrdrvr/agent-acp";
import type { ChatBackend } from "@pwrdrvr/agent-client";
import type { AiSurfaceDefault, Settings } from "@pwrsnap/shared";
import {
  buildChatSurface,
  chatControllerSignature,
  chatSurfaceDefaultsFromSettings,
  type ChatBackendDeps,
  type ChatSurfaceConfig
} from "../chat-controller-factory";

describe("chatSurfaceDefaultsFromSettings", () => {
  test("an empty surface default yields no kit knobs (Codex / kit defaults)", () => {
    expect(chatSurfaceDefaultsFromSettings({})).toEqual({});
  });

  test("provider stays the backend selector (NOT a Codex modelProvider)", () => {
    const surface: AiSurfaceDefault = {
      provider: "acp:gemini",
      model: "gpt-5.5",
      reasoning: "high"
    };
    expect(chatSurfaceDefaultsFromSettings(surface)).toEqual({
      provider: "acp:gemini",
      model: "gpt-5.5",
      effort: "high"
    });
  });

  test("only carries the leaves the user pinned (partial surface default)", () => {
    expect(chatSurfaceDefaultsFromSettings({ reasoning: "low" })).toEqual({
      effort: "low"
    });
    expect(chatSurfaceDefaultsFromSettings({ model: "gpt-5.5" })).toEqual({
      model: "gpt-5.5"
    });
  });

  test("empty strings on provider / model are treated as unset", () => {
    expect(
      chatSurfaceDefaultsFromSettings({ provider: "", model: "" })
    ).toEqual({});
  });
});

// ---- buildChatSurface — backend selection by provider -------------------

const noopSettings = (): Promise<Settings> =>
  Promise.resolve({
    ai: { acp: { enabledAgentIds: [], agents: {} } }
  } as unknown as Settings);

function baseConfig(overrides: Partial<ChatSurfaceConfig>): ChatSurfaceConfig {
  return {
    command: "codex",
    chatsDir: "/tmp/pwrsnap-test-chats",
    readSettings: noopSettings,
    channels: {
      threadUpdated: "x:a",
      streamDelta: "x:b",
      toolCall: "x:c",
      messageCommitted: "x:d",
      turnInterrupted: "x:e",
      approvalRequested: "x:f"
    } as unknown as ChatSurfaceConfig["channels"],
    send: (() => undefined) as unknown as ChatSurfaceConfig["send"],
    usageSurface: "library-chat",
    buildSystemPrompt: () => "",
    buildTurnContext: () => "",
    toolLabels: {},
    catalog: [],
    dispatchToolCall: (async () => ({})) as unknown as ChatSurfaceConfig["dispatchToolCall"],
    threadConfig: {},
    threadEnvironments: [],
    loggerScope: "pwrsnap:test-chat",
    ...overrides
  };
}

/** A stub `ChatBackend`. `wire()` calls `onEvent` once during construction;
 *  everything else is unused in these tests (no thread/start fires). */
function stubBackend(): ChatBackend {
  return {
    onEvent: vi.fn(() => () => undefined),
    onToolCall: vi.fn(() => () => undefined),
    onApprovalRequest: vi.fn(() => () => undefined),
    startThread: vi.fn(),
    startTurn: vi.fn(),
    interruptTurn: vi.fn(),
    close: vi.fn()
  } as unknown as ChatBackend;
}

/** The ACP factory now returns the client + its per-thread mcpServers. */
function stubAcpResult(): { client: ChatBackend; mcpServers: never[] } {
  return { client: stubBackend(), mcpServers: [] };
}

function discoveredGeminiGroup(
  instances: DiscoveredAcpAgentGroup["instances"] = [
    { command: "/usr/local/bin/gemini", version: "0.4.1", source: "path" }
  ]
): DiscoveredAcpAgentGroup {
  return {
    strategyId: "gemini",
    backendId: "acp:gemini",
    name: "Gemini CLI",
    args: ["--experimental-acp"],
    env: {},
    instances,
    discoveredAt: 1
  };
}

/** Settings stub with a per-agent ACP preference for the given agent. */
function settingsWithAcpPref(
  agentId: string,
  pref: { overridePath?: string; selectedPath?: string }
): () => Promise<Settings> {
  return () =>
    Promise.resolve({
      ai: { acp: { enabledAgentIds: [], agents: { [agentId]: pref } } }
    } as unknown as Settings);
}

describe("buildChatSurface — backend selection", () => {
  test('provider "codex" builds the Codex backend (no ACP discovery)', async () => {
    const makeCodexClient = vi.fn(() => stubBackend());
    const makeAcpClient = vi.fn(() => stubAcpResult());
    const discoverAcpAgentInstances = vi.fn(async () => [] as DiscoveredAcpAgentGroup[]);
    const deps: ChatBackendDeps = {
      makeCodexClient,
      makeAcpClient,
      discoverAcpAgentInstances
    };

    await buildChatSurface(baseConfig({ provider: "codex" }), deps);

    expect(makeCodexClient).toHaveBeenCalledTimes(1);
    expect(makeAcpClient).not.toHaveBeenCalled();
    expect(discoverAcpAgentInstances).not.toHaveBeenCalled();
  });

  test("an undefined provider builds the Codex backend", async () => {
    const makeCodexClient = vi.fn(() => stubBackend());
    const deps: ChatBackendDeps = { makeCodexClient };
    await buildChatSurface(baseConfig({}), deps);
    expect(makeCodexClient).toHaveBeenCalledTimes(1);
  });

  test('provider "acp:<id>" builds the ACP backend from the active instance', async () => {
    const group = discoveredGeminiGroup();
    const makeCodexClient = vi.fn(() => stubBackend());
    const makeAcpClient: NonNullable<ChatBackendDeps["makeAcpClient"]> = vi.fn(
      () => stubAcpResult()
    );
    const discoverAcpAgentInstances = vi.fn(async () => [group]);
    const deps: ChatBackendDeps = {
      makeCodexClient,
      makeAcpClient,
      discoverAcpAgentInstances
    };

    await buildChatSurface(baseConfig({ provider: "acp:gemini" }), deps);

    expect(discoverAcpAgentInstances).toHaveBeenCalledTimes(1);
    expect(makeAcpClient).toHaveBeenCalledTimes(1);
    const call = vi.mocked(makeAcpClient).mock.calls[0]?.[0];
    const agent = call?.agent;
    expect(agent?.command).toBe("/usr/local/bin/gemini");
    expect(agent?.args).toEqual(["--experimental-acp"]);
    // The ACP session must be pinned to a small scratch dir under chatsDir —
    // NOT process.cwd() — so Gemini doesn't scan the app/repo tree (the cause
    // of the multi-second chat stall).
    expect(call?.cwd).toBe("/tmp/pwrsnap-test-chats/.acp-chat");
    expect(makeCodexClient).not.toHaveBeenCalled();
  });

  test("spawns the user-picked instance, not the first found", async () => {
    const group = discoveredGeminiGroup([
      { command: "/usr/local/bin/gemini", version: "0.4.1", source: "path" },
      { command: "/opt/homebrew/bin/gemini", version: "0.3.0", source: "path" }
    ]);
    const makeAcpClient: NonNullable<ChatBackendDeps["makeAcpClient"]> = vi.fn(
      () => stubAcpResult()
    );
    const discoverAcpAgentInstances = vi.fn(async () => [group]);
    const deps: ChatBackendDeps = { makeAcpClient, discoverAcpAgentInstances };

    await buildChatSurface(
      baseConfig({
        provider: "acp:gemini",
        readSettings: settingsWithAcpPref("gemini", {
          selectedPath: "/opt/homebrew/bin/gemini"
        })
      }),
      deps
    );

    expect(vi.mocked(makeAcpClient).mock.calls[0]?.[0]?.agent?.command).toBe(
      "/opt/homebrew/bin/gemini"
    );
  });

  test("feeds the override path into discovery for an acp provider", async () => {
    const group = discoveredGeminiGroup([
      { command: "/custom/gemini", version: "9.9.9", source: "override" }
    ]);
    const makeAcpClient: NonNullable<ChatBackendDeps["makeAcpClient"]> = vi.fn(
      () => stubAcpResult()
    );
    const discoverAcpAgentInstances = vi.fn(async () => [group]);
    const deps: ChatBackendDeps = { makeAcpClient, discoverAcpAgentInstances };

    await buildChatSurface(
      baseConfig({
        provider: "acp:gemini",
        readSettings: settingsWithAcpPref("gemini", { overridePath: "/custom/gemini" })
      }),
      deps
    );

    expect(discoverAcpAgentInstances).toHaveBeenCalledWith({
      overrides: { gemini: "/custom/gemini" }
    });
    expect(vi.mocked(makeAcpClient).mock.calls[0]?.[0]?.agent?.command).toBe(
      "/custom/gemini"
    );
  });

  test("falls back to Codex when the ACP agent is not installed", async () => {
    const makeCodexClient = vi.fn(() => stubBackend());
    const makeAcpClient = vi.fn(() => stubAcpResult());
    const discoverAcpAgentInstances = vi.fn(async () => [] as DiscoveredAcpAgentGroup[]);
    const deps: ChatBackendDeps = {
      makeCodexClient,
      makeAcpClient,
      discoverAcpAgentInstances
    };

    await buildChatSurface(baseConfig({ provider: "acp:gemini" }), deps);

    expect(discoverAcpAgentInstances).toHaveBeenCalledTimes(1);
    expect(makeAcpClient).not.toHaveBeenCalled();
    expect(makeCodexClient).toHaveBeenCalledTimes(1);
  });

  test("falls back to Codex when ACP discovery throws", async () => {
    const makeCodexClient = vi.fn(() => stubBackend());
    const makeAcpClient = vi.fn(() => stubAcpResult());
    const discoverAcpAgentInstances = vi.fn(async () => {
      throw new Error("probe blew up");
    });
    const deps: ChatBackendDeps = {
      makeCodexClient,
      makeAcpClient,
      discoverAcpAgentInstances
    };

    await buildChatSurface(baseConfig({ provider: "acp:gemini" }), deps);

    expect(makeAcpClient).not.toHaveBeenCalled();
    expect(makeCodexClient).toHaveBeenCalledTimes(1);
  });
});

// ---- chatControllerSignature — what triggers a controller rebuild --------

function settingsFor(overrides: {
  command?: { mode?: string; pinnedPath?: string };
  profile?: string;
  libraryProvider?: string;
  libraryModel?: string;
  libraryReasoning?: string;
  sizzleProvider?: string;
}): Settings {
  return {
    codex: {
      mode: overrides.command?.mode ?? "auto",
      pinnedPath: overrides.command?.pinnedPath ?? "",
      profile: overrides.profile ?? ""
    },
    ai: {
      acp: { enabledAgentIds: [], agents: {} },
      defaults: {
        libraryChat: {
          ...(overrides.libraryProvider !== undefined
            ? { provider: overrides.libraryProvider }
            : {}),
          ...(overrides.libraryModel !== undefined ? { model: overrides.libraryModel } : {}),
          ...(overrides.libraryReasoning !== undefined
            ? { reasoning: overrides.libraryReasoning }
            : {})
        },
        sizzleChat: {
          ...(overrides.sizzleProvider !== undefined
            ? { provider: overrides.sizzleProvider }
            : {})
        }
      }
    }
  } as unknown as Settings;
}

describe("chatControllerSignature", () => {
  test("changes when the surface's provider changes (the rebuild trigger)", () => {
    const gemini = chatControllerSignature(
      settingsFor({ libraryProvider: "acp:gemini" }),
      "libraryChat"
    );
    const codex = chatControllerSignature(
      settingsFor({ libraryProvider: "codex" }),
      "libraryChat"
    );
    expect(gemini).not.toBe(codex);
  });

  test("changes when the model or reasoning changes", () => {
    const base = chatControllerSignature(
      settingsFor({ libraryProvider: "codex", libraryModel: "gpt-5.5" }),
      "libraryChat"
    );
    const otherModel = chatControllerSignature(
      settingsFor({ libraryProvider: "codex", libraryModel: "gpt-5.5-mini" }),
      "libraryChat"
    );
    const otherReasoning = chatControllerSignature(
      settingsFor({ libraryProvider: "codex", libraryModel: "gpt-5.5", libraryReasoning: "high" }),
      "libraryChat"
    );
    expect(base).not.toBe(otherModel);
    expect(base).not.toBe(otherReasoning);
  });

  test("changes when the codex command or auth profile changes", () => {
    const base = chatControllerSignature(settingsFor({}), "libraryChat");
    const pinned = chatControllerSignature(
      settingsFor({ command: { mode: "pinned", pinnedPath: "/opt/codex" } }),
      "libraryChat"
    );
    const profiled = chatControllerSignature(
      settingsFor({ profile: "work" }),
      "libraryChat"
    );
    expect(base).not.toBe(pinned);
    expect(base).not.toBe(profiled);
  });

  test("is STABLE when only the OTHER surface's config changes", () => {
    // Changing the Sizzle provider must not churn the Library controller.
    const a = chatControllerSignature(
      settingsFor({ libraryProvider: "codex", sizzleProvider: "acp:gemini" }),
      "libraryChat"
    );
    const b = chatControllerSignature(
      settingsFor({ libraryProvider: "codex", sizzleProvider: "acp:qwen" }),
      "libraryChat"
    );
    expect(a).toBe(b);
  });

  test("is identical for identical settings (no spurious rebuilds)", () => {
    const a = chatControllerSignature(
      settingsFor({ libraryProvider: "acp:gemini", libraryModel: "gemini-2.5" }),
      "libraryChat"
    );
    const b = chatControllerSignature(
      settingsFor({ libraryProvider: "acp:gemini", libraryModel: "gemini-2.5" }),
      "libraryChat"
    );
    expect(a).toBe(b);
  });
});

describe("buildChatSurface — dispose", () => {
  test("dispose closes an exclusively-ours Codex backend", async () => {
    const codexBackend = stubBackend();
    const makeCodexClient = vi.fn(() => codexBackend);
    const surface = await buildChatSurface(baseConfig({ provider: "codex" }), {
      makeCodexClient
    });
    await surface.dispose();
    expect(vi.mocked(codexBackend.close)).toHaveBeenCalledTimes(1);
  });

  test("dispose does NOT close a pooled (shared) ACP backend", async () => {
    const acpBackend = stubBackend();
    const makeAcpClient = vi.fn(() => ({ client: acpBackend, mcpServers: [] as never[] }));
    const discoverAcpAgentInstances = vi.fn(async () => [discoveredGeminiGroup()]);
    const surface = await buildChatSurface(baseConfig({ provider: "acp:gemini" }), {
      makeAcpClient,
      discoverAcpAgentInstances
    });
    await surface.dispose();
    expect(vi.mocked(acpBackend.close)).not.toHaveBeenCalled();
  });
});
