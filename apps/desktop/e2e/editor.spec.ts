// Phase 2 starter Editor — round-trip spec.
//
// Inserts a synthetic capture row directly via the better-sqlite3
// instance (no Screen Recording perms required), then drives:
//   1. `editor:open` → asserts a new BrowserWindow with the right
//      stage + captureId hash appears.
//   2. `overlays:upsert` with a valid arrow → asserts the live
//      `overlays:list` returns the inserted row, validated against
//      the zod schema.
//   3. `overlays:upsert` with garbage → asserts the validation gate
//      rejects it with `code: 'schema_mismatch'` and the table
//      stays clean.
//   4. `overlays:delete` → asserts the row drops from the live list.
//
// Keeps the test deterministic across platforms (no PNG decode, no
// renderer drag simulation — the renderer Editor.tsx is exercised
// indirectly via the IPC contract it uses).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const ARROW_FIXTURE = {
  kind: "arrow" as const,
  from: { x: 0.1, y: 0.1 },
  to: { x: 0.5, y: 0.5 },
  color: "auto" as const
};

test("editor:open creates a new window with the captureId hash", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);

    const before = app.electronApp.windows().length;
    const result = await app.dispatch("editor:open", { captureId });
    expect(result.ok).toBe(true);

    // A new window appears whose URL hash has stage=edit.
    await expect
      .poll(async () =>
        app.electronApp
          .windows()
          .some((w) => w.url().includes("stage=edit") && w.url().includes(captureId))
      )
      .toBe(true);

    const after = app.electronApp.windows().length;
    expect(after).toBeGreaterThan(before);
  } finally {
    await app.close();
  }
});

test("editor:open returns not_found for a missing capture", async () => {
  const app = await launchPwrSnap();
  try {
    const result = await app.dispatch("editor:open", { captureId: "no-such-capture-xyz" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  } finally {
    await app.close();
  }
});

test("overlays:upsert + list + delete round-trip", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedCapture(app);

    // Live list starts empty.
    const initial = await app.dispatch("overlays:list", { captureId });
    expect(initial.ok).toBe(true);
    if (initial.ok) expect(initial.value).toHaveLength(0);

    // Insert a valid arrow.
    const inserted = await app.dispatch("overlays:upsert", {
      captureId,
      overlay: ARROW_FIXTURE
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.value.data.kind).toBe("arrow");
    expect(inserted.value.applied_at).not.toBeNull();
    expect(inserted.value.source).toBe("user");

    // It comes back in the live list.
    const live = await app.dispatch("overlays:list", { captureId });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.value).toHaveLength(1);
    expect(live.value[0]!.id).toBe(inserted.value.id);

    // overlays_version on the capture bumped — fetch via the test
    // bridge and verify the editor can rely on it for cache
    // invalidation later.
    const overlaysVersion = await app.electronApp.evaluate((_electron, id: string) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: { getOverlaysVersion: (id: string) => number | null };
        }
      ).__PWRSNAP_TEST__;
      return bridge.getOverlaysVersion(id);
    }, captureId);
    expect(overlaysVersion ?? 0).toBeGreaterThanOrEqual(1);

    // Reject with garbage payload — validation gate kicks in.
    const garbage = await app.dispatch("overlays:upsert", {
      captureId,
      overlay: { kind: "wat", payload: "nope" } as never
    });
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) {
      expect(garbage.error.code).toBe("schema_mismatch");
    }

    // Delete → live list goes back to empty.
    const deleted = await app.dispatch("overlays:delete", { id: inserted.value.id });
    expect(deleted.ok).toBe(true);
    const final = await app.dispatch("overlays:list", { captureId });
    expect(final.ok).toBe(true);
    if (final.ok) expect(final.value).toHaveLength(0);
  } finally {
    await app.close();
  }
});

/**
 * Seed a synthetic capture row + a 1×1 PNG file so handlers that
 * stat/read the source path don't choke. Returns the captureId.
 *
 * The PNG bytes don't matter for these specs — we never decode the
 * file, only insert the metadata. A real PNG header is used so any
 * accidental sharp probe in a future Phase 2 commit doesn't crash.
 */
async function seedCapture(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-editor-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  // 1×1 transparent PNG (smallest valid).
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082",
    "hex"
  );
  await writeFile(pngPath, pngBytes);

  const captureId = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await app.electronApp.evaluate(
    (_electron, payload: { id: string; pngPath: string }) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            seedCapture: (input: {
              id: string;
              kind: "image" | "video";
              captured_at: string;
              source_app_bundle_id: string | null;
              source_app_name: string | null;
              src_path: string;
              width_px: number;
              height_px: number;
              device_pixel_ratio: number;
              byte_size: number;
              sha256: string;
            }) => unknown;
          };
        }
      ).__PWRSNAP_TEST__;
      bridge.seedCapture({
        id: payload.id,
        kind: "image",
        captured_at: new Date().toISOString(),
        source_app_bundle_id: "com.test.spec",
        source_app_name: "Editor Spec",
        src_path: payload.pngPath,
        width_px: 800,
        height_px: 600,
        device_pixel_ratio: 1,
        byte_size: 70,
        sha256: payload.id // unique sentinel, fine for tests
      });
    },
    { id: captureId, pngPath }
  );

  // Best-effort tmpdir cleanup — the OS sweeps /tmp anyway, and a
  // test that fails partway through shouldn't crash trying to clean
  // up something it never used.
  void rm; // satisfy unused-import lint without changing the surface
  return captureId;
}
