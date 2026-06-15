// In-memory undo/redo stack for capture soft-deletes, behind ⌘Z / Edit ▸ Undo.
//
// Holds only capture ids (a few bytes each), lives for the session, and is
// deliberately independent of the Undo toast — the toast is a quick visible
// affordance for the latest delete, this is the durable history. Bounded so a
// marathon session can't grow without limit; the bound is generous because
// the entries are tiny.
//
// Side-effect-free: methods return the id the caller should restore / re-trash
// (via library:restore / library:delete) and do the bookkeeping; the actual
// dispatch stays in the Library so this stays trivially unit-testable.

export class DeleteUndoStack {
  private undoIds: string[] = [];
  private redoIds: string[] = [];

  constructor(private readonly max = 200) {}

  /** Record a delete. Clears the redo stack (a fresh action invalidates redo)
   *  and caps the undo stack at `max`, dropping the oldest entry. */
  pushDelete(id: string): void {
    this.undoIds.push(id);
    if (this.undoIds.length > this.max) this.undoIds.shift();
    this.redoIds = [];
  }

  /** Pop the most-recent delete onto the redo stack; returns the id to
   *  restore, or undefined if there's nothing to undo. */
  undo(): string | undefined {
    const id = this.undoIds.pop();
    if (id === undefined) return undefined;
    this.redoIds.push(id);
    return id;
  }

  /** Pop the most-recent restore back onto the undo stack; returns the id to
   *  re-trash, or undefined if there's nothing to redo. */
  redo(): string | undefined {
    const id = this.redoIds.pop();
    if (id === undefined) return undefined;
    this.undoIds.push(id);
    if (this.undoIds.length > this.max) this.undoIds.shift();
    return id;
  }

  canUndo(): boolean {
    return this.undoIds.length > 0;
  }

  canRedo(): boolean {
    return this.redoIds.length > 0;
  }
}
