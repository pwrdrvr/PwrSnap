/**
 * Which window a Dock click (`app.on("activate")`) or a relaunch
 * (`second-instance`) brings back.
 *
 * The rule: the app window the user focused most recently. Before this,
 * both paths always raised the Library, so a user who had Settings (or
 * Sizzle Reels, Logs, a document window) in front, switched to another
 * app, and clicked the Dock icon got the Library on top of the window
 * they were using. macOS had already restored the right key window; our
 * `library.focus()` then overrode it.
 *
 * Only DESTINATION windows are recorded (the ones `listOpenAppWindows`
 * names). Chrome such as the focus sink, tray popover and float-over can
 * take key too — the focus sink is a focusable non-activating panel that
 * holds key during captures — and must never be what a Dock click raises.
 *
 * Kept free of Electron so the ordering can be model-tested.
 */
export type ActivateWindowState = "visible" | "minimized" | "hidden" | "gone";

export class AppWindowFocusOrder<W> {
  /** Most recently focused first. */
  private order: W[] = [];

  /** Returns true when the window was not already remembered. */
  noteFocused(window: W): boolean {
    const index = this.order.indexOf(window);
    if (index !== -1) this.order.splice(index, 1);
    this.order.unshift(window);
    return index === -1;
  }

  forget(window: W): void {
    const index = this.order.indexOf(window);
    if (index !== -1) this.order.splice(index, 1);
  }

  /**
   * The most recently focused window that is on screen. When every
   * remembered window is minimized, the most recent minimized one (the
   * caller restores it). Hidden windows are skipped; gone windows are
   * dropped. `null` means nothing remembered is available and the caller
   * falls back to the Library.
   */
  pickForActivate(stateOf: (window: W) => ActivateWindowState): W | null {
    const states = this.order.map((window) => ({ window, state: stateOf(window) }));
    this.order = states.filter(({ state }) => state !== "gone").map(({ window }) => window);
    return (
      states.find(({ state }) => state === "visible")?.window ??
      states.find(({ state }) => state === "minimized")?.window ??
      null
    );
  }

  /** Test/diagnostic view of the current order, most recent first. */
  snapshot(): readonly W[] {
    return [...this.order];
  }
}
