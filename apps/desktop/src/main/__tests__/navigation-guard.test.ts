// Pins the navigation/window-open policy in navigation-guard.ts.
//
// This is a backstop whose whole value is being unreachable in normal
// operation, so nothing in the app exercises it and no E2E spec can
// observe it. The hooks are registered against a fake `webContents` and
// driven directly — the same shape as the other main-process policy
// tests (media-permissions, window-content-protection).

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  appOn: vi.fn(),
  isPackaged: false,
  warn: vi.fn()
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  app: {
    on: mocks.appOn,
    get isPackaged() {
      return mocks.isPackaged;
    }
  } as unknown as typeof import("electron").app,
  shell: {
    openExternal: mocks.openExternal
  } as unknown as typeof import("electron").shell
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    warn: mocks.warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

import {
  decideNavigation,
  installNavigationGuard,
  isAppNavigationTarget,
  type NavigationContext
} from "../navigation-guard";

const ENTRY = "/Applications/PwrSnap.app/Contents/Resources/app.asar/out/renderer/index.html";

function ctx(overrides: Partial<NavigationContext> = {}): NavigationContext {
  return {
    rendererEntryPath: ENTRY,
    devServerUrl: undefined,
    currentUrl: `file://${ENTRY}`,
    ...overrides
  };
}

/**
 * Registers the guard and returns the hooks it installed on one fake
 * webContents, plus that fake's listener table.
 */
function installOnFakeContents(options: { url?: string } = {}) {
  mocks.appOn.mockReset();
  installNavigationGuard();

  const registered = mocks.appOn.mock.calls.find((c) => c[0] === "web-contents-created");
  expect(registered, "guard must listen on web-contents-created").toBeDefined();

  const listeners = new Map<string, (...args: never[]) => void>();
  let windowOpenHandler: ((d: { url: string; disposition: string }) => {
    action: string;
  }) | undefined;

  const contents = {
    getURL: () => options.url ?? `file://${ENTRY}`,
    setWindowOpenHandler: (h: typeof windowOpenHandler) => {
      windowOpenHandler = h;
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
      return contents;
    }
  };

  (registered as unknown as [string, (e: unknown, c: unknown) => void])[1](
    {},
    contents
  );

  return {
    windowOpen: (url: string, disposition = "foreground-tab") => {
      expect(windowOpenHandler).toBeDefined();
      return windowOpenHandler!({ url, disposition });
    },
    willNavigate: (url: string) => {
      const listener = listeners.get("will-navigate");
      expect(listener, "guard must listen on will-navigate").toBeDefined();
      const event = { preventDefault: vi.fn() };
      (listener as unknown as (e: unknown, u: string) => void)(event, url);
      return event;
    },
    willFrameNavigate: (url: string, isMainFrame: boolean) => {
      const listener = listeners.get("will-frame-navigate");
      expect(listener, "guard must listen on will-frame-navigate").toBeDefined();
      const details = { url, isMainFrame, preventDefault: vi.fn() };
      (listener as unknown as (d: unknown) => void)(details);
      return details;
    }
  };
}

beforeEach(() => {
  mocks.openExternal.mockClear();
  mocks.warn.mockClear();
  mocks.isPackaged = false;
  delete process.env.ELECTRON_RENDERER_URL;
});

describe("isAppNavigationTarget", () => {
  test("accepts the packaged renderer entry, with and without a stage hash", () => {
    expect(isAppNavigationTarget(`file://${ENTRY}`, ctx())).toBe(true);
    expect(isAppNavigationTarget(`file://${ENTRY}#stage=settings`, ctx())).toBe(true);
  });

  test("accepts a reload of the page the webContents is already on", () => {
    // The renderer error boundary's Reload button is a renderer-initiated
    // navigation, so it reaches will-navigate. It must survive even if the
    // entry path never matches for some packaging reason.
    const devUrl = "http://localhost:5173/#stage=library";
    expect(
      isAppNavigationTarget(devUrl, ctx({ currentUrl: `file://${ENTRY}` }))
    ).toBe(false);
    expect(
      isAppNavigationTarget(`file:///somewhere/else/index.html`, ctx({
        currentUrl: "file:///somewhere/else/index.html"
      }))
    ).toBe(true);
  });

  test("rejects any other local file", () => {
    for (const url of [
      "file:///Users/someone/Downloads/evil.html",
      "file:///etc/passwd",
      `file://${ENTRY}/../../../evil.html`
    ]) {
      expect(isAppNavigationTarget(url, ctx()), url).toBe(false);
    }
  });

  test("accepts the dev-server origin only when one is configured", () => {
    const dev = ctx({ devServerUrl: "http://localhost:5173" });
    expect(isAppNavigationTarget("http://localhost:5173/", dev)).toBe(true);
    expect(isAppNavigationTarget("http://localhost:5173/#stage=settings", dev)).toBe(true);
    // A different loopback port is somebody else's dev server.
    expect(isAppNavigationTarget("http://localhost:9999/", dev)).toBe(false);
    // With no dev server (packaged), the same URL is refused.
    expect(isAppNavigationTarget("http://localhost:5173/", ctx())).toBe(false);
  });

  test("accepts devtools: so the inspector keeps working", () => {
    expect(
      isAppNavigationTarget("devtools://devtools/bundled/devtools_app.html", ctx())
    ).toBe(true);
  });

  test("rejects remote origins and unparseable input", () => {
    for (const url of [
      "https://pwrsnap.com",
      "https://evil.example.com",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "not a url",
      ""
    ]) {
      expect(isAppNavigationTarget(url, ctx()), url).toBe(false);
    }
  });
});

