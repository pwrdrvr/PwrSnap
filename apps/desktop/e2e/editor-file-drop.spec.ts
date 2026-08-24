// Real-Electron coverage for the OS-file drop boundary.
//
// Playwright loads real filesystem paths into a hidden <input type=file>,
// yielding Chromium File objects backed by disk. The test then dispatches a
// DOM drop event with those same File objects onto the live editor canvas.
// This exercises Electron 41's preload webUtils.getPathForFile bridge, the
// renderer's bounded sequential batch loop, main's safe-open/decode pipeline,
// and v2 raster insertion without needing a headed Finder/Explorer session.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { expect, launchPwrSnap, test } from "./fixtures/electron-app";
import { openEditor } from "./fixtures/editor";

test.setTimeout(120_000);

test("editor-file-drop: Electron-backed files import sequentially and report the full batch", async () => {
  const app = await launchPwrSnap();
  try {
    const fixtureDir = path.join(app.homeRoot, "editor-file-drop-fixtures");
    await mkdir(fixtureDir, { recursive: true });
    const sourcePath = path.join(fixtureDir, "source.png");
    const firstDropPath = path.join(fixtureDir, "first.png");
    const secondDropPath = path.join(fixtureDir, "second.avif");
    await Promise.all([
      writeSolidPng(sourcePath, { r: 30, g: 144, b: 255 }),
      writeSolidPng(firstDropPath, { r: 255, g: 138, b: 31 }),
      // PNG bytes behind an AVIF extension deliberately prove that the
      // renderer's extension/MIME hint is not the trust boundary; main's
      // content decoder decides what the bytes actually are.
      writeSolidPng(secondDropPath, { r: 80, g: 200, b: 120 })
    ]);

    const captureId = await app.electronApp.evaluate(
      async (_electron, payload: { sourcePath: string }) => {
        const bridge = (
          globalThis as unknown as {
            __PWRSNAP_TEST__: {
              persistBundleCapture: (input: {
                tempPath: string;
                sourceApp: { bundleId: string | null; appName: string | null };
                devicePixelRatio: number;
              }) => Promise<{ record: { id: string } }>;
            };
          }
        ).__PWRSNAP_TEST__;
        const { record } = await bridge.persistBundleCapture({
          tempPath: payload.sourcePath,
          sourceApp: {
            bundleId: "com.test.editor-file-drop",
            appName: "Editor File Drop Spec"
          },
          devicePixelRatio: 1
        });
        return record.id;
      },
      { sourcePath }
    );

    const editor = await openEditor(app, captureId);
    await editor.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.dataset.testid = "os-drop-input";
      input.style.display = "none";
      document.body.appendChild(input);
    });
    const input = editor.locator('[data-testid="os-drop-input"]');
    await input.setInputFiles([firstDropPath, secondDropPath]);

    // Directly prove the live preload can resolve Electron/Chromium-backed
    // Files. A JS-constructed File would return an empty string here.
    const resolvedBasenames = await editor.evaluate(() => {
      const fileInput = document.querySelector<HTMLInputElement>(
        '[data-testid="os-drop-input"]'
      );
      const files = Array.from(fileInput?.files ?? []);
      return files.map((file) => {
        const resolved = window.pwrsnapApi?.getPathForFile(file) ?? "";
        return resolved.split(/[\\/]/).at(-1) ?? "";
      });
    });
    expect(resolvedBasenames).toEqual(["first.png", "second.avif"]);

    const canvas = editor.locator('[data-testid="editor-canvas"]');
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("editor canvas has no bounding box");

    await editor.evaluate(
      ({ clientX, clientY }) => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="os-drop-input"]'
        );
        const wrap = document.querySelector<HTMLElement>(
          '[data-testid="editor-canvas-wrap"]'
        );
        if (input?.files === null || input?.files === undefined || wrap === null) {
          throw new Error("drop fixture DOM missing");
        }
        const drop = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperties(drop, {
          clientX: { value: clientX },
          clientY: { value: clientY },
          dataTransfer: {
            value: {
              files: input.files,
              types: ["Files"],
              dropEffect: "copy"
            }
          }
        });
        wrap.dispatchEvent(drop);
      },
      { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
    );

    await expect(editor.locator('[data-testid="paste-notice"]')).toHaveText(
      "Imported 2 images"
    );

    let pastedZIndexes: number[] = [];
    await expect
      .poll(async () => {
        const result = await app.dispatch("layers:list", { captureId });
        if (!result.ok) return -1;
        pastedZIndexes = result.value
          .filter((layer) => layer.kind === "raster" && layer.name === "Pasted Image")
          .map((layer) => layer.z_index);
        return result.value.length;
      })
      .toBe(4);
    expect(pastedZIndexes).toHaveLength(2);
    expect(pastedZIndexes[0]).toBeLessThan(pastedZIndexes[1] ?? -1);
  } finally {
    await app.close();
  }
});

async function writeSolidPng(
  targetPath: string,
  color: { r: number; g: number; b: number }
): Promise<void> {
  const bytes = await sharp({
    create: { width: 32, height: 24, channels: 3, background: color }
  })
    .png()
    .toBuffer();
  await writeFile(targetPath, bytes);
}
