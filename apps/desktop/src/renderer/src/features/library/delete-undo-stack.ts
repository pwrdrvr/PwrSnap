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
  // Each entry is a BATCH of ids deleted by one user action — a single
  // grid/rail delete is a batch of one; "Move N to Trash" from the cart is
  // a batch of N. Undo/redo operate on the whole batch so a bulk delete is
  // one undoable step (and the toast can say "Restore N").
  private undoBatches: string[][] = [];
  private redoBatches: string[][] = [];

  constructor(private readonly max = 200) {}

  /** Record a delete batch. Clears the redo stack (a fresh action
   *  invalidates redo) and caps the undo stack at `max`, dropping the
   *  oldest entry. Empty batches are ignored. */
  pushDelete(ids: string[]): void {
    if (ids.length === 0) return;
    this.undoBatches.push([...ids]);
    if (this.undoBatches.length > this.max) this.undoBatches.shift();
    this.redoBatches = [];
  }

  /** Pop the most-recent delete batch onto the redo stack; returns the ids
   *  to restore, or undefined if there's nothing to undo. */
  undo(): string[] | undefined {
    const batch = this.undoBatches.pop();
    if (batch === undefined) return undefined;
    this.redoBatches.push(batch);
    return batch;
  }

  /** Pop the most-recent restore batch back onto the undo stack; returns the
   *  ids to re-trash, or undefined if there's nothing to redo. */
  redo(): string[] | undefined {
    const batch = this.redoBatches.pop();
    if (batch === undefined) return undefined;
    this.undoBatches.push(batch);
    if (this.undoBatches.length > this.max) this.undoBatches.shift();
    return batch;
  }

  canUndo(): boolean {
    return this.undoBatches.length > 0;
  }

  canRedo(): boolean {
    return this.redoBatches.length > 0;
  }
}
