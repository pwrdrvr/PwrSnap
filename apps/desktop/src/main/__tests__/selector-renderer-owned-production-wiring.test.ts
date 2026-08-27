import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

async function source(relativeUrl: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");
}

describe("renderer-owned selector capture production wiring", () => {
  test("macOS and Windows arm display media instead of capturing a main-process bitmap", async () => {
    const [selector, broker, screencapture] = await Promise.all([
      source("../capture/region-selector.ts"),
      source("../capture/selector-display-media.ts"),
      source("../capture/screencapture.ts")
    ]);

    expect(selector).toContain("usesRendererDisplayMedia");
    expect(selector).toContain("installRendererFramePort(lifecycle, win, targetDisplay)");
    expect(selector).toContain('kind: "renderer-display-media"');
    expect(broker).toContain("thumbnailSize: { width: 0, height: 0 }");
    expect(broker).toContain('types: ["screen"]');
    expect(broker).toContain("callback({ video: { id: source.id, name: source.name } })");
    expect(broker).not.toContain("toPNG(");
    expect(broker).not.toContain("toJPEG(");
    expect(selector).not.toContain("captureWindowsPickerSnapshot");
    expect(screencapture).not.toContain("captureWindowsPickerSnapshot");
    expect(screencapture).not.toContain("WINDOWS_PICKER_PREVIEW");
  });

  test("the renderer freezes/stops one track and encodes only the committed crop", async () => {
    const [component, frozenFrame, preload] = await Promise.all([
      source("../../renderer/src/features/region/RegionSelector.tsx"),
      source("../../renderer/src/features/region/frozen-frame.ts"),
      source("../../preload/index.ts")
    ]);

    expect(frozenFrame).toContain("navigator.mediaDevices.getDisplayMedia");
    expect(frozenFrame).toContain("audio: false");
    expect(frozenFrame).toContain("createImageBitmap(video)");
    expect(frozenFrame).toContain("stopDisplayStream(stream)");
    expect(frozenFrame).toContain("encodeFrozenCrop");
    expect(component).toContain("frameAcquisitionStartedRef.current");
    expect(component).toContain("encodeFrozenCrop(frozen, r, viewport())");
    expect(component).toContain("[crop.bytes]");
    expect(preload).toContain("event.ports");
    expect(preload).toContain('type: "pwrsnap-selector-frame-port"');
  });

  test("the image handler consumes the committed crop before the explicit Linux fallback", async () => {
    const handler = await source("../handlers/capture-handlers.ts");
    const committed = handler.indexOf("committedCropPath !== undefined");
    const fallback = handler.indexOf("screenSnapshotId !== undefined", committed);
    expect(committed).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(committed);
    expect(handler).not.toContain("cropRegisteredSnapshot");
  });
});
