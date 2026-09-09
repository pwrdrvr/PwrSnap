export type InteractiveSelectionCleanup = {
  hideSelector(): void;
  releaseSnapshot(): Promise<void>;
};

/**
 * Transfers ownership of a selector snapshot and guarantees that both the
 * overlay and registry entry are retired exactly once. Callers may clean up
 * eagerly before starting their expensive work; the finally is the backstop
 * for storage checks, focus work, dispatch, and any unexpected throw.
 */
export async function withInteractiveSelectionCleanup<T>(options: {
  snapshotId: string | undefined;
  hideSelector: () => void;
  releaseSnapshot: (snapshotId: string) => Promise<void>;
  run: (cleanup: InteractiveSelectionCleanup) => Promise<T>;
}): Promise<T> {
  let selectorHidden = false;
  let snapshotReleased = false;
  const cleanup: InteractiveSelectionCleanup = {
    hideSelector(): void {
      if (selectorHidden) return;
      selectorHidden = true;
      options.hideSelector();
    },
    async releaseSnapshot(): Promise<void> {
      if (options.snapshotId === undefined || snapshotReleased) return;
      snapshotReleased = true;
      await options.releaseSnapshot(options.snapshotId);
    }
  };

  try {
    return await options.run(cleanup);
  } finally {
    // The selector should disappear immediately even if registry cleanup is
    // slow. A hide failure must not prevent release of a retained NativeImage.
    try {
      cleanup.hideSelector();
    } finally {
      await cleanup.releaseSnapshot();
    }
  }
}
