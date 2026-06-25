// Coverage for the session-lived capture-delete undo/redo stack behind
// ⌘Z / Edit ▸ Undo (independent of the time-boxed Undo toast). Entries are
// BATCHES — a single delete is a batch of one; a cart "Move N to Trash" is
// a batch of N, undone/redone as one step.

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

  test("empty batch is ignored", () => {
    const s = new DeleteUndoStack();
    s.pushDelete([]);
    expect(s.canUndo()).toBe(false);
  });

  test("undo restores most-recent batch first (LIFO)", () => {
    const s = new DeleteUndoStack();
    s.pushDelete(["a"]);
    s.pushDelete(["b"]);
    s.pushDelete(["c"]);
    expect(s.undo()).toEqual(["c"]);
    expect(s.undo()).toEqual(["b"]);
    expect(s.undo()).toEqual(["a"]);
    expect(s.undo()).toBeUndefined();
    expect(s.canUndo()).toBe(false);
  });

  test("a bulk batch undoes/redoes as one step", () => {
    const s = new DeleteUndoStack();
    s.pushDelete(["a"]);
    s.pushDelete(["x", "y", "z"]); // a cart "Move 3 to Trash"
    expect(s.undo()).toEqual(["x", "y", "z"]); // one undo restores all three
    expect(s.undo()).toEqual(["a"]);
    expect(s.redo()).toEqual(["a"]);
    expect(s.redo()).toEqual(["x", "y", "z"]);
    expect(s.canRedo()).toBe(false);
  });

  test("redo re-trashes the most-recently undone batch, in reverse", () => {
    const s = new DeleteUndoStack();
    s.pushDelete(["a"]);
    s.pushDelete(["b"]);
    expect(s.undo()).toEqual(["b"]);
    expect(s.undo()).toEqual(["a"]);
    expect(s.canRedo()).toBe(true);
    expect(s.redo()).toEqual(["a"]);
    expect(s.redo()).toEqual(["b"]);
    expect(s.canRedo()).toBe(false);
    expect(s.undo()).toEqual(["b"]);
  });

  test("a fresh delete clears the redo stack", () => {
    const s = new DeleteUndoStack();
    s.pushDelete(["a"]);
    expect(s.undo()).toEqual(["a"]);
    expect(s.canRedo()).toBe(true);
    s.pushDelete(["b"]); // new action invalidates redo
    expect(s.canRedo()).toBe(false);
    expect(s.redo()).toBeUndefined();
  });

  test("the undo stack is capacity-bounded, dropping the oldest batch", () => {
    const s = new DeleteUndoStack(2);
    s.pushDelete(["a"]);
    s.pushDelete(["b"]);
    s.pushDelete(["c"]); // "a" drops off
    expect(s.undo()).toEqual(["c"]);
    expect(s.undo()).toEqual(["b"]);
    expect(s.undo()).toBeUndefined();
  });

  test("pushed batches are copied (caller mutation doesn't corrupt history)", () => {
    const s = new DeleteUndoStack();
    const ids = ["a", "b"];
    s.pushDelete(ids);
    ids.push("c");
    expect(s.undo()).toEqual(["a", "b"]);
  });
});
