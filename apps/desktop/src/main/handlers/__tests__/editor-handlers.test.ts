// Tests for editor-handlers — Phase 5 paste/drop bus verbs.
//
// Strategy mirrors layers-handlers-canvas.test.ts:
//   • in-memory better-sqlite3 with the migrations applied
//   • vi.mock for ../persistence/db so production code reaches the
//     test instance
//   • vi.mock for electron's BrowserWindow (broadcasts no-op)
//   • vi.mock for the bundle-store's scheduleRepack (observed via a
//     simple call log, doesn't actually pack a bundle)
//   • vi.mock for the worker client — we don't want to spawn a worker
//     per test, and the worker's own logic is covered by
//     paste-image-worker.test.ts
//
// Asserts the surface the IPC contract guarantees:
//   • v1 capture → v1_capture_use_v2 refusal
//   • missing capture → not_found
//   • clipboard with no image → no_image
//   • worker rejects → code mapped to image_* bus errors
//   • drop with symlink path → unsafe_symlink refusal (sanitized
//     message, no raw path in the error)
//   • happy path → layer inserted, layerId returned, scheduleRepack
//     called

import Database from "better-sqlite3";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let testDb: Database.Database;
let tmpDataRoot: string;

vi.mock("../../persistence/db", () => ({
  getDb: () => testDb
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => []
  },
  clipboard: {
    // Per-test, the test overrides this via the helper below.
    readImage: () => ({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0)
    })
  }
}));

const repackCalls: string[] = [];
vi.mock("../../persistence/bundle-store", () => ({
  scheduleRepack: (captureId: string): void => {
    repackCalls.push(captureId);
  }
}));

// Stub the worker client so we don't spawn worker_threads in tests.
const workerInputs: unknown[] = [];
let workerResponse: {
  ok: boolean;
  code?: string;
  message?: string;
  sha256?: string;
  widthPx?: number;
  heightPx?: number;
  pngBytes?: Uint8Array;
} = { ok: true };
vi.mock("../../workers/paste-image-worker-client", () => ({
  runPasteImageWorker: async (input: unknown) => {
    workerInputs.push(input);
    return workerResponse;
  }
}));

// Cache path resolver — point the cache at our temp dir so the
// handler's writeFile lands somewhere we can clean up.
vi.mock("../../persistence/paths", () => ({
  getCacheSourcePath: (captureId: string): string =>
    join(tmpDataRoot, captureId, "source.png")
}));

const { bus } = await import("../../command-bus");
const { registerEditorHandlers } = await import("../editor-handlers");
const { registerLayersHandlers } = await import("../layers-handlers");
const { insertLayerTreeForCapture } = await import("../../persistence/layers-repo");
const { clipboard } = await import("electron");

registerEditorHandlers();
registerLayersHandlers();

function applyAllMigrations(): void {
  const dir = new URL("../../persistence/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  testDb.pragma("foreign_keys = OFF");
  for (const file of files) {
    testDb.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  testDb.pragma("foreign_keys = ON");
}

function seedV2Capture(id: string, bundlePath: string): void {
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
        @id, 'image', '2026-05-24T12:00:00.000Z',
        NULL, NULL,
        NULL, @bundlePath, NULL,
        '2026-05-24T12:00:00.000Z', 2, 0,
        1000, 1000, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({ id, bundlePath, sha: `sha_${id}` });
  // Seed a root group so persistRasterFromBytes finds a parent.
  const rootId = `root_${id}`.padEnd(16, "x");
  const now = new Date().toISOString();
  insertLayerTreeForCapture(id, [
    {
      id: rootId,
      parent_id: null,
      kind: "group",
      collapsed: false,
      name: "Root",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now
    }
  ]);
}

function seedV1Capture(id: string): void {
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
        @id, 'image', '2026-05-24T12:00:00.000Z',
        NULL, NULL,
        NULL, NULL, NULL,
        NULL, 1, 0,
        1000, 1000, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({ id, sha: `sha_${id}` });
}

function setClipboardImage(pngBytes: Buffer | null): void {
  (clipboard.readImage as unknown as () => unknown) = () => ({
    isEmpty: () => pngBytes === null || pngBytes.length === 0,
    toPNG: () => (pngBytes === null ? Buffer.alloc(0) : pngBytes)
  });
}

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  applyAllMigrations();
  repackCalls.length = 0;
  workerInputs.length = 0;
  tmpDataRoot = mkdtempSync(join(tmpdir(), "pwrsnap-editor-test-"));
  workerResponse = {
    ok: true,
    sha256: "a".repeat(64),
    widthPx: 100,
    heightPx: 80,
    pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  };
  setClipboardImage(null);
});

afterEach(() => {
  testDb.close();
  rmSync(tmpDataRoot, { recursive: true, force: true });
});

