// Headless integration probe against the production renderer assets. No real
// camera, Electron window, external request or user-library file is involved.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../out/renderer",
);
const mime = {
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".html": "text/html",
  ".tflite": "application/octet-stream",
};
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      root,
      `.${decodeURIComponent(new URL(req.url, "http://localhost").pathname)}`,
    );
    if (!path.startsWith(root + sep)) throw new Error("Invalid asset path");
    res.setHeader(
      "Content-Type",
      mime[extname(path)] ?? "application/octet-stream",
    );
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const page = await browser.newPage();
  const pageErrors = [],
    requested = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    requested.push(route.request().url());
    return route.request().url().startsWith(origin) ||
      route.request().url().startsWith("blob:")
      ? route.continue()
      : route.abort();
  });
  await page.addInitScript(() => {
    window.cameraChunks = [];
    window.pwrsnapApi = {
      dispatch: async (command, req) => {
        if (
          command !== "recording:cameraChunk" ||
          req.bytes.length > 256 * 1024
        )
          throw new Error("Unexpected camera command");
        window.cameraChunks.push(new Uint8Array(req.bytes));
        return { ok: true, value: { accepted: true } };
      },
    };
  });
  if (process.argv.includes("--webm")) {
    await page.addInitScript(() => {
      const supported = MediaRecorder.isTypeSupported.bind(MediaRecorder);
      MediaRecorder.isTypeSupported = mime => !mime.startsWith("video/mp4") && supported(mime);
    });
  }
  await page.goto(`${origin}/camera.html`);
  await page.waitForFunction(() => !!window.pwrsnapCameraWorker);
  const recording = await page.evaluate(async () => {
    const media = await navigator.mediaDevices.getUserMedia({ video: true });
    const deviceId = media.getVideoTracks()[0].getSettings().deviceId;
    media.getTracks().forEach((track) => track.stop());
    return window.pwrsnapCameraWorker.record(deviceId, "test-camera");
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const stopped = await page.evaluate(() => window.pwrsnapCameraWorker.stop());
  assert(stopped.durationSec >= 1);
  assert(recording.width > 0 && recording.height > 0);
  if (process.argv.includes("--webm")) assert.equal(recording.mimeType, "video/webm");
  const bytes = await page.evaluate(async (mime) => {
    const source = new Blob(window.cameraChunks, { type: mime });
    const hash = async () =>
      [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", await source.arrayBuffer()),
        ),
      ].join();
    window.cameraSource = source;
    window.cameraHash = hash;
    window.beforeHash = await hash();
    await window.pwrsnapCameraWorker.open(URL.createObjectURL(source));
    return source.size;
  }, recording.mimeType);
  assert(bytes > 1000);
  const firstMask = await page.evaluate(() =>
    window.pwrsnapCameraWorker.frame(0.1, 320, 180),
  );
  const secondMask = await page.evaluate(() =>
    window.pwrsnapCameraWorker.frame(0.1, 320, 180),
  );
  const image = Buffer.from(firstMask, "base64");
  assert.equal(image.readUInt32BE(16), 640); // packed RGB + alpha
  assert.equal(image.readUInt32BE(20), 180);
  assert.equal(
    firstMask,
    secondMask,
    "The same source frame regenerates the same mask",
  );
  assert(
    await page.evaluate(
      async () => window.beforeHash === (await window.cameraHash()),
    ),
  );
  assert(
    requested.some((url) => url.endsWith("selfie_segmenter_landscape.tflite")),
  );
  assert(requested.some((url) => url.endsWith(".wasm")));
  assert.deepEqual(pageErrors, []);
  console.log(
    `Camera pipeline passed (${recording.mimeType}): ${bytes} immutable source bytes, ${recording.width}×${recording.height}, local MediaPipe mask regenerated identically.`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
