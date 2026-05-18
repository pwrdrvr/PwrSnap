// Exercises the video_captures + video_export_cache tables end-to-end
// against an in-memory better-sqlite3. The schema is loaded via the
// real migrations runner so this test pins both `0005_video_captures`
// and the captures-repo / source-store interaction surface — same way
// the captures-repo touches video metadata in production.

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

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "migrations"
);

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

function insertCaptureRow(
  db: Database.Database,
  id: string,
  kind: "image" | "video"
): void {
  db.prepare(
    `INSERT INTO captures (
       id, kind, captured_at, source_app_bundle_id, source_app_name,
       legacy_src_path, width_px, height_px, device_pixel_ratio, byte_size,
       sha256, edits_version, deleted_at
     ) VALUES (
       @id, @kind, '2026-05-18T12:00:00.000Z', NULL, NULL,
       @legacy_src_path, 1920, 1080, 2.0, 1024,
       @sha256, 0, NULL
     )`
  ).run({
    id,
    kind,
    legacy_src_path: `/tmp/captures/${id}.${kind === "video" ? "mp4" : "png"}`,
    sha256: `sha-${id}`
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

describe("video-repo metadata round-trip", () => {
  test("insertVideoMetadata + getVideoMetadata seeds defaultRange to full clip", async () => {
    const { insertVideoMetadata, getVideoMetadata } = await import("../video-repo");
    insertCaptureRow(mocks.db!, "cap-1", "video");

    insertVideoMetadata({
      captureId: "cap-1",
      durationSec: 12.5,
      containerFormat: "mp4",
      hasSystemAudio: true,
      hasMicrophoneAudio: false,
      subject: { kind: "region", rect: { x: 100, y: 200, w: 800, h: 600 }, displayId: 1 }
    });

    const meta = getVideoMetadata("cap-1");
    expect(meta).not.toBeNull();
    expect(meta!.durationSec).toBe(12.5);
    expect(meta!.containerFormat).toBe("mp4");
    expect(meta!.hasSystemAudio).toBe(true);
    expect(meta!.hasMicrophoneAudio).toBe(false);
    expect(meta!.defaultRange).toEqual({ start: 0, end: 12.5 });
    expect(meta!.previewStatus).toBe("pending");
    expect(meta!.previewPath).toBeNull();
  });

  test("getVideoMetadata returns null for image captures", async () => {
    const { getVideoMetadata } = await import("../video-repo");
    insertCaptureRow(mocks.db!, "img-1", "image");
    expect(getVideoMetadata("img-1")).toBeNull();
  });

  test("listVideoMetadata bulk-fetches by ids", async () => {
    const { insertVideoMetadata, listVideoMetadata } = await import("../video-repo");
    insertCaptureRow(mocks.db!, "v1", "video");
    insertCaptureRow(mocks.db!, "v2", "video");
    insertCaptureRow(mocks.db!, "v3", "video");

    for (const id of ["v1", "v2", "v3"]) {
      insertVideoMetadata({
        captureId: id,
        durationSec: 5,
        containerFormat: "mp4",
        hasSystemAudio: false,
        hasMicrophoneAudio: false,
        subject: { kind: "display", displayId: 1 }
      });
    }

    const out = listVideoMetadata(["v1", "v3"]);
    expect(out.size).toBe(2);
    expect(out.get("v1")?.durationSec).toBe(5);
    expect(out.get("v3")?.durationSec).toBe(5);
    expect(out.has("v2")).toBe(false);
  });

  test("setDefaultRange clamps to duration", async () => {
    const { insertVideoMetadata, setDefaultRange, getVideoMetadata } = await import(
      "../video-repo"
    );
    insertCaptureRow(mocks.db!, "cap-clamp", "video");
    insertVideoMetadata({
      captureId: "cap-clamp",
      durationSec: 10,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      subject: { kind: "display", displayId: 1 }
    });

    const written = setDefaultRange("cap-clamp", { start: -3, end: 9999 });
    expect(written).toEqual({ start: 0, end: 10 });
    expect(getVideoMetadata("cap-clamp")!.defaultRange).toEqual({ start: 0, end: 10 });
  });

  test("setDefaultRange returns null for missing video", async () => {
    const { setDefaultRange } = await import("../video-repo");
    expect(setDefaultRange("nope", { start: 0, end: 1 })).toBeNull();
  });

  test("updatePreview swaps path + status", async () => {
    const { insertVideoMetadata, updatePreview, getVideoMetadata } = await import(
      "../video-repo"
    );
    insertCaptureRow(mocks.db!, "cap-prev", "video");
    insertVideoMetadata({
      captureId: "cap-prev",
      durationSec: 2,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      subject: { kind: "display", displayId: 1 }
    });
    updatePreview("cap-prev", "previews/cap-prev.mp4", "ready");
    const meta = getVideoMetadata("cap-prev")!;
    expect(meta.previewPath).toBe("previews/cap-prev.mp4");
    expect(meta.previewStatus).toBe("ready");
  });

  test("hard-delete cascades to video_captures via FK", async () => {
    const { insertVideoMetadata, getVideoMetadata } = await import("../video-repo");
    insertCaptureRow(mocks.db!, "cascade-1", "video");
    insertVideoMetadata({
      captureId: "cascade-1",
      durationSec: 3,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      subject: { kind: "display", displayId: 1 }
    });
    expect(getVideoMetadata("cascade-1")).not.toBeNull();
    mocks.db!.prepare("DELETE FROM captures WHERE id = ?").run("cascade-1");
    expect(getVideoMetadata("cascade-1")).toBeNull();
  });
});

describe("video_export_cache", () => {
  test("lookupExport returns null on cold cache, hits after recordExport", async () => {
    const { recordExport, lookupExport } = await import("../video-repo");
    insertCaptureRow(mocks.db!, "exp-1", "video");

    const lookup = {
      captureId: "exp-1",
      range: { start: 0, end: 5 },
      format: "mp4" as const,
      audio: { includeSystemAudio: true, includeMicrophone: false }
    };
    expect(lookupExport(lookup)).toBeNull();

    recordExport({
      ...lookup,
      path: "/tmp/exports/exp-1-0-5-mp4-sys.mp4",
      byteSize: 12345
    });

    const hit = lookupExport(lookup);
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe("/tmp/exports/exp-1-0-5-mp4-sys.mp4");
    expect(hit!.byteSize).toBe(12345);
    expect(hit!.durationSec).toBe(5);
    expect(hit!.fromCache).toBe(true);
  });

  test("different audio choices cache independently", async () => {
    const { recordExport, lookupExport } = await import("../video-repo");
    insertCaptureRow(mocks.db!, "exp-audio", "video");

    recordExport({
      captureId: "exp-audio",
      range: { start: 0, end: 3 },
      format: "mp4",
      audio: { includeSystemAudio: true, includeMicrophone: false },
      path: "/tmp/sys.mp4",
      byteSize: 100
    });
    recordExport({
      captureId: "exp-audio",
      range: { start: 0, end: 3 },
      format: "mp4",
      audio: { includeSystemAudio: false, includeMicrophone: true },
      path: "/tmp/mic.mp4",
      byteSize: 200
    });

    const sys = lookupExport({
      captureId: "exp-audio",
      range: { start: 0, end: 3 },
      format: "mp4",
      audio: { includeSystemAudio: true, includeMicrophone: false }
    });
    const mic = lookupExport({
      captureId: "exp-audio",
      range: { start: 0, end: 3 },
      format: "mp4",
      audio: { includeSystemAudio: false, includeMicrophone: true }
    });
    expect(sys?.byteSize).toBe(100);
    expect(mic?.byteSize).toBe(200);
  });

  test("recordExport upserts in place for the same key", async () => {
    const { recordExport, lookupExport } = await import("../video-repo");
    insertCaptureRow(mocks.db!, "exp-up", "video");

    recordExport({
      captureId: "exp-up",
      range: { start: 1, end: 2 },
      format: "gif",
      audio: { includeSystemAudio: false, includeMicrophone: false },
      path: "/tmp/v1.gif",
      byteSize: 10
    });
    recordExport({
      captureId: "exp-up",
      range: { start: 1, end: 2 },
      format: "gif",
      audio: { includeSystemAudio: false, includeMicrophone: false },
      path: "/tmp/v2.gif",
      byteSize: 999
    });

    const hit = lookupExport({
      captureId: "exp-up",
      range: { start: 1, end: 2 },
      format: "gif",
      audio: { includeSystemAudio: false, includeMicrophone: false }
    });
    expect(hit?.path).toBe("/tmp/v2.gif");
    expect(hit?.byteSize).toBe(999);
  });
});

describe("normalizeRange", () => {
  test("clamps below 0 to 0 and above duration to duration", async () => {
    const { normalizeRange } = await import("../video-repo");
    expect(normalizeRange({ start: -1, end: 100 }, 10)).toEqual({ start: 0, end: 10 });
    expect(normalizeRange({ start: 5, end: 2 }, 10)).toEqual({ start: 5, end: 5 });
    expect(normalizeRange({ start: 2, end: 8 }, 10)).toEqual({ start: 2, end: 8 });
  });
});
