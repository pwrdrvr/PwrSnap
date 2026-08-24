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
//   • drop path replacement after secure read cannot change worker bytes
//   • happy path → layer inserted, layerId returned, scheduleRepack
//     called

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  renameSync,
  symlinkSync,
  truncateSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASTE_IMAGE_MAX_BYTES } from "@pwrsnap/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let testDb: Database.Database;
let tmpDataRoot: string;

const mocks = vi.hoisted(() => ({
  persistenceFailure: null as Error | null,
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}));

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
      getSize: () => ({ width: 0, height: 0 }),
      toPNG: () => Buffer.alloc(0)
    })
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    error: mocks.logError,
    info: mocks.logInfo,
    warn: mocks.logWarn
  })
}));

vi.mock("../../persistence/pending-source-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../persistence/pending-source-store")>();
  return {
    ...actual,
    materializePendingSourceForCapture: async (
      captureId: string,
      sha: string,
      bytes: Buffer
    ): Promise<void> => {
      if (mocks.persistenceFailure !== null) throw mocks.persistenceFailure;
      await actual.materializePendingSourceForCapture(captureId, sha, bytes);
    }
  };
});

const repackCalls: string[] = [];
vi.mock("../../persistence/bundle-store", () => ({
  scheduleRepack: (captureId: string): void => {
    repackCalls.push(captureId);
  }
}));

// Stub the worker client so we don't spawn worker_threads in tests.
const workerInputs: unknown[] = [];
let beforeWorker: (() => void) | null = null;
let workerWait: Promise<void> | null = null;
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
    beforeWorker?.();
    workerInputs.push(input);
    if (workerWait !== null) await workerWait;
    return workerResponse;
  }
}));

// Cache path resolver — point the cache at our temp dir so the
// handler's writeFile lands somewhere we can clean up.
vi.mock("../../persistence/paths", () => ({
  getCacheSourcePath: (captureId: string): string =>
    join(tmpDataRoot, "render-cache", captureId, "source.png"),
  getPendingSourceCaptureDir: (captureId: string): string =>
    join(tmpDataRoot, "pending-sources", captureId),
  getPendingSourcePath: (captureId: string, sha: string): string =>
    join(tmpDataRoot, "pending-sources", captureId, `${sha}.png`)
}));

const { bus } = await import("../../command-bus");
const { registerEditorHandlers } = await import("../editor-handlers");
const { registerLayersHandlers } = await import("../layers-handlers");
const { insertLayerTreeForCapture } = await import("../../persistence/layers-repo");
const { clipboard } = await import("electron");

registerEditorHandlers();
registerLayersHandlers();

const WORKER_PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const WORKER_PNG_SHA = createHash("sha256").update(WORKER_PNG_BYTES).digest("hex");

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

function setClipboardImage(
  pngBytes: Buffer | null,
  size: { width: number; height: number } = { width: 1, height: 1 }
): void {
  (clipboard.readImage as unknown as () => unknown) = () => ({
    isEmpty: () => pngBytes === null || pngBytes.length === 0,
    getSize: () => size,
    toPNG: () => (pngBytes === null ? Buffer.alloc(0) : pngBytes)
  });
}

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  applyAllMigrations();
  repackCalls.length = 0;
  workerInputs.length = 0;
  beforeWorker = null;
  workerWait = null;
  mocks.persistenceFailure = null;
  mocks.logError.mockReset();
  mocks.logInfo.mockReset();
  mocks.logWarn.mockReset();
  tmpDataRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "pwrsnap-editor-test-")
  );
  workerResponse = {
    ok: true,
    sha256: WORKER_PNG_SHA,
    widthPx: 100,
    heightPx: 80,
    pngBytes: new Uint8Array(WORKER_PNG_BYTES)
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

  test("preflights NativeImage pixels before synchronous PNG encoding", async () => {
    seedV2Capture("cap_bomb001", "/tmp/cap_native_bomb.pwrsnap");
    setClipboardImage(Buffer.from([0x89, 0x50]), {
      width: 6_000,
      height: 6_000
    });

    const result = await bus.dispatch(
      "editor:pasteImageAsLayer",
      { captureId: "cap_bomb001" },
      { principal: "ipc" }
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "image_too_large" }
    });
    expect(workerInputs).toHaveLength(0);
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

  test("worker rejects non-raster decoder → image_unsupported_format", async () => {
    seedV2Capture("cap_format", "/tmp/cap_format.pwrsnap");
    setClipboardImage(Buffer.from([0x89, 0x50]));
    workerResponse = {
      ok: false,
      code: "unsupported_format",
      message: "decoded format svg is not allowed"
    };
    const result = await bus.dispatch(
      "editor:pasteImageAsLayer",
      { captureId: "cap_format" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("image_unsupported_format");
    expect(result.error.message).toBe("Image format is not supported");
    expect(result.error.message).not.toContain("svg");
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
    expect(data.source_ref?.sha256).toBe(WORKER_PNG_SHA);
    expect(data.natural_width_px).toBe(100);
    expect(data.natural_height_px).toBe(80);
    expect(
      readFileSync(join(tmpDataRoot, "pending-sources", "cap_d", `${WORKER_PNG_SHA}.png`))
    ).toEqual(WORKER_PNG_BYTES);
  });

  test("persistence failure is path-free in both Result and logs", async () => {
    seedV2Capture("cap_pf", "/tmp/cap_pf.pwrsnap");
    setClipboardImage(Buffer.from([0x89, 0x50]));
    const privatePath = join(tmpDataRoot, "pending-sources", "private.png");
    mocks.persistenceFailure = Object.assign(
      new Error(`ENOSPC: no space left on device, open '${privatePath}'`),
      { code: "ENOSPC" }
    );

    const result = await bus.dispatch(
      "editor:pasteImageAsLayer",
      { captureId: "cap_pf" },
      { principal: "ipc" }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "persistence",
        code: "insert_failed",
        message: "Unable to add image layer"
      }
    });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(privatePath);
    expect(mocks.logError).toHaveBeenCalledWith(
      "editor:pasteImageAsLayer persistence failed",
      { captureId: "cap_pf", code: "insert_failed" }
    );
    expect(repackCalls).not.toContain("cap_pf");
  });
});