describe("decideNavigation", () => {
  test("allowlisted external URLs are handed off, not allowed in-place", () => {
    expect(
      decideNavigation("https://github.com/pwrdrvr/PwrSnap", ctx(), { allowSameApp: true })
    ).toEqual({ action: "external", url: "https://github.com/pwrdrvr/PwrSnap" });
  });

  test("a window.open at our own entry is blocked, not allowed", () => {
    // allowSameApp: false — no PwrSnap surface opens a second window this
    // way, and the window it would get carries our preload.
    expect(
      decideNavigation(`file://${ENTRY}`, ctx(), { allowSameApp: false })
    ).toEqual({ action: "block" });
    expect(
      decideNavigation(`file://${ENTRY}`, ctx(), { allowSameApp: true })
    ).toEqual({ action: "allow" });
  });
});

describe("installNavigationGuard", () => {
  test("denies every window.open, and opens an allowlisted URL externally", () => {
    const guard = installOnFakeContents();

    expect(guard.windowOpen("https://github.com/pwrdrvr/PwrSnap")).toEqual({
      action: "deny"
    });
    expect(mocks.openExternal).toHaveBeenCalledWith("https://github.com/pwrdrvr/PwrSnap");
  });

  test("denies a window.open at a non-allowlisted URL without opening anything", () => {
    const guard = installOnFakeContents();

    // Positive control: github.com is trusted, but only under /pwrdrvr.
    expect(guard.windowOpen("https://github.com/someone-else/repo")).toEqual({
      action: "deny"
    });
    expect(guard.windowOpen("https://evil.example.com")).toEqual({ action: "deny" });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalled();
  });

  test("blocks a cross-origin navigation and routes an allowlisted one out", () => {
    const guard = installOnFakeContents();

    const blocked = guard.willNavigate("https://evil.example.com");
    expect(blocked.preventDefault).toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();

    const external = guard.willNavigate("https://docs.pwrsnap.com");
    expect(external.preventDefault).toHaveBeenCalled();
    expect(mocks.openExternal).toHaveBeenCalledWith("https://docs.pwrsnap.com");
  });

  test("allows a same-origin navigation", () => {
    const guard = installOnFakeContents();

    const event = guard.willNavigate(`file://${ENTRY}#stage=settings`);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  test("allows the dev-server origin so `pnpm dev` keeps working", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    const guard = installOnFakeContents({ url: "http://localhost:5173/#stage=library" });

    const event = guard.willNavigate("http://localhost:5173/#stage=library");
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("the dev-server origin is refused in a packaged build", () => {
    // `app.isPackaged` is the kill switch: a stray ELECTRON_RENDERER_URL in
    // a shipped app must not open a navigation path.
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    mocks.isPackaged = true;
    const guard = installOnFakeContents({ url: `file://${ENTRY}` });

    const event = guard.willNavigate("http://localhost:5173/");
    expect(event.preventDefault).toHaveBeenCalled();
  });

  test("subframe navigations are guarded, main-frame ones are left to will-navigate", () => {
    const guard = installOnFakeContents();

    // Main frame: handled by will-navigate, so this arm must not act —
    // acting on both would open an allowlisted URL twice.
    const mainFrame = guard.willFrameNavigate("https://evil.example.com", true);
    expect(mainFrame.preventDefault).not.toHaveBeenCalled();

    const subFrame = guard.willFrameNavigate("https://evil.example.com", false);
    expect(subFrame.preventDefault).toHaveBeenCalled();
  });
});
