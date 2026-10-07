// Which captures the enrichment repair dialog counts and re-runs. Runs the
// real migrations into an in-memory database, so the joins are checked
// against the shipped schema.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EnrichmentRepairCriteria } from "@pwrsnap/shared";

let testDb: Database.Database;

vi.mock("../db", () => ({
  getDb: () => testDb
}));

const { createAiRun, completeAiRun, failAiRun, cancelAiRun, markAiRunRunning } = await import("../ai-runs-repo");
const { setLatestEnrichmentRun } = await import("../enrichment-repo");
const { previewEnrichmentRepair, listEnrichmentRepairCaptureIds, enrichmentRepairStatusOf } = await import(
  "../enrichment-repair-repo"
);

function applyAllMigrations(): void {
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  testDb.pragma("foreign_keys = OFF");
  for (const file of files) {
    testDb.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  testDb.pragma("foreign_keys = ON");
}

function seedCapture(
  id: string,
  opts: { capturedAt: string; bundleId?: string | null; appName?: string | null; deleted?: boolean }
): void {
  testDb
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at,
        source_app_bundle_id, source_app_name,
        legacy_src_path, bundle_path, flat_png_path,
        bundle_modified_at, bundle_format_version, bundle_edits_version,
        width_px, height_px, device_pixel_ratio,
        byte_size, sha256, edits_version, deleted_at
      ) VALUES (
        @id, 'image', @capturedAt,
        @bundleId, @appName,
        NULL, @bundlePath, NULL,
        @capturedAt, 2, 0,
        100, 100, 1,
        1000, @sha, 0, @deletedAt
      )`
    )
    .run({
      id,
      capturedAt: opts.capturedAt,
      bundleId: opts.bundleId ?? null,
      appName: opts.appName ?? null,
      bundlePath: `/tmp/${id}.pwrsnap`,
      sha: `sha_${id}`,
      deletedAt: opts.deleted === true ? "2026-10-01T00:00:00.000Z" : null
    });
}

function runWithStatus(captureId: string, status: "completed" | "failed" | "cancelled" | "running"): void {
  const run = createAiRun({ captureId, triggerSource: "auto-enrichment" });
  setLatestEnrichmentRun(captureId, run.id);
  if (status === "completed") completeAiRun(run.id, {}, 10);
  else if (status === "failed") failAiRun(run.id, "boom", 10);
  else if (status === "cancelled") cancelAiRun(run.id);
  else markAiRunRunning(run.id);
}

function criteria(patch: Partial<EnrichmentRepairCriteria> = {}): EnrichmentRepairCriteria {
  return {
    statuses: ["failed", "never"],
    since: null,
    until: null,
    apps: { mode: "include", appIds: [] },
    ...patch
  };
}

beforeEach(() => {
  testDb = new Database(":memory:");
  applyAllMigrations();
  // Newest first: c-new-failed is the newest capture.
  seedCapture("c-new-failed", { capturedAt: "2026-10-06T10:00:00.000Z", bundleId: "com.Apple.Safari", appName: "Safari" });
  seedCapture("c-never", { capturedAt: "2026-10-05T10:00:00.000Z", bundleId: "com.apple.safari", appName: "Safari" });
  seedCapture("c-cancelled", { capturedAt: "2026-10-04T10:00:00.000Z", bundleId: "com.tinyspeck.slackmacgap", appName: "Slack" });
  seedCapture("c-done", { capturedAt: "2026-10-03T10:00:00.000Z", bundleId: "com.apple.safari", appName: "Safari" });
  seedCapture("c-running", { capturedAt: "2026-10-02T10:00:00.000Z", bundleId: "com.apple.safari", appName: "Safari" });
  seedCapture("c-old-failed", { capturedAt: "2026-09-01T10:00:00.000Z", bundleId: null });
  seedCapture("c-trashed", { capturedAt: "2026-10-06T11:00:00.000Z", bundleId: "com.apple.safari", deleted: true });
  runWithStatus("c-new-failed", "failed");
  runWithStatus("c-cancelled", "cancelled");
  runWithStatus("c-done", "completed");
  runWithStatus("c-running", "running");
  runWithStatus("c-old-failed", "failed");
});

afterEach(() => {
  testDb.close();
});

describe("enrichment repair candidates", () => {
  test("failed covers failed and cancelled; never covers no run at all; live and trashed captures are left out", () => {
    expect(listEnrichmentRepairCaptureIds(criteria({ statuses: ["failed"] }))).toEqual([
      "c-new-failed",
      "c-cancelled",
      "c-old-failed"
    ]);
    expect(listEnrichmentRepairCaptureIds(criteria({ statuses: ["never"] }))).toEqual(["c-never"]);
  });

  test("runs newest first across both statuses", () => {
    expect(listEnrichmentRepairCaptureIds(criteria())).toEqual([
      "c-new-failed",
      "c-never",
      "c-cancelled",
      "c-old-failed"
    ]);
  });

  test("a capture whose run row was deleted counts as never ran", () => {
    seedCapture("c-orphan", { capturedAt: "2026-10-07T10:00:00.000Z" });
    runWithStatus("c-orphan", "failed");
    testDb.prepare("DELETE FROM ai_runs WHERE capture_id = ?").run("c-orphan");
    expect(enrichmentRepairStatusOf("c-orphan")).toBe("never");
  });

  test("the time window is [since, until)", () => {
    expect(
      listEnrichmentRepairCaptureIds(
        criteria({ since: "2026-10-04T10:00:00.000Z", until: "2026-10-06T10:00:00.000Z" })
      )
    ).toEqual(["c-never", "c-cancelled"]);
  });

  test("apps are matched by lowercased bundle id, with \"\" for no recorded app", () => {
    expect(
      listEnrichmentRepairCaptureIds(criteria({ apps: { mode: "include", appIds: ["com.apple.safari"] } }))
    ).toEqual(["c-new-failed", "c-never"]);
    expect(listEnrichmentRepairCaptureIds(criteria({ apps: { mode: "include", appIds: [""] } }))).toEqual([
      "c-old-failed"
    ]);
    expect(
      listEnrichmentRepairCaptureIds(criteria({ apps: { mode: "exclude", appIds: ["com.apple.safari", ""] } }))
    ).toEqual(["c-cancelled"]);
  });

  test("preview counts per status with every other criterion, and per app without the app facet", () => {
    const preview = previewEnrichmentRepair(
      criteria({ statuses: ["failed"], apps: { mode: "include", appIds: ["com.apple.safari"] } })
    );
    expect(preview.total).toBe(1);
    expect(preview.byStatus).toEqual({ failed: 1, never: 1 });
    expect(preview.apps).toEqual([
      { appKey: "", bundleId: null, name: null, count: 1 },
      { appKey: "com.apple.safari", bundleId: "com.Apple.Safari", name: "Safari", count: 1 },
      { appKey: "com.tinyspeck.slackmacgap", bundleId: "com.tinyspeck.slackmacgap", name: "Slack", count: 1 }
    ]);
  });

  test("statusOf reports where a capture stands now", () => {
    expect(enrichmentRepairStatusOf("c-new-failed")).toBe("failed");
    expect(enrichmentRepairStatusOf("c-cancelled")).toBe("failed");
    expect(enrichmentRepairStatusOf("c-never")).toBe("never");
    expect(enrichmentRepairStatusOf("c-done")).toBe("other");
    expect(enrichmentRepairStatusOf("c-running")).toBe("other");
    expect(enrichmentRepairStatusOf("c-trashed")).toBe("gone");
    expect(enrichmentRepairStatusOf("missing")).toBe("gone");
  });
});
