// `editor:open` Library Focus spec.
//
// Inserts a synthetic capture row directly via the better-sqlite3
// instance (no Screen Recording perms required), then drives
// `editor:open` and asserts the existing Library window enters
// Focus mode for the requested capture.
//
// Keeps the test deterministic across platforms (no PNG decode, no
// renderer drag simulation — the renderer Editor.tsx is exercised
// indirectly via the IPC contract it uses).
//
// The former `overlays:upsert + list + delete` round-trip lived here
// too; it exercised the retired v1 overlays IPC and was removed when
// the v1 write path was deleted. The v2 layer-tree equivalent is
// covered by the layers-handlers unit tests.

import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";
import { seedImageCapture } from "./fixtures/editor";

test("editor:open opens the capture in Library Focus", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedImageCapture(app, { idPrefix: "e2e", sourceAppName: "Editor Spec" });

    const before = app.electronApp.windows().length;
    const result = await app.dispatch("editor:open", { captureId });
    expect(result.ok).toBe(true);

    await expect(
      app.window.locator(`.psl__focus[data-capture-id="${captureId}"]`)
    ).toBeVisible();

    const after = app.electronApp.windows().length;
    expect(after).toBe(before);
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
