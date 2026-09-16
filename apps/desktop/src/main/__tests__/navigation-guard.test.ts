// Pins the navigation/window-open policy in navigation-guard.ts.
//
// This is a backstop whose whole value is being unreachable in normal
// operation, so nothing in the app exercises it and no E2E spec can
// observe it. The hooks are registered against a fake `webContents` and
// driven directly — the same shape as the other main-process policy
// tests (media-permissions, window-content-protection).

import { beforeEach, describe, expect, test, vi } from "vitest";
import { normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * Fixtures are built with the platform's own path/URL helpers, never by
 * string-concatenating `file://` onto a POSIX path: `file:///Applications/…`
 * is not a valid file URL on Windows (`fileURLToPath` throws
 * ERR_INVALID_FILE_URL_PATH with no drive letter), so a hardcoded POSIX
 * fixture made every entry-path assertion fail there while passing on macOS
 * and Linux — caught by the Windows CI lane, not locally.
 *
 * `rendererEntryPath` is normalized because production normalizes once at
 * module scope and then compares verbatim.
 */
const ENTRY = normalize(
  resolve("/Applications/PwrSnap.app/Contents/Resources/app.asar/out/renderer/index.html")
);
const ENTRY_URL = pathToFileURL(ENTRY).href;
const OTHER_PAGE = normalize(resolve("/somewhere/else/index.html"));
const OTHER_PAGE_URL = pathToFileURL(OTHER_PAGE).href;

function ctx(overrides: Partial<NavigationContext> = {}): NavigationContext {
  return {
    rendererEntryPath: ENTRY,
    devServerUrl: undefined,
    currentUrl: ENTRY_URL,
    ...overrides
  };
}

// The guard installs ONE `web-contents-created` listener for the whole
// process, and it is idempotent — so install once here and drive that single
// listener with a fresh fake webContents per test, which is also the shape
// production runs in.
installNavigationGuard();
const createdListener = mocks.appOn.mock.calls.find(
  (c) => c[0] === "web-contents-created"
)?.[1] as ((event: unknown, contents: unknown) => void) | undefined;

/** Attach the guard to one fake webContents and expose its hooks. */
function attachFakeContents(options: { url?: string } = {}) {
  expect(createdListener, "guard must listen on web-contents-created").toBeDefined();

  const listeners = new Map<string, (...args: never[]) => void>();
  let windowOpenHandler:
    | ((d: { url: string; disposition: string }) => { action: string })
    | undefined;

  const contents = {
    getURL: () => options.url ?? ENTRY_URL,
    setWindowOpenHandler: (h: typeof windowOpenHandler) => {
      windowOpenHandler = h;
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
      return contents;
    }
  };

  createdListener!({}, contents);

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
    expect(isAppNavigationTarget(ENTRY_URL, ctx())).toBe(true);
    expect(isAppNavigationTarget(`${ENTRY_URL}#stage=settings`, ctx())).toBe(true);
  });

  test("accepts a reload of the page the webContents is already on", () => {
    // The renderer error boundary's Reload button is a renderer-initiated
    // navigation, so it reaches will-navigate. It must survive even if the
    // entry path never matches for some packaging reason — hence a page that
    // is deliberately NOT the entry.
    expect(OTHER_PAGE).not.toBe(ENTRY);
    expect(
      isAppNavigationTarget(OTHER_PAGE_URL, ctx({ currentUrl: OTHER_PAGE_URL }))
    ).toBe(true);
    // ...and only that page: being on it does not license a different one.
    expect(
      isAppNavigationTarget(
        OTHER_PAGE_URL.replace("index.html", "other.html"),
        ctx({ currentUrl: OTHER_PAGE_URL })
      )
    ).toBe(false);
  });

  test("rejects any other local file", () => {
    for (const url of [
      pathToFileURL(resolve("/Users/someone/Downloads/evil.html")).href,
      `${ENTRY_URL}/../../../evil.html`
    ]) {
      expect(isAppNavigationTarget(url, ctx()), url).toBe(false);
    }
  });

  test("refuses a file: URL that carries a host", () => {
    // `fileURLToPath` throws ERR_INVALID_FILE_URL_HOST here. The file branch
    // must refuse outright rather than fall through to the dev-server origin
    // test: `URL.origin` is the string "null" for EVERY opaque scheme, so an
    // origin comparison cannot tell this apart from a data: URL.
    const withHost = "file://evil.example.com/Applications/x/index.html";
    expect(isAppNavigationTarget(withHost, ctx())).toBe(false);
    expect(
      isAppNavigationTarget(withHost, ctx({ devServerUrl: "http://localhost:5173" }))
    ).toBe(false);
    // Same trap from the other side: a dev-server URL whose own origin is
    // opaque must not make every opaque-origin target match it.
    expect(
      isAppNavigationTarget("data:text/html,<script>1</script>", ctx({
        devServerUrl: "weird:///whatever"
      }))
    ).toBe(false);
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
    expect(decideNavigation(ENTRY_URL, ctx(), { allowSameApp: false })).toEqual({
      action: "block"
    });
    expect(decideNavigation(ENTRY_URL, ctx(), { allowSameApp: true })).toEqual({
      action: "allow"
    });
  });
});

