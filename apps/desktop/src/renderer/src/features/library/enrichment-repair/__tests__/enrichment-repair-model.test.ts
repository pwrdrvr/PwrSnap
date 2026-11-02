import { describe, expect, test } from "vitest";
import type { EnrichmentRepairJob } from "@pwrsnap/shared";

import {
  ALL_APPS,
  formatElapsed,
  repairAppRowState,
  repairAppsToken,
  repairBarSegments,
  repairJobCount,
  repairJobHeadline,
  repairJobRecap,
  repairJobTally,
  repairOldestInFlightMs,
  repairOutcome,
  repairPaceToken,
  repairSetupFromRequest,
  repairStopReasonText,
  repairWindowBounds,
  repairWindowToken,
  toggleRepairApp
} from "../enrichment-repair-model";

describe("toggleRepairApp", () => {
  test("plain clicks build and unbuild a selection", () => {
    let facet = toggleRepairApp(ALL_APPS, "safari", false);
    expect(facet).toEqual({ mode: "include", appIds: ["safari"] });
    facet = toggleRepairApp(facet, "slack", false);
    expect(facet).toEqual({ mode: "include", appIds: ["safari", "slack"] });
    facet = toggleRepairApp(facet, "safari", false);
    expect(facet).toEqual({ mode: "include", appIds: ["slack"] });
    expect(toggleRepairApp(facet, "slack", false)).toBe(ALL_APPS);
  });

  test("⌥-click excludes, and ⌥-clicking again stops excluding", () => {
    let facet = toggleRepairApp(ALL_APPS, "electron", true);
    expect(facet).toEqual({ mode: "exclude", appIds: ["electron"] });
    facet = toggleRepairApp(facet, "finder", true);
    expect(repairAppRowState(facet, "finder")).toBe("excluded");
    facet = toggleRepairApp(facet, "electron", true);
    expect(facet).toEqual({ mode: "exclude", appIds: ["finder"] });
  });

  test("a plain click on an excluded app takes it back; on any other app it starts a selection", () => {
    const excluding = { mode: "exclude" as const, appIds: ["electron", "finder"] };
    expect(toggleRepairApp(excluding, "finder", false)).toEqual({ mode: "exclude", appIds: ["electron"] });
    expect(toggleRepairApp(excluding, "safari", false)).toEqual({ mode: "include", appIds: ["safari"] });
  });

  test("⌥-click while selecting switches to excluding just that app", () => {
    expect(toggleRepairApp({ mode: "include", appIds: ["safari"] }, "slack", true)).toEqual({
      mode: "exclude",
      appIds: ["slack"]
    });
  });
});

describe("repairWindowBounds", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");

  test("presets are a lower bound only", () => {
    expect(repairWindowBounds({ kind: "preset", preset: "7d" }, now)).toEqual({
      since: "2026-09-30T12:00:00.000Z",
      until: null
    });
    expect(repairWindowBounds({ kind: "preset", preset: "all" }, now)).toEqual({ since: null, until: null });
  });

  test("picked dates include the whole last day, in local time", () => {
    const bounds = repairWindowBounds({ kind: "dates", from: "2026-10-01", to: "2026-10-03" }, now);
    expect(bounds.since).toBe(new Date(2026, 9, 1).toISOString());
    expect(bounds.until).toBe(new Date(2026, 9, 4).toISOString());
  });

  test("half-picked dates bound only the side that is set", () => {
    expect(repairWindowBounds({ kind: "dates", from: "", to: "2026-10-03" }, now).since).toBeNull();
  });

  test("an exact range passes through untouched", () => {
    const range = { kind: "range" as const, since: "2026-10-07T10:42:00.000Z", until: "2026-10-07T11:20:00.000Z" };
    expect(repairWindowBounds(range, now)).toEqual({ since: range.since, until: range.until });
  });
});

describe("token line", () => {
  const now = new Date(2026, 9, 7, 12, 0).getTime();

  test("the window token reads after \"Captured\"", () => {
    expect(repairWindowToken({ kind: "preset", preset: "30d" }, now)).toBe("in the last 30 days");
    expect(repairWindowToken({ kind: "preset", preset: "all" }, now)).toBe("at any time");
    expect(repairWindowToken({ kind: "dates", from: "", to: "" }, now)).toBe("between dates");
    const range = repairWindowToken(
      { kind: "range", since: new Date(2026, 9, 7, 10, 42).toISOString(), until: new Date(2026, 9, 7, 11, 20).toISOString() },
      now
    );
    expect(range).toMatch(/today$/);
  });

  test("the apps token names one or two apps and counts more", () => {
    const name = (key: string): string => key.toUpperCase();
    expect(repairAppsToken(ALL_APPS, name)).toBe("all apps");
    expect(repairAppsToken({ mode: "include", appIds: ["a"] }, name)).toBe("A");
    expect(repairAppsToken({ mode: "include", appIds: ["a", "b"] }, name)).toBe("A and B");
    expect(repairAppsToken({ mode: "include", appIds: ["a", "b", "c"] }, name)).toBe("3 apps");
    expect(repairAppsToken({ mode: "exclude", appIds: ["a"] }, name)).toBe("all but A");
    expect(repairAppsToken({ mode: "exclude", appIds: ["a", "b"] }, name)).toBe("all but 2 apps");
  });

  test("pace", () => {
    expect(repairPaceToken(1)).toBe("one at a time");
    expect(repairPaceToken(4)).toBe("4 at a time");
  });
});

