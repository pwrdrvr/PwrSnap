import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let testDb: Database.Database;

vi.mock("../persistence/db", () => ({
  getDb: () => testDb
}));

const { createAiRun } = await import("../persistence/ai-runs-repo");
const {
  getAiRunUsageDetail,
  getAiUsageSummary,
  listAiUsageRuns,
  replaceAiRunMediaInputs,
  saveAiRunUsage
} = await import("../persistence/ai-usage-repo");

function migration(name: string): string {
  return readFileSync(new URL(`../persistence/migrations/${name}`, import.meta.url), "utf8");
}

function seedCapture(id = "cap_1"): void {
  testDb
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at,
        source_app_bundle_id, source_app_name, legacy_src_path,
        width_px, height_px, device_pixel_ratio,
        byte_size, sha256, edits_version, deleted_at
      ) VALUES (
        @id, 'image', '2026-05-12T12:00:00.000Z',
        NULL, NULL, '/tmp/capture.png',
        1200, 800, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({ id, sha: `sha_${id}` });
}

function applyMigrations(): void {
  testDb.exec(migration("0001_init.sql"));
  testDb.exec(migration("0006_ai_enrichment.sql"));
  testDb.pragma("foreign_keys = OFF");
  testDb.exec(migration("0007_bundle_storage.sql"));
  testDb.pragma("foreign_keys = ON");
  testDb.exec(migration("0008_layers.sql"));
  testDb.exec(migration("0009_legacy_bundle_migration_attempts.sql"));
  testDb.exec(migration("0010_ai_enrichment_title.sql"));
  testDb.exec(migration("0011_ai_enrichment_filename.sql"));
  testDb.exec(migration("0022_ai_usage_accounting.sql"));
}

