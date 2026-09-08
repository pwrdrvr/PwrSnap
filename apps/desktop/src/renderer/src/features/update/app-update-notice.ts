// Status → copy, for every surface that offers to restart into a
// downloaded update.
//
// Three surfaces render this today — the Library's lower-left toast
// (AppUpdateBanner), the tray popover strip, and the post-capture
// float-over card — and they must not drift apart in wording. So the
// wording lives here and nowhere else. The two compact popovers have
// far less room than the Library toast, hence the parallel `message`
// (a full sentence) / `compact` (one line, version first) pair rather
// than one string squeezed to fit the smallest surface.
//
// Only ACTIONABLE states produce a notice. `checking` / `available` /
// `downloading` deliberately return undefined: `autoDownload` is on
// (see initAppUpdater in main/auto-updater.ts), so that stretch is
// short and has nothing to press, and a row that appears and vanishes
// while the tray popover is open would resize the window for no
// reason. Settings → Updates renders the full status machine.

import type { AppUpdateStatus } from "@pwrsnap/shared";

export type AppUpdateNoticeKind = "ready" | "retry";

export type AppUpdateNotice = {
  /** `<status>:<version>` — the per-version dismissal key. A new
   *  actionable state brings a dismissed notice back. */
  key: string;
  kind: AppUpdateNoticeKind;
  version: string;
  /** Banner eyebrow / compact-row title. */
  title: string;
  /** Full sentence, for the Library toast. */
  message: string;
  /** One line, version first, for the tray + float-over rows. */
  compact: string;
  /** Button verb on the Library toast. */
  action: string;
  /** Button verb on the compact rows, where the control is 24px tall. */
  compactAction: string;
  /** Replaces whichever verb is showing while the install is in flight. */
  busyAction: string;
};

export function appUpdateNotice(status: AppUpdateStatus): AppUpdateNotice | undefined {
  if (status.status === "downloaded") {
    // A downgrade is the way back to the train the user picked, not an
    // update. Wording it as one reads as a mistake next to a version
    // number that is lower than the one they are running.
    const switching = status.downgrade === true;
    return {
      // The downgrade flag is part of the dismissal identity, not just
      // the wording: the same version can arrive first as a switch back
      // to the picked train and later as an ordinary update. Sharing one
      // key would let a dismissed switch silence the update.
      key: `downloaded:${switching ? "switch" : "update"}:${status.version}`,
      kind: "ready",
      version: status.version,
      title: switching ? "Switch ready" : "Update ready",
      message: switching
        ? `Restart to switch to v${status.version}.`
        : `Restart to update to v${status.version}.`,
      compact: switching
        ? `v${status.version} · restart to switch`
        : `v${status.version} · restart to install`,
      action: "Restart",
      compactAction: "Restart",
      busyAction: "Restarting..."
    };
  }
  if (status.status === "install-failed") {
    return {
      key: `install-failed:${status.version}`,
      kind: "retry",
      version: status.version,
      title: "Update retry needed",
      message: `The update to v${status.version} did not finish installing. Retry to download it again and restart.`,
      compact: `v${status.version} didn't finish installing`,
      action: "Retry update",
      compactAction: "Retry",
      busyAction: "Retrying..."
    };
  }
  return undefined;
}
