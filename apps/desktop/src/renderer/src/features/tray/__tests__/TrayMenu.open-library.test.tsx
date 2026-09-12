// TrayMenu — the header's "Open Library" button.
//
// Regression pin: the button's tooltip used to hard-code "(⌘⇧L)", but
// main never registered a global ⌘⇧L — the chord was pure fiction (the
// only ⌘⇧L in the app toggles the reel rail *inside* the Sizzle
// window). The tooltip now reads `settings.hotkeys.openLibrary` through
// `activeTrayHotkeyKeys`, which shows a chord only when main reports it
// REGISTERED — so a fresh install (openLibrary ships unbound) advertises
// nothing, and a chord the OS refused doesn't get advertised either.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_HOTKEYS,
  type HotkeyRegistrationStatusSnapshot,
  type HotkeySettingKey,
  type Settings
} from "@pwrsnap/shared";
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

/** A snapshot in which every bound chord registered cleanly — the happy
 *  path the tooltip is allowed to advertise. */
function allRegistered(hotkeys: Settings["hotkeys"]): HotkeyRegistrationStatusSnapshot {
  const entries = (Object.keys(hotkeys) as HotkeySettingKey[]).map((key) => [
    key,
    {
      key,
      accelerator: hotkeys[key],
      state: hotkeys[key] === "" ? ("unbound" as const) : ("active" as const),
      failure: null
    }
  ]);
  return Object.fromEntries(entries) as HotkeyRegistrationStatusSnapshot;
}

/** Minimal `window.pwrsnapApi` for the tray: `useHotkeys` reads
 *  `settings:read`, the tooltip gate reads `settings:hotkeyStatus`, and
 *  the display strip reads `system:listDisplays`. (`useLibrary` is
 *  mocked above, so no `library:list` stub is needed.) Everything else
 *  resolves empty. */
function installTrayApi(
  hotkeys: Partial<Settings["hotkeys"]>,
  status?: HotkeyRegistrationStatusSnapshot
): {
  calls: string[];
} {
  const calls: string[] = [];
  const merged: Settings["hotkeys"] = { ...DEFAULT_HOTKEYS, ...hotkeys };
  window.pwrsnapApi = {
    // The tooltip renders through `acceleratorToDisplayKeys`, which is
    // platform-aware (#508): without a platform the bridge falls back to
    // the Windows keycaps and the ⌘ assertions below become untestable.
    platform: "darwin",
    dispatch: vi.fn(async (name: string) => {
      calls.push(name);
      if (name === "settings:read") {
        return { ok: true, value: { hotkeys: merged } };
      }
      if (name === "settings:hotkeyStatus") {
        return { ok: true, value: status ?? allRegistered(merged) };
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

  test("stays silent about a bound chord main could not register", async () => {
    // The whole point of the original bug was a tooltip promising a
    // chord nothing handled. A chord the OS refused is the same lie by
    // a different route, so the registration gate has to cover it.
    const merged: Settings["hotkeys"] = {
      ...DEFAULT_HOTKEYS,
      openLibrary: "CommandOrControl+Alt+Shift+L"
    };
    const status = allRegistered(merged);
    installTrayApi(
      { openLibrary: "CommandOrControl+Alt+Shift+L" },
      {
        ...status,
        openLibrary: {
          key: "openLibrary",
          accelerator: "CommandOrControl+Alt+Shift+L",
          state: "inactive",
          failure: null
        }
      }
    );
    const el = await renderTray();

    expect(openLibraryButton(el).title).toBe("Open Library");
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
