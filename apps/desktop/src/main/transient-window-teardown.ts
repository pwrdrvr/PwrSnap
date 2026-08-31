type BeforeQuitRegistrar = {
  on(event: "before-quit", listener: () => void): unknown;
};

export type TransientWindowDisposers = Readonly<{
  disposeTray: () => void;
  disposeFloatOver: () => void;
  disposeRecordingController: () => void;
  disposeRegionSelector: () => void;
  disposeFocusSink: () => void;
  destroyTextBakePool: () => void;
}>;

/**
 * Destroy non-document BrowserWindows before Electron begins its normal
 * window-close pass. The Library is deliberately absent: it stays on the
 * ordinary graceful close path so app.quit() semantics remain intact.
 *
 * Returns the same idempotent disposer for a defensive will-quit call.
 */
export function installTransientWindowTeardown(
  app: BeforeQuitRegistrar,
  disposers: TransientWindowDisposers,
  options: { shouldDisposeOnBeforeQuit?: () => boolean } = {}
): () => void {
  let disposed = false;
  const disposeTransientWindows = (): void => {
    if (disposed) return;
    disposed = true;
    disposers.disposeTray();
    disposers.disposeFloatOver();
    disposers.disposeRecordingController();
    disposers.disposeRegionSelector();
    disposers.disposeFocusSink();
    disposers.destroyTextBakePool();
  };

  app.on("before-quit", () => {
    if (options.shouldDisposeOnBeforeQuit?.() === false) return;
    disposeTransientWindows();
  });
  return disposeTransientWindows;
}
