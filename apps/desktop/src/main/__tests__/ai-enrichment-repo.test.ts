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
  acceptTitle,
  acceptSuggestedTag,
  addUserTag,
  getCaptureEnrichment,
  getEnrichmentSummaries,
  getTopUserTags,
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
    testDb.exec(migration("0007_ai_enrichment_title.sql"));
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
        title: "",
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
      result: { ocrText: "", title: "", description: "Original suggestion", tags: [] }
    });

    const enrichment = acceptDescription("cap_1", "Edited by user");

    expect(enrichment.suggestedDescription).toBe("Original suggestion");
    expect(enrichment.acceptedDescription).toBe("Edited by user");
    expect(enrichment.descriptionAcceptedAt).not.toBeNull();
  });

  test("stores and accepts a separate title", () => {
    const run = createAiRun({ captureId: "cap_1" });
    storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: {
        ocrText: "",
        title: "Codex draft headline",
        description: "Codex draft description body",
        tags: []
      }
    });

    const enrichment = acceptTitle("cap_1", "User edited headline");

    expect(enrichment.suggestedTitle).toBe("Codex draft headline");
    expect(enrichment.acceptedTitle).toBe("User edited headline");
    expect(enrichment.titleAcceptedAt).not.toBeNull();
    expect(enrichment.suggestedDescription).toBe("Codex draft description body");
    expect(enrichment.acceptedDescription).toBeNull();
  });

  test("accepts a suggested tag once even when suggested twice", () => {
    const run = createAiRun({ captureId: "cap_1" });
    const first = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: {
        ocrText: "",
        title: "",
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
        result: { ocrText: "x", title: "", description: "x", tags: [] }
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
        title: "",
        description: "Newer suggestion",
        tags: [{ label: "new", confidence: 0.9 }]
      }
    });
    const afterStale = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: older.id,
      result: {
        ocrText: "old text",
        title: "",
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
      result: { ocrText: "late", title: "", description: "Late completion", tags: [] }
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
        title: "",
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
        title: "",
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
      result: { ocrText: "secret text", title: "", description: "desc", tags: [{ label: "bug", confidence: 1 }] }
    });
    acceptSuggestedTag("cap_1", enrichment.suggestedTags[0]!.id!);

    expect(getEnrichmentSummaries(["cap_1"])).toEqual([
      {
        captureId: "cap_1",
        status: "queued",
        acceptedTitle: null,
        acceptedDescription: null,
        acceptedTags: ["bug"],
        suggestedTagCount: 0
      }
    ]);
  });

  test("addUserTag persists a free-form user tag and is idempotent", () => {
    const enrichment = addUserTag("cap_1", "Custom Tag");

    expect(enrichment.acceptedTags).toEqual(["Custom Tag"]);

    // Idempotent — re-adding the same tag doesn't duplicate.
    const after = addUserTag("cap_1", "  custom tag  ");
    expect(after.acceptedTags).toEqual(["Custom Tag"]);

    // Source = 'user' (not 'codex') so the bias-hint query
    // doesn't conflate user-typed tags with codex-suggested ones.
    const row = testDb
      .prepare(
        `SELECT capture_tags.source FROM capture_tags
         JOIN tags ON tags.id = capture_tags.tag_id
         WHERE capture_tags.capture_id = ? AND tags.normalized_label = ?`
      )
      .get("cap_1", "custom tag") as { source: string } | undefined;
    expect(row?.source).toBe("user");
  });

  test("addUserTag throws on empty / whitespace-only labels", () => {
    expect(() => addUserTag("cap_1", "")).toThrow();
    expect(() => addUserTag("cap_1", "   ")).toThrow();
  });

  test("addUserTag throws when the capture is deleted or missing", () => {
    testDb.prepare("UPDATE captures SET deleted_at = datetime('now') WHERE id = ?").run("cap_1");
    expect(() => addUserTag("cap_1", "Whatever")).toThrow(/not found or deleted/);
    expect(() => addUserTag("cap_missing", "Whatever")).toThrow(/not found or deleted/);
  });

  test("storeCompletedEnrichment with autoAccept promotes suggestions and top tags", () => {
    const run = createAiRun({ captureId: "cap_1" });
    const enrichment = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: {
        ocrText: "Build passed",
        title: "Deploy succeeded",
        description: "CI dashboard with a green deploy badge.",
        tags: [
          { label: "ci", confidence: 0.95 },
          { label: "deploy", confidence: 0.9 },
          { label: "dashboard", confidence: 0.85 }
        ]
      },
      autoAccept: true
    });

    expect(enrichment.acceptedTitle).toBe("Deploy succeeded");
    expect(enrichment.acceptedDescription).toBe("CI dashboard with a green deploy badge.");
    expect(enrichment.titleAcceptedAt).not.toBeNull();
    expect(enrichment.descriptionAcceptedAt).not.toBeNull();
    // Top 2 tags promoted; the third stays as a pending suggestion.
    expect(enrichment.acceptedTags).toEqual(["ci", "deploy"]);
    expect(
      enrichment.suggestedTags.filter(
        (tag) => tag.accepted_at === null && tag.rejected_at === null
      ).map((tag) => tag.label)
    ).toEqual(["dashboard"]);
  });

  test("autoAccept does NOT overwrite an existing accepted_title or accepted_description", () => {
    const run = createAiRun({ captureId: "cap_1" });
    storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: { ocrText: "", title: "Old draft", description: "Old body", tags: [] }
    });
    // User-typed values in between Codex runs.
    acceptTitle("cap_1", "User-edited title");
    acceptDescription("cap_1", "User-edited description");

    const newRun = createAiRun({ captureId: "cap_1" });
    setLatestEnrichmentRun("cap_1", newRun.id);
    const after = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: newRun.id,
      result: {
        ocrText: "",
        title: "Fresh codex headline",
        description: "Fresh codex body",
        tags: []
      },
      autoAccept: true
    });

    expect(after.acceptedTitle).toBe("User-edited title");
    expect(after.acceptedDescription).toBe("User-edited description");
    expect(after.suggestedTitle).toBe("Fresh codex headline");
    expect(after.suggestedDescription).toBe("Fresh codex body");
  });

  test("autoAccept off (default) leaves accepted_* untouched", () => {
    const run = createAiRun({ captureId: "cap_1" });
    const enrichment = storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: {
        ocrText: "",
        title: "Draft title",
        description: "Draft body",
        tags: [{ label: "ci", confidence: 1 }]
      }
    });

    expect(enrichment.suggestedTitle).toBe("Draft title");
    expect(enrichment.suggestedDescription).toBe("Draft body");
    expect(enrichment.acceptedTitle).toBeNull();
    expect(enrichment.acceptedDescription).toBeNull();
    expect(enrichment.acceptedTags).toEqual([]);
  });

  test("getTopUserTags ranks accepted content tags by usage", () => {
    seedCapture("cap_2");
    seedCapture("cap_3");
    const run1 = createAiRun({ captureId: "cap_1" });
    const run2 = createAiRun({ captureId: "cap_2" });
    const run3 = createAiRun({ captureId: "cap_3" });
    storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run1.id,
      result: {
        ocrText: "",
        title: "",
        description: "x",
        tags: [
          { label: "deploy", confidence: 1 },
          { label: "ci", confidence: 1 }
        ]
      }
    });
    storeCompletedEnrichment({
      captureId: "cap_2",
      aiRunId: run2.id,
      result: {
        ocrText: "",
        title: "",
        description: "x",
        tags: [
          { label: "deploy", confidence: 1 },
          { label: "design-review", confidence: 1 }
        ]
      }
    });
    storeCompletedEnrichment({
      captureId: "cap_3",
      aiRunId: run3.id,
      result: {
        ocrText: "",
        title: "",
        description: "x",
        tags: [{ label: "deploy", confidence: 1 }]
      }
    });

    const captureMap: Record<string, string> = { cap_1: run1.id, cap_2: run2.id, cap_3: run3.id };
    for (const [captureId, runId] of Object.entries(captureMap)) {
      const enrichment = getCaptureEnrichment(captureId)!;
      for (const tag of enrichment.suggestedTags) {
        if (tag.id !== undefined) acceptSuggestedTag(captureId, tag.id);
      }
      void runId;
    }

    expect(getTopUserTags(10)).toEqual(["deploy", "ci", "design-review"]);
  });

  test("purging capture cascades enrichment rows", () => {
    const run = createAiRun({ captureId: "cap_1" });
    storeCompletedEnrichment({
      captureId: "cap_1",
      aiRunId: run.id,
      result: { ocrText: "Build passed", title: "", description: "desc", tags: [{ label: "ci", confidence: 1 }] }
    });

    testDb.prepare("DELETE FROM captures WHERE id = ?").run("cap_1");

    expect(testDb.prepare("SELECT COUNT(*) AS n FROM ai_runs").get()).toEqual({ n: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM capture_enrichments").get()).toEqual({ n: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM enrichment_tag_suggestions").get()).toEqual({
      n: 0
    });
  });
});
