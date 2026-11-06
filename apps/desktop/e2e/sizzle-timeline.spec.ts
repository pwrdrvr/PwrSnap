import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { test, expect, launchPwrSnap } from "./fixtures/electron-app";

test("agent timeline imports, frame inspection, fixed slots, and cached revisions", async ({}, testInfo) => {
  test.skip(
    process.platform !== "darwin",
    "This headed smoke test validates the macOS encoder and utility-process path"
  );
  const app = await launchPwrSnap();
  try {
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
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;
    const imported = await app.dispatch("sizzle:importAsset", {
      id,
      path: source
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
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
    const inspected = await app.dispatch("sizzle:inspectFrames", {
      id,
      frames: [0, 8, 23]
    });
    expect(inspected.ok).toBe(true);
    if (inspected.ok)
      expect([inspected.value.widthPx, inspected.value.heightPx]).toEqual([
        960, 180
      ]);
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
      expectedModifiedAt: saved.value.modifiedAt
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
    expect((await app.dispatch("sizzle:open", { projectId: id })).ok).toBe(
      true
    );
    await expect
      .poll(() =>
        app.electronApp
          .windows()
          .some((win) => win.url().includes("stage=sizzle"))
      )
      .toBe(true);
    const reel = app.electronApp
      .windows()
      .find((win) => win.url().includes("stage=sizzle"))!;
    await expect(
      reel.getByRole("heading", { name: "Launch preview" })
    ).toBeVisible();
    await expect(reel.getByRole("slider")).toBeVisible();
    await expect(
      reel.getByRole("button", { name: "Show movie" })
    ).toBeEnabled();
    await expect(reel.locator("video")).toBeVisible();
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
