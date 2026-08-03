// One-shot runs on the SHARED pooled ACP client. Pinned here:
//
//   • A run is a throwaway session on the pooled client — acquired (never a
//     private spawn), archived afterwards so the app-lifetime client doesn't
//     accumulate dead session state, and the client itself is never closed.
//   • rawText prefers the agent_message_delta stream over the coalesced
//     agent_message: on the shared client the chat strategies' surfaceThoughts
//     quirk folds reasoning prose into the final message, which would bury a
//     JSON reply (the enrichment parser's whole failure mode).
//   • Events from OTHER sessions on the shared process are ignored.
//   • Abort interrupts the in-flight turn; a non-completed turn throws.
//   • listModels reads capabilities from a throwaway session and archives it.
//
// `acquireAcpAgentClient` is mocked — these tests never touch a real pool,
// transport, or process.

import { describe, expect, test, vi } from "vitest";
import type { DiscoveredAcpAgent } from "@pwrdrvr/agent-acp";

const acquireAcpAgentClient = vi.hoisted(() => vi.fn());
vi.mock("../acp-agent-pool", () => ({ acquireAcpAgentClient }));

const { listPooledAcpModels, runPooledAcpOneShot } = await import("../acp-pooled-one-shot");

const AGENT: DiscoveredAcpAgent = {
  strategyId: "gemini",
  backendId: "acp:gemini",
  name: "Gemini CLI",
  command: "/opt/bin/gemini",
  args: ["--acp"],
  env: {},
  discoveredAt: 0
};

type FakeEvent = Record<string, unknown>;

