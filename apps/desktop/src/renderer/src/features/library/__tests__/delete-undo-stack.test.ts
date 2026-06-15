// Coverage for the session-lived capture-delete undo/redo stack behind
// ⌘Z / Edit ▸ Undo (independent of the time-boxed Undo toast).

import { describe, expect, test } from "vitest";
import { DeleteUndoStack } from "../delete-undo-stack";

describe("DeleteUndoStack", () => {
  test("empty stack: nothing to undo or redo", () => {
    const s = new DeleteUndoStack();
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    expect(s.undo()).toBeUndefined();
    expect(s.redo()).toBeUndefined();
  });

  test("undo restores most-recent first (LIFO)", () => {
    const s = new DeleteUndoStack();
    s.pushDelete("a");
    s.pushDelete("b");
    s.pushDelete("c");
    expect(s.undo()).toBe("c");
    expect(s.undo()).toBe("b");
    expect(s.undo()).toBe("a");
    expect(s.undo()).toBeUndefined();
    expect(s.canUndo()).toBe(false);
  });

  test("redo re-trashes the most-recently undone, in reverse", () => {
    const s = new DeleteUndoStack();
    s.pushDelete("a");
    s.pushDelete("b");
    expect(s.undo()).toBe("b");
    expect(s.undo()).toBe("a");
    expect(s.canRedo()).toBe(true);
    expect(s.redo()).toBe("a");
    expect(s.redo()).toBe("b");
    expect(s.canRedo()).toBe(false);
    // After redoing both, they're undoable again.
    expect(s.undo()).toBe("b");
  });

  test("a fresh delete clears the redo stack", () => {
    const s = new DeleteUndoStack();
    s.pushDelete("a");
    expect(s.undo()).toBe("a"); // redo now has "a"
    expect(s.canRedo()).toBe(true);
    s.pushDelete("b"); // new action invalidates redo
    expect(s.canRedo()).toBe(false);
    expect(s.redo()).toBeUndefined();
  });

  test("the undo stack is capacity-bounded, dropping the oldest", () => {
    const s = new DeleteUndoStack(2);
    s.pushDelete("a");
    s.pushDelete("b");
    s.pushDelete("c"); // "a" drops off
    expect(s.undo()).toBe("c");
    expect(s.undo()).toBe("b");
    expect(s.undo()).toBeUndefined(); // "a" is gone
  });

  test("redo also respects the cap", () => {
    const s = new DeleteUndoStack(1);
    s.pushDelete("a");
    expect(s.undo()).toBe("a");
    expect(s.redo()).toBe("a");
    // Pushing past the cap after a redo keeps only the newest.
    s.pushDelete("b");
    expect(s.undo()).toBe("b");
    expect(s.undo()).toBeUndefined();
  });
});
