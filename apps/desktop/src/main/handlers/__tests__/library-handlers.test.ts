// Tests for the library-handlers command bus. Scoped to the
// surface PR #130 added (`library:listByIds`) — other library
// handlers (list, byId, delete, restore, hardDelete, …) are covered
// by integration tests + the soft-delete suite elsewhere. This file
// pins the contract documented in the protocol:
//
//   - Returns rows in INPUT order (not rowid order).
//   - Drops missing ids silently (not as nulls).
//   - Drops soft-deleted rows.
//   - Validates the input shape via the shared validator (length
//     cap, non-empty strings).
//
// Mocks `getCapturesByIds` to return a fixed-shape capture set,
// since the SUT here is the handler's filter + order semantics, not
// the SQLite query.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown) => Promise<unknown>>(),
  getCapturesByIds: vi.fn<(ids: readonly string[]) => CaptureRecord[]>(),
  getCaptureById: vi.fn(),
  getAppStats: vi.fn(),
  getTotalLive: vi.fn(),
  hardDeleteCapture: vi.fn(),
  listCaptures: vi.fn(),
  listSoftDeletedIds: vi.fn(),
  restoreCapture: vi.fn(),
  softDeleteCapture: vi.fn(),
  send: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: { send: mocks.send }
      }
    ])
  },
  clipboard: {
    write: vi.fn(),
    writeText: vi.fn()
  }
}));

vi.mock("../../command-bus", () => ({
  bus: {
    register: vi.fn((name: string, handler: (req: unknown) => Promise<unknown>) => {
      mocks.handlers.set(name, handler);
    })
  }
}));

vi.mock("../../persistence/captures-repo", () => ({
  getAppStats: mocks.getAppStats,
  getCaptureById: mocks.getCaptureById,
  getCapturesByIds: mocks.getCapturesByIds,
  getTotalLive: mocks.getTotalLive,
  hardDeleteCapture: mocks.hardDeleteCapture,
  listCaptures: mocks.listCaptures,
  listSoftDeletedIds: mocks.listSoftDeletedIds,
  restoreCapture: mocks.restoreCapture,
  softDeleteCapture: mocks.softDeleteCapture
}));

vi.mock("../../persistence/enrichment-repo", () => ({
  addUserTag: vi.fn(),
  removeTag: vi.fn()
}));

vi.mock("../../persistence/bundle-store", () => ({
  moveBundlePairToTrash: vi.fn(),
  purgeBundlePairFromTrash: vi.fn(),
  restoreBundlePairFromTrash: vi.fn()
}));

vi.mock("../../persistence/source-store", () => ({
  moveSourceToTrash: vi.fn(),
  purgeCacheForCapture: vi.fn(),
  purgeOneFromTrash: vi.fn(),
  restoreSourceFromTrash: vi.fn()
}));

vi.mock("../../window", () => ({
  createEditWindow: vi.fn(),
  createMainWindow: vi.fn(),
  findMainLibraryWindow: vi.fn()
}));

