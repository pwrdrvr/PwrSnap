import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const macOSIcon = resolve(here, "../build/icon.iconset/icon_512x512@2x.png");

describe("macOS app icon", () => {
  it("keeps the tile inside Apple's legacy safe area", async () => {
    const { data, info } = await sharp(macOSIcon)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let left = info.width;
    let top = info.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const alpha = data[(y * info.width + x) * info.channels + 3];
        if (alpha < 128) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }

    expect({
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1
    }).toEqual({ x: 100, y: 100, width: 824, height: 824 });
  });
});
