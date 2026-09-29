// The GIF | MP4 switch at compact popover density. The markup is always
// there and CSS decides whether it shows, so what these pin is the state
// behind it: MP4 by default, the choice remembered, and a chord for the
// hidden format bringing that row forward.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VideoExportPresetGrid } from "../VideoExportPresetGrid";
import {
  VideoExportPresetsPanel,
  type VideoCopyShortcutRequest
} from "../VideoExportPresetsPanel";

const dispatch = vi.fn(async (name: string) => {
  if (name === "video:presetMetrics") return { ok: true, value: { metrics: [] } };
  if (name === "settings:read") {
    return {
      ok: true,
      value: { recording: { mp4IncludeMicrophone: true, mp4IncludeSystemAudio: true } }
    };
  }
  if (name === "clipboard:copyVideoFile") return { ok: true, value: { path: "/tmp/x.gif" } };
  return { ok: true, value: undefined };
});

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { pwrsnapApi: unknown }).pwrsnapApi = {
    platform: "darwin",
    dispatch,
    on: () => () => undefined
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  dispatch.mockClear();
});

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
    await Promise.resolve();
  });
  return container;
}

function inactive(el: HTMLElement): Record<"gif" | "mp4", string | null> {
  const read = (format: "gif" | "mp4"): string | null =>
    el
      .querySelector(`[data-testid="psl-copy-row-video-${format}-group"]`)
      ?.getAttribute("data-inactive") ?? null;
  return { gif: read("gif"), mp4: read("mp4") };
}

function switchButton(el: HTMLElement, group: "gif" | "mp4", format: "gif" | "mp4"): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>(
    `[data-testid="psl-copy-row-video-${group}-group"] .psl__copy-format-switch-btn[data-format="${format}"]`
  );
  if (found === null) throw new Error(`no ${format} switch in the ${group} group`);
  return found;
}

const panelProps = {
  captureId: "cap_1",
  audioTracks: { microphone: true, systemAudio: false },
  shortcutPlatform: "darwin"
} as const;

describe("GIF | MP4 switch", () => {
  test("a grid with no switch renders no switch and hides nothing", async () => {
    const el = await mount(
      createElement(VideoExportPresetGrid, {
        metrics: {},
        states: {},
        onCopy: () => undefined,
        onCopyPath: () => undefined,
        onDrag: () => undefined,
        shortcutPlatform: "darwin"
      })
    );
    expect(el.querySelector(".psl__copy-format-switch")).toBeNull();
    expect(el.querySelector("[data-inactive]")).toBeNull();
  });

  test("the panel starts on MP4, with the GIF row inactive", async () => {
    const el = await mount(createElement(VideoExportPresetsPanel, panelProps));
    expect(inactive(el)).toEqual({ gif: "true", mp4: "false" });
    // Both eyebrows carry the switch, so whichever row is showing has it.
    expect(switchButton(el, "mp4", "mp4").getAttribute("aria-pressed")).toBe("true");
    expect(switchButton(el, "gif", "gif").getAttribute("aria-pressed")).toBe("false");
    // Hidden by CSS, not unmounted: all six cards are still in the tree.
    expect(el.querySelectorAll(".fo__copy-card")).toHaveLength(6);
  });

  test("clicking GIF swaps the active row", async () => {
    const el = await mount(createElement(VideoExportPresetsPanel, panelProps));
    await act(async () => switchButton(el, "mp4", "gif").click());
    expect(inactive(el)).toEqual({ gif: "false", mp4: "true" });
    expect(switchButton(el, "gif", "gif").getAttribute("aria-pressed")).toBe("true");
  });

  test("the pick is remembered by the next panel in the window", async () => {
    let el = await mount(createElement(VideoExportPresetsPanel, panelProps));
    await act(async () => switchButton(el, "mp4", "gif").click());
    act(() => root!.unmount());
    container!.remove();
    el = await mount(createElement(VideoExportPresetsPanel, panelProps));
    expect(inactive(el)).toEqual({ gif: "false", mp4: "true" });
    // Leave the module state where the other tests expect it.
    await act(async () => switchButton(el, "gif", "mp4").click());
  });

  test("a chord for the hidden format brings that row forward", async () => {
    const shortcut: VideoCopyShortcutRequest = {
      captureId: "cap_1",
      format: "gif",
      preset: "low",
      sequence: 1
    };
    const el = await mount(
      createElement(VideoExportPresetsPanel, { ...panelProps, copyShortcut: shortcut })
    );
    expect(inactive(el)).toEqual({ gif: "false", mp4: "true" });
    const copies = dispatch.mock.calls.filter(([name]) => name === "clipboard:copyVideoFile");
    expect(copies).toHaveLength(1);
    await act(async () => switchButton(el, "gif", "mp4").click());
  });
});
