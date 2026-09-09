// Run with the workspace Electron, without launching PwrSnap or capturing a screen:
// pnpm --filter @pwrsnap/desktop exec electron scripts/benchmark-screen-png.cjs
// Optional: --iterations 10 --input C:\path\to\an-existing-opaque-screenshot.png
// Prints metrics only; never writes or uploads image bytes or reads app state.
// This is an experiment, NOT a production encoder. NativeImage bitmap color
// semantics vary by Electron version; pixel equality is a gate, not an assumption.
const { app, nativeImage } = require("electron");
const sharp = require("sharp");
const { readFile } = require("node:fs/promises");
const { performance } = require("node:perf_hooks");

const roundMs = (value) => Math.round(value * 100) / 100;

function options(args) {
  const result = { iterations: 5 };
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "--iterations" && /^\d+$/.test(value ?? "")) {
      result.iterations = Number(value);
    } else if (flag === "--input" && value) {
      result.input = value;
    } else {
      throw new Error("Usage: benchmark-screen-png.cjs [--iterations 1..100] [--input image.png]");
    }
  }
  if (result.iterations < 1 || result.iterations > 100) throw new Error("iterations must be 1..100");
  return result;
}

async function fixture(kind) {
  const width = 2992;
  const height = 1876;
  const rgba = Buffer.alloc(width * height * 4);
  let seed = 123456789;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (kind === "noise") {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        rgba[offset] = seed & 255;
        rgba[offset + 1] = (seed >>> 8) & 255;
        rgba[offset + 2] = (seed >>> 16) & 255;
      } else if (kind === "gradient") {
        rgba[offset] = Math.round(x * 255 / (width - 1));
        rgba[offset + 1] = Math.round(y * 255 / (height - 1));
        rgba[offset + 2] = 127;
      } else {
        // Flat panels, colored accents and fine glyph-like edges; no fonts needed.
        const ink = y % 32 < 12 && x % 17 < 8 && x < width * 0.7;
        rgba[offset] = ink ? 255 : 24;
        rgba[offset + 1] = ink ? 138 : 28;
        rgba[offset + 2] = ink ? 31 : 36;
      }
      rgba[offset + 3] = 255;
    }
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function decoded(png) {
  return sharp(png).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function run() {
  const opts = options(process.argv.slice(2));
  console.log(JSON.stringify({ event: "environment", platform: process.platform,
    arch: process.arch, electron: process.versions.electron, node: process.versions.node,
    sharp: sharp.versions.sharp, vips: sharp.versions.vips, iterations: opts.iterations }));
  // Calibrate channel order rather than silently assuming that toBitmap is RGBA.
  const probePng = await sharp(Buffer.from([231, 57, 19, 255]), {
    raw: { width: 1, height: 1, channels: 4 }
  }).png().toBuffer();
  const probe = nativeImage.createFromBuffer(probePng).toBitmap();
  const bgra = probe.equals(Buffer.from([19, 57, 231, 255]));
  if (!bgra && !probe.equals(Buffer.from([231, 57, 19, 255]))) {
    throw new Error("Unsupported NativeImage bitmap layout/color conversion");
  }
  console.log(JSON.stringify({ event: "bitmap_layout", order: bgra ? "BGRA" : "RGBA" }));
  let allEqual = true;
  for (const name of opts.input ? ["local-input"] : ["ui", "gradient", "noise"]) {
    const input = opts.input ? await readFile(opts.input) : await fixture(name);
    const loaded = nativeImage.createFromBuffer(input);
    if (loaded.isEmpty()) throw new Error("Input could not be decoded by Electron");
    const { width, height } = loaded.getSize();
    const bitmap = loaded.toBitmap();
    const freshImage = () => nativeImage.createFromBitmap(bitmap, { width, height });
    const reference = await decoded(freshImage().toPNG());
    const variants = ["native", "sharp-0", "sharp-1", "sharp-6"];
    // One unreported warmup per variant, then rotate order to limit order bias.
    for (let iteration = -1; iteration < opts.iterations; iteration++) {
      for (let index = 0; index < variants.length; index++) {
        const encoder = variants[(index + Math.max(0, iteration)) % variants.length];
        // A PNG-backed NativeImage can return its cached PNG in microseconds.
        // Start each sample from fresh raw pixels, like a desktopCapturer frame.
        // Fixture allocation is outside the encoder interval for ALL variants.
        const image = freshImage();
        const started = performance.now();
        let bitmapMs = 0;
        let swizzleMs = 0;
        let syncMs;
        let png;
        if (encoder === "native") {
          png = image.toPNG();
          syncMs = performance.now() - started;
        } else {
          const rgba = image.toBitmap();
          bitmapMs = performance.now() - started;
          if (rgba.length !== width * height * 4) throw new Error("Unexpected bitmap size");
          const swizzleStarted = performance.now();
          for (let offset = 0; offset < rgba.length; offset += 4) {
            // Deliberately gate this experiment to opaque desktop frames. Do not
            // treat premultiplied transparent pixels as straight-alpha RGBA.
            if (rgba[offset + 3] !== 255) throw new Error("Benchmark requires an opaque image");
            if (bgra) {
              const red = rgba[offset + 2];
              rgba[offset + 2] = rgba[offset];
              rgba[offset] = red;
            }
          }
          swizzleMs = performance.now() - swizzleStarted;
          const pending = sharp(rgba, { raw: { width, height, channels: 4 } })
            .png({ compressionLevel: Number(encoder.split("-")[1]), adaptiveFiltering: false })
            .toBuffer();
          syncMs = performance.now() - started;
          png = await pending;
        }
        const totalMs = performance.now() - started;
        // Verification is outside the timed region, includes dimensions and
        // color conversion, and rejects candidates that trade fidelity for speed.
        const actual = await decoded(png);
        const pixelsEqual = actual.info.width === reference.info.width
          && actual.info.height === reference.info.height && actual.data.equals(reference.data);
        allEqual &&= pixelsEqual;
        if (iteration >= 0) console.log(JSON.stringify({ event: "sample", fixture: name,
          iteration, encoder, width, height, byteSize: png.length,
          totalMs: roundMs(totalMs), syncMs: roundMs(syncMs),
          bitmapMs: roundMs(bitmapMs), swizzleMs: roundMs(swizzleMs), pixelsEqual }));
      }
    }
  }
  if (!allEqual) throw new Error("Pixel equivalence failed; do not adopt the candidate encoder");
}

app.whenReady().then(run).then(() => app.exit(0)).catch((error) => {
  // Avoid printing filesystem paths from optional local inputs.
  console.error(JSON.stringify({ event: "error", message: error.code ?? error.message }));
  app.exit(1);
});
