/*!
 * Adapted from DiskHound diagnostics shutdown (huntharo/diskhound@3877cdd).
 *
 * MIT License
 *
 * Copyright (c) 2026 Thomas Zarebczan
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { retryQuitAfterDispatch } from "../quit-retry";

/** Keep diagnostic targets alive while flushing, with one deadline per quit. */
export function createDiagnosticsShutdown(options: {
  stop: () => void | Promise<unknown>;
  resumeQuit: () => void;
  warn: (message: string) => void;
  /**
   * Whether anything is recording that a flush would have to save. When
   * this says no, quit is not deferred at all: `stop()` still runs (it
   * latches the targets' shutting-down flags) but nothing waits on it, so
   * the common quit is one before-quit pass instead of two. Omitted means
   * always defer.
   */
  hasPendingWork?: () => boolean;
}) {
  let complete = false;
  let resumingQuit = false;
  let updateOwnsQuit = false;
  let pending: Promise<void> | null = null;
  let installing: Promise<void> | null = null;
  let startedAt: number | undefined;

  const flush = (): Promise<void> => {
    startedAt ??= Date.now();
    pending ??= new Promise<void>((resolve) => {
      const finish = (reason?: "timeout" | "error", error?: unknown): void => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        try {
          if (reason === "timeout") {
            options.warn("diagnostics shutdown exceeded 10000 ms; continuing quit");
          } else if (reason === "error") {
            options.warn(
              `diagnostics shutdown failed: ${error instanceof Error ? error.message : String(error)}; continuing quit`
            );
          }
        } catch {
          // Neither error formatting nor a failing logger may hold quit open.
        }
        resolve();
      };
      // Referenced deliberately: release quit even with no remaining windows.
      // This bounds asynchronous hangs, not a blocked JavaScript event loop.
      const timer = setTimeout(() => finish("timeout"), 10_000);
      void Promise.resolve().then(options.stop).then(
        () => finish(),
        (error: unknown) => finish("error", error)
      );
    });
    return pending;
  };

  return {
    flush,
    /** Other quit barriers spend the same elapsed time, not a serial budget. */
    remainingQuitTime(timeoutMs: number): number {
      return Math.max(0, timeoutMs - (Date.now() - (startedAt ?? Date.now())));
    },
    beforeQuit(event: { preventDefault(): void }): boolean {
      // A failed install may leave the app running after diagnostics stopped.
      // The next quit still needs its own recording-finalization budget.
      startedAt ??= Date.now();
      if (complete) return false;
      if (!resumingQuit && !updateOwnsQuit && options.hasPendingWork?.() === false) {
        void flush();
        return false;
      }
      event.preventDefault();
      if (!resumingQuit) {
        resumingQuit = true;
        // Not from this chain directly: with nothing to flush it settles in
        // microtasks, which run INSIDE the native quit pass being deferred,
        // and that pass then cancels the retry. See quit-retry.ts.
        // An update that took over decides at settle time, as before; one
        // that takes over during the hop wins too.
        void flush().then(() => {
          if (updateOwnsQuit) return;
          retryQuitAfterDispatch(() => {
            if (!updateOwnsQuit) options.resumeQuit();
          });
        });
      }
      return true;
    },
    quitAndInstall(install: () => void): Promise<void> {
      updateOwnsQuit = true;
      // Claim ownership before awaiting, including takeover of a normal quit.
      installing ??= flush().then(install).catch((error: unknown) => {
        // Abandon only this quit attempt's clock. Diagnostics are already
        // stopped (or timed out), so retain their shared completion state.
        startedAt = undefined;
        throw error;
      }).finally(() => {
        updateOwnsQuit = false;
        installing = null;
      });
      return installing;
    }
  };
}
