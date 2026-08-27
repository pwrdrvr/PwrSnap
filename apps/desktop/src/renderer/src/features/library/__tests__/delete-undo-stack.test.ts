// Coverage for the session-lived capture-delete undo/redo stack behind
// ⌘Z / Edit ▸ Undo (independent of the time-boxed Undo toast). Entries are
// BATCHES — a single delete is a batch of one; a cart "Move N to Trash" is
// a batch of N, undone/redone as one step. Peeking never consumes an entry:
// only ids whose Result succeeded are settled onto the opposite stack.

import { describe, expect, test } from "vitest";
import { DeleteUndoStack } from "../delete-undo-stack";

describe("DeleteUndoStack", () => {
  test("empty stack has nothing to peek or settle", () => {
    const stack = new DeleteUndoStack();

    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(false);
    expect(stack.peekUndo()).toBeUndefined();
    expect(stack.peekRedo()).toBeUndefined();

    stack.settleUndo(["missing"]);
    stack.settleRedo(["missing"]);
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(false);
  });

  test("successful undo and redo settle a bulk batch as one step", () => {
    const stack = new DeleteUndoStack();
    stack.pushDelete(["a", "b", "c"]);

    expect(stack.peekUndo()).toEqual(["a", "b", "c"]);
    // Peeking is deliberately non-consuming while commands are pending.
    expect(stack.peekUndo()).toEqual(["a", "b", "c"]);
    stack.settleUndo(["a", "b", "c"]);

    expect(stack.canUndo()).toBe(false);
    expect(stack.peekRedo()).toEqual(["a", "b", "c"]);
    stack.settleRedo(["a", "b", "c"]);

    expect(stack.canRedo()).toBe(false);
    expect(stack.peekUndo()).toEqual(["a", "b", "c"]);
  });

  test("undo settles batches in LIFO order", () => {
    const stack = new DeleteUndoStack();
    stack.pushDelete(["a"]);
    stack.pushDelete(["b"]);
    stack.pushDelete(["c"]);

    expect(stack.peekUndo()).toEqual(["c"]);
    stack.settleUndo(["c"]);
    expect(stack.peekUndo()).toEqual(["b"]);
    stack.settleUndo(["b"]);
    expect(stack.peekUndo()).toEqual(["a"]);
    stack.settleUndo(["a"]);
    expect(stack.peekUndo()).toBeUndefined();

    // Redo reverses the sequence of successful undos.
    expect(stack.peekRedo()).toEqual(["a"]);
    stack.settleRedo(["a"]);
    expect(stack.peekRedo()).toEqual(["b"]);
    stack.settleRedo(["b"]);
    expect(stack.peekRedo()).toEqual(["c"]);
  });

  test("an all-failed undo remains available and creates no redo entry", () => {
    const stack = new DeleteUndoStack();
    stack.pushDelete(["a", "b"]);

    stack.settleUndo([]);
    expect(stack.peekUndo()).toEqual(["a", "b"]);
    expect(stack.peekRedo()).toBeUndefined();

    // Results for ids outside the current batch must not consume it either.
    stack.settleUndo(["not-in-the-batch"]);
    expect(stack.peekUndo()).toEqual(["a", "b"]);
    expect(stack.peekRedo()).toBeUndefined();
  });

  test("an all-failed redo remains available and creates no undo entry", () => {
    const stack = new DeleteUndoStack();
    stack.pushDelete(["a", "b"]);
    stack.settleUndo(["a", "b"]);

    stack.settleRedo([]);
    expect(stack.peekRedo()).toEqual(["a", "b"]);
    expect(stack.peekUndo()).toBeUndefined();

    stack.settleRedo(["not-in-the-batch"]);
    expect(stack.peekRedo()).toEqual(["a", "b"]);
    expect(stack.peekUndo()).toBeUndefined();
  });

  test("partial undo retains failures and moves only successes to redo", () => {
    const stack = new DeleteUndoStack();
    stack.pushDelete(["a", "b", "c"]);

    stack.settleUndo(["a", "c"]);

    expect(stack.peekUndo()).toEqual(["b"]);
    expect(stack.peekRedo()).toEqual(["a", "c"]);
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(true);
  });

  test("retrying a partial undo merges the original bulk action in original order", () => {
    const stack = new DeleteUndoStack();
    stack.pushDelete(["a", "b", "c", "d"]);

    stack.settleUndo(["d", "b"]);
    expect(stack.peekUndo()).toEqual(["a", "c"]);
    expect(stack.peekRedo()).toEqual(["b", "d"]);

    stack.settleUndo(["c", "a"]);
    expect(stack.peekUndo()).toBeUndefined();
    expect(stack.peekRedo()).toEqual(["a", "b", "c", "d"]);

    // It is still one logical redo step, not one entry per retry.
    stack.settleRedo(["a", "b", "c", "d"]);
    expect(stack.peekRedo()).toBeUndefined();
    expect(stack.peekUndo()).toEqual(["a", "b", "c", "d"]);
  });

  test("partial redo retains failures and retry merges the original bulk action", () => {
    const stack = new DeleteUndoStack();
    stack.pushDelete(["a", "b", "c", "d"]);
    stack.settleUndo(["a", "b", "c", "d"]);

    stack.settleRedo(["d", "b"]);
    expect(stack.peekRedo()).toEqual(["a", "c"]);
    expect(stack.peekUndo()).toEqual(["b", "d"]);

    stack.settleRedo(["c", "a"]);
    expect(stack.peekRedo()).toBeUndefined();
    expect(stack.peekUndo()).toEqual(["a", "b", "c", "d"]);

    // The merged batch remains one logical undo step.
    stack.settleUndo(["a", "b", "c", "d"]);
    expect(stack.peekUndo()).toBeUndefined();
    expect(stack.peekRedo()).toEqual(["a", "b", "c", "d"]);
  });

  test("redo immediately after a partial undo neither duplicates nor loses ids", () => {
    const stack = new DeleteUndoStack();
    stack.pushDelete(["a", "b", "c"]);

    // a and c are live; b remains trashed.
    stack.settleUndo(["a", "c"]);
    expect(stack.peekUndo()).toEqual(["b"]);
    expect(stack.peekRedo()).toEqual(["a", "c"]);

    // Re-trash the successful subset before retrying b. All three are now
    // trashed again and must recombine into exactly one original batch.
    stack.settleRedo(["a", "c"]);
    expect(stack.peekRedo()).toBeUndefined();
    expect(stack.peekUndo()).toEqual(["a", "b", "c"]);

    stack.settleUndo(["a", "b", "c"]);
    expect(stack.peekUndo()).toBeUndefined();
    expect(stack.peekRedo()).toEqual(["a", "b", "c"]);
  });

  test("settling history preserves redo until a fresh non-empty delete", () => {
    const stack = new DeleteUndoStack();
    stack.pushDelete(["a"]);
    stack.pushDelete(["b"]);

    stack.settleUndo(["b"]);
    expect(stack.peekRedo()).toEqual(["b"]);
    stack.settleUndo(["a"]);
    expect(stack.peekRedo()).toEqual(["a"]);

    // Empty input is not a new action and must not invalidate redo.
    stack.pushDelete([]);
    expect(stack.peekRedo()).toEqual(["a"]);

    stack.pushDelete(["c"]);
    expect(stack.canRedo()).toBe(false);
    expect(stack.peekRedo()).toBeUndefined();
    expect(stack.peekUndo()).toEqual(["c"]);
  });

  test("the undo stack is capacity-bounded, dropping the oldest batch", () => {
    const stack = new DeleteUndoStack(2);
    stack.pushDelete(["a"]);
    stack.pushDelete(["b"]);
    stack.pushDelete(["c"]);

    expect(stack.peekUndo()).toEqual(["c"]);
    stack.settleUndo(["c"]);
    expect(stack.peekUndo()).toEqual(["b"]);
    stack.settleUndo(["b"]);
    expect(stack.peekUndo()).toBeUndefined();
  });

  test("push and peek copy ids and duplicate ids are recorded once", () => {
    const stack = new DeleteUndoStack();
    const ids = ["a", "b", "a", "c", "b"];
    stack.pushDelete(ids);

    ids.push("d");
    const peeked = stack.peekUndo();
    expect(peeked).toEqual(["a", "b", "c"]);

    peeked?.push("e");
    expect(stack.peekUndo()).toEqual(["a", "b", "c"]);
  });
});
