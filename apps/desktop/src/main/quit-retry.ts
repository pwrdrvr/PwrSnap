/**
 * Re-issue a quit that a `before-quit` or `will-quit` listener deferred.
 *
 * Always from a fresh macrotask, never from the promise chain that settled
 * the deferral. Electron's quit state machine (shell/browser/browser.cc,
 * verified on 41.10.7) is:
 *
 *   Browser::Quit():           if (is_quitting_) return;
 *                              is_quitting_ = HandleBeforeQuit();   // emits before-quit
 *   Browser::NotifyAndShutdown(): emits will-quit;
 *                              if (prevented) is_quitting_ = false;
 *
 * and an emit that starts from a native task — ⌘Q (`terminate:`), Dock →
 * Quit, SIGTERM, and EVERY will-quit, which is emitted when the last window
 * finishes closing — runs a microtask checkpoint as the emit returns, which
 * is still inside those functions. A retry that settles in microtasks
 * therefore runs nested inside the pass it is retrying:
 *
 * - from before-quit: the nested pass sets `is_quitting_ = true` and starts
 *   closing windows, then the outer pass returns and writes `false` over
 *   it. The Library finishes closing with Electron believing it is not
 *   quitting, so it emits `window-all-closed` instead of `will-quit`, and
 *   with no window left nothing ever asks again.
 * - from will-quit: the nested `Browser::Quit()` sees `is_quitting_` still
 *   true and returns at once; the outer pass then sets it false. No windows,
 *   no event, no quit.
 *
 * Both were measured with `scripts/electron-quit-reentry-probe.mjs`.
 * A macrotask cannot run until the outer pass has returned, so the retry
 * always starts from a settled state.
 */
export function retryQuitAfterDispatch(quit: () => void): void {
  setImmediate(quit);
}
