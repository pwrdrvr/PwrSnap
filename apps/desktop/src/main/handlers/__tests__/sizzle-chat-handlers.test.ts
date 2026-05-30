// Sizzle chat verb registration + delegation. Uses a fake controller so
// the eight codex:sizzleChat:* verbs are exercised without a live Codex
// connection or DB. Also pins the unscoped-list guard (a Sizzle list with
// no project anchor must return empty, never the shared table's rows).

import { beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] }
}));

const { bus } = await import("../../command-bus");
const { registerSizzleChatHandlers } = await import("../sizzle-chat-handlers");

const view = {
  threadId: "th1",
  name: "Chat",
  createdAt: "",
  modifiedAt: "",
  anchorCaptureId: "sz_1",
  archived: false,
  pinned: false,
  lastMessagePreview: "",
  status: { kind: "idle" as const }
};

const controller = {
  listThreads: vi.fn(async () => [view]),
  createThread: vi.fn(async () => view),
  sendMessage: vi.fn(async () => ({ turnId: "turn1" })),
  getHistory: vi.fn(async () => []),
  rename: vi.fn(async () => view),
  archive: vi.fn(async () => view),
  interrupt: vi.fn(async () => undefined),
  resolveApproval: vi.fn(async () => undefined)
};

beforeAll(() => {
  registerSizzleChatHandlers({
    controller: controller as never,
    settingsReader: async () => ({}) as never
  });
});

describe("codex:sizzleChat verbs", () => {
  test("list scoped to a project delegates with the anchor", async () => {
    const r = await bus.dispatch(
      "codex:sizzleChat:list",
      { anchorCaptureId: "sz_1" },
      { principal: "ipc" }
    );
    expect(controller.listThreads).toHaveBeenCalledWith({
      includeArchived: false,
      anchorCaptureId: "sz_1"
    });
    expect(r).toEqual({ ok: true, value: { threads: [view] } });
  });

  test("list WITHOUT a project anchor returns empty, never hits the shared table", async () => {
    controller.listThreads.mockClear();
    const r = await bus.dispatch(
      "codex:sizzleChat:list",
      { anchorCaptureId: null },
      { principal: "ipc" }
    );
    expect(r).toEqual({ ok: true, value: { threads: [] } });
    expect(controller.listThreads).not.toHaveBeenCalled();
  });

  test("create delegates to createThread", async () => {
    await bus.dispatch("codex:sizzleChat:create", { anchorCaptureId: "sz_1" }, { principal: "ipc" });
    expect(controller.createThread).toHaveBeenCalledWith({ anchorCaptureId: "sz_1" });
  });

  test("send forwards threadId + text + anchor and returns the turnId", async () => {
    const r = await bus.dispatch(
      "codex:sizzleChat:send",
      { threadId: "th1", text: "make a reel", anchorCaptureId: "sz_1" },
      { principal: "ipc" }
    );
    expect(controller.sendMessage).toHaveBeenCalledWith({
      threadId: "th1",
      text: "make a reel",
      anchorCaptureId: "sz_1"
    });
    expect(r).toEqual({ ok: true, value: { turnId: "turn1" } });
  });

  test("approval forwards the full (threadId, turnId, approvalId, decision)", async () => {
    await bus.dispatch(
      "codex:sizzleChat:approval",
      { threadId: "th1", turnId: "turn1", approvalId: "ap1", decision: "approve" },
      { principal: "ipc" }
    );
    expect(controller.resolveApproval).toHaveBeenCalledWith({
      threadId: "th1",
      turnId: "turn1",
      approvalId: "ap1",
      decision: "approve"
    });
  });

  test("interrupt delegates", async () => {
    await bus.dispatch("codex:sizzleChat:interrupt", { threadId: "th1" }, { principal: "ipc" });
    expect(controller.interrupt).toHaveBeenCalledWith("th1");
  });
});
