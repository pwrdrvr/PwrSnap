import { retryQuitAfterDispatch } from "./quit-retry";

type QuitStallApp = {
  on(
    event: "before-quit" | "will-quit" | "window-all-closed" | "quit",
    listener: () => void
  ): unknown;
  quit(): void;
  exit(exitCode?: number): void;
};

/**
 * Longer than any bounded wait that legitimately sits between the final
 * before-quit pass and `quit`: the recording barrier holds will-quit for at
 * most 15 s, with no window left to show for it.
 */
export const QUIT_STALL_EXIT_MS = 20_000;

/**
 * Safety net under the quit sequence, NOT the fix for a stalled quit. The
 * fix is `retryQuitAfterDispatch` (quit-retry.ts); this exists so that the
 * next way of losing Electron's `is_quitting_` flag costs a log line rather
 * than a force-quit.
 *
 * Armed by a before-quit pass that nothing deferred (`isFinalPass`) and
 * disarmed by `quit`, which Electron emits only once it is really shutting
 * down.
 *
 * - `window-all-closed` while armed, before any will-quit, is the measured
 *   stall signature: Electron emits it in place of will-quit when the last
 *   window closes while it believes it is not quitting. Ask again, from a
 *   macrotask. After a will-quit it means something else: a listener (the
 *   recording barrier) prevented will-quit and owns the retry, and asking
 *   again would run the quit out from under its wait.
 * - If nothing has quit `exitAfterMs` later and no window is left, exit.
 *   That catches the variant with no event at all (a will-quit retry that
 *   lost the flag). If a window IS left, the quit was cancelled — a window
 *   refused to close — and the user is still working, so stand down.
 */
export function installQuitStallRecovery(
  app: QuitStallApp,
  options: {
    isFinalPass: () => boolean;
    hasWindows: () => boolean;
    log: { warn(message: string, data?: Record<string, unknown>): void };
    exitAfterMs?: number;
  }
): void {
  const exitAfterMs = options.exitAfterMs ?? QUIT_STALL_EXIT_MS;
  let armed = false;
  let sawWillQuit = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    armed = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  app.on("before-quit", () => {
    if (!options.isFinalPass()) return;
    disarm();
    armed = true;
    sawWillQuit = false;
    // Referenced on purpose: with no windows left this may be the only
    // thing that can still end the process.
    timer = setTimeout(() => {
      timer = null;
      if (!armed) return;
      if (options.hasWindows()) {
        armed = false;
        return;
      }
      options.log.warn("quit stalled with no windows left; exiting", { waitedMs: exitAfterMs });
      app.exit(0);
    }, exitAfterMs);
  });

  app.on("will-quit", () => {
    sawWillQuit = true;
  });

  app.on("window-all-closed", () => {
    if (!armed || sawWillQuit) return;
    options.log.warn("Electron dropped the quit after the last window closed; quitting again");
    retryQuitAfterDispatch(() => app.quit());
  });

  app.on("quit", disarm);
}