describe("installNavigationGuard", () => {
  test("denies every window.open, and opens an allowlisted URL externally", () => {
    const guard = attachFakeContents();

    expect(guard.windowOpen("https://github.com/pwrdrvr/PwrSnap")).toEqual({
      action: "deny"
    });
    expect(mocks.openExternal).toHaveBeenCalledWith("https://github.com/pwrdrvr/PwrSnap");
  });

  test("denies a window.open at a non-allowlisted URL without opening anything", () => {
    const guard = attachFakeContents();

    // Positive control: github.com is trusted, but only under /pwrdrvr.
    expect(guard.windowOpen("https://github.com/someone-else/repo")).toEqual({
      action: "deny"
    });
    expect(guard.windowOpen("https://evil.example.com")).toEqual({ action: "deny" });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalled();
  });

  test("a refused URL is logged without its query string or fragment", () => {
    const guard = attachFakeContents();

    guard.windowOpen("https://evil.example.com/cb?code=s3cret&state=xyz#tok=abc");

    expect(mocks.warn).toHaveBeenCalledWith("blocked window open", {
      url: "https://evil.example.com/cb",
      disposition: "foreground-tab"
    });
    const logged = JSON.stringify(mocks.warn.mock.calls);
    expect(logged).not.toContain("s3cret");
    expect(logged).not.toContain("tok=abc");
  });

  test("blocks a cross-origin navigation and routes an allowlisted one out", () => {
    const guard = attachFakeContents();

    const blocked = guard.willNavigate("https://evil.example.com");
    expect(blocked.preventDefault).toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();

    const external = guard.willNavigate("https://docs.pwrsnap.com");
    expect(external.preventDefault).toHaveBeenCalled();
    expect(mocks.openExternal).toHaveBeenCalledWith("https://docs.pwrsnap.com");
  });

  test("allows a same-origin navigation", () => {
    const guard = attachFakeContents();

    const event = guard.willNavigate(`${ENTRY_URL}#stage=settings`);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  test("allows the dev-server origin so `pnpm dev` keeps working", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    const guard = attachFakeContents({ url: "http://localhost:5173/#stage=library" });

    const event = guard.willNavigate("http://localhost:5173/#stage=library");
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("the dev-server origin is refused in a packaged build", () => {
    // `app.isPackaged` is the kill switch: a stray ELECTRON_RENDERER_URL in
    // a shipped app must not open a navigation path.
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    mocks.isPackaged = true;
    const guard = attachFakeContents();

    const event = guard.willNavigate("http://localhost:5173/");
    expect(event.preventDefault).toHaveBeenCalled();
  });

  test("installing twice does not double-register the hooks", () => {
    // The guard APPENDS an emitter listener, so a second registration would
    // give every webContents two will-navigate listeners and one click on an
    // allowlisted link would open two browser tabs.
    const before = mocks.appOn.mock.calls.filter(
      (c) => c[0] === "web-contents-created"
    ).length;
    installNavigationGuard();
    installNavigationGuard();
    const after = mocks.appOn.mock.calls.filter(
      (c) => c[0] === "web-contents-created"
    ).length;

    expect(before).toBe(1);
    expect(after).toBe(before);
  });

  test("subframe navigations are guarded, main-frame ones are left to will-navigate", () => {
    const guard = attachFakeContents();

    // Main frame: handled by will-navigate, so this arm must not act —
    // acting on both would open an allowlisted URL twice.
    const mainFrame = guard.willFrameNavigate("https://evil.example.com", true);
    expect(mainFrame.preventDefault).not.toHaveBeenCalled();

    const subFrame = guard.willFrameNavigate("https://evil.example.com", false);
    expect(subFrame.preventDefault).toHaveBeenCalled();
  });

  test("a subframe is refused even for an allowlisted URL", () => {
    const guard = attachFakeContents();

    const sub = guard.willFrameNavigate("https://github.com/pwrdrvr/PwrSnap", false);
    expect(sub.preventDefault).toHaveBeenCalled();
    // A hidden iframe that can pop browser tabs is a worse gadget than the
    // navigation it was attempting.
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
