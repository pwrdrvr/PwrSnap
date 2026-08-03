// ACP warm-on-first-use call sites. ACP agents are no longer spawned at
// boot — the ONLY production triggers for `warmConfiguredAcpAgentsOnFirstChatUse`
// are the two chat surfaces' controller routers, so any chat verb (the panel
// dispatches `list` on open; an MCP client may go straight to create/send)
// fires the warm-up trigger. These tests pin that wiring: dispatching a chat
// verb on either surface calls the injected trigger, and verbs keep working
// around it.

import { beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] }
}));

const { bus } = await import("../../command-bus");
const { registerLibraryChatHandlers } = await import("../library-chat-handlers");
const { registerSizzleChatHandlers } = await import("../sizzle-chat-handlers");

const kitView = {
  threadId: "th1",
  name: "Chat",
  createdAt: "",
  modifiedAt: "",
  anchorId: "sz_1",
  archived: false,
  pinned: false,
  lastMessagePreview: "",
  status: { kind: "idle" as const }
};

function makeController(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    listThreads: vi.fn(async () => [kitView]),
    createThread: vi.fn(async () => kitView),
    sendMessage: vi.fn(async () => ({ turnId: "turn1" })),
    getHistory: vi.fn(async () => []),
    rename: vi.fn(async () => kitView),
    archive: vi.fn(async () => kitView),
    interrupt: vi.fn(async () => undefined),
    resolveApproval: vi.fn(async () => undefined),
    forkThreadsForAnchor: vi.fn(async () => [])
  };
}

const libraryWarm = vi.fn();
const sizzleWarm = vi.fn();

beforeAll(() => {
  registerLibraryChatHandlers({
    controller: makeController() as never,
    settingsReader: async () => ({}) as never,
    warmAcpAgentsOnFirstUse: libraryWarm
  });
  registerSizzleChatHandlers({
    controller: makeController() as never,
    settingsReader: async () => ({}) as never,
    warmAcpAgentsOnFirstUse: sizzleWarm
  });
});

describe("chat surfaces trigger ACP warm-on-first-use", () => {
  test("library surface: list (panel open) fires the trigger", async () => {
    expect(libraryWarm).not.toHaveBeenCalled();
    const r = await bus.dispatch("codex:libraryChat:list", {}, { principal: "ipc" });
    expect(r.ok).toBe(true);
    expect(libraryWarm).toHaveBeenCalled();
  });

  test("library surface: send also routes through the trigger", async () => {
    libraryWarm.mockClear();
    const r = await bus.dispatch(
      "codex:libraryChat:send",
      { threadId: "th1", text: "hi" },
      { principal: "ipc" }
    );
    expect(r.ok).toBe(true);
    expect(libraryWarm).toHaveBeenCalled();
  });

  test("sizzle surface: list fires the trigger", async () => {
    expect(sizzleWarm).not.toHaveBeenCalled();
    const r = await bus.dispatch(
      "codex:sizzleChat:list",
      { anchorCaptureId: "sz_1" },
      { principal: "ipc" }
    );
    expect(r.ok).toBe(true);
    expect(sizzleWarm).toHaveBeenCalled();
  });

  test("sizzle surface: send also routes through the trigger", async () => {
    sizzleWarm.mockClear();
    const r = await bus.dispatch(
      "codex:sizzleChat:send",
      { threadId: "th1", text: "hi" },
      { principal: "ipc" }
    );
    expect(r.ok).toBe(true);
    expect(sizzleWarm).toHaveBeenCalled();
  });
});