describe("editor:pasteImageAsLayer", () => {
  test("v1 capture → v1_capture_use_v2", async () => {
    seedV1Capture("cap_v1");
    setClipboardImage(Buffer.from([0x89, 0x50]));
    const result = await bus.dispatch(
      "editor:pasteImageAsLayer",
      { captureId: "cap_v1" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("v1_capture_use_v2");
  });

  test("missing capture → not_found", async () => {
    const result = await bus.dispatch(
      "editor:pasteImageAsLayer",
      { captureId: "does_not_exist" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("not_found");
  });

  test("empty clipboard → no_image", async () => {
    seedV2Capture("cap_a", "/tmp/cap_a.pwrsnap");
    setClipboardImage(null);
    const result = await bus.dispatch(
      "editor:pasteImageAsLayer",
      { captureId: "cap_a" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("no_image");
  });

  test("worker rejects with size_cap_exceeded → image_too_large", async () => {
    seedV2Capture("cap_b", "/tmp/cap_b.pwrsnap");
    setClipboardImage(Buffer.from([0x89, 0x50]));
    workerResponse = {
      ok: false,
      code: "size_cap_exceeded",
      message: "internal — should NOT reach renderer"
    };
    const result = await bus.dispatch(
      "editor:pasteImageAsLayer",
      { captureId: "cap_b" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("image_too_large");
    // Sanitized: never leak the worker's raw message.
    expect(result.error.message).not.toContain("internal");
  });

  test("worker rejects with decode_failed → image_decode_failed", async () => {
    seedV2Capture("cap_c", "/tmp/cap_c.pwrsnap");
    setClipboardImage(Buffer.from([0x89, 0x50]));
    workerResponse = { ok: false, code: "decode_failed", message: "x" };
    const result = await bus.dispatch(
      "editor:pasteImageAsLayer",
      { captureId: "cap_c" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("image_decode_failed");
  });

  test("happy path → layer inserted, layerId returned, repack scheduled", async () => {
    seedV2Capture("cap_d", "/tmp/cap_d.pwrsnap");
    setClipboardImage(Buffer.from([0x89, 0x50]));
    const result = await bus.dispatch(
      "editor:pasteImageAsLayer",
      { captureId: "cap_d", positionXn: 0.25, positionYn: 0.5 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(typeof result.value.layerId).toBe("string");
    expect(result.value.layerId.length).toBeGreaterThanOrEqual(16);
    expect(repackCalls).toContain("cap_d");
    // Worker was called with the clipboard bytes.
    expect(workerInputs.length).toBe(1);
    const wi = workerInputs[0] as { kind: string };
    expect(wi.kind).toBe("decode-buffer");
    // Verify the layer was inserted with the right shape.
    const row = testDb
      .prepare<[string], { kind: string; data: string; transform_json: string }>(
        `SELECT kind, data, transform_json FROM layers WHERE id = ?`
      )
      .get(result.value.layerId);
    expect(row?.kind).toBe("raster");
    const data = JSON.parse(row?.data ?? "{}");
    expect(data.source_ref?.sha256).toBe("a".repeat(64));
    expect(data.natural_width_px).toBe(100);
    expect(data.natural_height_px).toBe(80);
  });
});

describe("editor:dropImageAsLayer", () => {
  test("v1 capture → v1_capture_use_v2", async () => {
    seedV1Capture("cap_v1");
    const path = join(tmpDataRoot, "input.png");
    writeFileSync(path, Buffer.from([0x89, 0x50]));
    const result = await bus.dispatch(
      "editor:dropImageAsLayer",
      { captureId: "cap_v1", filePath: path },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("v1_capture_use_v2");
  });

  test("symlink → unsafe_symlink (sanitized message, no path leak)", async () => {
    seedV2Capture("cap_e", "/tmp/cap_e.pwrsnap");
    const target = join(tmpDataRoot, "target.png");
    const link = join(tmpDataRoot, "link.png");
    writeFileSync(target, Buffer.from([0x89, 0x50]));
    symlinkSync(target, link);
    const result = await bus.dispatch(
      "editor:dropImageAsLayer",
      { captureId: "cap_e", filePath: link },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unsafe_symlink");
    expect(result.error.message).toBe("Invalid file");
    // Critical: the path must NOT be in the error message — that's
    // what makes the gate "sanitized".
    expect(result.error.message).not.toContain(link);
    expect(result.error.message).not.toContain(target);
  });

  test("missing file → unsafe_stat_failed (sanitized)", async () => {
    seedV2Capture("cap_f", "/tmp/cap_f.pwrsnap");
    const missing = join(tmpDataRoot, "nope.png");
    const result = await bus.dispatch(
      "editor:dropImageAsLayer",
      { captureId: "cap_f", filePath: missing },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unsafe_stat_failed");
    expect(result.error.message).toBe("Invalid file");
  });

  test("happy path → layer inserted via worker decode-path", async () => {
    seedV2Capture("cap_g", "/tmp/cap_g.pwrsnap");
    const path = join(tmpDataRoot, "drop.png");
    writeFileSync(path, Buffer.from([0x89, 0x50]));
    const result = await bus.dispatch(
      "editor:dropImageAsLayer",
      { captureId: "cap_g", filePath: path, positionXn: 0.5, positionYn: 0.5 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(typeof result.value.layerId).toBe("string");
    expect(workerInputs.length).toBe(1);
    const wi = workerInputs[0] as { kind: string; path?: string };
    expect(wi.kind).toBe("decode-path");
    expect(wi.path).toBe(path);
    expect(repackCalls).toContain("cap_g");
  });
});
