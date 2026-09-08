// Subscription + install hooks shared by every update surface.
//
// `events:app-update:status` is broadcast to every BrowserWindow (and
// relayed across the process split), and `app:update:*` is routed to
// whichever process owns the updater by the command-bus routing table
// — so the tray popover and the float-over toast need no new IPC to
// carry this. They were simply never listening.

import { useCallback, useEffect, useState } from "react";
import type { AppUpdateStatus } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

/** Both inputs below arrive as `unknown` over IPC, and the update row
 *  is a passenger on surfaces that must keep working without it — the
 *  post-capture toast above all. A malformed payload leaves the last
 *  good status in place instead of throwing through the host's render. */
function asAppUpdateStatus(payload: unknown): AppUpdateStatus | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { status } = payload as { status?: unknown };
  return typeof status === "string" ? (payload as AppUpdateStatus) : undefined;
}

/**
 * Live updater status for this window.
 *
 * Reads the snapshot once — main may have reached `downloaded` long
 * before this component mounted, which is the normal case for the
 * tray popover and the post-capture toast — and races that read
 * against the live event so a real event always wins.
 */
export function useAppUpdateStatus(): AppUpdateStatus {
  const [status, setStatus] = useState<AppUpdateStatus>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.appUpdateStatus,
      (payload) => {
        receivedEvent = true;
        if (cancelled) return;
        const next = asAppUpdateStatus(payload);
        if (next !== undefined) setStatus(next);
      }
    );
    void (async () => {
      const result = await dispatch("app:update:status", {});
      if (cancelled || receivedEvent || !result.ok) return;
      const next = asAppUpdateStatus(result.value);
      if (next !== undefined) setStatus(next);
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return status;
}

export type AppUpdateInstall = {
  /** True from the click until main either fails or quits the app. */
  busy: boolean;
  /** Set when the install could not start; replaces the notice's own
   *  subline rather than opening a dialog. */
  error: string | undefined;
  install: () => void;
  /** Clear busy + error — call when a new notice supersedes the one
   *  the error belonged to. */
  reset: () => void;
};

export function useAppUpdateInstall(): AppUpdateInstall {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const install = useCallback((): void => {
    setBusy(true);
    setError(undefined);
    void (async () => {
      const result = await dispatch("app:update:install", {});
      if (!result.ok) {
        setError(result.error.message);
        setBusy(false);
        return;
      }
      if (result.value.status === "error") {
        setError(result.value.message);
        setBusy(false);
      }
      // status === "restarting" → main is about to quit-and-install.
      // Stay busy so the button cannot be pressed twice on the way out.
    })();
  }, []);

  const reset = useCallback((): void => {
    setBusy(false);
    setError(undefined);
  }, []);

  return { busy, error, install, reset };
}
