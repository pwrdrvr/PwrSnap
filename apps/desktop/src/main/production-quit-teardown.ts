type QuitEvent = {
  preventDefault(): void;
};

export type ProductionQuitLifecycle = {
  onWillQuit(listener: (event: QuitEvent) => void): void;
  quit(): void;
};

export type ProductionQuitTeardownDependencies = {
  isRecordingActive(): boolean;
  cancelRecording(): Promise<void>;
  warnRecordingCancelFailure(cause: unknown): void;
  unregisterGlobalShortcuts(): void;
  stopLibraryProcess(): void;
  disposeCodexProfileHandlers(): void;
  disposeTransientWindows(): void;
  disposeIpcDispatcher(): void;
  stopToolRpcServer(): Promise<void>;
  closeAcpAgentPool(): Promise<void>;
  closeCodexAgentPool(): Promise<void>;
  disposeLocalAgentMcpSettingsListener(): void;
  disableLocalAgentMcpLifecycle(): void;
  denyLocalAgentConsent(): void;
  shutdownCompositeThumbnailWorker(): void;
  cancelScheduledRepacks(): void;
  closeDatabase(): void;
};

/**
 * Install the production graceful-quit path before any bootstrap branch can
 * call app.quit(). The packaged Windows smoke intentionally uses this exact
 * path rather than a test-only cleanup seam.
 */
export function installProductionQuitTeardown(
  lifecycle: ProductionQuitLifecycle,
  dependencies: ProductionQuitTeardownDependencies
): void {
  // Track whether we've already initiated the recording-cancel teardown so we
  // do not loop when app.quit() retries after cancellation completes.
  let recordingCancelInFlight = false;
  lifecycle.onWillQuit((event) => {
    // A recorder child must be cancelled before the rest of teardown. Retry
    // app.quit() afterward so the ordinary path below still runs in full.
    if (dependencies.isRecordingActive() && !recordingCancelInFlight) {
      recordingCancelInFlight = true;
      event.preventDefault();
      void dependencies
        .cancelRecording()
        .catch((cause: unknown) => {
          dependencies.warnRecordingCancelFailure(cause);
        })
        .finally(() => {
          lifecycle.quit();
        });
      return;
    }

    dependencies.unregisterGlobalShortcuts();
    dependencies.stopLibraryProcess();
    dependencies.disposeCodexProfileHandlers();
    dependencies.disposeTransientWindows();
    dependencies.disposeIpcDispatcher();
    void dependencies.stopToolRpcServer().catch(() => undefined);
    void dependencies.closeAcpAgentPool().catch(() => undefined);
    void dependencies.closeCodexAgentPool().catch(() => undefined);
    dependencies.disposeLocalAgentMcpSettingsListener();
    dependencies.disableLocalAgentMcpLifecycle();
    dependencies.denyLocalAgentConsent();
    dependencies.shutdownCompositeThumbnailWorker();
    // Repack timers consult SQLite, so cancel them before closing the DB.
    dependencies.cancelScheduledRepacks();
    dependencies.closeDatabase();
  });
}
