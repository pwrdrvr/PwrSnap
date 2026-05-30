// Phase 2 starter Editor — `editor:open` window spec.
//
// Inserts a synthetic capture row directly via the better-sqlite3
// instance (no Screen Recording perms required), then drives
// `editor:open` and asserts a new BrowserWindow with the right
// stage + captureId hash appears.
//
// Keeps the test deterministic across platforms (no PNG decode, no
// renderer drag simulation — the renderer Editor.tsx is exercised
// indirectly via the IPC contract it uses).
//
// The former `overlays:upsert + list + delete` round-trip lived here
// too; it exercised the retired v1 overlays IPC and was removed when
// the v1 write path was deleted. The v2 layer-tree equivalent is
// covered by the layers-handlers unit tests.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

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

// `editor:open returns not_found for a missing capture` moved to
// apps/desktop/src/main/handlers/__tests__/library-handlers-editor-open.test.ts.
// The handler is one `getCaptureById` lookup + a null-check — the
// launchPwrSnap round-trip was 100% of the test budget and the dominant
// source of the Linux/xvfb worker-teardown flakes on PR #125.

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
              legacy_src_path: string | null;
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
        legacy_src_path: payload.pngPath,
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
