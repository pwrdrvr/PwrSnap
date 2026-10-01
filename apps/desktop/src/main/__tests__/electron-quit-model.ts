/**
 * A model of Electron's quit state machine, for tests that need to know
 * whether a quit actually reaches `quit`. Transcribed from
 * shell/browser/browser.cc and window_list.cc at v41.10.7:
 *
 *   Browser::Quit()             if (is_quitting_) return;
 *                               is_quitting_ = HandleBeforeQuit();
 *                               if (!is_quitting_) return;
 *                               empty ? NotifyAndShutdown() : CloseAllWindows();
 *   Browser::OnWindowAllClosed  is_quitting_ ? NotifyAndShutdown()
 *                                            : emit window-all-closed;
 *   Browser::NotifyAndShutdown  emit will-quit;
 *                               if (prevented) { is_quitting_ = false; return; }
 *                               Shutdown();   // emits quit
 *
 * The part a plain event-emitter fake gets wrong is WHEN microtasks run.
 * An emit that starts from a native task (⌘Q, Dock → Quit, SIGTERM, a
 * window finishing its close) runs a microtask checkpoint as the emit
 * returns — still inside the C++ function, before the assignment after it.
 * An emit reached from JS (`app.quit()` in a click handler) does not; its
 * microtasks wait for that JS to return. The model reproduces both, and
 * the outcomes it predicts match what
 * apps/desktop/scripts/electron-quit-reentry-probe.mjs measures on the real
 * runtime.
 */

type QuitEvent = { preventDefault(): void };
type Listener = (event: QuitEvent) => void;

/** Enough turns to settle any promise chain that does no I/O. */
async function microtaskCheckpoint(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

export class ElectronQuitModel {
  /** Every event emitted, in order. Window closes are `closed:<name>`. */
  readonly emitted: string[] = [];
  exitCode: number | null = null;
  private quitting = false;
  private shutdown = false;
  private readonly windows: Set<string>;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(windows: readonly string[]) {
    this.windows = new Set(windows);
  }

  get hasQuit(): boolean {
    return this.shutdown;
  }

  get windowCount(): number {
    return this.windows.size;
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  /** `app.quit()` called from JavaScript. */
  readonly quit = (): void => {
    if (this.quitting) return;
    this.finishQuit(!this.emit("before-quit"), "js");
  };

  readonly exit = (exitCode = 0): void => {
    this.exitCode = exitCode;
    this.shutdown = true;
  };

  /** `Browser::Quit` run as a native task: ⌘Q, Dock → Quit, SIGTERM. */
  async quitFromNativeTask(): Promise<void> {
    if (this.quitting) return;
    const prevented = this.emit("before-quit");
    await microtaskCheckpoint();
    this.finishQuit(!prevented, "native");
  }

  /** `BrowserWindow.destroy()`: synchronous, no close event. */
  destroyWindow(name: string): void {
    this.removeWindow(name, "js");
  }

  /** Run every pending task, including the ones those tasks queue. */
  async settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private finishQuit(allowed: boolean, origin: "js" | "native"): void {
    this.quitting = allowed;
    if (!allowed) return;
    if (this.windows.size === 0) {
      void this.notifyAndShutdown(origin);
      return;
    }
    for (const name of [...this.windows]) {
      this.emitted.push(`close:${name}`);
      // The renderer unloads, and the window finishes closing on a later
      // native task.
      setImmediate(() => this.removeWindow(name, "native"));
    }
  }

  private removeWindow(name: string, origin: "js" | "native"): void {
    if (!this.windows.delete(name)) return;
    this.emitted.push(`closed:${name}`);
    if (this.windows.size > 0) return;
    if (this.quitting) {
      void this.notifyAndShutdown(origin);
    } else {
      this.emit("window-all-closed");
    }
  }

  private async notifyAndShutdown(origin: "js" | "native"): Promise<void> {
    if (this.shutdown) return;
    const prevented = this.emit("will-quit");
    if (origin === "native") await microtaskCheckpoint();
    if (prevented) {
      this.quitting = false;
      return;
    }
    this.shutdown = true;
    this.emit("quit");
  }

  /** Returns whether a listener called preventDefault(). */
  private emit(name: string): boolean {
    this.emitted.push(name);
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return prevented;
  }
}
