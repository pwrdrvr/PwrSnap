import { describe, expect, test, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredAcpAgentGroup } from "@pwrdrvr/agent-acp";
import type { ChatBackend } from "@pwrdrvr/agent-client";
import type {
  AgentBackendApprovalHandler,
  NormalizedThreadEvent
} from "@pwrdrvr/agent-core";
import type {
  AiSurfaceDefault,
  ChatApprovalRequest,
  LibraryChatThreadView,
  Settings
} from "@pwrsnap/shared";
import {
  buildChatSurface,
  chatControllerSignature,
  chatSurfaceDefaultsFromSettings,
  type ChatBackendDeps,
  type ChatSurfaceConfig
} from "../chat-controller-factory";
import type { ChatApprovalBroker, ChatApprovalResolver } from "../chat-approval-broker";
import { ThreadStoreAdapter } from "../thread-store-adapter";

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
    ai: { acp: { enabledAgentIds: ["gemini", "grok", "kimi", "qwen"], agents: {} } }
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

function controllableBackend(): {
  backend: ChatBackend;
  requestApproval: (method: string, params: unknown) => Promise<"approved" | "denied" | "abort">;
  emit: (event: NormalizedThreadEvent) => void;
} {
  const backend = stubBackend();
  let handler: AgentBackendApprovalHandler | null = null;
  const listeners = new Set<(event: NormalizedThreadEvent) => void>();
  vi.mocked(backend.onEvent).mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  vi.mocked(backend.onApprovalRequest).mockImplementation((next) => {
    handler = next;
    return () => {
      if (handler === next) handler = null;
    };
  });
  return {
    backend,
    requestApproval: (method, params) => {
      if (handler === null) throw new Error("approval handler was not wired");
      return handler(method, params);
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function approvalBrokerDouble(overrides: {
  register?: (
    request: ChatApprovalRequest,
    owner: object,
    resolve: ChatApprovalResolver
  ) => boolean;
  closeOwner?: (owner: object) => Promise<void>;
  closeThread?: (threadId: string) => Promise<void>;
  openThread?: (threadId: string) => void;
} = {}): ChatApprovalBroker {
  return {
    register: overrides.register ?? (() => true),
    decorateThread: (view: LibraryChatThreadView) => view,
    closeOwner: overrides.closeOwner ?? (async () => undefined),
    closeThread: overrides.closeThread ?? (async () => undefined),
    openThread: overrides.openThread ?? (() => undefined)
  } as unknown as ChatApprovalBroker;
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
  pref: { overridePath?: string; selectedPath?: string },
  enabled = true
): () => Promise<Settings> {
  return () =>
    Promise.resolve({
      ai: { acp: { enabledAgentIds: enabled ? [agentId] : [], agents: { [agentId]: pref } } }
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
    // The ACP session must be pinned to the app-owned scratch jail — NOT
    // process.cwd() (so Gemini doesn't scan the app/repo tree, the cause of the
    // multi-second chat stall) and NOT chatsDir, which is the user's Documents
    // tree. On ACP, cwd is one of only two real sandbox controls.
    expect(call?.cwd).toBe(join(tmpdir(), "pwrsnap", ".acp-scratch"));
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
      strategies: [expect.objectContaining({ id: "gemini" })],
      overrides: { gemini: "/custom/gemini" }
    });
    expect(vi.mocked(makeAcpClient).mock.calls[0]?.[0]?.agent?.command).toBe(
      "/custom/gemini"
    );
  });

  test("does not discover or spawn a disabled acp provider", async () => {
    const makeCodexClient = vi.fn(() => stubBackend());
    const makeAcpClient = vi.fn(() => stubAcpResult());
    const discoverAcpAgentInstances = vi.fn(async () => [discoveredGeminiGroup()]);
    const deps: ChatBackendDeps = {
      makeCodexClient,
      makeAcpClient,
      discoverAcpAgentInstances
    };

    await buildChatSurface(
      baseConfig({
        provider: "acp:gemini",
        readSettings: settingsWithAcpPref("gemini", { overridePath: "/custom/gemini" }, false)
      }),
      deps
    );

    expect(discoverAcpAgentInstances).not.toHaveBeenCalled();
    expect(makeAcpClient).not.toHaveBeenCalled();
    expect(makeCodexClient).toHaveBeenCalledTimes(1);
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
  test("does not make approval cleanup idle until delayed final journal commit finishes", async () => {
    const threadId = "thread-delayed-journal";
    const turnId = "turn-delayed-journal";
    const record = {
      threadId,
      name: "Delayed journal",
      createdAt: "2026-08-23T00:00:00.000Z",
      modifiedAt: "2026-08-23T00:00:00.000Z",
      anchorId: null,
      anchorHistory: [],
      archived: false,
      pinned: false
    };
    const journal: unknown[] = [];
    const assistantAppendStarted = deferred<void>();
    const assistantAppendGate = deferred<void>();
    const storeGet = vi
      .spyOn(ThreadStoreAdapter.prototype, "get")
      .mockResolvedValue(record);
    const journalAppend = vi
      .spyOn(ThreadStoreAdapter.prototype, "journalAppend")
      .mockImplementation(async (_id, entry) => {
        const role = (entry as { message?: { role?: unknown } }).message?.role;
        if (role === "assistant") {
          assistantAppendStarted.resolve(undefined);
          await assistantAppendGate.promise;
        }
        journal.push(entry);
      });
    const controlled = controllableBackend();
    vi.mocked(controlled.backend.startTurn).mockResolvedValue({ turnId });
    const closeThread = vi.fn(async () => {
      expect(
        journal.some(
          (entry) =>
            (entry as { message?: { role?: unknown; text?: unknown } }).message?.role ===
              "assistant" &&
            (entry as { message?: { text?: unknown } }).message?.text === "final answer"
        )
      ).toBe(true);
    });
    const surface = await buildChatSurface(
      baseConfig({
        provider: "codex",
        approvalBroker: approvalBrokerDouble({ closeThread })
      }),
      { makeCodexClient: () => controlled.backend }
    );

    try {
      await surface.controller.sendMessage({ threadId, text: "question" });
      controlled.emit({
        kind: "agent_message_delta",
        threadId,
        turnId,
        itemId: "assistant-item",
        delta: "final answer"
      });
      controlled.emit({ kind: "turn_completed", threadId, turnId, status: "completed" });

      await assistantAppendStarted.promise;
      expect(closeThread).not.toHaveBeenCalled();

      assistantAppendGate.resolve(undefined);
      await vi.waitFor(() => expect(closeThread).toHaveBeenCalledWith(threadId));
      expect(journalAppend).toHaveBeenCalledTimes(2);
    } finally {
      await surface.dispose();
      journalAppend.mockRestore();
      storeGet.mockRestore();
    }
  });

  test("registers an approval resolver bound to the exact originating controller", async () => {
    // The kit publishes awaiting/idle thread status around its private approval
    // promise. This factory-level test has no app database, so keep that
    // incidental lookup at the adapter seam while exercising the real
    // controller approval machinery.
    const storeGet = vi.spyOn(ThreadStoreAdapter.prototype, "get").mockResolvedValue(null);
    const controlled = controllableBackend();
    let registered:
      | {
          request: ChatApprovalRequest;
          owner: object;
          resolve: ChatApprovalResolver;
        }
      | undefined;
    const register = vi.fn(
      (request: ChatApprovalRequest, owner: object, resolve: ChatApprovalResolver) => {
        registered = { request, owner, resolve };
        return true;
      }
    );
    const broker = approvalBrokerDouble({ register });
    const surface = await buildChatSurface(
      baseConfig({ provider: "codex", approvalBroker: broker }),
      { makeCodexClient: () => controlled.backend }
    );
    const controllerResolve = vi.spyOn(surface.controller, "resolveApproval");

    const backendDecision = controlled.requestApproval(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-original",
        turnId: "turn-original",
        command: "pwd"
      }
    );
    await vi.waitFor(() => expect(registered).toBeDefined());
    const captured = registered;
    if (captured === undefined) throw new Error("broker did not capture approval");

    await captured.resolve("approve");

    expect(controllerResolve).toHaveBeenCalledWith({
      threadId: captured.request.threadId,
      turnId: captured.request.turnId,
      approvalId: captured.request.approvalId,
      decision: "approved"
    });
    await expect(backendDecision).resolves.toBe("approved");
    await vi.waitFor(() => expect(storeGet).toHaveBeenCalledTimes(2));
    await surface.dispose();
    storeGet.mockRestore();
  });

  test("safe-denies an invalid backend approval identity without broker or renderer exposure", async () => {
    const storeGet = vi.spyOn(ThreadStoreAdapter.prototype, "get").mockResolvedValue(null);
    const controlled = controllableBackend();
    const register = vi.fn(() => true);
    const send = vi.fn();
    const surface = await buildChatSurface(
      baseConfig({
        provider: "codex",
        approvalBroker: approvalBrokerDouble({ register }),
        send: send as unknown as ChatSurfaceConfig["send"]
      }),
      { makeCodexClient: () => controlled.backend }
    );

    try {
      const backendDecision = controlled.requestApproval(
        "item/commandExecution/requestApproval",
        {
          threadId: "thread\u202espoofed",
          turnId: "turn-invalid",
          command: "never expose"
        }
      );

      await expect(backendDecision).resolves.toBe("denied");
      expect(register).not.toHaveBeenCalled();
      expect(
        send.mock.calls.some(([channel]) => channel === "x:f")
      ).toBe(false);
    } finally {
      await surface.dispose();
      storeGet.mockRestore();
    }
  });

  test("closes broker ownership before closing the exclusive backend", async () => {
    const order: string[] = [];
    const controlled = controllableBackend();
    const send = vi.fn();
    vi.mocked(controlled.backend.close).mockImplementation(async () => {
      order.push("backend.close");
    });
    const closeOwner = vi.fn(async () => {
      order.push("broker.closeOwner");
      controlled.emit({
        kind: "tool_call",
        threadId: "thread-live-during-cleanup",
        turnId: "turn-live-during-cleanup",
        toolCall: {
          id: "call-live-during-cleanup",
          name: "library_search",
          kind: "search",
          label: "Still live",
          status: "completed"
        }
      });
    });
    const surface = await buildChatSurface(
      baseConfig({
        provider: "codex",
        approvalBroker: approvalBrokerDouble({ closeOwner }),
        send: send as unknown as ChatSurfaceConfig["send"]
      }),
      { makeCodexClient: () => controlled.backend }
    );

    await surface.dispose();

    expect(order).toEqual(["broker.closeOwner", "backend.close"]);
    expect(send).toHaveBeenCalledTimes(1);
    controlled.emit({
      kind: "tool_call",
      threadId: "thread-after-cleanup",
      turnId: "turn-after-cleanup",
      toolCall: {
        id: "call-after-cleanup",
        name: "library_search",
        kind: "search",
        label: "Must be silent",
        status: "completed"
      }
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("still closes the exclusive backend when broker-owner cleanup fails", async () => {
    const codexBackend = stubBackend();
    const closeOwner = vi.fn(async () => {
      throw new Error("deny callback failed");
    });
    const surface = await buildChatSurface(
      baseConfig({
        provider: "codex",
        approvalBroker: approvalBrokerDouble({ closeOwner })
      }),
      { makeCodexClient: () => codexBackend }
    );

    await expect(surface.dispose()).resolves.toBeUndefined();

    expect(codexBackend.close).toHaveBeenCalledTimes(1);
  });

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
