import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  test,
  expect,
  launchPwrSnap,
  type LaunchedApp
} from "./fixtures/electron-app";

const ffmpeg = [
  process.env.PWRSNAP_FFMPEG_PATH,
  path.resolve(import.meta.dirname, "../build/ffmpeg/ffmpeg"),
  ...(process.env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) => path.join(directory, "ffmpeg"))
].find((candidate): candidate is string =>
  Boolean(candidate && existsSync(candidate))
);

async function prepareTimeline(app: LaunchedApp) {
  const source = path.join(app.homeRoot, "contrived-source.png");
  await writeFile(
    source,
    await sharp({
      create: { width: 400, height: 200, channels: 3, background: "#ff8a1f" }
    })
      .png()
      .toBuffer()
  );
  const created = await app.dispatch("sizzle:create", {
    name: "Launch preview"
  });
  if (!created.ok) throw new Error(created.error.message);
  const id = created.value.id;
  const imported = await app.dispatch("sizzle:importAsset", {
    id,
    path: source
  });
  if (!imported.ok) throw new Error(JSON.stringify(imported.error));
  const current = await app.dispatch("sizzle:get", { id });
  if (!current.ok) throw new Error(current.error.message);
  const saved = await app.dispatch("sizzle:setTimeline", {
    id,
    expectedModifiedAt: current.value.modifiedAt,
    timeline: {
      version: 1,
      width: 320,
      height: 180,
      bindings: { count: 4200 },
      scenes: [
        {
          id: "benchmark",
          durationFrames: 12,
          layers: [
            {
              id: "image",
              kind: "image",
              assetId: imported.value.id,
              x: 0,
              y: 0,
              width: 320,
              height: 180
            },
            {
              id: "number",
              kind: "counter",
              x: 10,
              y: 50,
              width: 300,
              height: 70,
              fontSize: 48,
              align: "center",
              from: 0,
              to: { binding: "count" },
              countFrames: 6
            }
          ]
        },
        {
          id: "end",
          durationFrames: 12,
          layers: [
            {
              id: "title",
              kind: "text",
              text: "Get it done.",
              x: 20,
              y: 45,
              width: 280,
              height: 90,
              fontSize: 36
            }
          ]
        }
      ]
    }
  });
  if (!saved.ok) throw new Error(saved.error.message);
  return { id, saved: saved.value };
}

async function openTimeline(app: LaunchedApp, id: string) {
  const opened = await app.dispatch("sizzle:open", { projectId: id });
  if (!opened.ok) throw new Error(opened.error.message);
  await expect
    .poll(() =>
      app.electronApp
        .windows()
        .some((win) => win.url().includes("stage=sizzle"))
    )
    .toBe(true);
  return app.electronApp
    .windows()
    .find((win) => win.url().includes("stage=sizzle"))!;
}

test("agent still timeline imports, frame inspection, and review without an encoder", async ({}, testInfo) => {
  test.skip(
    process.platform !== "darwin",
    "Sizzle rendering currently supports macOS and Windows"
  );
  const app = await launchPwrSnap();
  try {
    const { id } = await prepareTimeline(app);
    const inspected = await app.dispatch("sizzle:inspectFrames", {
      id,
      frames: [0, 8, 23]
    });
    if (!inspected.ok) throw new Error(JSON.stringify(inspected.error));
    expect([inspected.value.widthPx, inspected.value.heightPx]).toEqual([
      960, 180
    ]);
    const reel = await openTimeline(app, id);
    await expect(
      reel.getByRole("heading", { name: "Launch preview" })
    ).toBeVisible();
    await expect(reel.getByRole("slider")).toBeVisible();
    await expect
      .poll(() =>
        reel
          .locator("img")
          .first()
          .evaluate((image: HTMLImageElement) => image.naturalWidth)
      )
      .toBeGreaterThan(0);
    await reel.screenshot({ path: testInfo.outputPath("sizzle-timeline.png") });
  } finally {
    await app.close();
  }
});

test("agent timeline movie rendering reuses unchanged scenes and exports to Movies", async () => {
  test.skip(
    process.platform !== "darwin" || !ffmpeg,
    "Requires the macOS FFmpeg sidecar or an explicitly installed development encoder"
  );
  const app = await launchPwrSnap({ env: { PWRSNAP_FFMPEG_PATH: ffmpeg } });
  try {
    const { id, saved } = await prepareTimeline(app);
    const first = await app.dispatch("sizzle:render", { id, mode: "preview" });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value).toMatchObject({
      durationSec: 0.8,
      renderedScenes: 2,
      cachedScenes: 0
    });
    const updated = await app.dispatch("sizzle:setBindings", {
      id,
      bindings: { count: 5200 },
      expectedModifiedAt: saved.modifiedAt
    });
    if (!updated.ok) throw new Error(updated.error.message);
    const revised = await app.dispatch("sizzle:render", {
      id,
      mode: "preview"
    });
    if (!revised.ok) throw new Error(revised.error.message);
    expect(revised.value).toMatchObject({
      durationSec: 0.8,
      renderedScenes: 1,
      cachedScenes: 1
    });
    const full = await app.dispatch("sizzle:render", { id, mode: "full" });
    if (!full.ok) throw new Error(full.error.message);
    expect(
      full.value.outputPath.startsWith(
        path.join(app.homeRoot, "Movies", "PwrSnap")
      )
    ).toBe(true);
    const reel = await openTimeline(app, id);
    await expect(
      reel.getByRole("button", { name: "Show movie" })
    ).toBeEnabled();
    await expect(reel.locator("video")).toBeVisible();
  } finally {
    await app.close();
  }
});
