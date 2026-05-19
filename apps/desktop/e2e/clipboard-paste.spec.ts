// Clipboard paste spec — verifies File -> New -> Paste from Clipboard's
// command-bus backing path. The menu item itself is native Electron UI,
// so the behavioral assertion drives `capture:pasteFromClipboard`
// directly after seeding the system clipboard with real image bytes.

import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { launchPwrSnap } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

async function makeClipboardPng(widthPx: number, heightPx: number): Promise<Buffer> {
  return await sharp({
    create: {
      width: widthPx,
      height: heightPx,
      channels: 3,
      background: { r: 40, g: 120, b: 190 }
    }
  })
    .png()
    .toBuffer();
}

async function writeClipboardImage(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  png: Buffer
): Promise<void> {
  await app.electronApp.evaluate(
    ({ clipboard, nativeImage }, payload: { bytes: number[] }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(payload.bytes));
      if (image.isEmpty()) throw new Error("fixture image decoded empty");
      clipboard.write({ image });
    },
    { bytes: Array.from(png) }
  );
}

async function writeClipboardImageFileUrl(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  png: Buffer
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-clipboard-file-url-"));
  const pngPath = path.join(dir, "fixture.png");
  await writeFile(pngPath, png);
  const fileUrl = pathToFileURL(pngPath).href;
  await app.electronApp.evaluate(
    ({ clipboard }, payload: { fileUrl: string }) => {
      clipboard.clear();
      clipboard.writeBookmark("PwrSnap fixture", payload.fileUrl);
    },
    { fileUrl }
  );
  return pngPath;
}

async function clearClipboard(app: Awaited<ReturnType<typeof launchPwrSnap>>): Promise<void> {
  await app.electronApp.evaluate(() => {
    const bridge = (
      globalThis as unknown as { __PWRSNAP_TEST__: { clearClipboard: () => void } }
    ).__PWRSNAP_TEST__;
    bridge.clearClipboard();
  });
}

async function readPasteMenuEnabled(app: Awaited<ReturnType<typeof launchPwrSnap>>): Promise<boolean> {
  return await app.electronApp.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const file = menu?.items.find((item) => item.label === "File");
    file?.submenu?.emit("menu-will-show");
    const next = file?.submenu?.items.find((item) => item.label === "New");
    next?.submenu?.emit("menu-will-show");
    return menu?.getMenuItemById("file-new-paste-from-clipboard")?.enabled ?? false;
  });
}

test.describe("clipboard paste into library", () => {
  test.skip(!isMac, "clipboard NativeImage ingest is macOS-only in Phase 1");

  test("File menu exposes New -> Paste from Clipboard", async () => {
    const app = await launchPwrSnap();
    try {
      const labels = await app.electronApp.evaluate(({ Menu }) => {
        const root = Menu.getApplicationMenu();
        return (
          root?.items.map((item) => ({
            label: item.label,
            submenu: item.submenu?.items.map((child) => ({
              label: child.label,
              submenu: child.submenu?.items.map((grandchild) => grandchild.label) ?? []
            })) ?? []
          })) ?? []
        );
      });
      const file = labels.find((item) => item.label === "File");
      expect(file).toBeDefined();
      const next = file!.submenu.find((item) => item.label === "New");
      expect(next?.submenu).toContain("Paste from Clipboard");
    } finally {
      await app.close();
    }
  });

  test("Paste from Clipboard menu item reflects pasteboard image availability", async () => {
    const app = await launchPwrSnap();
    try {
      await clearClipboard(app);
      expect(await readPasteMenuEnabled(app)).toBe(false);

      await writeClipboardImage(app, await makeClipboardPng(80, 45));
      expect(await readPasteMenuEnabled(app)).toBe(true);

      await clearClipboard(app);
      await writeClipboardImageFileUrl(app, await makeClipboardPng(90, 50));
      expect(await readPasteMenuEnabled(app)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("capture:pasteFromClipboard persists current clipboard image", async () => {
    const app = await launchPwrSnap();
    try {
      await writeClipboardImage(app, await makeClipboardPng(320, 180));

      const pasted = await app.dispatch("capture:pasteFromClipboard", {});
      expect(pasted.ok, JSON.stringify(pasted)).toBe(true);
      if (!pasted.ok) return;

      expect(pasted.value.width_px).toBe(320);
      expect(pasted.value.height_px).toBe(180);
      expect(pasted.value.device_pixel_ratio).toBe(1);
      expect(pasted.value.source_app_bundle_id).toBe("com.pwrsnap.clipboard");
      expect(pasted.value.source_app_name).toBe("Clipboard");
      expect(pasted.value.flat_png_path).not.toBeNull();
      const fileStat = await stat(pasted.value.flat_png_path!);
      expect(fileStat.isFile()).toBe(true);

      const listed = await app.dispatch("library:list", { limit: 5 });
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.rows[0]?.id).toBe(pasted.value.id);
      expect(listed.value.appStats?.some((stat) => stat.sourceAppName === "Clipboard")).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("capture:pasteFromClipboard returns a structured error when clipboard has no image", async () => {
    const app = await launchPwrSnap();
    try {
      await clearClipboard(app);

      const pasted = await app.dispatch("capture:pasteFromClipboard", {});
      expect(pasted.ok).toBe(false);
      if (pasted.ok) return;
      expect(pasted.error.kind).toBe("clipboard");
      expect(pasted.error.code).toBe("no_image");
    } finally {
      await app.close();
    }
  });

  test("capture:pasteFromClipboard persists an image file URL from the clipboard", async () => {
    const app = await launchPwrSnap();
    try {
      const pngPath = await writeClipboardImageFileUrl(app, await makeClipboardPng(96, 54));

      const pasted = await app.dispatch("capture:pasteFromClipboard", {});
      expect(pasted.ok, JSON.stringify(pasted)).toBe(true);
      if (!pasted.ok) return;

      expect(pasted.value.width_px).toBe(96);
      expect(pasted.value.height_px).toBe(54);
      expect(pasted.value.flat_png_path).not.toBe(pngPath);
      expect(pasted.value.flat_png_path).not.toBeNull();
      const fileStat = await stat(pasted.value.flat_png_path!);
      expect(fileStat.isFile()).toBe(true);
    } finally {
      await app.close();
    }
  });

});