function makeFakeClient(options?: {
  threadId?: string;
  model?: string;
  capabilities?: unknown;
}) {
  const threadId = options?.threadId ?? "th-1";
  const eventCbs = new Set<(event: FakeEvent) => void>();
  const emit = (event: FakeEvent): void => {
    for (const cb of [...eventCbs]) cb(event);
  };
  let capsCb: ((event: { runtimeCapabilities: unknown }) => void) | null = null;
  const client = {
    emit,
    startThread: vi.fn(async (opts?: { model?: string }) => {
      if (options?.capabilities !== undefined) {
        capsCb?.({ runtimeCapabilities: options.capabilities });
      }
      return {
        threadId,
        ...(opts?.model !== undefined
          ? { model: opts.model }
          : options?.model !== undefined
            ? { model: options.model }
            : {}),
        modelProvider: "acp:gemini",
        serviceTier: null
      };
    }),
    onEvent: vi.fn((cb: (event: FakeEvent) => void) => {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    }),
    onRuntimeCapabilities: vi.fn((cb: (event: { runtimeCapabilities: unknown }) => void) => {
      capsCb = cb;
      return () => {
        capsCb = null;
      };
    }),
    startTurn: vi.fn(async () => ({ turnId: "turn-1" })),
    interruptTurn: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
  return client;
}

describe("runPooledAcpOneShot", () => {
  test("runs a throwaway session on the pooled client and archives it", async () => {
    const client = makeFakeClient({ model: "gemini-2.5-flash" });
    client.startTurn.mockImplementation(async () => {
      client.emit({ kind: "agent_message_delta", threadId: "th-1", delta: '{"title":' });
      client.emit({ kind: "agent_message_delta", threadId: "th-1", delta: '"hi"}' });
      client.emit({
        kind: "agent_message",
        threadId: "th-1",
        message: { text: 'Let me think about this…\n\n{"title":"hi"}' }
      });
      client.emit({ kind: "token_usage", threadId: "th-1", usage: { totalTokens: 42 } });
      client.emit({ kind: "turn_completed", threadId: "th-1", status: "completed" });
      return { turnId: "turn-1" };
    });
    acquireAcpAgentClient.mockResolvedValue(client);

    const response = await runPooledAcpOneShot({
      agent: AGENT,
      cwd: "/tmp/Chats/.acp-chat",
      request: { prompt: "describe", imagePaths: ["/tmp/a.png"], effort: "low" }
    });

    expect(acquireAcpAgentClient).toHaveBeenCalledWith(AGENT, "/tmp/Chats/.acp-chat");
    // Deltas win over the coalesced message — the folded-in thought prose
    // ("Let me think…") must NOT reach the caller's JSON parser.
    expect(response.rawText).toBe('{"title":"hi"}');
    expect(response.threadId).toBe("th-1");
    expect(response.turnId).toBe("turn-1");
    expect(response.model).toBe("gemini-2.5-flash");
    expect(response.tokenUsage).toEqual({ totalTokens: 42 });
    // Session dropped, process kept.
    expect(client.archiveThread).toHaveBeenCalledWith("th-1");
    expect(client.close).not.toHaveBeenCalled();
  });

  test("requests the caller's model on session start", async () => {
    const client = makeFakeClient();
    client.startTurn.mockImplementation(async () => {
      client.emit({ kind: "turn_completed", threadId: "th-1", status: "completed" });
      return { turnId: "turn-1" };
    });
    acquireAcpAgentClient.mockResolvedValue(client);

    const response = await runPooledAcpOneShot({
      agent: AGENT,
      cwd: "/cwd",
      request: { prompt: "p", model: "gemini-2.5-pro" }
    });
    expect(client.startThread).toHaveBeenCalledWith({ model: "gemini-2.5-pro" });
    expect(response.model).toBe("gemini-2.5-pro");
  });

  test("ignores events from other sessions on the shared process", async () => {
    const client = makeFakeClient();
    client.startTurn.mockImplementation(async () => {
      client.emit({ kind: "agent_message_delta", threadId: "chat-thread", delta: "chat noise" });
      client.emit({ kind: "agent_message", threadId: "th-1", message: { text: "mine" } });
      client.emit({ kind: "turn_completed", threadId: "chat-thread", status: "failed" });
      client.emit({ kind: "turn_completed", threadId: "th-1", status: "completed" });
      return { turnId: "turn-1" };
    });
    acquireAcpAgentClient.mockResolvedValue(client);

    const response = await runPooledAcpOneShot({
      agent: AGENT,
      cwd: "/cwd",
      request: { prompt: "p" }
    });
    expect(response.rawText).toBe("mine");
  });

  test("a non-completed turn throws and still archives the session", async () => {
    const client = makeFakeClient();
    client.startTurn.mockImplementation(async () => {
      client.emit({ kind: "error", threadId: "th-1", message: "model exploded" });
      client.emit({ kind: "turn_completed", threadId: "th-1", status: "failed" });
      return { turnId: "turn-1" };
    });
    acquireAcpAgentClient.mockResolvedValue(client);

    await expect(
      runPooledAcpOneShot({ agent: AGENT, cwd: "/cwd", request: { prompt: "p" } })
    ).rejects.toThrow("model exploded");
    expect(client.archiveThread).toHaveBeenCalledWith("th-1");
    expect(client.close).not.toHaveBeenCalled();
  });

  test("abort interrupts the in-flight turn", async () => {
    const client = makeFakeClient();
    const abort = new AbortController();
    client.interruptTurn.mockImplementation(async () => {
      client.emit({ kind: "turn_completed", threadId: "th-1", status: "cancelled" });
    });
    // Turn never completes on its own; the abort is what ends it.
    client.startTurn.mockImplementation(async () => {
      queueMicrotask(() => abort.abort());
      return { turnId: "turn-1" };
    });
    acquireAcpAgentClient.mockResolvedValue(client);

    await expect(
      runPooledAcpOneShot({
        agent: AGENT,
        cwd: "/cwd",
        request: { prompt: "p", abortSignal: abort.signal }
      })
    ).rejects.toThrow("cancelled");
    expect(client.interruptTurn).toHaveBeenCalledWith("th-1");
    expect(client.archiveThread).toHaveBeenCalledWith("th-1");
  });

  test("an already-aborted request never opens a session", async () => {
    const client = makeFakeClient();
    acquireAcpAgentClient.mockResolvedValue(client);
    const abort = new AbortController();
    abort.abort();
    await expect(
      runPooledAcpOneShot({
        agent: AGENT,
        cwd: "/cwd",
        request: { prompt: "p", abortSignal: abort.signal }
      })
    ).rejects.toThrow("aborted before start");
    expect(client.startThread).not.toHaveBeenCalled();
  });
});

describe("listPooledAcpModels", () => {
  test("reads advertised models from a throwaway session and archives it", async () => {
    const client = makeFakeClient({
      capabilities: {
        models: {
          availableModels: [
            { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
            { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", isDefault: true }
          ]
        }
      }
    });
    acquireAcpAgentClient.mockResolvedValue(client);

    const models = await listPooledAcpModels({ agent: AGENT, cwd: "/cwd" });
    expect(models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(client.archiveThread).toHaveBeenCalledWith("th-1");
    expect(client.close).not.toHaveBeenCalled();
  });

  test("an agent that advertises nothing yields []", async () => {
    const client = makeFakeClient();
    acquireAcpAgentClient.mockResolvedValue(client);
    const models = await listPooledAcpModels({ agent: AGENT, cwd: "/cwd" });
    expect(models).toEqual([]);
    expect(client.archiveThread).toHaveBeenCalledWith("th-1");
  });
});
