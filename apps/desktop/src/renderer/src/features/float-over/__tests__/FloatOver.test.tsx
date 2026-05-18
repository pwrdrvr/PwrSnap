// Pins the FloatOver toast's asset-mode discriminator. Image mode
// stays byte-for-byte unchanged (existing snapshots / specs cover
// that flow); these tests focus on the video branch — preview
// element, GIF/MP4 button shape, export-state subtitle, audio-track-
// aware copy.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { FloatOver, type FloatOverAsset } from "../FloatOver";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderToast(asset: FloatOverAsset): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(FloatOver, {
        asset,
        src: asset.src,
        srcW: 1920,
        srcH: 1080,
        srcBytes: 1024,
        startCountdown: false
      })
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function unmount(): Promise<void> {
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
}

afterEach(async () => {
  await unmount();
});

describe("FloatOver asset mode", () => {
  test("video asset renders <video> in fo__preview and GIF/MP4 buttons in fo__copy", async () => {
    await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/abc",
      durationSec: 12.5,
      hasSystemAudio: true,
      hasMicrophoneAudio: false,
      onExport: () => undefined
    });

    // Preview slot has a <video>, not an <img>.
    const preview = container?.querySelector(".fo__preview");
    expect(preview?.querySelector("video")).not.toBeNull();
    expect(preview?.querySelector("img")).toBeNull();
    expect(preview?.querySelector("video")?.getAttribute("src")).toBe("pwrsnap-capture://r/abc");

    // Header reads "Recording saved" with the duration appended.
    expect(container?.querySelector(".fo__hdr-title")?.textContent).toBe("Recording saved");
    expect(container?.querySelector(".fo__hdr-sub")?.textContent).toContain("12.5s");

    // Copy row has exactly two buttons: GIF + MP4 in that order.
    const copyRow = container?.querySelector(".fo__copy");
    const buttons = copyRow?.querySelectorAll("button.fo__copy-btn");
    expect(buttons?.length).toBe(2);
    expect(buttons?.[0]?.querySelector(".fo__copy-label")?.textContent).toBe("GIF");
    expect(buttons?.[1]?.querySelector(".fo__copy-label")?.textContent).toBe("MP4");
  });

  test("MP4 subtitle reflects audio track availability", async () => {
    await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/audio",
      durationSec: 5,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport: () => undefined
    });
    let buttons = container!.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[1]?.textContent).toContain("Full clip · silent");

    await unmount();
    await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/audio",
      durationSec: 5,
      hasSystemAudio: true,
      hasMicrophoneAudio: false,
      onExport: () => undefined
    });
    buttons = container!.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[1]?.textContent).toContain("Full clip · with audio");
  });

  test("export-state Encoding / Saved / Failed subtitle reflects state per format", async () => {
    await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/s",
      durationSec: 1,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport: () => undefined,
      exportState: { kind: "running", format: "gif" }
    });
    let buttons = container!.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[0]?.textContent).toContain("Encoding…");
    // The other format is untouched.
    expect(buttons[1]?.textContent).toContain("Full clip");

    await unmount();
    await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/s",
      durationSec: 1,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport: () => undefined,
      exportState: { kind: "done", format: "mp4", path: "/tmp/x.mp4" }
    });
    buttons = container!.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[1]?.textContent).toContain("Saved");

    await unmount();
    await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/s",
      durationSec: 1,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport: () => undefined,
      exportState: { kind: "error", format: "gif", message: "boom" }
    });
    buttons = container!.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[0]?.textContent).toContain("Failed — retry");
  });

  test("clicking GIF / MP4 invokes onExport with the right format", async () => {
    const onExport = vi.fn();
    await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/click",
      durationSec: 3,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport
    });
    const [gif, mp4] = Array.from(
      container!.querySelectorAll<HTMLButtonElement>(".fo__copy button.fo__copy-btn")
    );
    await act(async () => {
      gif?.click();
      mp4?.click();
    });
    expect(onExport).toHaveBeenCalledWith("gif");
    expect(onExport).toHaveBeenCalledWith("mp4");
  });

  test("image asset (default) keeps the existing <img> + Low/Med/High copy row", async () => {
    await renderToast({
      kind: "image",
      src: "pwrsnap-capture://r/img"
    });
    expect(container?.querySelector(".fo__preview img")).not.toBeNull();
    expect(container?.querySelector(".fo__preview video")).toBeNull();
    // Default copy row has THREE columns (Low / Med / High).
    const copyButtons = container?.querySelectorAll(".fo__copy > *");
    expect(copyButtons?.length).toBe(3);
    expect(container?.querySelector(".fo__hdr-title")?.textContent).toBe("Snap captured");
  });
});
