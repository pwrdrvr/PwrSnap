// In-memory undo/redo stack for capture soft-deletes, behind ⌘Z / Edit ▸ Undo.
//
// Holds only capture ids (a few bytes each), lives for the session, and is
// deliberately independent of the Undo toast — the toast is a quick visible
// affordance for the latest delete, this is the durable history. Bounded so a
// marathon session can't grow without limit; the bound is generous because
// the entries are tiny.
//
// Side-effect-free: callers first peek at the batch they should restore /
// re-trash, run the Result-returning commands, then settle ONLY the ids that
// succeeded. Failed ids stay on the originating stack so a partial failure
// can be retried without replaying the successful mutations.

export class DeleteUndoStack {
  // Each entry is a BATCH of ids deleted by one user action — a single
  // grid/rail delete is a batch of one; "Move N to Trash" from the cart is
  // a batch of N. Undo/redo operate on the whole batch so a bulk delete is
  // one undoable step (and the toast can say "Restore N").
  private undoBatches: DeleteBatch[] = [];
  private redoBatches: DeleteBatch[] = [];
  private nextBatchId = 1;

  constructor(private readonly max = 200) {}

  /** Record a delete batch. Clears the redo stack (a fresh action
   *  invalidates redo) and caps the undo stack at `max`, dropping the
   *  oldest entry. Empty batches are ignored. */
  pushDelete(ids: string[]): void {
    if (ids.length === 0) return;
    const copied = [...new Set(ids)];
    this.undoBatches.push({
      batchId: this.nextBatchId++,
      ids: copied,
      order: copied
    });
    if (this.undoBatches.length > this.max) this.undoBatches.shift();
    this.redoBatches = [];
  }

  /** Return a copy of the most-recent delete batch without consuming it.
   *  The caller must pass successful ids to `settleUndo` after the restore
   *  Results resolve. */
  peekUndo(): string[] | undefined {
    const batch = this.undoBatches.at(-1);
    return batch === undefined ? undefined : [...batch.ids];
  }

  /** Move only successfully restored ids from the current undo batch to the
   *  redo stack. Failed ids remain the next undo batch. */
  settleUndo(succeededIds: readonly string[]): void {
    this.settle(this.undoBatches, this.redoBatches, succeededIds);
  }

  /** Return a copy of the most-recent restore batch without consuming it.
   *  The caller must pass successful ids to `settleRedo` after delete Results
   *  resolve. */
  peekRedo(): string[] | undefined {
    const batch = this.redoBatches.at(-1);
    return batch === undefined ? undefined : [...batch.ids];
  }

  /** Move only successfully re-trashed ids from the current redo batch back
   *  to the undo stack. Failed ids remain the next redo batch. */
  settleRedo(succeededIds: readonly string[]): void {
    this.settle(this.redoBatches, this.undoBatches, succeededIds);
    if (this.undoBatches.length > this.max) this.undoBatches.shift();
  }

  canUndo(): boolean {
    return this.undoBatches.length > 0;
  }

  canRedo(): boolean {
    return this.redoBatches.length > 0;
  }

  private settle(
    from: DeleteBatch[],
    to: DeleteBatch[],
    succeededIds: readonly string[]
  ): void {
    const batch = from.at(-1);
    if (batch === undefined || succeededIds.length === 0) return;

    const succeeded = new Set(succeededIds);
    const moved = batch.ids.filter((id) => succeeded.has(id));
    if (moved.length === 0) return;

    const retained = batch.ids.filter((id) => !succeeded.has(id));
    if (retained.length === 0) from.pop();
    else from[from.length - 1] = { ...batch, ids: retained };

    // A partial action can temporarily exist on both stacks. When its
    // remaining ids later succeed, merge them back into the same logical
    // batch so one original cart delete remains one redo/undo step.
    const existingIndex = this.findBatchIndex(to, batch.batchId);
    if (existingIndex < 0) {
      to.push({ ...batch, ids: moved });
      return;
    }
    const existing = to[existingIndex];
    if (existing === undefined) return;
    const combined = new Set([...existing.ids, ...moved]);
    to[existingIndex] = {
      ...existing,
      ids: batch.order.filter((id) => combined.has(id))
    };
  }

  private findBatchIndex(batches: readonly DeleteBatch[], batchId: number): number {
    for (let index = batches.length - 1; index >= 0; index -= 1) {
      if (batches[index]?.batchId === batchId) return index;
    }
    return -1;
  }
}

type DeleteBatch = {
  readonly batchId: number;
  readonly ids: string[];
  readonly order: string[];
};
