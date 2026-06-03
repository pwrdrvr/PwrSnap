// Sizzle chat verb registration + delegation. Uses a fake (kit-shaped)
// controller so the eight codex:sizzleChat:* verbs are exercised without a
// live Codex connection or DB. Also pins the unscoped-list guard (a Sizzle
// list with no project anchor must return empty, never the shared table's
// rows).
//
// Post-migration wiring: the controller is now the kit's `ChatThreadController`
// — it speaks `anchorId` (not `anchorCaptureId`) and the neutral approval
// decision `"approved" | "denied" | "abort"`. The verbs translate the wire
// payloads at the boundary: `anchorCaptureId → anchorId` on the way in,
// `NormalizedThreadView → LibraryChatThreadView` (anchorId → anchorCaptureId)
// on the way out, and `ChatApprovalDecision → NormalizedApprovalDecision`.

import { beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] }
}));

const { bus } = await import("../../command-bus");
const { registerSizzleChatHandlers } = await import("../sizzle-chat-handlers");

/** What the kit controller returns: a `NormalizedThreadView` (anchorId). */
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

/** What the renderer expects back over IPC: a `LibraryChatThreadView`
 *  (anchorCaptureId). */
const rendererView = {
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
  listThreads: vi.fn(async () => [kitView]),
  createThread: vi.fn(async () => kitView),
  sendMessage: vi.fn(async () => ({ turnId: "turn1" })),
  getHistory: vi.fn(async () => []),
  rename: vi.fn(async () => kitView),
  archive: vi.fn(async () => kitView),
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
      anchorId: "sz_1"
    });
    expect(r).toEqual({ ok: true, value: { threads: [rendererView] } });
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
    expect(controller.createThread).toHaveBeenCalledWith({ anchorId: "sz_1" });
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
      anchorId: "sz_1"
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
      // "approve" maps to the kit's neutral "approved" at the boundary.
      decision: "approved"
    });
  });

  test("interrupt delegates", async () => {
    await bus.dispatch("codex:sizzleChat:interrupt", { threadId: "th1" }, { principal: "ipc" });
    expect(controller.interrupt).toHaveBeenCalledWith("th1");
  });
});
