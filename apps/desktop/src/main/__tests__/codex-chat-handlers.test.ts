// Chat verb registration + delegation. Uses a fake chat manager so the
// handlers can be exercised without a live Codex connection or DB.

import { beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp" }
}));

vi.mock("../persistence/db", () => ({
  getDb: () => {
    throw new Error("db not used in chat handler test");
  }
}));

const { bus } = await import("../command-bus");
const { registerCodexHandlers } = await import("../handlers/codex-handlers");

const manager = {
  newSession: vi.fn(async (_projectId: string) => ({
    ok: true as const,
    value: { sessionId: "s1", threadId: "t1" }
  })),
  sendTurn: vi.fn(async () => ({ ok: true as const, value: { turnId: "turn1" } })),
  submitApproval: vi.fn(() => ({ ok: true as const, value: undefined })),
  cancelTurn: vi.fn(() => ({ ok: true as const, value: undefined })),
  closeSession: vi.fn(async () => ({ ok: true as const, value: undefined }))
};

beforeAll(() => {
  registerCodexHandlers({
    clientFactory: () => ({}) as never,
    settingsReader: async () => ({}) as never,
    chatManager: manager as never
  });
});

describe("codex chat verbs", () => {
  test("codex:newSession delegates to manager.newSession", async () => {
    const r = await bus.dispatch("codex:newSession", { projectId: "p1" }, { principal: "ipc" });
    expect(manager.newSession).toHaveBeenCalledWith("p1");
    expect(r).toEqual({ ok: true, value: { sessionId: "s1", threadId: "t1" } });
  });

  test("codex:newSession rejects an empty projectId", async () => {
    const r = await bus.dispatch("codex:newSession", { projectId: "" }, { principal: "ipc" });
    expect(r.ok).toBe(false);
  });

  test("codex:sendTurn forwards sessionId + input", async () => {
    const input = [{ type: "text" as const, text: "hello" }];
    const r = await bus.dispatch("codex:sendTurn", { sessionId: "s1", input }, { principal: "ipc" });
    expect(manager.sendTurn).toHaveBeenCalledWith("s1", input);
    expect(r).toEqual({ ok: true, value: { turnId: "turn1" } });
  });

  test("codex:sendTurn rejects an empty input array", async () => {
    const r = await bus.dispatch("codex:sendTurn", { sessionId: "s1", input: [] }, { principal: "ipc" });
    expect(r.ok).toBe(false);
  });

  test("codex:submitApproval forwards the decision", async () => {
    await bus.dispatch(
      "codex:submitApproval",
      { sessionId: "s1", turnId: "turn1", requestId: "req1", decision: "approve" },
      { principal: "ipc" }
    );
    expect(manager.submitApproval).toHaveBeenCalledWith("s1", "turn1", "req1", "approve");
  });

  test("codex:submitApproval rejects an unknown decision", async () => {
    const r = await bus.dispatch(
      "codex:submitApproval",
      { sessionId: "s1", turnId: "turn1", requestId: "req1", decision: "yolo" as never },
      { principal: "ipc" }
    );
    expect(r.ok).toBe(false);
  });

  test("codex:cancelTurn delegates", async () => {
    await bus.dispatch("codex:cancelTurn", { sessionId: "s1", turnId: "turn1" }, { principal: "ipc" });
    expect(manager.cancelTurn).toHaveBeenCalledWith("s1", "turn1");
  });

  test("codex:closeSession delegates", async () => {
    await bus.dispatch("codex:closeSession", { sessionId: "s1" }, { principal: "ipc" });
    expect(manager.closeSession).toHaveBeenCalledWith("s1");
  });
});
