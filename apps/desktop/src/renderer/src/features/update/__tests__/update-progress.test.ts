import { describe, expect, test } from "vitest";
import {
  downloadMeter,
  isUpdateCheckInProgress,
  updateCheckOutcomeNotice,
  updateProgressCopy
} from "../update-progress";

describe("isUpdateCheckInProgress", () => {
  test("covers every status a check passes through before it has an answer", () => {
    expect(isUpdateCheckInProgress({ status: "checking" })).toBe(true);
    expect(isUpdateCheckInProgress({ status: "available", version: "1.0.0" })).toBe(true);
    expect(isUpdateCheckInProgress({ status: "downloading", version: "1.0.0" })).toBe(true);
  });

  test("excludes every settled one, so the live card comes down", () => {
    for (const status of [
      { status: "idle" },
      { status: "no-update", version: "1.0.0" },
      { status: "downloaded", version: "1.0.0" },
      { status: "canceled", version: "1.0.0" },
      { status: "skipped", reason: "not here" },
      { status: "error", message: "nope" }
    ] as const) {
      expect(isUpdateCheckInProgress(status)).toBe(false);
    }
  });
});

describe("updateProgressCopy", () => {
  test("sweeps while the release read is out, with nothing to cancel yet", () => {
    const copy = updateProgressCopy({ status: "checking" });

    expect(copy.title).toBe("Checking for updates");
    expect(copy.percent).toBeUndefined();
    expect(copy.meter).toBeUndefined();
    expect(copy.cancelable).toBe(false);
  });

  test("offers Cancel as soon as a download is the thing being waited on", () => {
    const copy = updateProgressCopy({ status: "available", version: "1.0.0" });

    expect(copy.title).toBe("Update available");
    expect(copy.message).toBe("Starting download of v1.0.0...");
    // Before a single byte has moved. Main registers its cancellable download
    // at this same moment for exactly this reason.
    expect(copy.cancelable).toBe(true);
    expect(copy.percent).toBeUndefined();
  });

  test("names the version and the percent it is at", () => {
    const copy = updateProgressCopy({
      status: "downloading",
      version: "1.0.0",
      percent: 42,
      transferred: 50_000_000,
      total: 118_000_000,
      bytesPerSecond: 3_300_000
    });

    expect(copy.title).toBe("Downloading update");
    expect(copy.message).toBe("PwrSnap v1.0.0 - 42%");
    expect(copy.percent).toBe(42);
    expect(copy.meter).toBe("48 MB of 113 MB · 3.1 MB/s");
    expect(copy.cancelable).toBe(true);
  });

  test("words a downgrade as a switch, not an update", () => {
    // The version number on screen is LOWER than the one running. Calling
    // that an update reads as a mistake — same rule as `appUpdateNotice`.
    expect(
      updateProgressCopy({ status: "available", version: "1.0.1", downgrade: true })
    ).toMatchObject({
      title: "Switch available",
      message: "Starting download of v1.0.1 to switch back..."
    });
    expect(
      updateProgressCopy({
        status: "downloading",
        version: "1.0.1",
        percent: 12,
        downgrade: true
      })
    ).toMatchObject({ title: "Downloading switch", message: "PwrSnap v1.0.1 - 12%" });
  });

  test("falls back to the sweep when the feed reports no percent", () => {
    // A feed that sends no content length leaves electron-updater nothing to
    // compute one from; a bar pinned at 0 would read as a stalled download.
    const copy = updateProgressCopy({ status: "downloading", version: "1.0.0" });

    expect(copy.message).toBe("PwrSnap v1.0.0");
    expect(copy.percent).toBeUndefined();
    expect(copy.meter).toBeUndefined();
  });

  test("clamps a percent the feed overshot rather than overflowing the bar", () => {
    expect(
      updateProgressCopy({ status: "downloading", version: "1.0.0", percent: 104 }).percent
    ).toBe(100);
    expect(
      updateProgressCopy({ status: "downloading", version: "1.0.0", percent: -3 }).percent
    ).toBe(0);
  });
});

describe("downloadMeter", () => {
  test("drops the half it does not know", () => {
    expect(downloadMeter({ transferred: 2_048 })).toBe("2.0 KB transferred");
    expect(downloadMeter({ bytesPerSecond: 500 })).toBe("500 B/s");
    expect(downloadMeter({})).toBeUndefined();
  });

  test("does not divide by a total the feed reported as zero", () => {
    expect(downloadMeter({ transferred: 1_024, total: 0 })).toBe("1.0 KB transferred");
  });

  test("ignores a rate of zero rather than printing a stalled one", () => {
    // electron-updater reports 0 B/s on the first tick, before it has two
    // samples to divide.
    expect(downloadMeter({ transferred: 0, total: 1_024, bytesPerSecond: 0 })).toBe(
      "0 B of 1.0 KB"
    );
  });
});

describe("updateCheckOutcomeNotice", () => {
  test("says nothing for the two results another surface owns", () => {
    // `checking` belongs to the live card; `downloaded` belongs to the sticky
    // Restart notice, and a second card would be the same offer twice.
    expect(updateCheckOutcomeNotice({ status: "checking" })).toBeUndefined();
    expect(
      updateCheckOutcomeNotice({ status: "downloaded", version: "1.0.0" })
    ).toBeUndefined();
  });

  test("reports a cancel as an outcome, never as a failure", () => {
    const notice = updateCheckOutcomeNotice({ status: "canceled", version: "1.0.0" });

    expect(notice).toEqual({
      key: "canceled:1.0.0",
      title: "Download canceled",
      message: "PwrSnap v1.0.0 is still available - check again to download it.",
      // A danger eyebrow in front of someone who got exactly what they asked
      // for is the whole reason `canceled` is not `error`.
      isError: false
    });
  });

  test("points a canceled switch back at the switch, not at an update", () => {
    expect(
      updateCheckOutcomeNotice({ status: "canceled", version: "1.0.1", downgrade: true })
        ?.message
    ).toBe("PwrSnap v1.0.1 is still available - check again to switch.");
  });

  test("marks only a failed check as an error", () => {
    expect(updateCheckOutcomeNotice({ status: "error", message: "404" })).toMatchObject({
      title: "Update check failed",
      message: "404",
      isError: true
    });
    expect(
      updateCheckOutcomeNotice({ status: "skipped", reason: "auto-update disabled" })
    ).toMatchObject({ title: "Updates unavailable", isError: false });
    expect(updateCheckOutcomeNotice({ status: "no-update", version: "1.0.0" })).toMatchObject(
      { title: "PwrSnap is up to date", message: "You're running v1.0.0.", isError: false }
    );
  });

  test("keys each answer so a later, different one re-arms the countdown", () => {
    expect(updateCheckOutcomeNotice({ status: "no-update", version: "1.0.0" })?.key).toBe(
      "no-update:1.0.0"
    );
    expect(updateCheckOutcomeNotice({ status: "error", message: "404" })?.key).toBe(
      "error:404"
    );
  });
});
