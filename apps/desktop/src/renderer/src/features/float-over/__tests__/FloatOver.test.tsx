import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureEnrichment } from "@pwrsnap/shared";
import { FloatOver, type FloatOverAsset } from "../FloatOver";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function enrichment(patch: Partial<CaptureEnrichment> = {}): CaptureEnrichment {
  return {
    captureId: "cap_1",
    latestRunId: "run_1",
    status: "completed",
    ocrText: "LINE",
    suggestedDescription: "Dark-mode LINE desktop chat showing PwrAgent command help.",
    acceptedDescription: null,
    descriptionAcceptedAt: null,
    suggestedTags: [
      { id: "tag_1", label: "line", confidence: 0.91, accepted_at: null, rejected_at: null },
      { id: "tag_2", label: "chat", confidence: 0.84, accepted_at: null, rejected_at: null }
    ],
    acceptedTags: [],
    ...patch
  };
}

async function renderFloatOver(props: Parameters<typeof FloatOver>[0]): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(FloatOver, props));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

async function renderToast(asset: FloatOverAsset): Promise<HTMLDivElement> {
  return renderFloatOver({
    asset,
    src: asset.src,
    srcW: 1920,
    srcH: 1080,
    srcBytes: 1024,
    startCountdown: false
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

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  await unmount();
});

describe("FloatOver asset mode", () => {
  test("video asset renders <video> in fo__preview and GIF/MP4 buttons in fo__copy", async () => {
    const el = await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/abc",
      durationSec: 12.5,
      hasSystemAudio: true,
      hasMicrophoneAudio: false,
      onExport: () => undefined
    });

    const preview = el.querySelector(".fo__preview");
    expect(preview?.querySelector("video")).not.toBeNull();
    expect(preview?.querySelector("img")).toBeNull();
    expect(preview?.querySelector("video")?.getAttribute("src")).toBe("pwrsnap-capture://r/abc");

    expect(el.querySelector(".fo__hdr-title")?.textContent).toBe("Recording saved");
    expect(el.querySelector(".fo__hdr-sub")?.textContent).toContain("12.5s");

    const buttons = el.querySelectorAll("button.fo__copy-btn");
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.querySelector(".fo__copy-label")?.textContent).toBe("GIF");
    expect(buttons[1]?.querySelector(".fo__copy-label")?.textContent).toBe("MP4");
  });

  test("MP4 subtitle reflects audio track availability", async () => {
    let el = await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/audio",
      durationSec: 5,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport: () => undefined
    });
    let buttons = el.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[1]?.textContent).toContain("Full clip · silent");

    await unmount();
    el = await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/audio",
      durationSec: 5,
      hasSystemAudio: true,
      hasMicrophoneAudio: false,
      onExport: () => undefined
    });
    buttons = el.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[1]?.textContent).toContain("Full clip · with audio");
  });

  test("export-state Encoding / Saved / Failed subtitle reflects state per format", async () => {
    let el = await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/s",
      durationSec: 1,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport: () => undefined,
      exportState: { kind: "running", format: "gif" }
    });
    let buttons = el.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[0]?.textContent).toContain("Encoding…");
    expect(buttons[1]?.textContent).toContain("Full clip");

    await unmount();
    el = await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/s",
      durationSec: 1,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport: () => undefined,
      exportState: { kind: "done", format: "mp4", path: "/tmp/x.mp4" }
    });
    buttons = el.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[1]?.textContent).toContain("Saved");

    await unmount();
    el = await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/s",
      durationSec: 1,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport: () => undefined,
      exportState: { kind: "error", format: "gif", message: "boom" }
    });
    buttons = el.querySelectorAll(".fo__copy button.fo__copy-btn");
    expect(buttons[0]?.textContent).toContain("Failed — retry");
  });

  test("clicking GIF / MP4 invokes onExport with the right format", async () => {
    const onExport = vi.fn();
    const el = await renderToast({
      kind: "video",
      src: "pwrsnap-capture://r/click",
      durationSec: 3,
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      onExport
    });
    const [gif, mp4] = Array.from(
      el.querySelectorAll<HTMLButtonElement>(".fo__copy button.fo__copy-btn")
    );
    await act(async () => {
      gif?.click();
      mp4?.click();
    });
    expect(onExport).toHaveBeenCalledWith("gif");
    expect(onExport).toHaveBeenCalledWith("mp4");
  });

  test("image asset (default) keeps the existing <img> + Low/Med/High copy row", async () => {
    const el = await renderToast({
      kind: "image",
      src: "pwrsnap-capture://r/img"
    });
    expect(el.querySelector(".fo__preview img")).not.toBeNull();
    expect(el.querySelector(".fo__preview video")).toBeNull();
    expect(el.querySelectorAll(".fo__copy > *").length).toBe(3);
    expect(el.querySelector(".fo__hdr-title")?.textContent).toBe("Snap captured");
  });
});

describe("FloatOver Codex suggestions", () => {
  test("previews Codex suggested description in the description field", async () => {
    const onAcceptDescription = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment(),
      aiEnabled: true,
      aiConsentAccepted: true,
      onAcceptDescription
    });

    const textarea = el.querySelector<HTMLTextAreaElement>(".fo__desc");
    expect(textarea?.value).toBe("Dark-mode LINE desktop chat showing PwrAgent command help.");
    expect(textarea?.classList.contains("is-suggested")).toBe(true);

    textarea?.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(onAcceptDescription).not.toHaveBeenCalled();
  });

  test("does not pause countdown just because a Codex description is previewed", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment(),
      aiEnabled: true,
      aiConsentAccepted: true
    });

    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(false);
  });

  test("pauses countdown while Codex is still running", async () => {
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment({
        status: "running",
        suggestedDescription: null,
        suggestedTags: []
      }),
      aiEnabled: true,
      aiConsentAccepted: true
    });

    expect(el.querySelector(".fo")?.classList.contains("is-thinking")).toBe(true);
    expect(el.querySelector(".fo")?.classList.contains("is-paused")).toBe(true);
  });

  test("accepts suggested description when the user clicks Use", async () => {
    const onAcceptDescription = vi.fn();
    const el = await renderFloatOver({
      src: "data:image/png;base64,",
      startCountdown: false,
      enrichment: enrichment(),
      aiEnabled: true,
      aiConsentAccepted: true,
      onAcceptDescription
    });

    await act(async () => {
      el.querySelector<HTMLButtonElement>(".fo__ai-accept")?.click();
    });

    expect(onAcceptDescription).toHaveBeenCalledWith(
      "Dark-mode LINE desktop chat showing PwrAgent command help."
    );
  });
});
