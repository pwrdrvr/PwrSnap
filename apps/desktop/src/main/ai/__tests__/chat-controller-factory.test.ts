import { describe, expect, test, vi } from "vitest";
import type { DiscoveredAcpAgent } from "@pwrdrvr/agent-acp";
import type { ChatBackend } from "@pwrdrvr/agent-client";
import type { AiSurfaceDefault, Settings } from "@pwrsnap/shared";
import {
  buildChatSurface,
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
  Promise.resolve({} as unknown as Settings);

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

function discoveredGemini(): DiscoveredAcpAgent {
  return {
    strategyId: "gemini",
    backendId: "acp:gemini",
    name: "Gemini CLI",
    command: "/usr/local/bin/gemini",
    args: ["--experimental-acp"],
    env: {},
    discoveredAt: 1
  };
}

describe("buildChatSurface — backend selection", () => {
  test('provider "codex" builds the Codex backend (no ACP discovery)', async () => {
    const makeCodexClient = vi.fn(() => stubBackend());
    const makeAcpClient = vi.fn(() => stubBackend());
    const discoverAcpAgents = vi.fn(async () => [] as DiscoveredAcpAgent[]);
    const deps: ChatBackendDeps = {
      makeCodexClient,
      makeAcpClient,
      discoverAcpAgents
    };

    await buildChatSurface(baseConfig({ provider: "codex" }), deps);

    expect(makeCodexClient).toHaveBeenCalledTimes(1);
    expect(makeAcpClient).not.toHaveBeenCalled();
    expect(discoverAcpAgents).not.toHaveBeenCalled();
  });

  test("an undefined provider builds the Codex backend", async () => {
    const makeCodexClient = vi.fn(() => stubBackend());
    const deps: ChatBackendDeps = { makeCodexClient };
    await buildChatSurface(baseConfig({}), deps);
    expect(makeCodexClient).toHaveBeenCalledTimes(1);
  });

  test('provider "acp:<id>" builds the ACP backend from the discovered agent', async () => {
    const agent = discoveredGemini();
    const makeCodexClient = vi.fn(() => stubBackend());
    const makeAcpClient: NonNullable<ChatBackendDeps["makeAcpClient"]> = vi.fn(
      () => stubBackend()
    );
    const discoverAcpAgents = vi.fn(async () => [agent]);
    const deps: ChatBackendDeps = {
      makeCodexClient,
      makeAcpClient,
      discoverAcpAgents
    };

    await buildChatSurface(baseConfig({ provider: "acp:gemini" }), deps);

    expect(discoverAcpAgents).toHaveBeenCalledTimes(1);
    expect(makeAcpClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(makeAcpClient).mock.calls[0]?.[0]?.agent).toEqual(agent);
    expect(makeCodexClient).not.toHaveBeenCalled();
  });

  test("falls back to Codex when the ACP agent is not installed", async () => {
    const makeCodexClient = vi.fn(() => stubBackend());
    const makeAcpClient = vi.fn(() => stubBackend());
    const discoverAcpAgents = vi.fn(async () => [] as DiscoveredAcpAgent[]);
    const deps: ChatBackendDeps = {
      makeCodexClient,
      makeAcpClient,
      discoverAcpAgents
    };

    await buildChatSurface(baseConfig({ provider: "acp:gemini" }), deps);

    expect(discoverAcpAgents).toHaveBeenCalledTimes(1);
    expect(makeAcpClient).not.toHaveBeenCalled();
    expect(makeCodexClient).toHaveBeenCalledTimes(1);
  });

  test("falls back to Codex when ACP discovery throws", async () => {
    const makeCodexClient = vi.fn(() => stubBackend());
    const makeAcpClient = vi.fn(() => stubBackend());
    const discoverAcpAgents = vi.fn(async () => {
      throw new Error("probe blew up");
    });
    const deps: ChatBackendDeps = {
      makeCodexClient,
      makeAcpClient,
      discoverAcpAgents
    };

    await buildChatSurface(baseConfig({ provider: "acp:gemini" }), deps);

    expect(makeAcpClient).not.toHaveBeenCalled();
    expect(makeCodexClient).toHaveBeenCalledTimes(1);
  });
});
