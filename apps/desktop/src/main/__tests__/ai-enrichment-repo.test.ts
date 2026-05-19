import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let testDb: Database.Database;

vi.mock("../persistence/db", () => ({
  getDb: () => testDb
}));

const { cancelAiRun, completeAiRun, createAiRun, failAiRun } = await import(
  "../persistence/ai-runs-repo"
);
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

  test("stale completion does not overwrite the latest run result", () => {
    const older = createAiRun({ captureId: "cap_1" });
    setLatestEnrichmentRun("cap_1", older.id);
    const newer = createAiRun({ captureId: "cap_1" });
    setLatestEnrichmentRun("cap_1", newer.id);

    storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: newer.id,
      result: {
        ocrText: "new text",
        description: "Newer suggestion",
        tags: [{ label: "new", confidence: 0.9 }]
      }
    });
    const afterStale = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: older.id,
      result: {
        ocrText: "old text",
        description: "Older suggestion",
        tags: [{ label: "old", confidence: 0.9 }]
      }
    });

    expect(afterStale.latestRunId).toBe(newer.id);
    expect(afterStale.ocrText).toBe("new text");
    expect(afterStale.suggestedDescription).toBe("Newer suggestion");
    expect(afterStale.suggestedTags.map((tag) => tag.label)).toEqual(["new"]);
  });

  test("cancelled latest run cannot store a late completion", () => {
    const run = createAiRun({ captureId: "cap_1" });
    setLatestEnrichmentRun("cap_1", run.id);
    cancelAiRun(run.id);
    completeAiRun(run.id, { ocrText: "late", description: "late", tags: [] }, 10);

    const enrichment = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: { ocrText: "late", description: "Late completion", tags: [] }
    });

    expect(enrichment.latestRunId).toBe(run.id);
    expect(enrichment.status).toBe("cancelled");
    expect(enrichment.ocrText).toBeNull();
    expect(enrichment.suggestedDescription).toBeNull();
  });

  test("only latest run suggestions are presented and accepted", () => {
    const first = createAiRun({ captureId: "cap_1" });
    setLatestEnrichmentRun("cap_1", first.id);
    const firstEnrichment = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: first.id,
      result: {
        ocrText: "",
        description: "First suggestion",
        tags: [{ label: "stale", confidence: 0.9 }]
      }
    });
    const staleTagId = firstEnrichment.suggestedTags[0]!.id!;

    const second = createAiRun({ captureId: "cap_1" });
    setLatestEnrichmentRun("cap_1", second.id);
    const latest = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: second.id,
      result: {
        ocrText: "",
        description: "Second suggestion",
        tags: [{ label: "fresh", confidence: 0.8 }]
      }
    });

    expect(latest.suggestedTags.map((tag) => tag.label)).toEqual(["fresh"]);
    expect(() => acceptSuggestedTag("cap_1", staleTagId)).toThrow(/tag suggestion not found/);
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
