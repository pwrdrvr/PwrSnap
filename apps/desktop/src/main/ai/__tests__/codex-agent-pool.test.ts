import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireCodexAgentBackendView,
  closeCodexAgentPool,
  listCodexModelsFromPool,
  runCodexOneShotFromPool
} from "../codex-agent-pool";
import { __setDesktopSettingsStoreForTests } from "../../settings/desktop-settings-store";

type MockCodexThreadClient = {
  startThread: ReturnType<typeof vi.fn>;
  forkThread: ReturnType<typeof vi.fn>;
  interruptTurn: ReturnType<typeof vi.fn>;
  onToolCall: ReturnType<typeof vi.fn>;
  onApprovalRequest: ReturnType<typeof vi.fn>;
  emitEvent(event: unknown): void;
};

type MockCodexDiscovery = {
  selectedCommand?: string;
  selectedSource?: "path" | "config" | "application";
  candidates: Array<{
    command: string;
    source: "path" | "config" | "application";
    executable: boolean;
    selected: boolean;
    version?: string;
    failureReason?: string;
  }>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mockCodexThreadClients = vi.hoisted(() => [] as MockCodexThreadClient[]);
const mockConnectionRequest = vi.hoisted(() =>
  vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({}))
);
const mockDiscoverCodexCommands = vi.hoisted(() =>
  vi.fn(async ({ configuredCommand }: { configuredCommand?: string } = {}): Promise<MockCodexDiscovery> => {
    const command = configuredCommand ?? "codex";
    return {
      selectedCommand: command,
      selectedSource: configuredCommand === undefined ? "path" : "config",
      candidates: [
        {
          command,
          source: configuredCommand === undefined ? "path" : "config",
          executable: true,
          selected: true,
          version: "0.144.0"
        }
      ]
    };
  })
);

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/pwrsnap-codex-agent-pool-settings",
    getVersion: () => "1.0.0"
  },
  BrowserWindow: { getAllWindows: () => [] }
}));

vi.mock("../../settings/codex-discovery", () => ({
  compareCodexCliVersions: () => 0,
  discoverCodexCommands: mockDiscoverCodexCommands,
  MINIMUM_CODEX_CLI_VERSION: "0.144.0",
  probeCodexAuth: vi.fn(async () => ({
    status: "authenticated",
    testedAt: "2026-09-01T00:00:00.000Z",
    durationMs: 1
  })),
  selectResolvedCodexCommand: (
    discovery: { candidates: Array<{ command: string; source: string; selected: boolean }> },
    fallback: string
  ) => {
    const selected = discovery.candidates.find((candidate) => candidate.selected);
    return selected ?? { command: fallback, source: "path" };
  }
}));

// The enrichment sandbox denies escalations at ERROR level with the run +
// capture id (issue #69). Capture the scoped logger so a test can assert the
// denial actually reaches the log, not just that the decision was "denied".
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}));

vi.mock("../../log", () => ({
  getMainLogger: () => mockLogger,
  isMainLogDebugCollectionEnabled: () => false
}));

vi.mock("@pwrdrvr/agent-client", () => {
  class CodexThreadClient {
    private readonly eventHandlers = new Set<(event: unknown) => void>();
    readonly startThread = vi.fn(async () => ({
      threadId: "thread-1",
      model: "gpt-5.5",
      modelProvider: "codex",
      serviceTier: null
    }));
    readonly startTurn = vi.fn(async () => ({ turnId: "turn-1" }));
    readonly interruptTurn = vi.fn(async () => undefined);
    readonly archiveThread = vi.fn(async () => undefined);
    readonly forkThread = vi.fn(async () => ({
      threadId: "thread-fork",
      model: "gpt-5.5",
      modelProvider: "codex",
      serviceTier: null
    }));
    readonly clearThreadGitInfo = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
    readonly onEvent = vi.fn((handler: (event: unknown) => void) => {
      this.eventHandlers.add(handler);
      return () => this.eventHandlers.delete(handler);
    });
    readonly onToolCall = vi.fn(() => () => undefined);
    readonly onApprovalRequest = vi.fn(() => () => undefined);
    readonly getConnection = vi.fn(async () => ({
      request: mockConnectionRequest,
      setNotificationHandler: vi.fn()
    }));
    readonly initialize = vi.fn(async () => ({ userAgent: "codex-test" }));
    readonly handleNotification = vi.fn();

    constructor(_options: unknown) {
      mockCodexThreadClients.push(this);
    }

    emitEvent(event: unknown): void {
      for (const handler of this.eventHandlers) handler(event);
    }
  }

  return { CodexThreadClient };
});

