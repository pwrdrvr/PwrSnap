// Command-bus handlers for the `settings:*` namespace.
//
// Slice B (this file's first cut): the only verb that lands is
// `settings:open`. It's idempotent — calling it on an already-open
// Settings window just focuses it. An optional `page` argument is
// passed through to the renderer via the URL hash so callers can
// deep-link a specific sidebar entry.
//
// Slices C+ will extend this module with `settings:read/write`,
// `settings:refreshCodexDiscovery`, and the secret-store verbs. They
// share the same handler-registration shape.
//
// Mirrors the structure of library-handlers.ts (no `bus` parameter;
// the module imports it directly). Keep these in lockstep — both are
// the canonical "bus handler" pattern in the codebase.

import { ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { createSettingsWindow, findSettingsWindow } from "../window";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:settings-handlers");

export function registerSettingsHandlers(): void {
  bus.register("settings:open", async (req) => {
    const existing = findSettingsWindow();
    if (existing !== null) {
      if (existing.isMinimized()) existing.restore();
      if (!existing.isVisible()) existing.show();
      existing.focus();
      // If the caller asked for a specific page, navigate the renderer
      // there. The simplest cross-process route is the URL hash; the
      // renderer's `useActivePage` hook listens for `hashchange`.
      if (req.page !== undefined) {
        existing.webContents
          .executeJavaScript(
            `window.location.hash = "stage=settings&page=${req.page}";`,
            true
          )
          .catch((cause: unknown) => {
            log.warn("settings:open: failed to set hash on existing window", {
              page: req.page,
              message: cause instanceof Error ? cause.message : String(cause)
            });
          });
      }
      return ok(undefined);
    }
    const extraHash = req.page !== undefined ? `page=${req.page}` : undefined;
    createSettingsWindow(extraHash);
    return ok(undefined);
  });
}