describe("AI usage repository", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    testDb.pragma("foreign_keys = ON");
    applyMigrations();
    seedCapture();
  });

  afterEach(() => {
    testDb.close();
  });

  test("stores usage, cost, and media detail for a run", () => {
    const run = createAiRun({
      captureId: "cap_1",
      task: "enrich",
      triggerSource: "library-regenerate",
      selectedModel: "gpt-5.4-mini"
    });
    saveAiRunUsage({
      aiRunId: run.id,
      threadId: "thread-1",
      turnId: "turn-1",
      model: "gpt-5.4-mini",
      modelProvider: "openai",
      serviceTier: null,
      usageStatus: "available",
      tokens: {
        totalTokens: 1_500,
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 500,
        reasoningOutputTokens: 50,
        modelContextWindow: 400_000
      },
      cost: {
        status: "available",
        currency: "USD",
        catalogVersion: "2026-05-30",
        pricingSourceUrl: "https://developers.openai.com/api/docs/pricing",
        pricedAt: "2026-05-30T00:00:00.000Z",
        rateSnapshot: {
          model: "gpt-5.4-mini",
          serviceTier: null,
          contextClass: "standard",
          inputUsdPerMillion: 0.75,
          cachedInputUsdPerMillion: 0.075,
          outputUsdPerMillion: 4.5
        },
        uncachedInputTokens: 800,
        cachedInputTokens: 200,
        outputTokens: 500,
        uncachedInputCostMicros: 600,
        cachedInputCostMicros: 15,
        outputCostMicros: 2_250,
        totalCostMicros: 2_865
      }
    });
    replaceAiRunMediaInputs(run.id, [
      {
        ordinal: 0,
        role: "capture",
        transform: "prepared-jpeg",
        sourceMimeType: "image/png",
        sentMimeType: "image/jpeg",
        format: "jpeg",
        encoder: "sharp mozjpeg",
        quality: 75,
        sourceWidthPx: 1200,
        sourceHeightPx: 800,
        sentWidthPx: 1024,
        sentHeightPx: 683,
        sentByteSize: 123_456,
        maxEdgePx: 1024,
        maxBytes: 1_000_000,
        scaleRatio: 1024 / 1200
      }
    ]);

    const detail = getAiRunUsageDetail(run.id);

    expect(detail?.run.triggerSource).toBe("library-regenerate");
    expect(detail?.model).toBe("gpt-5.4-mini");
    expect(detail?.tokens?.cachedInputTokens).toBe(200);
    expect(detail?.cost.status).toBe("available");
    if (detail?.cost.status === "available") {
      expect(detail.cost.totalCostMicros).toBe(2_865);
      expect(detail.cost.rateSnapshot.outputUsdPerMillion).toBe(4.5);
    }
    expect(detail?.mediaInputs).toHaveLength(1);
    expect(detail?.mediaInputs[0]).toMatchObject({
      transform: "prepared-jpeg",
      sentMimeType: "image/jpeg",
      quality: 75,
      sentWidthPx: 1024,
      sentByteSize: 123_456
    });
  });

  test("represents missing usage and price as explicit unavailable states", () => {
    const run = createAiRun({ captureId: "cap_1" });
    saveAiRunUsage({
      aiRunId: run.id,
      usageStatus: "unavailable",
      usageUnavailableReason: "Codex did not report token usage",
      cost: { status: "unavailable", reason: "usage unavailable" }
    });

    const detail = getAiRunUsageDetail(run.id);
    const listed = listAiUsageRuns({ limit: 10 });

    expect(detail?.usageStatus).toBe("unavailable");
    expect(detail?.usageUnavailableReason).toBe("Codex did not report token usage");
    expect(detail?.tokens).toBeNull();
    expect(detail?.cost).toEqual({ status: "unavailable", reason: "usage unavailable" });
    expect(listed.items[0]?.usageStatus).toBe("unavailable");
    expect(listed.items[0]?.priceStatus).toBe("unavailable");
  });

  test("summarizes usage by task, trigger source, and model", () => {
    const run = createAiRun({
      captureId: "cap_1",
      task: "enrich",
      triggerSource: "auto-enrichment"
    });
    saveAiRunUsage({
      aiRunId: run.id,
      model: "gpt-5.4-mini",
      usageStatus: "available",
      tokens: {
        totalTokens: 300,
        inputTokens: 200,
        cachedInputTokens: 20,
        outputTokens: 100,
        reasoningOutputTokens: 10,
        modelContextWindow: null
      },
      cost: {
        status: "available",
        currency: "USD",
        catalogVersion: "2026-05-30",
        pricingSourceUrl: "https://developers.openai.com/api/docs/pricing",
        pricedAt: "2026-05-30T00:00:00.000Z",
        rateSnapshot: {
          model: "gpt-5.4-mini",
          serviceTier: null,
          contextClass: "standard",
          inputUsdPerMillion: 0.75,
          cachedInputUsdPerMillion: 0.075,
          outputUsdPerMillion: 4.5
        },
        uncachedInputTokens: 180,
        cachedInputTokens: 20,
        outputTokens: 100,
        uncachedInputCostMicros: 135,
        cachedInputCostMicros: 2,
        outputCostMicros: 450,
        totalCostMicros: 587
      }
    });

    const summary = getAiUsageSummary("24h");

    expect(summary.runCount).toBe(1);
    expect(summary.totalTokens).toBe(300);
    expect(summary.estimatedTotalCostMicros).toBe(587);
    expect(summary.buckets).toEqual([
      expect.objectContaining({
        task: "enrich",
        triggerSource: "auto-enrichment",
        model: "gpt-5.4-mini",
        runCount: 1
      })
    ]);
  });

  test("deleting a capture cascades usage and media rows", () => {
    const run = createAiRun({ captureId: "cap_1" });
    saveAiRunUsage({
      aiRunId: run.id,
      usageStatus: "unavailable",
      cost: { status: "unavailable", reason: "usage unavailable" }
    });
    replaceAiRunMediaInputs(run.id, [
      {
        ordinal: 0,
        role: "capture",
        transform: "prepared-jpeg",
        sentMimeType: "image/jpeg",
        format: "jpeg",
        sentWidthPx: 100,
        sentHeightPx: 100,
        sentByteSize: 1000
      }
    ]);

    testDb.prepare("DELETE FROM captures WHERE id = ?").run("cap_1");

    expect(testDb.prepare("SELECT COUNT(*) AS n FROM ai_runs").get()).toEqual({ n: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM ai_run_usage").get()).toEqual({ n: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM ai_run_media_inputs").get()).toEqual({
      n: 0
    });
  });
});
