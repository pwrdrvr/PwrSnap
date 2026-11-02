// One ⌘Z for a surface that edits more than one thing. The video stage
// edits the trim (useVideoTrimRange) and the presenter (usePresenter);
// each keeps its own past and future, and this clock puts them in one
// order.
//
//   • Every entry a stack records is stamped from the shared clock.
//   • Undo takes the stack whose newest past entry is newest overall;
//     redo takes the stack whose next future entry is oldest overall —
//     so a mixed history unwinds and replays in the order it happened.
//   • A fresh edit in any stack clears EVERY stack's future, so history
//     stays one line: undoing a cut and then moving the presenter must
//     not leave the cut waiting on ⇧⌘Z.

export type EditHistorySource = {
  /** Stamp of the entry undo would restore, if any. */
  readonly pastStamp: () => number | undefined;
  /** Stamp of the entry redo would restore, if any. */
  readonly futureStamp: () => number | undefined;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly dropFuture: () => void;
};

export class EditHistory {
  private clock = 0;
  private readonly sources = new Set<EditHistorySource>();

  register(source: EditHistorySource): () => void {
    this.sources.add(source);
    return () => {
      this.sources.delete(source);
    };
  }

  /** A stamp for an entry `origin` is about to record for a new edit.
   *  Every other stack's redo is dropped. */
  stamp(origin: EditHistorySource): number {
    for (const source of this.sources) if (source !== origin) source.dropFuture();
    return ++this.clock;
  }

  private pick(read: (s: EditHistorySource) => number | undefined, newest: boolean): EditHistorySource | null {
    let best: EditHistorySource | null = null;
    let bestStamp = 0;
    for (const source of this.sources) {
      const stamp = read(source);
      if (stamp === undefined) continue;
      if (best === null || (newest ? stamp > bestStamp : stamp < bestStamp)) {
        best = source;
        bestStamp = stamp;
      }
    }
    return best;
  }

  canUndo(): boolean {
    return this.pick((s) => s.pastStamp(), true) !== null;
  }
  canRedo(): boolean {
    return this.pick((s) => s.futureStamp(), false) !== null;
  }
  undo(): void {
    this.pick((s) => s.pastStamp(), true)?.undo();
  }
  redo(): void {
    this.pick((s) => s.futureStamp(), false)?.redo();
  }
}