afterEach(async () => {
  await closeCodexAgentPool();
  __setDesktopSettingsStoreForTests(null);
  mockCodexThreadClients.length = 0;
  vi.clearAllMocks();
  mockLogger.error.mockClear();
  mockConnectionRequest.mockReset();
  mockConnectionRequest.mockResolvedValue({});
});

describe("Codex agent pool", () => {
  test("refuses to start a thread when the CLI is older than the protocol floor", async () => {
    mockDiscoverCodexCommands.mockResolvedValueOnce({
      candidates: [
        {
          command: "codex-test",
          source: "config",
          executable: false,
          selected: false,
          version: "0.143.0",
          failureReason: "codex_too_old"
        }
      ]
    });
    const view = acquireCodexAgentBackendView({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-old-cli-test" },
      loggerScope: "pwrsnap:test-codex-pool"
    });

    await expect(view.startThread()).rejects.toThrow(
      "older than the minimum supported version 0.144.0"
    );
    expect(mockCodexThreadClients[0]?.startThread).not.toHaveBeenCalled();

    // Retrying the runtime action itself reuses the failed publication instead
    // of launching another machine probe.
    await expect(view.startThread()).rejects.toThrow(
      "older than the minimum supported version 0.144.0"
    );
    expect(mockDiscoverCodexCommands).toHaveBeenCalledTimes(1);
    expect(mockCodexThreadClients[0]?.startThread).not.toHaveBeenCalled();
  });

  test("uses the store-resolved command without a second version probe", async () => {
    mockDiscoverCodexCommands.mockResolvedValueOnce({
      selectedCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
      selectedSource: "application",
      candidates: [{
        command: "/Applications/ChatGPT.app/Contents/Resources/codex",
        source: "application",
        executable: true,
        selected: true,
        version: "0.144.0"
      }]
    });
    const view = acquireCodexAgentBackendView({
      command: "codex",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-discovery-test" },
      loggerScope: "pwrsnap:test-codex-pool"
    });

    await view.startThread();

    expect(mockDiscoverCodexCommands).toHaveBeenCalledWith({
      configuredCommand: undefined,
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-discovery-test" }
    });
    expect(mockDiscoverCodexCommands).toHaveBeenCalledTimes(1);
  });

  test.each([true, false])(
    "preserves Code Mode enablement (%s) for chat thread overlays",
    async (enabled) => {
      mockConnectionRequest.mockImplementation(async (method: string) =>
        method === "config/read"
          ? { config: { features: { code_mode: enabled } } }
          : {}
      );
      const view = acquireCodexAgentBackendView({
        command: "codex-test",
        env: { CODEX_HOME: `/tmp/pwrsnap-codex-pool-code-mode-${enabled}` },
        loggerScope: "pwrsnap:test-codex-pool"
      });

      await view.startThread({
        cwd: "/tmp/pwrsnap-code-mode-chat",
        config: {
          features: {
            code_mode: {
              direct_only_tool_namespaces: ["pwrsnap_library", "pwrsnap_sizzle"]
            }
          }
        }
      });

      expect(mockCodexThreadClients[0]?.startThread).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            features: {
              code_mode: {
                direct_only_tool_namespaces: ["pwrsnap_library", "pwrsnap_sizzle"],
                enabled
              }
            }
          }
        })
      );
    }
  );

  test("preserves Code Mode settings when forking a chat", async () => {
    mockConnectionRequest.mockImplementation(async (method: string) =>
      method === "config/read"
        ? {
            config: {
              features: {
                code_mode: {
                  enabled: true,
                  direct_only_tool_namespaces: ["mcp__history"]
                }
              }
            }
          }
        : {}
    );
    const view = acquireCodexAgentBackendView({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-code-mode-fork" },
      loggerScope: "pwrsnap:test-codex-pool"
    });

    await view.forkThread?.({
      sourceThreadId: "source-thread",
      cwd: "/tmp/pwrsnap-code-mode-fork",
      config: {
        features: {
          code_mode: {
            direct_only_tool_namespaces: ["pwrsnap_library", "pwrsnap_sizzle"]
          }
        }
      }
    });

    expect(mockConnectionRequest).toHaveBeenCalledWith(
      "config/read",
      { includeLayers: false, cwd: "/tmp/pwrsnap-code-mode-fork" },
      20_000
    );
    expect(mockCodexThreadClients[0]?.forkThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadId: "source-thread",
        cwd: "/tmp/pwrsnap-code-mode-fork",
        config: {
          features: {
            code_mode: {
              direct_only_tool_namespaces: [
                "mcp__history",
                "pwrsnap_library",
                "pwrsnap_sizzle"
              ],
              enabled: true
            }
          }
        }
      })
    );
  });

  test("preserves each model's advertised reasoning efforts and default", async () => {
    mockConnectionRequest.mockResolvedValueOnce({
      data: [
        {
          id: "gpt-5.6-terra",
          model: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          description: "Frontier model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "high", description: "Thorough" },
            { reasoningEffort: "xhigh", description: "Extra high" },
            { reasoningEffort: "max", description: "Maximum" },
            { reasoningEffort: "ultra", description: "Ultra" }
          ],
          defaultReasoningEffort: "medium",
          inputModalities: ["text", "image"],
          defaultServiceTier: null,
          isDefault: true
        }
      ],
      nextCursor: null
    });

    const models = await listCodexModelsFromPool({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-model-test" },
      includeHidden: false
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: "gpt-5.6-terra",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "medium"
      })
    ]);
  });

  test("interrupts a view's active turns before releasing handlers", async () => {
    const view = acquireCodexAgentBackendView({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-test" },
      loggerScope: "pwrsnap:test-codex-pool"
    });
    const started = await view.startThread();
    await view.startTurn({
      threadId: started.threadId,
      input: { text: "hello" }
    } as never);

    await view.close();

    expect(mockCodexThreadClients[0]?.interruptTurn).toHaveBeenCalledTimes(1);
    expect(mockCodexThreadClients[0]?.interruptTurn).toHaveBeenCalledWith("thread-1");
  });

  test("does not interrupt turns already completed by Codex", async () => {
    const view = acquireCodexAgentBackendView({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-test" },
      loggerScope: "pwrsnap:test-codex-pool"
    });
    const started = await view.startThread();
    await view.startTurn({
      threadId: started.threadId,
      input: { text: "hello" }
    } as never);
    mockCodexThreadClients[0]?.emitEvent({
      kind: "turn_completed",
      threadId: "thread-1",
      status: "completed"
    });

    await view.close();

    expect(mockCodexThreadClients[0]?.interruptTurn).not.toHaveBeenCalled();
  });

  test("uses a fresh ephemeral thread for every pooled one-shot run", async () => {
    let nextThread = 0;
    mockConnectionRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "config/read") {
        return {
          config: {
            features: { code_mode: true },
            mcp_servers: {
              context7: { command: "npx", env: { SECRET: "never-forward-me" } },
              pwrsnap: { command: "pwrsnap-mcp-server" }
            }
          }
        };
      }
      if (method === "thread/start") {
        nextThread += 1;
        return {
          thread: { id: `one-shot-thread-${nextThread}` },
          model: "gpt-5.6-luna",
          modelProvider: "openai",
          serviceTier: null
        };
      }
      if (method === "turn/start") {
        const { threadId } = params as { threadId: string };
        const turnId = `turn-for-${threadId}`;
        setTimeout(() => {
          mockCodexThreadClients[0]?.emitEvent({
            kind: "agent_message",
            threadId,
            turnId,
            message: { text: '{"ok":true}' }
          });
          mockCodexThreadClients[0]?.emitEvent({
            kind: "token_usage",
            threadId,
            turnId,
            usage: {
              inputTokens: 2_500,
              cachedInputTokens: 0,
              outputTokens: 20,
              reasoningOutputTokens: 0,
              totalTokens: 2_520
            }
          });
          mockCodexThreadClients[0]?.emitEvent({
            kind: "turn_completed",
            threadId,
            turnId,
            status: "completed"
          });
        }, 0);
        return { turn: { id: turnId } };
      }
      return {};
    });

    const options = {
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-one-shot-test" },
      workspaceDir: "/tmp/pwrsnap-one-shot-workspace",
      prompt: "describe this image",
      imagePaths: ["/tmp/capture.jpg"],
      baseInstructions: "Return JSON only.",
      threadConfig: {
        project_doc_max_bytes: 0,
        features: {
          code_mode: {
            direct_only_tool_namespaces: ["pwrsnap_library", "pwrsnap_sizzle"]
          }
        }
      }
    } as const;

    const first = await runCodexOneShotFromPool(options);
    const second = await runCodexOneShotFromPool(options);

    expect(first.threadId).toBe("one-shot-thread-1");
    expect(second.threadId).toBe("one-shot-thread-2");
    expect(mockCodexThreadClients).toHaveLength(1);

    const calls = mockConnectionRequest.mock.calls;
    const starts = calls.filter(([method]) => method === "thread/start");
    expect(starts).toHaveLength(2);
    for (const [, params] of starts) {
      expect(params).toMatchObject({
        ephemeral: true,
        environments: [],
        config: {
          project_doc_max_bytes: 0,
          features: {
            code_mode: {
              direct_only_tool_namespaces: ["pwrsnap_library", "pwrsnap_sizzle"],
              enabled: true
            }
          },
          mcp_servers: {
            context7: { enabled: false },
            pwrsnap: { enabled: false }
          }
        }
      });
      expect(params).not.toHaveProperty("dynamicTools");
      expect(JSON.stringify(params)).not.toContain("never-forward-me");
    }
    expect(calls.filter(([method]) => method === "config/read")).toHaveLength(2);
    expect(calls.filter(([method]) => method === "thread/unsubscribe")).toHaveLength(2);
    expect(calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    expect(calls.some(([method]) => method === "thread/rollback")).toBe(false);
  });

  // --- Capture-enrichment sandbox invariant (issue #69) -------------------
  //
  // The enrichment turn's only input is a screenshot, which is untrusted: it
  // can carry text engineered to talk the model into running a command or
  // reading a file. `prompts/capture-enrichment.md` tells the model to ignore
  // that, but a prompt is a request. These tests pin the CONTROLS.
  // See AGENTS.md § "Capture enrichment runs in a sandbox jail".

  /** Wire the connection mock for a one-shot whose turn is held open until the
   *  returned `completeTurn()` is called — so a test can inject an App Server
   *  request while the enrichment thread is live. */
  function stageHeldOneShot(): { completeTurn: () => void } {
    let held: (() => void) | null = null;
    mockConnectionRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") return { thread: { id: "one-shot-thread-1" } };
      if (method === "turn/start") {
        const { threadId } = params as { threadId: string };
        const turnId = "turn-held";
        held = () => {
          mockCodexThreadClients[0]?.emitEvent({
            kind: "agent_message",
            threadId,
            turnId,
            message: { text: '{"ok":true}' }
          });
          mockCodexThreadClients[0]?.emitEvent({
            kind: "turn_completed",
            threadId,
            turnId,
            status: "completed"
          });
        };
        return { turn: { id: turnId } };
      }
      return {};
    });
    return {
      completeTurn: () => {
        held?.();
      }
    };
  }

  test("pins the sandbox posture on every enrichment thread/start", async () => {
    mockConnectionRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") return { thread: { id: "one-shot-thread-1" } };
      if (method === "turn/start") {
        const { threadId } = params as { threadId: string };
        setTimeout(() => {
          mockCodexThreadClients[0]?.emitEvent({
            kind: "agent_message",
            threadId,
            turnId: "turn-1",
            message: { text: "{}" }
          });
          mockCodexThreadClients[0]?.emitEvent({
            kind: "turn_completed",
            threadId,
            turnId: "turn-1",
            status: "completed"
          });
        }, 0);
        return { turn: { id: "turn-1" } };
      }
      return {};
    });

    await runCodexOneShotFromPool({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-sandbox-test" },
      workspaceDir: "/tmp/pwrsnap-enrichment-jail",
      prompt: "describe this image",
      imagePaths: ["/tmp/capture.jpg"]
    });

    const start = mockConnectionRequest.mock.calls.find(([method]) => method === "thread/start");
    // Each field is load-bearing; widening ANY of them widens what an injected
    // screenshot can talk the model into doing. Change deliberately or not at
    // all.
    expect(start?.[1]).toMatchObject({
      // No context (or injected instruction) survives from one capture to the next.
      ephemeral: true,
      // The agent's cwd is an app-owned scratch dir — not the user's captures,
      // not userData, not the repo.
      cwd: "/tmp/pwrsnap-enrichment-jail",
      runtimeWorkspaceRoots: ["/tmp/pwrsnap-enrichment-jail"],
      // Background job: nobody is at the keyboard to answer a prompt.
      approvalPolicy: "never",
      // READ-SCOPED posture: denies reads outside the jail. NOT
      // `sandbox: "read-only"`, which permits reading the whole filesystem.
      permissions: "pwrsnap_enrichment",
      // Environment profiles can carry their own tool/permission grants.
      environments: [],
      persistExtendedHistory: false,
      config: {
        permissions: {
          pwrsnap_enrichment: {
            filesystem: {
              ":root": "deny",
              ":minimal": "read",
              "/tmp/pwrsnap-enrichment-jail": "read"
            }
          }
        }
      }
    });
    expect(start?.[1]).not.toHaveProperty("sandbox");
  });

  // A Codex build that rejects `permissions` must not break enrichment — it
  // falls back to the older posture, which is exactly the pre-existing
  // behavior. It is WEAKER (read-only permits whole-filesystem reads), so the
  // fallback is logged rather than passing silently.
  test("falls back to sandbox:read-only when Codex rejects the permissions profile", async () => {
    let startAttempts = 0;
    mockConnectionRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") {
        startAttempts += 1;
        const p = params as { permissions?: unknown };
        if (p.permissions !== undefined) {
          throw new Error("unknown field `permissions`");
        }
        return { thread: { id: "one-shot-thread-1" } };
      }
      if (method === "turn/start") {
        const { threadId } = params as { threadId: string };
        setTimeout(() => {
          mockCodexThreadClients[0]?.emitEvent({
            kind: "agent_message",
            threadId,
            turnId: "turn-1",
            message: { text: "{}" }
          });
          mockCodexThreadClients[0]?.emitEvent({
            kind: "turn_completed",
            threadId,
            turnId: "turn-1",
            status: "completed"
          });
        }, 0);
        return { turn: { id: "turn-1" } };
      }
      return {};
    });

    const result = await runCodexOneShotFromPool({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-fallback-test" },
      workspaceDir: "/tmp/pwrsnap-enrichment-jail",
      prompt: "describe this image",
      imagePaths: ["/tmp/capture.jpg"]
    });

    // Enrichment still succeeded.
    expect(result.threadId).toBe("one-shot-thread-1");
    expect(startAttempts).toBe(2);

    const starts = mockConnectionRequest.mock.calls.filter(([m]) => m === "thread/start");
    expect(starts[0]?.[1]).toMatchObject({ permissions: "pwrsnap_enrichment" });
    expect(starts[1]?.[1]).toMatchObject({ sandbox: "read-only" });
    expect(starts[1]?.[1]).not.toHaveProperty("permissions");
    // The degradation is visible, not silent.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("does NOT restrict reads"),
      expect.anything()
    );
  });

  // A transient failure must NOT downgrade read scoping. Only an error that
  // actually names the permissions field/profile justifies the weaker posture.
  test("does not downgrade the sandbox on a transient thread/start failure", async () => {
    let startAttempts = 0;
    mockConnectionRequest.mockImplementation(async (method: string) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") {
        startAttempts += 1;
        throw new Error("request timed out after 20000ms");
      }
      return {};
    });

    await expect(
      runCodexOneShotFromPool({
        command: "codex-test",
        env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-transient-test" },
        workspaceDir: "/tmp/pwrsnap-enrichment-jail",
        prompt: "describe this image",
        imagePaths: ["/tmp/capture.jpg"]
      })
    ).rejects.toThrow("timed out");

    // One attempt only — no silent retry with sandbox:read-only.
    expect(startAttempts).toBe(1);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("does NOT restrict reads"),
      expect.anything()
    );
  });

  test("does not downgrade the sandbox when the start is aborted", async () => {
    let startAttempts = 0;
    mockConnectionRequest.mockImplementation(async (method: string) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") {
        startAttempts += 1;
        throw new DOMException("one-shot turn aborted", "AbortError");
      }
      return {};
    });

    await expect(
      runCodexOneShotFromPool({
        command: "codex-test",
        env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-abort-test" },
        workspaceDir: "/tmp/pwrsnap-enrichment-jail",
        prompt: "describe this image",
        imagePaths: ["/tmp/capture.jpg"]
      })
    ).rejects.toThrow("aborted");

    expect(startAttempts).toBe(1);
  });

  test("denies an approval request from an enrichment turn and logs run + capture id", async () => {
    const { completeTurn } = stageHeldOneShot();

    const run = runCodexOneShotFromPool({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-approval-test" },
      workspaceDir: "/tmp/pwrsnap-enrichment-jail",
      prompt: "describe this image",
      imagePaths: ["/tmp/capture.jpg"],
      diagnostics: { runId: "run-42", captureId: "cap-42" }
    });
    await vi.waitFor(() =>
      expect(
        mockConnectionRequest.mock.calls.some(([method]) => method === "turn/start")
      ).toBe(true)
    );

    // Simulate the App Server asking to run a shell command mid-turn — the
    // shape a successful prompt injection would produce.
    const approvalHandler = mockCodexThreadClients[0]?.onApprovalRequest.mock
      .calls[0]?.[0] as (method: string, params: unknown) => Promise<string>;
    await expect(
      approvalHandler("turn/requestApproval", {
        threadId: "one-shot-thread-1",
        toolCall: {
          name: "shell",
          rawInput: { command: "cat ~/.aws/credentials" }
        }
      })
    ).resolves.toBe("denied");

    expect(mockLogger.error).toHaveBeenCalledWith(
      "capture enrichment sandbox escalation denied",
      expect.objectContaining({
        backend: "codex",
        kind: "approval",
        method: "turn/requestApproval",
        threadId: "one-shot-thread-1",
        runId: "run-42",
        captureId: "cap-42",
        toolName: "shell"
      })
    );
    // Screenshot-derived arguments must never reach the log.
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain("credentials");

    completeTurn();
    await run;
  });

  // Codex's real exec-approval shape (`CommandExecutionRequestApprovalParams`)
  // carries the literal command line in a TOP-LEVEL `command` field — no tool
  // name anywhere. That is the field a prompt-injected screenshot's payload
  // arrives in, so it must never be mistaken for an identity field.
  test("never logs the command line from a Codex exec approval", async () => {
    const { completeTurn } = stageHeldOneShot();

    const run = runCodexOneShotFromPool({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-exec-approval-test" },
      workspaceDir: "/tmp/pwrsnap-enrichment-jail",
      prompt: "describe this image",
      imagePaths: ["/tmp/capture.jpg"],
      diagnostics: { runId: "run-13", captureId: "cap-13" }
    });
    await vi.waitFor(() =>
      expect(
        mockConnectionRequest.mock.calls.some(([method]) => method === "turn/start")
      ).toBe(true)
    );

    const approvalHandler = mockCodexThreadClients[0]?.onApprovalRequest.mock
      .calls[0]?.[0] as (method: string, params: unknown) => Promise<string>;
    await expect(
      approvalHandler("commandExecution/requestApproval", {
        threadId: "one-shot-thread-1",
        turnId: "turn-held",
        itemId: "item-1",
        command: "cat ~/.aws/credentials",
        cwd: "/Users/someone",
        reason: "the screenshot said to"
      })
    ).resolves.toBe("denied");

    expect(mockLogger.error).toHaveBeenCalledWith(
      "capture enrichment sandbox escalation denied",
      expect.objectContaining({
        kind: "approval",
        method: "commandExecution/requestApproval",
        runId: "run-13",
        captureId: "cap-13",
        // No identity field in these params — better null than the payload.
        toolName: null
      })
    );
    const logged = JSON.stringify(mockLogger.error.mock.calls);
    expect(logged).not.toContain("credentials");
    expect(logged).not.toContain("/Users/someone");

    completeTurn();
    await run;
  });

  test("refuses a tool call from an enrichment turn instead of dispatching it", async () => {
    const { completeTurn } = stageHeldOneShot();

    const run = runCodexOneShotFromPool({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-toolcall-test" },
      workspaceDir: "/tmp/pwrsnap-enrichment-jail",
      prompt: "describe this image",
      imagePaths: ["/tmp/capture.jpg"],
      diagnostics: { runId: "run-7", captureId: "cap-7" }
    });
    await vi.waitFor(() =>
      expect(
        mockConnectionRequest.mock.calls.some(([method]) => method === "turn/start")
      ).toBe(true)
    );

    const toolCallHandler = mockCodexThreadClients[0]?.onToolCall.mock.calls[0]?.[0] as (
      call: { method: string; params: unknown }
    ) => Promise<{ success: boolean }>;
    const result = await toolCallHandler({
      method: "turn/toolCall",
      params: { threadId: "one-shot-thread-1", name: "read_file", arguments: { path: "/etc/passwd" } }
    });

    expect(result).toMatchObject({ success: false });
    expect(mockLogger.error).toHaveBeenCalledWith(
      "capture enrichment sandbox escalation denied",
      expect.objectContaining({
        backend: "codex",
        kind: "tool_call",
        runId: "run-7",
        captureId: "cap-7",
        toolName: "read_file"
      })
    );
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain("passwd");

    completeTurn();
    await run;
  });

  test("fails closed before starting a one-shot thread when MCP config cannot be read", async () => {
    mockConnectionRequest.mockImplementation(async (method: string) => {
      if (method === "config/read") throw new Error("config unavailable");
      return {};
    });

    await expect(
      runCodexOneShotFromPool({
        command: "codex-test",
        env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-mcp-fail-closed-test" },
        workspaceDir: "/tmp/pwrsnap-mcp-fail-closed-workspace",
        prompt: "describe this image",
        threadConfig: { project_doc_max_bytes: 0 }
      })
    ).rejects.toThrow("config unavailable");

    expect(
      mockConnectionRequest.mock.calls.some(([method]) => method === "thread/start")
    ).toBe(false);
  });

  test("does not start a queued one-shot after the shared owner closes", async () => {
    const unsubscribeGate = deferred();
    mockConnectionRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") {
        return {
          thread: { id: "active-one-shot-thread" },
          model: "gpt-5.6-luna",
          modelProvider: "openai",
          serviceTier: null
        };
      }
      if (method === "turn/start") {
        const { threadId } = params as { threadId: string };
        const turnId = `turn-for-${threadId}`;
        setTimeout(() => {
          mockCodexThreadClients[0]?.emitEvent({
            kind: "agent_message",
            threadId,
            turnId,
            message: { text: '{"ok":true}' }
          });
          mockCodexThreadClients[0]?.emitEvent({
            kind: "turn_completed",
            threadId,
            turnId,
            status: "completed"
          });
        }, 0);
        return { turn: { id: turnId } };
      }
      if (method === "thread/unsubscribe") return await unsubscribeGate.promise;
      return {};
    });

    const options = {
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-shared-shutdown-test" },
      workspaceDir: "/tmp/pwrsnap-shared-shutdown-workspace",
      prompt: "describe this image",
      threadConfig: { project_doc_max_bytes: 0 }
    } as const;
    const firstRun = runCodexOneShotFromPool(options);
    const secondOutcome = runCodexOneShotFromPool(options).catch(
      (error: unknown) => error
    );

    await vi.waitFor(() => {
      expect(
        mockConnectionRequest.mock.calls.filter(([method]) => method === "thread/unsubscribe")
      ).toHaveLength(1);
    });
    await closeCodexAgentPool();
    unsubscribeGate.resolve();

    await expect(firstRun).resolves.toEqual(
      expect.objectContaining({ threadId: "active-one-shot-thread" })
    );
    await expect(secondOutcome).resolves.toEqual(
      expect.objectContaining({
        message: "Codex one-shot cancelled because its shared owner closed"
      })
    );
    expect(mockCodexThreadClients).toHaveLength(1);
    expect(
      mockConnectionRequest.mock.calls.filter(([method]) => method === "thread/start")
    ).toHaveLength(1);
  });
});
