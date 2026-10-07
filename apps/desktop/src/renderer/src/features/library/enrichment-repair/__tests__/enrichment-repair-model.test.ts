import { describe, expect, test } from "vitest";
import type { EnrichmentRepairJob } from "@pwrsnap/shared";

import {
  ALL_APPS,
  repairAppRowState,
  repairJobHeadline,
  repairJobTally,
  repairWindowBounds,
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
    expect(repairWindowBounds("7d", { from: "", to: "" }, now)).toEqual({
      since: "2026-09-30T12:00:00.000Z",
      until: null
    });
    expect(repairWindowBounds("all", { from: "", to: "" }, now)).toEqual({ since: null, until: null });
  });

  test("a custom range includes the whole last day, in local time", () => {
    const bounds = repairWindowBounds("custom", { from: "2026-10-01", to: "2026-10-03" }, now);
    expect(bounds.since).toBe(new Date(2026, 9, 1).toISOString());
    expect(bounds.until).toBe(new Date(2026, 9, 4).toISOString());
  });

  test("a half-filled custom range bounds only the side that is set", () => {
    expect(repairWindowBounds("custom", { from: "", to: "2026-10-03" }, now).since).toBeNull();
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
    currentCaptureId: "c",
    currentStartedAt: null,
    waitingUntil: null,
    stopReason: null,
    startedAt: "2026-10-07T12:00:00.000Z",
    finishedAt: null
  };

  test("headline and tally", () => {
    expect(repairJobHeadline(job)).toBe("Re-running AI · 34 of 128");
    expect(repairJobTally(job)).toBe("30 fixed · 3 failed again · 1 skipped");
    expect(repairJobHeadline({ ...job, state: "completed" })).toBe("AI re-run finished · 128 snaps");
  });
});
