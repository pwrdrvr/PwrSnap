import { describe, expect, test } from "vitest";
import type { CaptureEnrichment, CaptureRecord } from "@pwrsnap/shared";
import {
  clearFinishedDockItems,
  dockItemLabel,
  dockItemTitle,
  dockItemStatus,
  dockStatus,
  hasFinishedDockItems,
  isLeavingSnapInFlight,
  mayAwaitFirstRun,
  catalogRailItems,
  mergeCatalogRecords,
  railInFlightCount,
  removeCatalogRecords,
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
  test("a retained snap with no expected AI run has no status glyph and can be cleared", () => {
    const saved = { ...item("saved", 1, null), awaitingFirstRun: false };
    expect(dockItemStatus(saved)).toBeNull();
    expect(dockItemLabel(saved)).toBe(dockItemTitle(saved));
    expect(hasFinishedDockItems([saved])).toBe(true);
    expect(clearFinishedDockItems([saved])).toEqual([]);
    expect(catalogRailItems([saved.record!], [saved], null, false)[0]?.status).toBeNull();
    expect(dockItemStatus({ ...saved, enrichment: enrichment("saved", "running") })).toBe("reading");
  });

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

});

describe("the rail's catalog", () => {
  const at = (id: string, capturedAt: string): CaptureRecord =>
    record(id, { captured_at: capturedAt });
  const older = at("older", "2026-09-27T09:00:00.000Z");
  const middle = at("middle", "2026-09-27T09:30:00.000Z");
  const newest = at("newest", "2026-09-27T10:00:00.000Z");

  test("is newest first by capture time, whatever order records arrive in", () => {
    const rows = mergeCatalogRecords([older], [newest, middle]);
    expect(rows.map((row) => row.id)).toEqual(["newest", "middle", "older"]);
  });

  test("a refreshed record replaces its row; a deleted one leaves", () => {
    const edited = { ...middle, edits_version: 3 };
    const rows = mergeCatalogRecords([newest, middle, older], [
      edited,
      { ...older, deleted_at: "2026-09-27T11:00:00.000Z" }
    ]);
    expect(rows.map((row) => row.id)).toEqual(["newest", "middle"]);
    expect(rows[1]?.edits_version).toBe(3);
    expect(removeCatalogRecords(rows, ["newest"]).map((row) => row.id)).toEqual(["middle"]);
  });

  test("opening a snap removes nothing and reorders nothing", () => {
    const catalog = [newest, middle, older];
    const current = { captureId: "older", addedAt: 5, record: older, enrichment: null };
    const rail = catalogRailItems(catalog, [], current, true);
    expect(rail.map((row) => row.captureId)).toEqual(["newest", "middle", "older"]);
  });

  test("the toast's own snap is listed before the catalog has heard of it", () => {
    const fresh = at("fresh", "2026-09-27T10:05:00.000Z");
    const current = { captureId: "fresh", addedAt: 9, record: fresh, enrichment: null };
    const rail = catalogRailItems([newest, older], [], current, true);
    expect(rail.map((row) => row.captureId)).toEqual(["fresh", "newest", "older"]);
  });

  test("glyphs only where the model is on a snap, or a waiting snap finished unseen", () => {
    const queue = [
      { ...item("newest", 3, "completed"), record: newest },
      { ...item("middle", 2, "running"), record: middle }
    ];
    const current = { captureId: "older", addedAt: 5, record: older, enrichment: enrichment("older", "completed") };
    const rail = catalogRailItems([newest, middle, older], queue, current, true);
    expect(rail.map((row) => row.status)).toEqual(["ready", "reading", null]);
    expect(railInFlightCount(rail)).toBe(1);
  });

  test("only a snap just taken can still be waiting for its first run", () => {
    const takenAt = Date.parse(newest.captured_at);
    expect(mayAwaitFirstRun(newest, takenAt + 5_000)).toBe(true);
    expect(mayAwaitFirstRun(newest, takenAt + 10 * 60_000)).toBe(false);
    expect(mayAwaitFirstRun(null, takenAt)).toBe(true);
  });

  test("the toast's own snap shows the model still reading it", () => {
    const current = { captureId: "newest", addedAt: 5, record: newest, enrichment: null };
    expect(catalogRailItems([newest], [], current, true)[0]?.status).toBe("waiting");
    // With AI off, "no run yet" means never.
    expect(catalogRailItems([newest], [], current, false)[0]?.status).toBeNull();
  });
});

describe("visible cap", () => {
  const five = [1, 2, 3, 4, 5].map((n) => item(`s${n}`, n));

  test("shows the newest three and folds the rest", () => {
    const { visible, overflow } = splitDockItems(five, 3);
    expect(visible.map((entry) => entry.captureId)).toEqual(["s5", "s4", "s3"]);
    expect(overflow.map((entry) => entry.captureId)).toEqual(["s2", "s1"]);
  });

  test("three or fewer: nothing folds", () => {
    expect(splitDockItems(five.slice(0, 3), 3).overflow).toEqual([]);
  });
});

describe("labels", () => {
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

  test("an overflow row says what the snap is and where it stands", () => {
    expect(dockItemLabel(item("a", 1_000))).toBe("Snap · 1,280 × 800 — reading");
  });
});