vi.mock("../../persistence/legacy-bundle-migration", () => ({
  getLegacyMigrationProgress: vi.fn(() => ({ pending: 0, total: 0 }))
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

// Helper — build a CaptureRecord stub matching the canonical shape.
// Local to this test file so renderer-side changes to the type
// surface DON'T transparently keep stale defaults passing here —
// editing the type forces the test maintainer to update this builder.
function makeRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: "rec-default",
    kind: "image",
    captured_at: "2026-05-27T00:00:00.000Z",
    legacy_src_path: null,
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 2,
    bundle_edits_version: 0,
    width_px: 1920,
    height_px: 1080,
    device_pixel_ratio: 2,
    byte_size: 1024 * 200,
    sha256: "deadbeef",
    source_app_bundle_id: null,
    source_app_name: null,
    edits_version: 0,
    deleted_at: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.getCapturesByIds.mockReset();
  mocks.send.mockReset();
});

describe("library:listByIds — handler contract", () => {
  test("validation: empty ids array → ok with no rows (not an error)", async () => {
    // A zero-length input is a legitimate "I have nothing to look
    // up" — the validator accepts it (length 0 is ≤ the 500 cap),
    // the handler returns `{ rows: [] }`. The downstream getCapturesByIds
    // is called with [] and returns []. No reason to error here.
    mocks.getCapturesByIds.mockReturnValue([]);
    const { registerLibraryHandlers } = await import("../library-handlers");
    registerLibraryHandlers();
    const handler = mocks.handlers.get("library:listByIds");
    expect(handler).toBeDefined();
    const result = await handler!({ ids: [] });
    expect(result).toEqual({ ok: true, value: { rows: [] } });
  });

  test("validation: non-array ids → validation error", async () => {
    const { registerLibraryHandlers } = await import("../library-handlers");
    registerLibraryHandlers();
    const handler = mocks.handlers.get("library:listByIds");
    const result = await handler!({ ids: "rec-1" });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "ids_required" }
    });
  });

  test("validation: non-string element → validation error with index", async () => {
    const { registerLibraryHandlers } = await import("../library-handlers");
    registerLibraryHandlers();
    const handler = mocks.handlers.get("library:listByIds");
    const result = await handler!({ ids: ["rec-1", 42, "rec-2"] });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "id_invalid" }
    });
    // Validator returns errors that reference the failing index so a
    // bug in the caller can be localized — confirm the index is in
    // the message.
    expect((result as { error: { message: string } }).error.message).toContain("[1]");
  });

  test("validation: exceeding the 500-id cap → ids_too_many", async () => {
    const { registerLibraryHandlers } = await import("../library-handlers");
    registerLibraryHandlers();
    const handler = mocks.handlers.get("library:listByIds");
    const ids = Array.from({ length: 501 }, (_, i) => `rec-${i}`);
    const result = await handler!({ ids });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "ids_too_many" }
    });
    // Validator short-circuits before the SQLite query — the
    // getCapturesByIds spy should NOT have been called.
    expect(mocks.getCapturesByIds).not.toHaveBeenCalled();
  });

  test("happy path: returns rows in INPUT order (not whatever order getCapturesByIds returns)", async () => {
    // The actual getCapturesByIds preserves input order — but the
    // handler must NOT re-sort the returned array, otherwise it
    // would break the DetailRail's scene-list rendering (scenes
    // are scene-order, not capture-creation-order). Pin that by
    // having the mock return rows in the order requested.
    mocks.getCapturesByIds.mockImplementation((ids) =>
      ids.map((id) => makeRecord({ id }))
    );
    const { registerLibraryHandlers } = await import("../library-handlers");
    registerLibraryHandlers();
    const handler = mocks.handlers.get("library:listByIds");
    const result = (await handler!({ ids: ["rec-c", "rec-a", "rec-b"] })) as {
      ok: true;
      value: { rows: CaptureRecord[] };
    };
    expect(result.ok).toBe(true);
    expect(result.value.rows.map((r) => r.id)).toEqual(["rec-c", "rec-a", "rec-b"]);
  });

  test("missing ids are silently dropped (NOT returned as nulls)", async () => {
    // The handler doesn't render placeholder rows for missing ids;
    // the project view downstream treats "absent" as "this scene's
    // capture has been deleted" and grays it out. Returning nulls
    // would force every consumer to filter again — drop them here.
    mocks.getCapturesByIds.mockImplementation((ids) =>
      // Mock the underlying helper's behavior: drop missing ids.
      ids.filter((id) => id !== "rec-missing").map((id) => makeRecord({ id }))
    );
    const { registerLibraryHandlers } = await import("../library-handlers");
    registerLibraryHandlers();
    const handler = mocks.handlers.get("library:listByIds");
    const result = (await handler!({
      ids: ["rec-a", "rec-missing", "rec-b"]
    })) as { ok: true; value: { rows: CaptureRecord[] } };
    expect(result.value.rows.map((r) => r.id)).toEqual(["rec-a", "rec-b"]);
  });

  test("soft-deleted rows are dropped from the result", async () => {
    // The repo helper returns soft-deleted rows (matches getCaptureById
    // semantics — the deletion is a status flag, not row removal).
    // The handler filters them out for the listByIds surface because
    // its primary consumer (the sizzle project view) only wants to
    // render captures that currently exist in the user's library.
    mocks.getCapturesByIds.mockImplementation((ids) =>
      ids.map((id) =>
        makeRecord({
          id,
          deleted_at: id === "rec-deleted" ? "2026-05-26T00:00:00.000Z" : null
        })
      )
    );
    const { registerLibraryHandlers } = await import("../library-handlers");
    registerLibraryHandlers();
    const handler = mocks.handlers.get("library:listByIds");
    const result = (await handler!({
      ids: ["rec-a", "rec-deleted", "rec-b"]
    })) as { ok: true; value: { rows: CaptureRecord[] } };
    expect(result.value.rows.map((r) => r.id)).toEqual(["rec-a", "rec-b"]);
  });

  test("respects deduplication when caller passes repeated ids", async () => {
    // Sanity: if the caller passes the same id twice, the repo
    // returns one row, and the handler's filter doesn't multiply
    // it. Tests the case where a future bug double-pushes ids
    // into the dispatch array.
    mocks.getCapturesByIds.mockImplementation((ids) => {
      // Real impl returns each id at most once (the IN clause +
      // input-order map). Mirror that here.
      const seen = new Set<string>();
      const out: CaptureRecord[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(makeRecord({ id }));
      }
      return out;
    });
    const { registerLibraryHandlers } = await import("../library-handlers");
    registerLibraryHandlers();
    const handler = mocks.handlers.get("library:listByIds");
    const result = (await handler!({
      ids: ["rec-a", "rec-a", "rec-b"]
    })) as { ok: true; value: { rows: CaptureRecord[] } };
    expect(result.value.rows.map((r) => r.id)).toEqual(["rec-a", "rec-b"]);
  });
});
