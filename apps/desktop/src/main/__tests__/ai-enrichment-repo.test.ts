import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let testDb: Database.Database;

vi.mock("../persistence/db", () => ({
  getDb: () => testDb
}));

const { createAiRun, failAiRun } = await import("../persistence/ai-runs-repo");
const {
  acceptDescription,
  acceptSuggestedTag,
  getCaptureEnrichment,
  getEnrichmentSummaries,
  setLatestEnrichmentRun,
  storeCompletedEnrichment
} = await import("../persistence/enrichment-repo");

function migration(name: string): string {
  return readFileSync(new URL(`../persistence/migrations/${name}`, import.meta.url), "utf8");
}

function seedCapture(id = "cap_1"): void {
  testDb
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at,
        source_app_bundle_id, source_app_name, src_path,
        width_px, height_px, device_pixel_ratio,
        byte_size, sha256, overlays_version, deleted_at
      ) VALUES (
        @id, 'image', '2026-05-12T12:00:00.000Z',
        NULL, NULL, '/tmp/capture.png',
        1200, 800, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({ id, sha: `sha_${id}` });
}

describe("AI enrichment repositories", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    testDb.pragma("foreign_keys = ON");
    testDb.exec(migration("0001_init.sql"));
    testDb.exec(migration("0006_ai_enrichment.sql"));
    seedCapture();
  });

  afterEach(() => {
    testDb.close();
  });

  test("stores a completed enrichment and reads suggestions", () => {
    const run = createAiRun({ captureId: "cap_1" });
    const enrichment = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: {
        ocrText: "Build passed",
        description: "CI dashboard with a successful build",
        tags: [
          { label: "CI", confidence: 0.9 },
          { label: "deploy", confidence: 0.8 }
        ]
      }
    });

    expect(enrichment.ocrText).toBe("Build passed");
    expect(enrichment.suggestedTags.map((tag) => tag.label)).toEqual(["CI", "deploy"]);
    expect(enrichment.acceptedTags).toEqual([]);
  });

  test("accepts an edited description while preserving the suggestion", () => {
    const run = createAiRun({ captureId: "cap_1" });
    storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: { ocrText: "", description: "Original suggestion", tags: [] }
    });

    const enrichment = acceptDescription("cap_1", "Edited by user");

    expect(enrichment.suggestedDescription).toBe("Original suggestion");
    expect(enrichment.acceptedDescription).toBe("Edited by user");
    expect(enrichment.descriptionAcceptedAt).not.toBeNull();
  });

  test("accepts a suggested tag once even when suggested twice", () => {
    const run = createAiRun({ captureId: "cap_1" });
    const first = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: {
        ocrText: "",
        description: "",
        tags: [
          { label: "Deploy", confidence: 0.9 },
          { label: "deploy", confidence: 0.8 }
        ]
      }
    });

    const tagId = first.suggestedTags[0]!.id!;
    const accepted = acceptSuggestedTag("cap_1", tagId);
    const acceptedAgain = acceptSuggestedTag("cap_1", tagId);

    expect(accepted.acceptedTags).toEqual(["Deploy"]);
    expect(acceptedAgain.acceptedTags).toEqual(["Deploy"]);
  });

  test("does not store enrichment for a deleted capture", () => {
    const run = createAiRun({ captureId: "cap_1" });
    testDb.prepare("UPDATE captures SET deleted_at = datetime('now') WHERE id = ?").run("cap_1");

    expect(() =>
      storeCompletedEnrichment({
        captureId: "cap_1",
        aiRunId: run.id,
        result: { ocrText: "x", description: "x", tags: [] }
      })
    ).toThrow(/deleted/);
  });

  test("failed run does not update enrichment", () => {
    const run = createAiRun({ captureId: "cap_1" });
    failAiRun(run.id, "schema_mismatch");

    const enrichment = getCaptureEnrichment("cap_1");

    expect(enrichment?.ocrText).toBeNull();
    expect(enrichment?.suggestedTags).toEqual([]);
  });

  test("latest run is visible before completion", () => {
    const run = createAiRun({ captureId: "cap_1" });
    const enrichment = setLatestEnrichmentRun("cap_1", run.id);

    expect(enrichment.latestRunId).toBe(run.id);
    expect(enrichment.status).toBe("queued");
    expect(enrichment.ocrText).toBeNull();
  });

  test("summaries are batch-friendly and compact", () => {
    const run = createAiRun({ captureId: "cap_1" });
    const enrichment = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: { ocrText: "secret text", description: "desc", tags: [{ label: "bug", confidence: 1 }] }
    });
    acceptSuggestedTag("cap_1", enrichment.suggestedTags[0]!.id!);

    expect(getEnrichmentSummaries(["cap_1"])).toEqual([
      {
        captureId: "cap_1",
        status: "queued",
        acceptedDescription: null,
        acceptedTags: ["bug"],
        suggestedTagCount: 0
      }
    ]);
  });

  test("purging capture cascades enrichment rows", () => {
    const run = createAiRun({ captureId: "cap_1" });
    storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: { ocrText: "Build passed", description: "desc", tags: [{ label: "ci", confidence: 1 }] }
    });

    testDb.prepare("DELETE FROM captures WHERE id = ?").run("cap_1");

    expect(testDb.prepare("SELECT COUNT(*) AS n FROM ai_runs").get()).toEqual({ n: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM capture_enrichments").get()).toEqual({ n: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM enrichment_tag_suggestions").get()).toEqual({
      n: 0
    });
  });
});
