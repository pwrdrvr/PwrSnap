// What a user-initiated update check SAYS, as pure functions.
//
// Split out of AppUpdateBanner for the reason `app-update-notice.ts` is: the
// interesting part of a progress card is the wording and the arithmetic, and
// neither needs a DOM to be checked. The split is also what lets the copy be
// pinned against a downgrade — the case PwrGit's original has no equivalent
// of — without rendering anything.
//
// Two halves, and they answer different moments:
//   - `updateProgressCopy` — the check is still working. Live card, no
//     countdown.
//   - `updateCheckOutcomeNotice` — the check has finished and left nothing to
//     act on. Ordinary auto-dismissing notice, countdown correct.
// An outcome that IS actionable (a downloaded update) belongs to
// `appUpdateNotice`, which the three update surfaces already share.

import type { AppUpdateCheckResult, AppUpdateStatus } from "@pwrsnap/shared";
import { formatBytes } from "../../lib/format-bytes";

/** The statuses a check passes through before it has an answer. While the
 *  status is one of these the banner shows a live card instead of a
 *  countdown — a strip draining toward a dismissal that has nothing to do
 *  with the work is the bug this file exists to fix. */
export type AppUpdateProgressStatus = Extract<
  AppUpdateStatus,
  { status: "checking" | "available" | "downloading" }
>;

export function isUpdateCheckInProgress(
  status: AppUpdateStatus
): status is AppUpdateProgressStatus {
  return (
    status.status === "checking" ||
    status.status === "available" ||
    status.status === "downloading"
  );
}

export type UpdateProgressCopy = {
  title: string;
  message: string;
  /** 0-100 for a determinate bar, `undefined` for the indeterminate sweep. */
  percent: number | undefined;
  /** Byte counts and rate, or `undefined` when the feed reports neither. */
  meter: string | undefined;
  /** A download is running, so there is something for Cancel to stop. */
  cancelable: boolean;
};

export function updateProgressCopy(status: AppUpdateProgressStatus): UpdateProgressCopy {
  if (status.status === "checking") {
    return {
      title: "Checking for updates",
      message: "Asking GitHub for the latest release...",
      percent: undefined,
      meter: undefined,
      cancelable: false
    };
  }
  // A downgrade is the way back to the train the user picked, not an update.
  // Wording it as one reads as a mistake beside a version number that is
  // LOWER than the one they are running — same rule as `appUpdateNotice`.
  const switching = status.downgrade === true;
  if (status.status === "available") {
    return {
      title: switching ? "Switch available" : "Update available",
      message: switching
        ? `Starting download of v${status.version} to switch back...`
        : `Starting download of v${status.version}...`,
      percent: undefined,
      meter: undefined,
      // Offered from here, before a single byte has moved. Main registers its
      // cancellable download at the same moment for exactly this reason.
      cancelable: true
    };
  }
  // ONE number for the bar and the label. `percent` reaches us as
  // `(transferred / total) * 100`, so a feed that reports no content length
  // makes it NaN, and a differential download can overshoot 100 — printing
  // the raw value beside a clamped bar gives "- NaN%" or "- 104%" over a bar
  // that says something else entirely.
  const percent = clampPercent(status.percent);
  return {
    title: switching ? "Downloading switch" : "Downloading update",
    message: `PwrSnap v${status.version}${percent === undefined ? "" : ` - ${percent}%`}`,
    // A feed that sends no content length leaves electron-updater nothing to
    // compute a percent from. Fall back to the sweep rather than pinning the
    // bar at 0% for the length of the download.
    percent,
    meter: downloadMeter(status),
    cancelable: true
  };
}

function clampPercent(percent: number | undefined): number | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  return Math.min(100, Math.max(0, percent));
}

/** `47 MB of 177 MB · 3.1 MB/s`, dropping whichever half is unknown. */
export function downloadMeter(progress: {
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}): string | undefined {
  const parts: string[] = [];
  if (isPositive(progress.total) && isCount(progress.transferred)) {
    parts.push(`${formatBytes(progress.transferred)} of ${formatBytes(progress.total)}`);
  } else if (isCount(progress.transferred)) {
    parts.push(`${formatBytes(progress.transferred)} transferred`);
  }
  if (isPositive(progress.bytesPerSecond)) {
    parts.push(`${formatBytes(progress.bytesPerSecond)}/s`);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function isCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function isPositive(value: number | undefined): value is number {
  return isCount(value) && value > 0;
}

export type UpdateCheckOutcomeNotice = {
  /** Re-arms the auto-dismiss countdown when a later check lands a different
   *  answer, and keeps one answer from re-raising itself on re-render. */
  key: string;
  title: string;
  message: string;
  /** Danger eyebrow. A cancel is deliberately NOT one — see below. */
  isError: boolean;
};

/**
 * A finished user-initiated check that leaves nothing to press.
 *
 * `undefined` for the two results that are not this surface's to report:
 * `checking` (the live card has it) and `downloaded` (the sticky Restart
 * notice from `appUpdateNotice` has it, and a second card would be the same
 * offer twice).
 */
export function updateCheckOutcomeNotice(
  result: AppUpdateCheckResult
): UpdateCheckOutcomeNotice | undefined {
  if (result.status === "checking" || result.status === "downloaded") return undefined;
  if (result.status === "skipped") {
    return {
      key: `skipped:${result.reason}`,
      title: "Updates unavailable",
      message: result.reason,
      isError: false
    };
  }
  if (result.status === "error") {
    return {
      key: `error:${result.message}`,
      title: "Update check failed",
      message: result.message,
      isError: true
    };
  }
  if (result.status === "canceled") {
    // Its own status on purpose. `available` would promise a download that is
    // no longer running, and `error` would put a danger eyebrow in front of
    // someone who got exactly what they asked for.
    return {
      key: `canceled:${result.version}`,
      title: "Download canceled",
      message:
        result.downgrade === true
          ? `PwrSnap v${result.version} is still available - check again to switch.`
          : `PwrSnap v${result.version} is still available - check again to download it.`,
      isError: false
    };
  }
  if (result.status === "available") {
    // Only reachable if the download outlived the wait main puts on it: a
    // fresh offer settles as `downloaded`, `canceled` or `error`.
    return {
      key: `available:${result.version}`,
      title: result.downgrade === true ? "Switch available" : "Update available",
      message: `PwrSnap v${result.version} is downloading in the background.`,
      isError: false
    };
  }
  return {
    key: `no-update:${result.version}`,
    title: "PwrSnap is up to date",
    message: `You're running v${result.version}.`,
    isError: false
  };
}
