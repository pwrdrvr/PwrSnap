import { describe, expect, it, vi } from "vitest";
import type { ChatThreadSidecar } from "@pwrsnap/shared";
import type { CommandContext } from "../../command-bus";
import type { ChatThreadStore } from "../chat-thread-store";
import {
  ChatThreadAccess,
  chatMessagesFromJournal,
  chatThreadActorFor,
  chatThreadViewFromSidecar
} from "../chat-thread-access";

function sidecar(
  threadId: string,
  overrides: Partial<ChatThreadSidecar> = {}
): ChatThreadSidecar {
  return {
    schemaVersion: 1,
    threadId,
    name: `Chat ${threadId}`,
    createdAt: "2026-08-23T00:00:00.000Z",
    modifiedAt: "2026-08-23T00:00:00.000Z",
    anchorCaptureId: null,
    focusHistory: [],
    archived: false,
    pinned: false,
    provider: "codex",
    model: "gpt-5.6",
    reasoning: "high",
    ownerClientId: null,
    ...overrides
  };
}

function context(principal: CommandContext["principal"], clientId?: string): CommandContext {
  const ctx: CommandContext = {
    principal,
    signal: new AbortController().signal
  };
  if (clientId !== undefined) {
    ctx.localAgent = { clientId, capabilities: [] };
  }
  return ctx;
}

type FakeStore = {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  readJournal: ReturnType<typeof vi.fn>;
};

function harness(
  overrides: Partial<FakeStore> = {},
  surface: "library" | "sizzle" = "library"
): { access: ChatThreadAccess; store: FakeStore } {
  const store: FakeStore = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    readJournal: vi.fn(async () => []),
    ...overrides
  };
  return {
    store,
    access: new ChatThreadAccess({
      surface,
      store: () => store as unknown as ChatThreadStore,
      loggerScope: `test:${surface}-thread-access`
    })
  };
}

