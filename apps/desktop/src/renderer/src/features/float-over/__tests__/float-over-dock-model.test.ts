import { describe, expect, test } from "vitest";
import type { CaptureEnrichment, CaptureRecord } from "@pwrsnap/shared";
import {
  clearFinishedDockItems,
  dockItemLabel,
  dockItemTitle,
  dockStatus,
  formatDockAge,
  hasFinishedDockItems,
  isLeavingSnapInFlight,
  railDockItems,
  removeDockItem,
  splitDockItems,
  updateDockEnrichment,
  upsertDockItem,
  type DockItem
} from "../float-over-dock-model";

function enrichment(
  captureId: string,
  status: CaptureEnrichment["status"],
  patch: Partial<CaptureEnrichment> = {}
): CaptureEnrichment {
  return {
    captureId,
    latestRunId: `run_${captureId}`,
    status,
    error: null,
    ocrText: null,
    suggestedTitle: null,
    acceptedTitle: null,
    titleAcceptedAt: null,
    suggestedFilenameStem: null,
    acceptedFilenameStem: null,
    filenameAcceptedAt: null,
    suggestedDescription: null,
    acceptedDescription: null,
    descriptionAcceptedAt: null,
    suggestedTags: [],
    acceptedTags: [],
    ...patch
  };
}

function record(id: string, patch: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id,
    kind: "image",
    captured_at: "2026-09-27T10:00:00.000Z",
    legacy_src_path: `/tmp/${id}.png`,
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 2,
    bundle_edits_version: 0,
    width_px: 1280,
    height_px: 800,
    device_pixel_ratio: 1,
    byte_size: 1000,
    sha256: `sha_${id}`,
    source_app_bundle_id: null,
    source_app_name: null,
    source_window_title: null,
    edits_version: 0,
    has_alpha: false,
    deleted_at: null,
    video: null,
    ...patch
  };
}

function item(
  captureId: string,
  addedAt: number,
  status: CaptureEnrichment["status"] | null = "running"
): DockItem {
  return {
    captureId,
    addedAt,
    record: record(captureId),
    enrichment: status === null ? null : enrichment(captureId, status)
  };
}

describe("dock status", () => {
  test("maps every enrichment status onto the four glyphs", () => {
    expect(dockStatus(null)).toBe("waiting");
    expect(dockStatus(enrichment("a", "queued"))).toBe("waiting");
    expect(dockStatus(enrichment("a", "running"))).toBe("reading");
    expect(dockStatus(enrichment("a", "completed"))).toBe("ready");
    expect(dockStatus(enrichment("a", "failed"))).toBe("failed");
    expect(dockStatus(enrichment("a", "cancelled"))).toBe("failed");
  });

  test("a snap with no run yet waits only when enrichment is going to run", () => {
    expect(isLeavingSnapInFlight(null, true)).toBe(true);
    // AI off: "no run" means never, not not-yet.
    expect(isLeavingSnapInFlight(null, false)).toBe(false);
    // A run that exists counts either way.
    expect(isLeavingSnapInFlight(enrichment("a", "queued"), false)).toBe(true);
    expect(isLeavingSnapInFlight(enrichment("a", "running"), false)).toBe(true);
    expect(isLeavingSnapInFlight(enrichment("a", "completed"), true)).toBe(false);
    expect(isLeavingSnapInFlight(enrichment("a", "failed"), true)).toBe(false);
  });
});

