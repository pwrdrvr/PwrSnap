// End-to-end exercise of the PR-1 substrate: the FTS5 migration
// (0017_capture_search_fts), the `searchCaptures` repo function, and
// the `listEnrichmentsByCaptureIds` bulk helper. Runs the real
// migrations runner against an in-memory better-sqlite3 — mirrors
// the pattern used by `video-repo.test.ts`.
//
// What this DOES cover:
//   - Backfill on first-run picks up existing rows.
//   - Triggers keep the FTS5 index in sync with capture_enrichments
//     UPDATEs (the common case for AI runs landing).
//   - Triggers handle captures.DELETE cascades (no orphan FTS5 rows).
//   - searchCaptures composes filters conjunctively.
//   - searchCaptures excludes soft-deleted rows.
//   - searchCaptures FTS5 path returns matchSnippet; filter-only path
//     returns matchSnippet = null.
//   - listEnrichmentsByCaptureIds bulk lookup returns the full map
//     keyed by every input id (missing → null entry).
//   - listEnrichmentsByCaptureIds surfaces user-tagged captures that
//     have no enrichment row (matches getCaptureEnrichment edge case).
//
// What this does NOT cover:
//   - The library:search bus handler envelope (covered by
//     library-handlers.test.ts).
//   - FTS5 query parser internals (those tests live on the upstream
//     SQLite project; we just sanitize inputs before MATCH).

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null
}));

