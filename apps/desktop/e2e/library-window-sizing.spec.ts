import {
  expect,
  launchPwrSnap,
  test,
  waitForLibraryWindowPaint
} from "./fixtures/electron-app";

const TARGET = { width: 1440, height: 900 };

test.skip(process.platform !== "darwin", "covers the macOS BrowserWindow compositor path");

test("library window commits its resized compositor surface", async () => {
  const app = await launchPwrSnap({ windowSize: TARGET });
  try {
    const renderer = await app.window.evaluate(() => {
      const root = document.querySelector(".psl");
      const rootRect = root?.getBoundingClientRect();
      return {
        innerWidth: globalThis.innerWidth,
        innerHeight: globalThis.innerHeight,
        documentClientWidth: document.documentElement.clientWidth,
        documentClientHeight: document.documentElement.clientHeight,
        rootRect: rootRect?.toJSON() ?? null,
        devicePixelRatio: globalThis.devicePixelRatio
      };
    });

    await app.window.evaluate(() => {
      const markers = [
        ["top-left", "#ff0000", "left:0;top:0"],
        ["top-right", "#00ff00", "right:0;top:0"],
        ["bottom-left", "#0000ff", "left:0;bottom:0"],
        ["bottom-right", "#ff00ff", "right:0;bottom:0"]
      ] as const;
      for (const [id, color, position] of markers) {
        const marker = document.createElement("div");
        marker.dataset.windowCornerMarker = id;
        marker.style.cssText =
          `position:fixed;${position};width:12px;height:12px;background:${color};` +
          "z-index:2147483647;pointer-events:none";
        document.body.append(marker);
      }
    });
    await waitForLibraryWindowPaint(app.electronApp, app.window);

    const native = await app.electronApp.evaluate(
      async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((candidate) => {
          if (candidate.isDestroyed()) return false;
          const url = candidate.webContents.getURL();
          return url.includes("/renderer/index.html") && !url.includes("stage=");
        });
        if (win === undefined) throw new Error("library BrowserWindow missing");

        const inspect = (image: Electron.NativeImage) => {
          const size = image.getSize();
          const bitmap = image.toBitmap();
          // NativeImage bitmaps are BGRA on macOS. Inspect only small corner
          // regions: the markers are pinned to the compositor edges, so this
          // distinguishes a correctly-sized image containing a stale/offset
          // surface from one whose current layout reached every corner.
          const countCorner = (
            horizontal: "left" | "right",
            vertical: "top" | "bottom",
            color: { b: number; g: number; r: number }
          ): number => {
            const sampleWidth = Math.max(16, Math.ceil(size.width * 0.02));
            const sampleHeight = Math.max(16, Math.ceil(size.height * 0.02));
            const minX = horizontal === "left" ? 0 : size.width - sampleWidth;
            const minY = vertical === "top" ? 0 : size.height - sampleHeight;
            let count = 0;
            for (let y = minY; y < minY + sampleHeight; y += 1) {
              for (let x = minX; x < minX + sampleWidth; x += 1) {
                const offset = (y * size.width + x) * 4;
                const b = bitmap[offset] ?? 0;
                const g = bitmap[offset + 1] ?? 0;
                const r = bitmap[offset + 2] ?? 0;
                const a = bitmap[offset + 3] ?? 0;
                if (
                  a > 220 &&
                  Math.abs(b - color.b) < 35 &&
                  Math.abs(g - color.g) < 35 &&
                  Math.abs(r - color.r) < 35
                ) {
                  count += 1;
                }
              }
            }
            return count;
          };
          return {
            size,
            markers: {
              topLeft: countCorner("left", "top", { b: 0, g: 0, r: 255 }),
              topRight: countCorner("right", "top", { b: 0, g: 255, r: 0 }),
              bottomLeft: countCorner("left", "bottom", { b: 255, g: 0, r: 0 }),
              bottomRight: countCorner("right", "bottom", { b: 255, g: 0, r: 255 })
            }
          };
        };

        const contentImage = await win.webContents.capturePage();
        return {
          bounds: win.getBounds(),
          contentBounds: win.getContentBounds(),
          contentSize: win.getContentSize(),
          isVisible: win.isVisible(),
          capturePage: inspect(contentImage)
        };
      }
    );

    expect(native.contentSize).toEqual([TARGET.width, TARGET.height]);
    expect(native.bounds).toMatchObject({ width: TARGET.width, height: TARGET.height });
    expect(native.contentBounds).toMatchObject({ width: TARGET.width, height: TARGET.height });
    expect(native.isVisible).toBe(true);
    expect(renderer).toMatchObject({
      innerWidth: TARGET.width,
      innerHeight: TARGET.height,
      documentClientWidth: TARGET.width,
      documentClientHeight: TARGET.height,
      rootRect: { x: 0, y: 0, width: TARGET.width, height: TARGET.height }
    });
    expect(native.capturePage.size).toEqual({
      width: TARGET.width * renderer.devicePixelRatio,
      height: TARGET.height * renderer.devicePixelRatio
    });
    expect(native.capturePage.markers.topLeft).toBeGreaterThan(50);
    expect(native.capturePage.markers.topRight).toBeGreaterThan(50);
    expect(native.capturePage.markers.bottomLeft).toBeGreaterThan(50);
    expect(native.capturePage.markers.bottomRight).toBeGreaterThan(50);
  } finally {
    await app.close();
  }
});