describe("dock membership", () => {
  test("stacks newest first, and a snap that rejoins keeps its place", () => {
    let queue = upsertDockItem([], item("a", 1));
    queue = upsertDockItem(queue, item("b", 2));
    queue = upsertDockItem(queue, item("a", 99, "completed"));
    expect(queue.map((entry) => [entry.captureId, entry.addedAt])).toEqual([
      ["b", 2],
      ["a", 1]
    ]);
    expect(queue[1]?.enrichment?.status).toBe("completed");
  });

  test("a snap that joins in the same millisecond goes on top", () => {
    const queue = upsertDockItem([item("old", 7)], item("new", 7));
    expect(queue.map((entry) => entry.captureId)).toEqual(["new", "old"]);
  });

  test("a refresh without a record or enrichment keeps the ones it has", () => {
    const queue = upsertDockItem([item("a", 1)], {
      captureId: "a",
      addedAt: 5,
      record: null,
      enrichment: null
    });
    expect(queue[0]?.record?.id).toBe("a");
    expect(queue[0]?.enrichment?.status).toBe("running");
  });

  test("enrichment updates land on their own snap only", () => {
    const queue = [item("a", 1), item("b", 2)];
    const next = updateDockEnrichment(queue, enrichment("b", "completed"));
    expect(next.map((entry) => entry.enrichment?.status)).toEqual(["running", "completed"]);
    expect(updateDockEnrichment(queue, enrichment("zzz", "completed"))).toEqual(queue);
    expect(removeDockItem(queue, "a").map((entry) => entry.captureId)).toEqual(["b"]);
  });

  test("Clear finished keeps every snap still being read, and the one on screen", () => {
    const queue = [
      item("reading", 1),
      item("done", 2, "completed"),
      item("broken", 3, "failed"),
      item("showing", 4, "completed")
    ];
    expect(hasFinishedDockItems(queue)).toBe(true);
    expect(hasFinishedDockItems([item("reading", 1)])).toBe(false);
    expect(hasFinishedDockItems([item("showing", 4, "completed")], "showing")).toBe(false);
    expect(
      clearFinishedDockItems(queue, "showing").map((entry) => entry.captureId)
    ).toEqual(["reading", "showing"]);
  });

  test("the rail lists the waiting snaps plus the one on screen", () => {
    const rail = railDockItems([item("a", 1)], item("fresh", 9, null));
    expect(rail.map((entry) => entry.captureId)).toEqual(["fresh", "a"]);
    expect(railDockItems([item("a", 1)], null).map((entry) => entry.captureId)).toEqual(["a"]);
  });
});

describe("visible cap", () => {
  const five = [1, 2, 3, 4, 5].map((n) => item(`s${n}`, n));

  test("shows the newest three and folds the rest", () => {
    const { visible, overflow } = splitDockItems(five, 3);
    expect(visible.map((entry) => entry.captureId)).toEqual(["s5", "s4", "s3"]);
    expect(overflow.map((entry) => entry.captureId)).toEqual(["s2", "s1"]);
  });

  test("never folds away the snap the toast is showing", () => {
    const { visible, overflow } = splitDockItems(five, 3, "s1");
    expect(visible.map((entry) => entry.captureId)).toEqual(["s5", "s4", "s1"]);
    expect(overflow.map((entry) => entry.captureId)).toEqual(["s3", "s2"]);
  });

  test("three or fewer: nothing folds", () => {
    expect(splitDockItems(five.slice(0, 3), 3).overflow).toEqual([]);
  });
});

describe("labels", () => {
  test("ages read m:ss, and h:mm:ss past an hour", () => {
    expect(formatDockAge(-5)).toBe("0:00");
    expect(formatDockAge(31_400)).toBe("0:31");
    expect(formatDockAge(125_000)).toBe("2:05");
    expect(formatDockAge(3_725_000)).toBe("1:02:05");
  });

  test("a snap is named by the model once it has, by its source until then", () => {
    const base = item("a", 0);
    expect(dockItemTitle({ ...base, record: record("a", { source_app_name: "Toaster" }) })).toBe(
      "Toaster snap · 1,280 × 800"
    );
    expect(dockItemTitle({ ...base, record: record("a", { kind: "video" }) })).toBe(
      "Recording · 1,280 × 800"
    );
    expect(
      dockItemTitle({
        ...base,
        enrichment: enrichment("a", "completed", { suggestedTitle: "  Cereal box pricing grid " })
      })
    ).toBe("Cereal box pricing grid");
    expect(dockItemTitle({ ...base, record: null, enrichment: null })).toBe("Snap");
  });

  test("an overflow row says what the snap is, where it stands, and how long it has waited", () => {
    expect(dockItemLabel(item("a", 1_000), 32_000)).toBe("Snap · 1,280 × 800 — reading · 0:31");
  });
});
