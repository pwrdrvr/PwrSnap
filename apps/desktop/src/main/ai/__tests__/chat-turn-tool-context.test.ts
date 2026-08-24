import { describe, expect, test } from "vitest";
import { ChatTurnToolContextStore } from "../chat-turn-tool-context";

describe("ChatTurnToolContextStore", () => {
  test("a rejected duplicate cannot replace another window's exact active turn", () => {
    const store = new ChatTurnToolContextStore();
    store.commit("thread-1", "turn-1", { principal: "ipc", sourceWindowId: 101 });

    // A rejected duplicate has no returned turn id, so the handler performs no
    // commit for window 202. The original turn remains bound to window 101.
    expect(store.forToolCall({ threadId: "thread-1", turnId: "turn-1" }))
      .toMatchObject({ sourceWindowId: 101 });
  });

  test("terminal state clears a context and fences a late send result", () => {
    const store = new ChatTurnToolContextStore();
    store.commit("thread-1", "turn-1", { principal: "ipc", sourceWindowId: 101 });
    store.clearTurn("thread-1", "turn-1");
    store.commit("thread-1", "turn-1", { principal: "ipc", sourceWindowId: 202 });

    expect(store.forToolCall({ threadId: "thread-1", turnId: "turn-1" })).toBeUndefined();
  });
});