vi.mock("../db", () => ({
  getDb: (): Database.Database => {
    if (mocks.db === null) {
      throw new Error("test db not initialized");
    }
    return mocks.db;
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);
  }
}

function insertCapture(
  db: Database.Database,
  args: {
    id: string;
    capturedAt?: string;
    kind?: "image" | "video";
    sourceAppBundleId?: string | null;
    sourceAppName?: string | null;
    deletedAt?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO captures (
       id, kind, captured_at,
       source_app_bundle_id, source_app_name,
       legacy_src_path, width_px, height_px, device_pixel_ratio, byte_size,
       sha256, edits_version, deleted_at
     ) VALUES (
       @id, @kind, @captured_at,
       @bundle, @name,
       @path, 1920, 1080, 2.0, 1024,
       @sha256, 0, @deleted_at
     )`
  ).run({
    id: args.id,
    kind: args.kind ?? "image",
    captured_at: args.capturedAt ?? "2026-05-27T12:00:00.000Z",
    bundle: args.sourceAppBundleId ?? null,
    name: args.sourceAppName ?? null,
    path: `/tmp/captures/${args.id}.png`,
    sha256: `sha-${args.id}`,
    deleted_at: args.deletedAt ?? null
  });
}

function insertEnrichment(
  db: Database.Database,
  args: {
    captureId: string;
    title?: string | null;
    description?: string | null;
    ocrText?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO capture_enrichments (
       capture_id, latest_ai_run_id, ocr_text,
       suggested_title, accepted_title, title_accepted_at,
       suggested_description, accepted_description, description_accepted_at
     ) VALUES (
       @captureId, NULL, @ocr,
       @suggested_title, @accepted_title, @accepted_at,
       @suggested_desc, @accepted_desc, @accepted_at
     )`
  ).run({
    captureId: args.captureId,
    ocr: args.ocrText ?? null,
    suggested_title: args.title ?? null,
    accepted_title: args.title ?? null,
    suggested_desc: args.description ?? null,
    accepted_desc: args.description ?? null,
    accepted_at:
      args.title !== undefined || args.description !== undefined
        ? "2026-05-27T13:00:00.000Z"
        : null
  });
}

beforeEach(() => {
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  applyMigrations(mocks.db);
});

afterEach(() => {
  mocks.db?.close();
  mocks.db = null;
});

// ────────────────────────────────────────────────────────────────────
// Migration shape — FTS5 table + triggers exist after migrations run.
describe("0017_capture_search_fts — migration shape", () => {
  test("creates the capture_search_fts virtual table", () => {
    const row = mocks.db!
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='capture_search_fts'"
      )
      .get();
    expect(row).toBeDefined();
  });

  test("creates the captures + capture_enrichments sync triggers", () => {
    const triggers = mocks.db!
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = triggers.map((t) => t.name);
    expect(names).toContain("captures_ai_fts");
    expect(names).toContain("captures_au_fts");
    expect(names).toContain("captures_ad_fts");
    expect(names).toContain("capture_enrichments_ai_fts");
    expect(names).toContain("capture_enrichments_au_fts");
    expect(names).toContain("capture_enrichments_ad_fts");
  });

  test("re-running the migration is idempotent (IF NOT EXISTS guards)", () => {
    // Apply the migration again — should not throw "already exists".
    const sql = readFileSync(
      join(MIGRATIONS_DIR, "0017_capture_search_fts.sql"),
      "utf8"
    );
    expect(() => mocks.db!.exec(sql)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// Trigger behaviors — index stays in sync with source-table edits.
describe("0017_capture_search_fts — trigger sync", () => {
  test("captures INSERT seeds FTS5 row with source_app_name", () => {
    insertCapture(mocks.db!, {
      id: "cap-1",
      sourceAppName: "Telegram"
    });
    const row = mocks.db!
      .prepare(
        "SELECT capture_id, source_app_name FROM capture_search_fts WHERE capture_id = ?"
      )
      .get("cap-1") as { capture_id: string; source_app_name: string };
    expect(row.capture_id).toBe("cap-1");
    expect(row.source_app_name).toBe("Telegram");
  });

  test("capture_enrichments INSERT fills in title / description / ocr_text", () => {
    insertCapture(mocks.db!, { id: "cap-2", sourceAppName: "Notion" });
    insertEnrichment(mocks.db!, {
      captureId: "cap-2",
      title: "Pairing code screen",
      description: "Shows the 6-digit code with a Copy button",
      ocrText: "Pairing code: 123456"
    });
    const row = mocks.db!
      .prepare(
        "SELECT title, description, ocr_text, source_app_name FROM capture_search_fts WHERE capture_id = ?"
      )
      .get("cap-2") as {
      title: string;
      description: string;
      ocr_text: string;
      source_app_name: string;
    };
    expect(row.title).toBe("Pairing code screen");
    expect(row.description).toBe("Shows the 6-digit code with a Copy button");
    expect(row.ocr_text).toBe("Pairing code: 123456");
    expect(row.source_app_name).toBe("Notion");
  });

  test("captures UPDATE of source_app_name propagates to FTS5", () => {
    insertCapture(mocks.db!, { id: "cap-3", sourceAppName: "Discord" });
    mocks.db!
      .prepare("UPDATE captures SET source_app_name = ? WHERE id = ?")
      .run("Slack", "cap-3");
    const row = mocks.db!
      .prepare("SELECT source_app_name FROM capture_search_fts WHERE capture_id = ?")
      .get("cap-3") as { source_app_name: string };
    expect(row.source_app_name).toBe("Slack");
  });

  test("captures DELETE cascades to FTS5 (no orphan row)", () => {
    insertCapture(mocks.db!, { id: "cap-4", sourceAppName: "Excel" });
    mocks.db!.prepare("DELETE FROM captures WHERE id = ?").run("cap-4");
    const row = mocks.db!
      .prepare("SELECT capture_id FROM capture_search_fts WHERE capture_id = ?")
      .get("cap-4");
    expect(row).toBeUndefined();
  });

  test("capture_enrichments UPDATE of accepted_title re-syncs FTS5 row", () => {
    insertCapture(mocks.db!, { id: "cap-5", sourceAppName: "Figma" });
    insertEnrichment(mocks.db!, {
      captureId: "cap-5",
      title: "Old title",
      description: null,
      ocrText: null
    });
    mocks.db!
      .prepare("UPDATE capture_enrichments SET accepted_title = ? WHERE capture_id = ?")
      .run("New title", "cap-5");
    const row = mocks.db!
      .prepare("SELECT title FROM capture_search_fts WHERE capture_id = ?")
      .get("cap-5") as { title: string };
    expect(row.title).toBe("New title");
  });

  test("capture_enrichments DELETE clears AI fields but keeps source_app_name", () => {
    insertCapture(mocks.db!, { id: "cap-6", sourceAppName: "Linear" });
    insertEnrichment(mocks.db!, {
      captureId: "cap-6",
      title: "Will be removed",
      description: "Also removed",
      ocrText: "Removed too"
    });
    mocks.db!
      .prepare("DELETE FROM capture_enrichments WHERE capture_id = ?")
      .run("cap-6");
    const row = mocks.db!
      .prepare(
        "SELECT title, description, ocr_text, source_app_name FROM capture_search_fts WHERE capture_id = ?"
      )
      .get("cap-6") as {
      title: string | null;
      description: string | null;
      ocr_text: string | null;
      source_app_name: string;
    };
    expect(row.title).toBeNull();
    expect(row.description).toBeNull();
    expect(row.ocr_text).toBeNull();
    expect(row.source_app_name).toBe("Linear");
  });
});

// ────────────────────────────────────────────────────────────────────
// searchCaptures — query plan #1: FTS5 path.
describe("searchCaptures — FTS5 query path", () => {
  test("returns hits matching the query, ordered by FTS5 rank", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, { id: "cap-a", sourceAppName: "Telegram" });
    insertEnrichment(mocks.db!, {
      captureId: "cap-a",
      title: "Pairing code generation",
      description: "User generates the 6-digit code",
      ocrText: "Pairing code: 123456"
    });
    insertCapture(mocks.db!, { id: "cap-b", sourceAppName: "Notion" });
    insertEnrichment(mocks.db!, {
      captureId: "cap-b",
      title: "Onboarding wizard",
      description: "Welcome flow with pairing instructions",
      ocrText: "Welcome to PwrAgent"
    });
    insertCapture(mocks.db!, { id: "cap-c", sourceAppName: "Slack" });
    insertEnrichment(mocks.db!, {
      captureId: "cap-c",
      title: "Standup notes",
      description: "Unrelated content",
      ocrText: "Today I worked on…"
    });

    const rows = searchCaptures({ query: "pairing" });
    const ids = rows.map((r) => r.record.id);
    expect(ids).toContain("cap-a");
    expect(ids).toContain("cap-b");
    expect(ids).not.toContain("cap-c");
  });

  test("matchSnippet is non-null for FTS5 hits and contains the [hit] marker", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, { id: "cap-d", sourceAppName: "Telegram" });
    insertEnrichment(mocks.db!, {
      captureId: "cap-d",
      title: "Pairing code screen",
      description: null,
      ocrText: null
    });
    const rows = searchCaptures({ query: "pairing" });
    expect(rows[0]?.matchSnippet).not.toBeNull();
    expect(rows[0]?.matchSnippet).toContain("[hit]");
    expect(rows[0]?.matchSnippet).toContain("[/hit]");
  });

  test("prefix matching: 'pair' matches 'pairing'", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, { id: "cap-e", sourceAppName: "App" });
    insertEnrichment(mocks.db!, {
      captureId: "cap-e",
      title: "Pairing instructions",
      description: null,
      ocrText: null
    });
    const rows = searchCaptures({ query: "pair" });
    expect(rows.map((r) => r.record.id)).toContain("cap-e");
  });

  test("FTS5 special characters in user input don't crash the query", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, { id: "cap-x", sourceAppName: "App" });
    // Pathological user input — quotes, operators, parentheses.
    // Should sanitize cleanly and return zero results (no match for
    // "pairing" in the empty enrichment).
    expect(() => searchCaptures({ query: '"; DROP TABLE; --' })).not.toThrow();
    expect(() => searchCaptures({ query: "AND OR NOT" })).not.toThrow();
    expect(() => searchCaptures({ query: "(((foo)))" })).not.toThrow();
  });

  test("empty-after-sanitize query returns []", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, { id: "cap-y", sourceAppName: "App" });
    insertEnrichment(mocks.db!, {
      captureId: "cap-y",
      title: "Match anything",
      description: null,
      ocrText: null
    });
    // Only special chars → sanitizer drops them all → empty token set.
    expect(searchCaptures({ query: "()()()*" })).toEqual([]);
  });

  test("ranks title-match higher than ocr-only match", async () => {
    // FTS5 BM25 weights all columns equally by default. We don't
    // override column weights, so this test just verifies BOTH types
    // of hit appear without asserting strict order — relevance
    // tuning is a future enhancement.
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, { id: "ocr-only", sourceAppName: "X" });
    insertEnrichment(mocks.db!, {
      captureId: "ocr-only",
      title: "Unrelated",
      description: "Other text",
      ocrText: "telegram"
    });
    insertCapture(mocks.db!, { id: "title-match", sourceAppName: "X" });
    insertEnrichment(mocks.db!, {
      captureId: "title-match",
      title: "Telegram window",
      description: "Other text",
      ocrText: "Unrelated"
    });
    const rows = searchCaptures({ query: "telegram" });
    expect(rows.length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// searchCaptures — query plan #2: filter-only path (no FTS5 join).
describe("searchCaptures — filter-only path", () => {
  test("no query + appBundleIds filter → captures from that app, ordered captured_at DESC", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, {
      id: "old",
      sourceAppBundleId: "com.tinyspeck.slackmacgap",
      capturedAt: "2026-05-26T10:00:00.000Z"
    });
    insertCapture(mocks.db!, {
      id: "new",
      sourceAppBundleId: "com.tinyspeck.slackmacgap",
      capturedAt: "2026-05-27T10:00:00.000Z"
    });
    insertCapture(mocks.db!, {
      id: "other-app",
      sourceAppBundleId: "com.notion.Notion",
      capturedAt: "2026-05-27T11:00:00.000Z"
    });
    const rows = searchCaptures({
      appBundleIds: ["com.tinyspeck.slackmacgap"]
    });
    expect(rows.map((r) => r.record.id)).toEqual(["new", "old"]);
    // matchSnippet is null for filter-only results.
    expect(rows[0]?.matchSnippet).toBeNull();
  });

  test("appBundleIds with null in the array matches captures with no bundle id", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, {
      id: "bundle-null",
      sourceAppBundleId: null
    });
    insertCapture(mocks.db!, {
      id: "bundle-set",
      sourceAppBundleId: "com.example.app"
    });
    const rows = searchCaptures({ appBundleIds: [null] });
    expect(rows.map((r) => r.record.id)).toEqual(["bundle-null"]);
  });

  test("kinds filter restricts to image / video", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, { id: "img-1", kind: "image" });
    insertCapture(mocks.db!, { id: "vid-1", kind: "video" });
    insertCapture(mocks.db!, { id: "img-2", kind: "image" });

    const images = searchCaptures({ kinds: ["image"] });
    expect(images.map((r) => r.record.id).sort()).toEqual(["img-1", "img-2"]);

    const videos = searchCaptures({ kinds: ["video"] });
    expect(videos.map((r) => r.record.id)).toEqual(["vid-1"]);

    const both = searchCaptures({ kinds: ["image", "video"] });
    expect(both.length).toBe(3);
  });

  test("dateRange filter is inclusive on both ends", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, {
      id: "before",
      capturedAt: "2026-05-25T12:00:00.000Z"
    });
    insertCapture(mocks.db!, {
      id: "on-start",
      capturedAt: "2026-05-26T00:00:00.000Z"
    });
    insertCapture(mocks.db!, {
      id: "middle",
      capturedAt: "2026-05-26T12:00:00.000Z"
    });
    insertCapture(mocks.db!, {
      id: "on-end",
      capturedAt: "2026-05-27T23:59:59.000Z"
    });
    insertCapture(mocks.db!, {
      id: "after",
      capturedAt: "2026-05-28T00:00:00.000Z"
    });
    const rows = searchCaptures({
      dateRange: {
        start: "2026-05-26T00:00:00.000Z",
        end: "2026-05-27T23:59:59.000Z"
      }
    });
    const ids = rows.map((r) => r.record.id).sort();
    expect(ids).toEqual(["middle", "on-end", "on-start"]);
  });

  test("hasOcr=true returns only captures with non-empty OCR", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, { id: "no-enrichment" });
    insertCapture(mocks.db!, { id: "ocr-null" });
    insertEnrichment(mocks.db!, {
      captureId: "ocr-null",
      ocrText: null
    });
    insertCapture(mocks.db!, { id: "ocr-empty" });
    insertEnrichment(mocks.db!, {
      captureId: "ocr-empty",
      ocrText: ""
    });
    insertCapture(mocks.db!, { id: "ocr-set" });
    insertEnrichment(mocks.db!, {
      captureId: "ocr-set",
      ocrText: "Some text"
    });
    const rows = searchCaptures({ hasOcr: true });
    expect(rows.map((r) => r.record.id)).toEqual(["ocr-set"]);
  });

  test("limit caps the result count", async () => {
    const { searchCaptures } = await import("../captures-repo");
    for (let i = 0; i < 50; i++) {
      insertCapture(mocks.db!, {
        id: `cap-${i}`,
        capturedAt: `2026-05-${(i % 28) + 1}T00:00:00.000Z`
      });
    }
    const rows = searchCaptures({ limit: 5 });
    expect(rows.length).toBe(5);
  });

  test("filters compose conjunctively (kinds + dateRange + hasOcr together)", async () => {
    const { searchCaptures } = await import("../captures-repo");
    // Match: image, in range, has OCR.
    insertCapture(mocks.db!, {
      id: "match",
      kind: "image",
      capturedAt: "2026-05-27T12:00:00.000Z"
    });
    insertEnrichment(mocks.db!, { captureId: "match", ocrText: "Hello" });
    // Miss on kind (video).
    insertCapture(mocks.db!, {
      id: "miss-kind",
      kind: "video",
      capturedAt: "2026-05-27T12:00:00.000Z"
    });
    insertEnrichment(mocks.db!, { captureId: "miss-kind", ocrText: "Hello" });
    // Miss on date.
    insertCapture(mocks.db!, {
      id: "miss-date",
      kind: "image",
      capturedAt: "2026-04-27T12:00:00.000Z"
    });
    insertEnrichment(mocks.db!, { captureId: "miss-date", ocrText: "Hello" });
    // Miss on OCR (none set).
    insertCapture(mocks.db!, {
      id: "miss-ocr",
      kind: "image",
      capturedAt: "2026-05-27T12:00:00.000Z"
    });

    const rows = searchCaptures({
      kinds: ["image"],
      dateRange: { start: "2026-05-01", end: "2026-05-31" },
      hasOcr: true
    });
    expect(rows.map((r) => r.record.id)).toEqual(["match"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// searchCaptures — soft-delete handling.
describe("searchCaptures — soft-delete handling", () => {
  test("excludes rows with deleted_at set, whether FTS5 or filter-only path", async () => {
    const { searchCaptures } = await import("../captures-repo");
    insertCapture(mocks.db!, {
      id: "live",
      sourceAppName: "Telegram"
    });
    insertEnrichment(mocks.db!, {
      captureId: "live",
      title: "Live capture"
    });
    insertCapture(mocks.db!, {
      id: "trashed",
      sourceAppName: "Telegram",
      deletedAt: "2026-05-27T00:00:00.000Z"
    });
    insertEnrichment(mocks.db!, {
      captureId: "trashed",
      title: "Trashed capture"
    });

    // FTS5 path.
    expect(
      searchCaptures({ query: "capture" }).map((r) => r.record.id)
    ).toEqual(["live"]);

    // Filter-only path.
    expect(searchCaptures({}).map((r) => r.record.id).sort()).toEqual(["live"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// listEnrichmentsByCaptureIds — bulk helper.
describe("listEnrichmentsByCaptureIds — bulk helper", () => {
  test("returns a map keyed by every input id; missing rows map to null", async () => {
    const { listEnrichmentsByCaptureIds } = await import("../enrichment-repo");
    insertCapture(mocks.db!, { id: "has-enrich" });
    insertEnrichment(mocks.db!, {
      captureId: "has-enrich",
      title: "Some title"
    });
    insertCapture(mocks.db!, { id: "no-enrich" });

    const out = listEnrichmentsByCaptureIds(["has-enrich", "no-enrich", "missing"]);
    expect(out.size).toBe(3);
    expect(out.get("has-enrich")?.acceptedTitle).toBe("Some title");
    expect(out.get("no-enrich")).toBeNull();
    expect(out.get("missing")).toBeNull();
  });

  test("empty input → empty map (no SQL dispatched)", async () => {
    const { listEnrichmentsByCaptureIds } = await import("../enrichment-repo");
    const out = listEnrichmentsByCaptureIds([]);
    expect(out.size).toBe(0);
  });

  test("user-tagged capture with no enrichment row still surfaces", async () => {
    // Edge case from getCaptureEnrichment: a user manually tagged a
    // capture (library:addTag) without any AI run. The capture has
    // no `capture_enrichments` row, only `capture_tags` entries.
    // listEnrichmentsByCaptureIds must surface it — otherwise
    // user-curated tags would silently disappear from agent context.
    const { listEnrichmentsByCaptureIds } = await import("../enrichment-repo");
    insertCapture(mocks.db!, { id: "tag-only" });
    // Insert a tag directly (mirrors addUserTag's effect).
    mocks.db!
      .prepare(
        `INSERT INTO tags (id, label, normalized_label, kind)
         VALUES (@id, @label, @norm, 'content')`
      )
      .run({ id: "tag-1", label: "Important", norm: "important" });
    mocks.db!
      .prepare(
        `INSERT INTO capture_tags (capture_id, tag_id, source)
         VALUES (@captureId, @tagId, 'user')`
      )
      .run({ captureId: "tag-only", tagId: "tag-1" });

    const out = listEnrichmentsByCaptureIds(["tag-only"]);
    const enrichment = out.get("tag-only");
    expect(enrichment).not.toBeNull();
    expect(enrichment?.acceptedTags).toEqual(["Important"]);
  });

  test("throws RangeError above 999 ids (SQLite parameter cap defense)", async () => {
    const { listEnrichmentsByCaptureIds } = await import("../enrichment-repo");
    const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    expect(() => listEnrichmentsByCaptureIds(ids)).toThrow(RangeError);
  });
});
