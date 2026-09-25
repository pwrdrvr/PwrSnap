// The MP4 row's audio toggles. One per track the take recorded, pressed
// = in the file; a take with no audio says so; GIF never gets one.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VideoExportPresetGrid } from "../VideoExportPresetGrid";
import type { Mp4AudioControl } from "../useMp4ExportAudio";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

function render(mp4Audio: Mp4AudioControl | undefined): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(VideoExportPresetGrid, {
        metrics: {},
        states: {},
        onCopy: () => undefined,
        onCopyPath: () => undefined,
        onDrag: () => undefined,
        shortcutPlatform: "darwin",
        mp4Audio
      })
    );
  });
  return container;
}

function toggles(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>(".psl__copy-audio-toggle")];
}

function group(el: HTMLElement, format: "gif" | "mp4"): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[data-testid="psl-copy-row-video-${format}-group"]`);
  if (found === null) throw new Error(`no ${format} group`);
  return found;
}

function control(overrides: Partial<Mp4AudioControl> = {}): Mp4AudioControl {
  return {
    recorded: { microphone: true, systemAudio: true },
    kept: { microphone: true, systemAudio: true },
    onToggle: vi.fn(),
    ...overrides
  };
}

describe("VideoExportPresetGrid MP4 audio toggles", () => {
  test("one toggle per recorded track, on the MP4 row only", () => {
    const el = render(control());

    expect(toggles(group(el, "gif"))).toHaveLength(0);
    const mp4 = toggles(group(el, "mp4"));
    expect(mp4.map((b) => b.dataset.track)).toEqual(["microphone", "systemAudio"]);
    expect(mp4.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
  });

  test("a left-out track reads as off in text, glyph and pressed state — not colour alone", () => {
    const el = render(control({ kept: { microphone: false, systemAudio: true } }));
    const [mic, system] = toggles(el);

    expect(mic!.getAttribute("aria-pressed")).toBe("false");
    expect(mic!.textContent).toBe("Micoff");
    // The slash across the mic only exists in the left-out glyph.
    expect(mic!.querySelector('path[d="M2 2l12 12"]')).not.toBeNull();
    expect(system!.getAttribute("aria-pressed")).toBe("true");
    expect(system!.textContent).toBe("System");
  });

  test("a left-out system track draws the speaker crossed, not with sound waves", () => {
    const el = render(control({ kept: { microphone: true, systemAudio: false } }));
    const [mic, system] = toggles(el);

    expect(mic!.querySelector('path[d="M2 2l12 12"]')).toBeNull();
    expect(system!.querySelector('path[d="M10.6 6.2l3.6 3.6M14.2 6.2l-3.6 3.6"]')).not.toBeNull();
    expect(system!.querySelector('path[d="M12.7 4.2a5.2 5.2 0 0 1 0 7.6"]')).toBeNull();
  });

  test("the accessible name starts with the visible label and never says off", () => {
    const el = render(control({ kept: { microphone: false, systemAudio: true } }));
    const [mic] = toggles(el);

    expect(mic!.getAttribute("aria-label")).toBe("Mic audio in MP4 exports");
    const hidden = mic!.querySelector('[aria-hidden="true"]:not(svg)');
    expect(hidden?.textContent).toBe("off");
  });

  test("clicking a toggle asks to flip that track", () => {
    const onToggle = vi.fn();
    const el = render(control({ kept: { microphone: true, systemAudio: false }, onToggle }));
    const [mic, system] = toggles(el);

    act(() => mic!.click());
    act(() => system!.click());

    expect(onToggle.mock.calls).toEqual([
      ["microphone", false],
      ["systemAudio", true]
    ]);
  });

  test("a take with only a microphone gets only the Mic toggle", () => {
    const el = render(control({ recorded: { microphone: true, systemAudio: false } }));

    expect(toggles(el).map((b) => b.dataset.track)).toEqual(["microphone"]);
  });

  test("a take with no audio says so instead of offering a control", () => {
    const el = render(control({ recorded: { microphone: false, systemAudio: false } }));

    expect(toggles(el)).toHaveLength(0);
    expect(el.querySelector('[data-testid="psl-copy-audio-none"]')?.textContent).toBe(
      "No audio recorded"
    );
  });

  test("no toggles until the saved preference has loaded", () => {
    const el = render(control({ kept: null }));

    expect(toggles(el)).toHaveLength(0);
    expect(el.querySelector('[data-testid="psl-copy-audio-none"]')).toBeNull();
  });

  test("surfaces that pass no control render the grid unchanged", () => {
    const el = render(undefined);

    expect(toggles(el)).toHaveLength(0);
    expect(el.querySelector('[data-testid="psl-copy-audio-none"]')).toBeNull();
  });
});