describe("repairSetupFromRequest", () => {
  test("no request keeps the defaults", () => {
    expect(repairSetupFromRequest(undefined)).toEqual({});
    expect(repairSetupFromRequest({})).toEqual({});
  });

  test("a preset and statuses carry over; an exact range becomes a range window", () => {
    expect(repairSetupFromRequest({ statuses: ["never"], window: "all" })).toEqual({
      statuses: ["never"],
      window: { kind: "preset", preset: "all" }
    });
    expect(
      repairSetupFromRequest({ window: { since: "2026-10-07T10:42:00.000Z", until: "2026-10-07T11:20:00.000Z" } })
    ).toEqual({
      window: { kind: "range", since: "2026-10-07T10:42:00.000Z", until: "2026-10-07T11:20:00.000Z" }
    });
  });
});

describe("job copy", () => {
  const job: EnrichmentRepairJob = {
    jobId: "j",
    state: "running",
    criteria: { statuses: ["failed"], since: null, until: null, apps: ALL_APPS },
    total: 128,
    processed: 34,
    succeeded: 30,
    failed: 3,
    skipped: 1,
    concurrency: 2,
    inFlight: [{ captureId: "c", startedAt: "2026-10-07T12:00:30.000Z" }],
    waitingUntil: null,
    stopReason: null,
    startedAt: "2026-10-07T12:00:00.000Z",
    finishedAt: null
  };

  test("headline, count and tally", () => {
    expect(repairJobHeadline(job)).toBe("Re-running AI");
    expect(repairJobCount(job)).toBe("34 / 128");
    expect(repairJobTally(job)).toBe("30 fixed · 3 failed again · 1 skipped");
    const clean = { ...job, state: "completed" as const, processed: 128, succeeded: 128, failed: 0, skipped: 0 };
    expect(repairJobHeadline(clean)).toBe("All 128 snaps fixed");
    expect(repairJobCount(clean)).toBe("");
    expect(repairJobHeadline({ ...job, state: "completed" })).toBe("AI re-run done");
    expect(repairJobHeadline({ ...job, state: "cancelled" })).toBe("AI re-run stopped");
    expect(repairJobHeadline({ ...job, state: "stopped" })).toBe("AI re-run paused");
  });

  test("outcome", () => {
    expect(repairOutcome(job)).toBeNull();
    expect(repairOutcome({ ...job, state: "completed", failed: 0 })).toBe("clean");
    expect(repairOutcome({ ...job, state: "completed" })).toBe("mixed");
    expect(repairOutcome({ ...job, state: "completed", total: 0 })).toBe("empty");
    expect(repairOutcome({ ...job, state: "cancelled" })).toBe("cancelled");
    expect(repairOutcome({ ...job, state: "stopped" })).toBe("stopped");
  });

  test("the recap reads what the job was asked to do", () => {
    expect(repairJobRecap(job, Date.parse("2026-10-07T12:01:00.000Z"))).toBe(
      "Failed · all time · all apps · 2 at a time"
    );
  });

  test("the bar splits by result, with what is in flight after", () => {
    const seg = repairBarSegments(job);
    expect(seg.ok).toBeCloseTo(30 / 128);
    expect(seg.bad).toBeCloseTo(3 / 128);
    expect(seg.skip).toBeCloseTo(1 / 128);
    expect(seg.live).toBeCloseTo(1 / 128);
    expect(seg.held).toBe(0);
    const held = repairBarSegments({ ...job, inFlight: [], waitingUntil: "2026-10-07T12:01:00.000Z" });
    expect(held.live).toBe(0);
    expect(held.held).toBeCloseTo(1 / 128);
    expect(repairBarSegments({ ...job, state: "cancelled" }).live).toBe(0);
  });

  test("the oldest snap in flight sets the activity clock", () => {
    const now = Date.parse("2026-10-07T12:01:00.000Z");
    expect(repairOldestInFlightMs(job, now)).toBe(30_000);
    const two = {
      ...job,
      inFlight: [...job.inFlight, { captureId: "d", startedAt: "2026-10-07T12:00:10.000Z" }]
    };
    expect(repairOldestInFlightMs(two, now)).toBe(50_000);
    expect(repairOldestInFlightMs({ ...job, inFlight: [] }, now)).toBeNull();
  });

  test("elapsed and stop reasons", () => {
    expect(formatElapsed(40_000)).toBe("40 s");
    expect(formatElapsed(14 * 60_000)).toBe("14 min");
    expect(formatElapsed(65 * 60_000)).toBe("1 h 5 min");
    expect(repairStopReasonText("AI enrichment was turned off.")).toBe("AI enrichment was turned off");
    expect(repairStopReasonText(null)).toBe("it could not go on");
  });
});