describe("editor:dropImageAsLayer", () => {
  test("v1 capture → v1_capture_use_v2", async () => {
    seedV1Capture("cap_v1");
    const path = join(tmpDataRoot, "input.png");
    writeFileSync(path, Buffer.from([0x89, 0x50]));
    const result = await bus.dispatch(
      "editor:dropImageAsLayer",
      { captureId: "cap_v1", filePath: path, operationId: "op_v1" },
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
      { captureId: "cap_e", filePath: link, operationId: "op_symlink" },
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
      { captureId: "cap_f", filePath: missing, operationId: "op_missing" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unsafe_stat_failed");
    expect(result.error.message).toBe("Invalid file");
  });

  test("oversize file → image_too_large (sanitized)", async () => {
    seedV2Capture("cap_size", "/tmp/cap_size.pwrsnap");
    const path = join(tmpDataRoot, "oversize.png");
    writeFileSync(path, Buffer.alloc(0));
    truncateSync(path, PASTE_IMAGE_MAX_BYTES + 1);
    const result = await bus.dispatch(
      "editor:dropImageAsLayer",
      { captureId: "cap_size", filePath: path, operationId: "op_size" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("image_too_large");
    expect(result.error.message).toBe("Image exceeds size cap");
    expect(result.error.message).not.toContain(path);
    expect(workerInputs).toHaveLength(0);
  });

  test("happy path → worker receives securely-read bytes, never a path", async () => {
    seedV2Capture("cap_g", "/tmp/cap_g.pwrsnap");
    const path = join(tmpDataRoot, "drop.png");
    const sourceBytes = Buffer.from([0x89, 0x50, 0x11, 0x22]);
    writeFileSync(path, sourceBytes);
    const result = await bus.dispatch(
      "editor:dropImageAsLayer",
      {
        captureId: "cap_g",
        filePath: path,
        operationId: "op_happy",
        positionXn: 0.5,
        positionYn: 0.5
      },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(typeof result.value.layerId).toBe("string");
    expect(workerInputs.length).toBe(1);
    const wi = workerInputs[0] as { kind: string; bytes: Uint8Array };
    expect(wi.kind).toBe("decode-buffer");
    expect(Buffer.from(wi.bytes)).toEqual(sourceBytes);
    expect(wi).not.toHaveProperty("path");
    expect(repackCalls).toContain("cap_g");
  });

  test("persistence failure is path-free in both Result and logs", async () => {
    seedV2Capture("cap_df", "/tmp/cap_df.pwrsnap");
    const inputPath = join(tmpDataRoot, "drop.png");
    writeFileSync(inputPath, Buffer.from([0x89, 0x50, 0x11, 0x22]));
    const privatePath = join(tmpDataRoot, "pending-sources", "private.png");
    mocks.persistenceFailure = Object.assign(
      new Error(`EACCES: permission denied, rename '${privatePath}.tmp' -> '${privatePath}'`),
      { code: "EACCES" }
    );

    const result = await bus.dispatch(
      "editor:dropImageAsLayer",
      {
        captureId: "cap_df",
        filePath: inputPath,
        operationId: "op_drop_fail"
      },
      { principal: "ipc" }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "persistence",
        code: "insert_failed",
        message: "Unable to add image layer"
      }
    });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(privatePath);
    expect(mocks.logError).toHaveBeenCalledWith(
      "editor:dropImageAsLayer persistence failed",
      { captureId: "cap_df", code: "insert_failed" }
    );
    expect(repackCalls).not.toContain("cap_df");
  });

  test("cancel during decode prevents insertion into the old capture", async () => {
    seedV2Capture("cap_cancel", "/tmp/cap_cancel.pwrsnap");
    const path = join(tmpDataRoot, "cancel.png");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x11, 0x22]));
    let releaseWorker!: () => void;
    workerWait = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });

    const dropPromise = bus.dispatch(
      "editor:dropImageAsLayer",
      {
        captureId: "cap_cancel",
        filePath: path,
        operationId: "op_cancel"
      },
      { principal: "ipc" }
    );
    await vi.waitFor(() => expect(workerInputs).toHaveLength(1));
    const cancelled = await bus.dispatch(
      "editor:cancelDropImageImport",
      { operationId: "op_cancel" },
      { principal: "ipc" }
    );
    expect(cancelled).toEqual({ ok: true, value: { cancelled: true } });
    releaseWorker();

    const result = await dropPromise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error.code).toBe("drop_cancelled");
    expect(
      testDb
        .prepare<[string], { count: number }>(
          `SELECT COUNT(*) AS count FROM layers WHERE capture_id = ? AND kind = 'raster'`
        )
        .get("cap_cancel")?.count
    ).toBe(0);
    expect(repackCalls).not.toContain("cap_cancel");
  });

  test("sequential drops preserve input order as increasing visual z-order", async () => {
    seedV2Capture("cap_batch", "/tmp/cap_batch.pwrsnap");
    const firstPath = join(tmpDataRoot, "first.png");
    const secondPath = join(tmpDataRoot, "second.png");
    writeFileSync(firstPath, Buffer.from([0x89, 0x50, 0x01]));
    writeFileSync(secondPath, Buffer.from([0x89, 0x50, 0x02]));

    const first = await bus.dispatch(
      "editor:dropImageAsLayer",
      { captureId: "cap_batch", filePath: firstPath, operationId: "op_batch" },
      { principal: "ipc" }
    );
    const second = await bus.dispatch(
      "editor:dropImageAsLayer",
      { captureId: "cap_batch", filePath: secondPath, operationId: "op_batch" },
      { principal: "ipc" }
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected both drops to succeed");
    const rows = testDb
      .prepare<[string, string], { id: string; z_index: number }>(
        `SELECT id, z_index FROM layers WHERE id IN (?, ?)`
      )
      .all(first.value.layerId, second.value.layerId);
    const zById = new Map(rows.map((row) => [row.id, row.z_index]));
    expect(zById.get(first.value.layerId)).toBeLessThan(
      zById.get(second.value.layerId) ?? -1
    );
  });

  test("replacing the leaf after secure read cannot change worker input", async () => {
    seedV2Capture("cap_swap", "/tmp/cap_swap.pwrsnap");
    const path = join(tmpDataRoot, "replace-after-open.png");
    const replacementPath = join(tmpDataRoot, "replacement.png");
    const originalBytes = Buffer.from([0x89, 0x50, 0xaa, 0xbb]);
    const replacementBytes = Buffer.from("replacement-secret-bytes");
    writeFileSync(path, originalBytes);
    writeFileSync(replacementPath, replacementBytes);
    beforeWorker = () => {
      rmSync(path);
      renameSync(replacementPath, path);
    };

    const result = await bus.dispatch(
      "editor:dropImageAsLayer",
      { captureId: "cap_swap", filePath: path, operationId: "op_swap" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(path)).toEqual(replacementBytes);
    expect(workerInputs).toHaveLength(1);
    const wi = workerInputs[0] as { kind: string; bytes: Uint8Array };
    expect(wi.kind).toBe("decode-buffer");
    expect(Buffer.from(wi.bytes)).toEqual(originalBytes);
    expect(Buffer.from(wi.bytes)).not.toEqual(replacementBytes);
    expect(wi).not.toHaveProperty("path");
  });
});
