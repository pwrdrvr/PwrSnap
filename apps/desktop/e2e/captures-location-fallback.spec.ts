// Behavioral macOS coverage for issue #263. This deliberately tests the
// application contract with a real POSIX EACCES against the fixture's
// isolated Documents directory; native macOS TCC prompt/reset automation is
// a separate VM-lab concern because Playwright cannot drive the system-owned
// consent sheet.

import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, launchPwrSnap, test } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

async function writeClipboardImage(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<void> {
  const png = await sharp({
    create: {
      width: 96,
      height: 54,
      channels: 3,
      background: { r: 255, g: 138, b: 31 }
    }
  })
    .png()
    .toBuffer();
  await app.electronApp.evaluate(
    ({ clipboard, nativeImage }, payload: { bytes: number[] }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(payload.bytes));
      if (image.isEmpty()) throw new Error("fixture image decoded empty");
      clipboard.write({ image });
    },
    { bytes: Array.from(png) }
  );
}

function findFloatOverPage(app: Awaited<ReturnType<typeof launchPwrSnap>>) {
  return app.electronApp.windows().find((page) => page.url().includes("stage=float-over")) ?? null;
}

test.describe("captures location fallback", () => {
  test.skip(!isMac, "Documents-folder permission behavior is macOS-only");

  test("Documents denial falls back to home and stays sticky until a guarded switch", async () => {
    const app = await launchPwrSnap();
    const documentsRoot = path.join(app.homeRoot, "Documents");
    const fallbackRoot = path.join(app.homeRoot, "PwrSnap");
    await mkdir(documentsRoot, { recursive: true });
    await chmod(documentsRoot, 0o000);

    try {
      await writeClipboardImage(app);

      // Paste skips the preflight probe, so this exercises the real
      // persistence-time EACCES recovery path and its one-time retry.
      const pasted = await app.dispatch("capture:pasteFromClipboard", {});
      expect(pasted.ok, JSON.stringify(pasted)).toBe(true);
      if (!pasted.ok) return;
      expect(pasted.value.bundle_path).not.toBeNull();
      expect(pasted.value.bundle_path).toEqual(
        expect.stringMatching(`^${escapeRegExp(`${fallbackRoot}${path.sep}`)}`)
      );
      expect((await stat(pasted.value.bundle_path!)).isFile()).toBe(true);

      const afterFallback = await app.dispatch("settings:read", {});
      expect(afterFallback.ok, JSON.stringify(afterFallback)).toBe(true);
      if (!afterFallback.ok) return;
      expect(afterFallback.value.storage.capturesLocation).toBe("home");

      // Direct command-bus dispatch intentionally skips the interactive
      // capture controller, so explicitly present the persisted record in the
      // toast before asserting its destination label.
      await app.electronApp.evaluate(
        (_electron, payload: { captureId: string }) => {
          const bridge = (
            globalThis as unknown as {
              __PWRSNAP_TEST__: {
                setFloatOverState: (event: unknown) => void;
              };
            }
          ).__PWRSNAP_TEST__;
          bridge.setFloatOverState({
            kind: "show-loaded",
            captureId: payload.captureId
          });
        },
        { captureId: pasted.value.id }
      );
      await expect.poll(() => findFloatOverPage(app) !== null, { timeout: 5000 }).toBe(true);
      const floatOver = findFloatOverPage(app);
      if (floatOver === null) throw new Error("float-over window never appeared");
      await expect(floatOver.locator(".fo__dest-saved")).toContainText("saved · ~/PwrSnap");

      await app.window.locator(".psl__storage-trigger").click();
      const storagePopover = app.window.getByRole("dialog", { name: "Storage usage" });
      const capturesRow = storagePopover.locator(".psl__storage-row").filter({
        hasText: "Capture folders"
      });
      await expect(capturesRow).toContainText("new → ~/PwrSnap");
      await app.window.keyboard.press("Escape");

      const guarded = await app.dispatch("storage:capturesLocationStatus", {});
      expect(guarded.ok, JSON.stringify(guarded)).toBe(true);
      if (!guarded.ok) return;
      expect(guarded.value.location).toBe("home");
      expect(guarded.value.homeCaptureReferences).toBe(1);
      expect(guarded.value.canMoveToDocuments).toBe(false);

      // Granting access later must not silently split the library. The
      // explicit check confirms Documents, but the saved root stays home.
      await chmod(documentsRoot, 0o700);
      const checked = await app.dispatch("storage:checkCapturesAccess", {});
      expect(checked).toEqual({ ok: true, value: { granted: true } });
      const stillSticky = await app.dispatch("settings:read", {});
      expect(stillSticky.ok, JSON.stringify(stillSticky)).toBe(true);
      if (!stillSticky.ok) return;
      expect(stillSticky.value.storage.capturesLocation).toBe("home");

      // Switch-back remains blocked until every on-disk file and durable DB
      // reference under ~/PwrSnap is gone (including soft-deleted rows).
      const blockedMove = await app.dispatch("storage:moveCapturesToDocuments", {});
      expect(blockedMove.ok).toBe(false);

      expect(await app.dispatch("library:delete", { id: pasted.value.id })).toEqual({
        ok: true,
        value: undefined
      });
      expect(await app.dispatch("library:purge", { id: pasted.value.id })).toEqual({
        ok: true,
        value: undefined
      });

      const eligible = await app.dispatch("storage:capturesLocationStatus", {});
      expect(eligible.ok, JSON.stringify(eligible)).toBe(true);
      if (!eligible.ok) return;
      expect(eligible.value.canMoveToDocuments).toBe(true);

      const moved = await app.dispatch("storage:moveCapturesToDocuments", {});
      expect(moved.ok, JSON.stringify(moved)).toBe(true);
      if (!moved.ok) return;
      expect(moved.value.location).toBe("documents");
    } finally {
      // Restore traversal before fixture teardown tries to remove the tree.
      await chmod(documentsRoot, 0o700).catch(() => undefined);
      await app.close();
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
