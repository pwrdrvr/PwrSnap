// TrayMenu — the header's "Open Library" button.
//
// Regression pin: the button's tooltip used to hard-code "(⌘⇧L)", but
// main never registered a global ⌘⇧L — the chord was pure fiction (the
// only ⌘⇧L in the app toggles the reel rail *inside* the Sizzle
// window). The tooltip now reads `settings.hotkeys.openLibrary`, which
// ships UNBOUND, so a fresh install advertises no chord at all and a
// user-bound chord shows up verbatim.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_HOTKEYS, type Settings } from "@pwrsnap/shared";
import { TrayMenu } from "../TrayMenu";

// `useLibrary` owns a MODULE-LEVEL store (`let snapshot`, `subscribed`, a
// listeners Set) plus an uncancelled `setTimeout(refetchHead, 100)` from
// ensureSubscription(). Both outlive unmount, so unmocked: only the first
// test here would ever dispatch `library:list` (the rest hit
// `if (subscribed) return` and render its leftover snapshot), and the
// stray timer can fire into a later test — or after the file ends, with
// `pwrsnapApi` already deleted — updating a React store outside act().
// `vi.resetModules()` does NOT fix this: TrayMenu is imported statically,
// so the singleton is bound before any test runs. Mocking is the fix, and
// costs nothing — these tests are about the header button, not the
// last-snap block.
vi.mock("../../../lib/useLibrary", () => ({
  useLibrary: () => ({
    loading: false,
    isLoadingMore: false,
    rows: [],
    hasMore: false,
    appStats: [],
    totalLive: 0,
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

type EventHandler = (payload: unknown) => void;

/** Minimal `window.pwrsnapApi` for the tray: `useHotkeys` reads
 *  `settings:read` and the display strip reads `system:listDisplays`.
 *  (`useLibrary` is mocked above, so no `library:list` stub is needed.)
 *  Everything else resolves empty. */
function installTrayApi(hotkeys: Partial<Settings["hotkeys"]>): {
  calls: string[];
} {
  const calls: string[] = [];
  window.pwrsnapApi = {
    dispatch: vi.fn(async (name: string) => {
      calls.push(name);
      if (name === "settings:read") {
        return { ok: true, value: { hotkeys: { ...DEFAULT_HOTKEYS, ...hotkeys } } };
      }
      if (name === "system:listDisplays") return { ok: true, value: { displays: [] } };
      if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
      return { ok: true, value: undefined };
    }),
    on: (_channel: string, _handler: EventHandler) => () => undefined,
    requestTrayResize: vi.fn(),
    startCaptureDrag: vi.fn()
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return { calls };
}

async function renderTray(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(TrayMenu));
  });
  // Let the settings:read / library:list promises land.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function openLibraryButton(el: HTMLElement): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll("button")).find((b) =>
    b.querySelector(".sr-only")?.textContent === "Open Library"
  );
  if (found === undefined) throw new Error("Open Library button not found");
  return found as HTMLButtonElement;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  delete (window as { pwrsnapApi?: unknown }).pwrsnapApi;
});

describe("TrayMenu — Open Library button", () => {
  // Self-pin the invariant the rest of this file assumes. `installTrayApi`
  // spreads DEFAULT_HOTKEYS, so without this a flip of the shipped default
  // to a real chord would leave all three tests green while the tray went
  // back to advertising a binding by default.
  test("openLibrary ships unbound", () => {
    expect(DEFAULT_HOTKEYS.openLibrary).toBe("");
  });

  test("advertises no chord when openLibrary is unbound (the shipped default)", async () => {
    installTrayApi({ openLibrary: "" });
    const el = await renderTray();

    expect(openLibraryButton(el).title).toBe("Open Library");
    // The specific lie we regressed on.
    expect(el.innerHTML).not.toContain("⌘⇧L");
  });

  test("renders the live chord once the user binds one", async () => {
    installTrayApi({ openLibrary: "CommandOrControl+Alt+Shift+L" });
    const el = await renderTray();

    expect(openLibraryButton(el).title).toBe("Open Library  (⌘⌥⇧L)");
  });

  test("clicking it dispatches library:focus", async () => {
    const { calls } = installTrayApi({ openLibrary: "" });
    const el = await renderTray();

    // Snapshot the mount-time dispatches first, so this asserts the BUTTON
    // sent it rather than "something did at some point".
    expect(calls).not.toContain("library:focus");
    await act(async () => {
      openLibraryButton(el).click();
    });

    expect(calls).toContain("library:focus");
  });
});
