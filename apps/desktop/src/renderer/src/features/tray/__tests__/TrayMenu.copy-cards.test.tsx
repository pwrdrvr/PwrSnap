// TrayMenu — the last snap's Low / Med / High copy cards must describe
// the snap exactly as every other copy surface does.
//
// The tray rendered its cards from the legacy estimate alone and never
// resolved the DPI-aware export ladder, so with "DPI-aware export" on it
// showed no Retina / scale tags. The float-over toast, open on the SAME
// snap beside it, said HIGH 2880 × 1878 RETINA while the tray said
// nothing — the same capture, described two ways.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { DEFAULT_HOTKEYS, EVENT_CHANNELS } from "@pwrsnap/shared";
import { TrayMenu } from "../TrayMenu";

const LAST_SNAP = {
  id: "snap_retina_0001",
  kind: "image",
  captured_at: new Date().toISOString(),
  width_px: 2880,
  height_px: 1878,
  device_pixel_ratio: 2,
  byte_size: 2_400_000,
  edits_version: 0,
  source_app_name: "Cereal Box",
  video: null
};

vi.mock("../../../lib/useLibrary", () => ({
  useLibrary: () => ({
    loading: false,
    isLoadingMore: false,
    rows: [LAST_SNAP],
    hasMore: false,
    appStats: [],
    totalLive: 1,
    error: null,
    loadMore: async () => undefined,
    refresh: async () => undefined
  }),
  useSelectedCaptureId: () => [null, () => undefined]
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    class ResizeObserver {
      observe(): void {
        return;
      }
      unobserve(): void {
        return;
      }
      disconnect(): void {
        return;
      }
    } as unknown as typeof ResizeObserver;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const handlers = new Map<string, Set<(payload: unknown) => void>>();

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  handlers.clear();
  delete (window as { pwrsnapApi?: unknown }).pwrsnapApi;
});

function experimental(dpiAwareExport: boolean, allowRetinaExport: boolean) {
  return { dpiAwareExport, allowRetinaExport };
}

function installApi(exp: ReturnType<typeof experimental>): void {
  window.pwrsnapApi = {
    platform: "darwin",
    dispatch: vi.fn(async (name: string) => {
      if (name === "settings:read") {
        return { ok: true, value: { hotkeys: DEFAULT_HOTKEYS, experimental: exp } };
      }
      if (name === "system:listDisplays") return { ok: true, value: { displays: [] } };
      if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
      return { ok: true, value: undefined };
    }),
    on: (channel: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
    requestTrayResize: vi.fn(),
    startCaptureDrag: vi.fn()
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
}

async function renderTray(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(TrayMenu));
  });
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  return container;
}

function cardTags(el: HTMLElement): Array<string | null> {
  return [...el.querySelectorAll(".ps-tray__last-copy .fo__copy-btn")].map(
    (card) => card.querySelector(".fo__copy-tag")?.textContent ?? null
  );
}

function cardDims(el: HTMLElement): string[] {
  return [...el.querySelectorAll(".ps-tray__last-copy .fo__copy-dim")].map(
    (dim) => dim.textContent ?? ""
  );
}

describe("TrayMenu last-snap copy cards", () => {
  test("a 2× snap says Retina on High, like the toast and the Library", async () => {
    installApi(experimental(true, true));
    const el = await renderTray();
    expect(cardTags(el)).toEqual(["½×", "1×", "Retina"]);
    expect(cardDims(el)[0]).toContain("720");
  });

  test("Retina export off tops out at 1×, and drops a Low too small to read", async () => {
    installApi(experimental(true, false));
    const el = await renderTray();
    // Logical width 1440: Low would be 360px, under the 480px floor.
    expect(cardTags(el)).toEqual([null, "½×", "1×"]);
    const low = el.querySelector<HTMLButtonElement>(".ps-tray__last-copy .fo__copy-btn")!;
    expect(low.disabled).toBe(true);
  });

  test("legacy export shows no tags", async () => {
    installApi(experimental(false, true));
    const el = await renderTray();
    expect(cardTags(el)).toEqual([null, null, null]);
  });

  test("follows a settings change without reopening", async () => {
    installApi(experimental(false, true));
    const el = await renderTray();
    await act(async () => {
      for (const handler of handlers.get(EVENT_CHANNELS.settingsChanged) ?? []) {
        handler({ settings: { hotkeys: DEFAULT_HOTKEYS, experimental: experimental(true, true) } });
      }
    });
    expect(cardTags(el)).toEqual(["½×", "1×", "Retina"]);
  });
});
