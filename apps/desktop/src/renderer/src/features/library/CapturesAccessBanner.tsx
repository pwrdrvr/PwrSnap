// Inline notice that macOS is blocking reads of the captures folder.
//
// Subscribes to `events:storage:captures-access` from main; reads the
// initial snapshot once (in case the denial happened before this
// component mounted — e.g. boot maintenance hit it) and races that
// read against any real event so a fresh event always wins. Visible
// while `denied` is true; auto-dismisses when main observes access
// recovering (every previously-denied path read successfully).
//
// Why this exists: a TCC denial makes thumbnails render broken with
// no error anywhere the user looks — the capture record exists, the
// file exists, but every open() returns EPERM. Worse, the render
// cache hides the problem for already-baked captures, so it looks
// like a handful of corrupted files instead of a permission issue.
// See main/storage/captures-access-health.ts for the mechanism.
//
// Mirrors AppUpdateBanner's shape (and reuses its CSS classes via a
// modifier) so the two banners stack consistently above the Library.

import { useEffect, useState, type ReactElement } from "react";
import type { CapturesAccessHealth } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

const HEALTHY: CapturesAccessHealth = {
  denied: false,
  deniedPathCount: 0,
  samplePath: null,
  firstDeniedAt: null,
  lastDeniedAt: null
};

export function CapturesAccessBanner(): ReactElement | null {
  const [health, setHealth] = useState<CapturesAccessHealth>(HEALTHY);
  // Dismissal is keyed on the denied-path count so the banner stays
  // hidden for the session once dismissed, but re-surfaces if the
  // problem grows (more distinct files denied).
  const [dismissedAtCount, setDismissedAtCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.capturesAccessChanged,
      (payload) => {
        receivedEvent = true;
        if (cancelled) return;
        setHealth(payload as CapturesAccessHealth);
      }
    );
    void (async () => {
      const result = await dispatch("storage:capturesAccessHealth", {});
      if (cancelled || receivedEvent || !result.ok) return;
      setHealth(result.value);
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  if (!health.denied) return null;
  if (dismissedAtCount !== null && health.deniedPathCount <= dismissedAtCount) {
    return null;
  }

  const fileNoun = health.deniedPathCount === 1 ? "capture file" : "capture files";

  return (
    <aside
      className="app-update-banner captures-access-banner"
      role="alert"
      aria-live="assertive"
    >
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">macOS is blocking captures</p>
        <p className="app-update-banner__message">
          {health.deniedPathCount} {fileNoun} in your captures folder can’t be read
          (operation not permitted), so previews show broken. Grant Documents-folder
          access under Privacy &amp; Security → Files &amp; Folders — when running from a
          terminal in development, grant it to that terminal app — then relaunch PwrSnap.
        </p>
      </div>
      <div className="app-update-banner__actions">
        <button
          className="app-update-banner__restart"
          type="button"
          onClick={() => {
            void dispatch("storage:openCapturesAccessSettings", {});
          }}
        >
          Open Privacy Settings
        </button>
        <button
          className="app-update-banner__dismiss"
          type="button"
          aria-label="Dismiss captures access notification"
          onClick={() => setDismissedAtCount(health.deniedPathCount)}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