describe("chatThreadActorFor", () => {
  it("always interprets IPC as the exact human NULL owner", () => {
    expect(chatThreadActorFor(context("ipc"))).toEqual({
      ok: true,
      value: { ownerClientId: null }
    });
    // A localAgent-shaped field may not turn an IPC call into MCP ownership.
    expect(chatThreadActorFor(context("ipc", "spoofed-client"))).toEqual({
      ok: true,
      value: { ownerClientId: null }
    });
  });

  it("requires and preserves the authenticated MCP clientId exactly", () => {
    expect(chatThreadActorFor(context("mcp", "client-a"))).toEqual({
      ok: true,
      value: { ownerClientId: "client-a" }
    });
    const missing = chatThreadActorFor(context("mcp"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("thread_owner_missing");
  });
});

describe("ChatThreadAccess authorization", () => {
  it("allows only the exact owner and rejects human/MCP cross-access", async () => {
    const human = sidecar("human");
    const owned = sidecar("owned", { ownerClientId: "client-a" });
    const { access, store } = harness();

    store.get.mockImplementation(async (threadId: string) =>
      threadId === "human" ? human : threadId === "owned" ? owned : null
    );

    await expect(access.require("human", context("ipc"))).resolves.toEqual({
      ok: true,
      value: human
    });
    await expect(access.require("owned", context("mcp", "client-a"))).resolves.toEqual({
      ok: true,
      value: owned
    });

    for (const result of [
      await access.require("owned", context("ipc")),
      await access.require("human", context("mcp", "client-a")),
      await access.require("owned", context("mcp", "client-b"))
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("thread_owner_mismatch");
    }
  });

  it("distinguishes missing threads from cross-surface threads", async () => {
    const { access, store } = harness();
    store.get.mockImplementation(async (threadId: string) =>
      threadId === "sz_other"
        ? sidecar("sz_other", { anchorCaptureId: "sz_project" })
        : null
    );

    const missing = await access.require("missing", context("ipc"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("thread_not_found");

    const wrongSurface = await access.require("sz_other", context("ipc"));
    expect(wrongSurface.ok).toBe(false);
    if (!wrongSurface.ok) expect(wrongSurface.error.code).toBe("thread_surface_mismatch");
  });

  it("fails closed with a sanitized Result when store reads fail", async () => {
    const { access } = harness({
      list: vi.fn(async () => {
        throw new Error("sqlite password-like detail");
      }),
      get: vi.fn(async () => {
        throw new Error("disk path /private/example");
      }),
      readJournal: vi.fn(async () => {
        throw new Error("journal secret");
      })
    });

    const listed = await access.list(context("ipc"));
    const required = await access.require("thread-1", context("ipc"));
    const history = await access.history(sidecar("thread-1"));

    for (const result of [listed, required, history]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("chat_store_unavailable");
        expect(result.error.message).not.toMatch(/password|private|secret/i);
      }
    }
  });
});

describe("ChatThreadAccess store-authoritative reads", () => {
  it("lists from the store and filters exact owner plus surface", async () => {
    const human = sidecar("human", { anchorCaptureId: "cap-1" });
    const ownedA = sidecar("owned-a", {
      anchorCaptureId: "cap-1",
      ownerClientId: "client-a"
    });
    const ownedB = sidecar("owned-b", {
      anchorCaptureId: "cap-1",
      ownerClientId: "client-b"
    });
    const sizzle = sidecar("sz-thread", { anchorCaptureId: "sz_project" });
    const storeList = vi.fn(async () => [human, ownedA, ownedB, sizzle]);
    const { access } = harness({ list: storeList });

    const humanResult = await access.list(context("ipc"), {
      includeArchived: true,
      anchorCaptureId: "cap-1"
    });
    expect(storeList).toHaveBeenLastCalledWith({
      includeArchived: true,
      anchorCaptureId: "cap-1"
    });
    expect(humanResult.ok && humanResult.value.map((item) => item.threadId)).toEqual(["human"]);

    const mcpResult = await access.list(context("mcp", "client-a"));
    expect(mcpResult.ok && mcpResult.value.map((item) => item.threadId)).toEqual(["owned-a"]);
  });

  it("parses store-only journal history without exposing unknown entry shapes", async () => {
    const entries = [
      {
        kind: "message",
        message: { id: "m1", role: "user", text: "hello", createdAt: 1_700_000_000_000 }
      },
      {
        kind: "message",
        message: { id: "m2", role: "assistant", text: "hi" }
      },
      { kind: "tool_call", args: { private: true } },
      { kind: "message", message: { id: "bad", role: "tool", text: "hidden" } },
      null
    ];
    const parsed = chatMessagesFromJournal(entries);

    expect(parsed).toEqual([
      {
        id: "m1",
        role: "user",
        content: [{ kind: "text", text: "hello" }],
        status: "complete",
        createdAt: new Date(1_700_000_000_000).toISOString()
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ kind: "text", text: "hi" }],
        status: "complete",
        createdAt: new Date(0).toISOString()
      }
    ]);

    const { access, store } = harness({ readJournal: vi.fn(async () => entries) });
    const result = await access.history(sidecar("thread-1"));
    expect(store.readJournal).toHaveBeenCalledWith("thread-1");
    expect(result).toEqual({ ok: true, value: parsed });
  });

  it("maps a sidecar to a truthful backend-independent resting view", () => {
    const source = sidecar("thread-1", {
      name: "Persisted",
      anchorCaptureId: "cap-8",
      provider: "acp:gemini",
      model: "gemini-2.5-pro",
      reasoning: "high"
    });
    expect(chatThreadViewFromSidecar(source)).toEqual({
      threadId: "thread-1",
      name: "Persisted",
      createdAt: source.createdAt,
      modifiedAt: source.modifiedAt,
      anchorCaptureId: "cap-8",
      archived: false,
      pinned: false,
      lastMessagePreview: "",
      status: { kind: "idle" },
      provider: "acp:gemini",
      model: "gemini-2.5-pro",
      reasoning: "high",
      pendingApproval: null
    });
  });
});

describe("ChatThreadAccess live routing and create context", () => {
  it("broadcasts only remembered human threads on this surface", () => {
    const { access } = harness();
    expect(access.shouldBroadcastToHuman("unknown")).toBe(false);

    // A live view alone cannot establish ownership.
    access.observeThreadView(chatThreadViewFromSidecar(sidecar("view-only")));
    expect(access.shouldBroadcastToHuman("view-only")).toBe(false);

    access.onThreadCreated(sidecar("human"));
    access.onThreadCreated(sidecar("owned", { ownerClientId: "client-a" }));
    access.onThreadCreated(sidecar("sz_cross", { anchorCaptureId: "sz_project" }));
    access.observeThreadView({
      ...chatThreadViewFromSidecar(sidecar("human", { name: "Live human" })),
      status: { kind: "streaming", turnId: "turn-live" }
    });
    expect(access.shouldBroadcastToHuman("human")).toBe(true);
    expect(access.shouldBroadcastToHuman("owned")).toBe(false);
    expect(access.shouldBroadcastToHuman("sz_cross")).toBe(false);
    expect(access.humanViewForThread("human")?.name).toBe("Live human");
    expect(access.humanViewForThread("human")?.status).toEqual({
      kind: "streaming",
      turnId: "turn-live"
    });
    expect(access.humanViewForThread("owned")).toBeNull();

    access.forget("human");
    expect(access.shouldBroadcastToHuman("human")).toBe(false);
  });

  it("keeps concurrent create owners isolated across awaits", async () => {
    const { access } = harness();
    let releaseA: () => void = () => undefined;
    let releaseB: () => void = () => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const runA = access.runCreate("client-a", async () => {
      expect(access.ownerClientIdForCreate()).toBe("client-a");
      await gateA;
      expect(access.ownerClientIdForCreate()).toBe("client-a");
      return "a";
    });
    const runB = access.runCreate("client-b", async () => {
      expect(access.ownerClientIdForCreate()).toBe("client-b");
      await gateB;
      expect(access.ownerClientIdForCreate()).toBe("client-b");
      return "b";
    });

    expect(access.ownerClientIdForCreate()).toBeNull();
    releaseB();
    releaseA();
    await expect(Promise.all([runA, runB])).resolves.toEqual(["a", "b"]);
    expect(access.ownerClientIdForCreate()).toBeNull();
  });
});
