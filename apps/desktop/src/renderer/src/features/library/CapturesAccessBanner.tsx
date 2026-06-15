// Floating toast (lower-left .app-toast-stack) that macOS is blocking
// reads of the captures folder.
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
// modifier) so the two toasts stack consistently in the lower-left.
// Copy + the settings deep-link button are platform-tailored — see
// describeCapturesAccess below — since the remediation differs by OS
// (macOS TCC vs Windows Controlled Folder Access vs Linux Flatpak/Snap
// confinement).

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

  const copy = describeCapturesAccess(
    window.pwrsnapApi?.platform,
    health.deniedPathCount
  );

  return (
    <aside
      className="app-update-banner captures-access-banner"
      role="alert"
      aria-live="assertive"
    >
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">{copy.eyebrow}</p>
        <p className="app-update-banner__message">{copy.message}</p>
      </div>
      <div className="app-update-banner__actions">
        {copy.showSettingsButton ? (
          <button
            className="app-update-banner__restart"
            type="button"
            onClick={() => {
              void dispatch("storage:openCapturesAccessSettings", {});
            }}
          >
            Open Privacy Settings
          </button>
        ) : null}
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

type CapturesAccessCopy = {
  eyebrow: string;
  message: string;
  /** Only macOS has a reliable settings deep link (Files & Folders).
   *  Windows denials are ambiguous (Controlled Folder Access vs AV vs
   *  OneDrive cloud-only files) and Linux confinement varies by
   *  Flatpak/Snap, so neither gets an auto-link button. */
  showSettingsButton: boolean;
};

/**
 * Platform-tailored copy for the captures-access denial. macOS gets the
 * precise TCC remediation (the only platform that ships today); Windows
 * and Linux get accurate, hedged guidance for their closest analog —
 * Controlled Folder Access / antivirus / OneDrive on Windows, Flatpak/
 * Snap filesystem confinement on Linux — and a generic fallback covers
 * anything else.
 */
function describeCapturesAccess(
  platform: string | undefined,
  count: number
): CapturesAccessCopy {
  const fileNoun = count === 1 ? "capture file" : "capture files";
  const lead = `${count} ${fileNoun} in your captures folder can’t be read`;

  if (platform === "darwin") {
    return {
      eyebrow: "macOS is blocking captures",
      message:
        `${lead} (operation not permitted), so previews show broken. Grant ` +
        "Documents-folder access under Privacy & Security → Files & Folders — when " +
        "running from a terminal in development, grant it to that terminal app — then " +
        "relaunch PwrSnap.",
      showSettingsButton: true
    };
  }
  if (platform === "win32") {
    return {
      eyebrow: "Can’t read captures",
      message:
        `${lead} (access denied), so previews show broken. This is usually Controlled ` +
        "Folder Access (Windows Security → Ransomware protection) or antivirus blocking " +
        "PwrSnap, or files still syncing from OneDrive. Allow PwrSnap to read the folder, " +
        "then reopen it.",
      showSettingsButton: false
    };
  }
  if (platform === "linux") {
    return {
      eyebrow: "Can’t read captures",
      message:
        `${lead} (permission denied), so previews show broken. If PwrSnap is installed ` +
        "as a Flatpak or Snap, grant it filesystem access to your Documents (or home) " +
        "folder — e.g. with Flatseal or `snap connect` — then reopen it.",
      showSettingsButton: false
    };
  }
  return {
    eyebrow: "Can’t read captures",
    message:
      `${lead} (permission denied), so previews show broken. Make sure PwrSnap has ` +
      "permission to read the folder, then reopen it.",
    showSettingsButton: false
  };
}
