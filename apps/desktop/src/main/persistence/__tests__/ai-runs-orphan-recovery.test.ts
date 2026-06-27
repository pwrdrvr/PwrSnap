// Tests for `failOrphanedRunsOnBoot` — the boot-time sweep that rescues
// enrichment runs wedged in `queued`/`running` when the owning process
// died mid-turn. User-reported bug: a 10-day-old snap stuck on "Kimi is
// reading the snap" forever, with the Regenerate button hidden (it's
// hidden while queued/running) so there was no way to retry. The live
// run's abort handle lives in an in-memory Map that doesn't survive a
// process exit, so at boot any queued/running row is orphaned and must
// be reset to a terminal state.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let testDb: Database.Database;

vi.mock("../db", () => ({
  getDb: () => testDb
}));

const { createAiRun, markAiRunRunning, getAiRun, failOrphanedRunsOnBoot, ORPHANED_RUN_ERROR } =
  await import("../ai-runs-repo");

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

function seedCapture(id: string): void {
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
        @id, 'image', '2026-06-17T21:08:51.000Z',
        NULL, NULL,
        NULL, @bundlePath, NULL,
        '2026-06-17T21:08:51.000Z', 2, 0,
        2880, 1920, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({ id, bundlePath: `/tmp/${id}.pwrsnap`, sha: `sha_${id}` });
}

beforeEach(() => {
  testDb = new Database(":memory:");
  applyAllMigrations();
});

afterEach(() => {
  testDb.close();
});

describe("failOrphanedRunsOnBoot", () => {
  test("resets a stuck 'running' run to 'failed' with the orphan error", () => {
    seedCapture("cap-running");
    const run = createAiRun({ captureId: "cap-running", triggerSource: "auto-enrichment" });
    markAiRunRunning(run.id);
    expect(getAiRun(run.id)?.status).toBe("running");

    const reset = failOrphanedRunsOnBoot();

    expect(reset).toBe(1);
    const after = getAiRun(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe(ORPHANED_RUN_ERROR);
  });

  test("resets a stuck 'queued' run too (never reached running)", () => {
    seedCapture("cap-queued");
    const run = createAiRun({ captureId: "cap-queued", triggerSource: "auto-enrichment" });
    expect(getAiRun(run.id)?.status).toBe("queued");

    expect(failOrphanedRunsOnBoot()).toBe(1);
    expect(getAiRun(run.id)?.status).toBe("failed");
  });

  test("leaves terminal runs untouched", () => {
    seedCapture("cap-done");
    const completed = createAiRun({ captureId: "cap-done", triggerSource: "auto-enrichment" });
    testDb
      .prepare("UPDATE ai_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
      .run(completed.id);

    seedCapture("cap-fail");
    const failed = createAiRun({ captureId: "cap-fail", triggerSource: "auto-enrichment" });
    testDb
      .prepare("UPDATE ai_runs SET status = 'failed', error = 'real failure' WHERE id = ?")
      .run(failed.id);

    expect(failOrphanedRunsOnBoot()).toBe(0);
    expect(getAiRun(completed.id)?.status).toBe("completed");
    expect(getAiRun(failed.id)?.status).toBe("failed");
    // Pre-existing failure message must not be clobbered.
    expect(getAiRun(failed.id)?.error).toBe("real failure");
  });

  test("is a no-op when there is nothing to reset", () => {
    expect(failOrphanedRunsOnBoot()).toBe(0);
  });
});
