import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

async function source(relativeUrl: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");
}

describe("renderer-owned selector capture production wiring", () => {
  test("the experiment defaults off and updates live from the settings substrate", async () => {
    const [settings, broker, selector, bootstrap, page] = await Promise.all([
      source("../settings/desktop-settings-service.ts"),
      source("../capture/selector-display-media.ts"),
      source("../capture/region-selector.ts"),
      source("../index.ts"),
      source("../../renderer/src/features/settings/pages/ExperimentalPage.tsx")
    ]);

    expect(settings).toContain("rendererOwnedSelectorCapture: false");
    expect(broker).toContain("let rendererOwnedSelectorCaptureEnabled = false");
    expect(selector).toContain("isRendererOwnedSelectorCaptureEnabled()");
    expect(bootstrap).toContain("setRendererOwnedSelectorCaptureEnabled(");
    expect(bootstrap).toContain("setRendererOwnedSelectorCaptureEnabled(false)");
    expect(bootstrap).toContain("settings.experimental.rendererOwnedSelectorCapture");
    expect(page).toContain("Use renderer-owned selector capture");
    expect(page).toContain("changes apply to the next capture");
  });

  test("opted-in macOS and Windows use display media without a main-process bitmap", async () => {
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
    expect(selector).toContain("payload.fullWindow === true && trustedWindow !== undefined");
    expect(selector).not.toContain(
      'selectorMode === "window" && payload.fullWindow === true'
    );
    expect(screencapture).not.toContain("captureWindowsPickerSnapshot");
    expect(screencapture).not.toContain("WINDOWS_PICKER_PREVIEW");
  });

  test("the renderer freezes/stops one track and encodes only the committed crop", async () => {
    const [component, frozenFrame, cropStream, preload, selector] = await Promise.all([
      source("../../renderer/src/features/region/RegionSelector.tsx"),
      source("../../renderer/src/features/region/frozen-frame.ts"),
      source("../../renderer/src/features/region/crop-stream.ts"),
      source("../../preload/index.ts"),
      source("../capture/region-selector.ts")
    ]);

    expect(frozenFrame).toContain("navigator.mediaDevices.getDisplayMedia");
    expect(frozenFrame).toContain("audio: false");
    expect(frozenFrame).toContain('cursor: "never"');
    expect(frozenFrame).toContain("createImageBitmap(video)");
    expect(frozenFrame).toContain("stopDisplayStream(stream)");
    expect(frozenFrame).toContain("FROZEN_FRAME_ACQUISITION_TIMEOUT_MS");
    expect(frozenFrame).toContain("waitForVideoFrame(video, controller.signal)");
    expect(frozenFrame).toContain("controller.abort(cause)");
    expect(frozenFrame).toContain('canvas.getContext("2d", { alpha: false })');
    expect(frozenFrame).not.toContain('canvas.getContext("bitmaprenderer")');
    expect(frozenFrame).toContain("encodeFrozenCrop");
    expect(component).toContain("frameAcquisitionStartedRef.current");
    expect(component).toContain("encodeFrozenCrop(frozen, r, viewport())");
    expect(component).toContain("openSelectorCropStream(currentInvocationId)");
    expect(component).toContain("streamEncodedCrop(currentInvocationId, crop");
    expect(component).toContain('"crop-commit-failed-encode"');
    expect(component).toContain('"crop-commit-failed-stream"');
    expect(cropStream).toContain("SELECTOR_CROP_CHUNK_BYTES");
    expect(cropStream).toContain(".slice(offset,");
    expect(cropStream).toContain("port.postMessage(message, transfer)");
    expect(cropStream).toContain('type: "pwrsnap-selector-crop-port"');
    expect(preload).toContain("event.ports");
    expect(preload).toContain('type: "pwrsnap-selector-frame-port"');
    expect(preload).toContain("ipcRenderer.postMessage(");
    expect(preload).toContain("REGION_SELECTOR_CROP_PORT_CHANNEL");
    expect(selector).toContain("ipcMain.on(SELECTOR_CROP_PORT_CHANNEL, installRendererCropPort)");
    expect(selector).toContain("isActiveSelectorSender(event.sender, invocationId)");
    expect(selector).toContain("lifecycle.cropPortOpened");
    expect(selector).toContain("ipcMain.removeAllListeners(SELECTOR_CROP_PORT_CHANNEL)");
    expect(component).toContain("onSelectorFrameRelease");
    expect(preload).toContain("REGION_SELECTOR_FRAME_RELEASE_CHANNEL");
    const hide = selector.indexOf("win.hide();");
    const release = selector.indexOf(
      "win.webContents.send(SELECTOR_FRAME_RELEASE_CHANNEL",
      hide
    );
    expect(hide).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(hide);
  });

  test("presentation uses a dedicated post-show generation-bound acknowledgement", async () => {
    const [selector, component, preload] = await Promise.all([
      source("../capture/region-selector.ts"),
      source("../../renderer/src/features/region/RegionSelector.tsx"),
      source("../../preload/index.ts")
    ]);

    const show = selector.indexOf("win.show();");
    const moveTop = selector.indexOf("win.moveTop();", show);
    const arm = selector.indexOf("win.webContents.send(SELECTOR_PRESENTATION_ARM_CHANNEL", moveTop);
    expect(show).toBeGreaterThanOrEqual(0);
    expect(moveTop).toBeGreaterThan(show);
    expect(arm).toBeGreaterThan(moveTop);
    expect(selector).toContain("onSelectorPresented?: (event: SelectorPresentedEvent) => void");
    expect(selector).toContain("isActiveSelectorSender(event.sender, presented.invocationId)");
    expect(component).toContain("onSelectorPresentationArm");
    expect(component).toContain("notifySelectorPresented");
    expect(component).toContain("expectedGeneration");
    expect(preload).toContain('"region-selector:presentation-arm"');
    expect(preload).toContain('"region-selector:presented"');
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
