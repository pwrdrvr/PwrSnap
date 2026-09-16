// Navigation + window-open policy for every webContents PwrSnap creates.
//
// Why this exists
// ───────────────
// Electron's defaults here are both "yes". With no `setWindowOpenHandler`
// a `window.open` — which is what Chromium turns a middle-click or a
// cmd/ctrl-click on an `<a href>` into — creates a NEW BrowserWindow
// carrying the SAME webPreferences, i.e. our preload and its IPC bridge,
// pointed at content we did not choose. With no `will-navigate` listener
// a renderer may navigate its own top-level frame anywhere it likes, and
// the preload is re-attached to whatever lands.
//
// PwrSnap had neither. Ordinary operation never noticed, because every
// window is `contextIsolation: true, sandbox: true, nodeIntegration:
// false` and loads `file://` or the dev server — but the About page
// renders three real `<a href="https://…">` rows. Their `onClick`
// calls `preventDefault()` and routes through `app:openExternal`, which
// is right for a plain left-click and is NOT CONSULTED for a
// middle-click or a cmd-click. So the one surface that deliberately
// routes links through an allowlist could still be made to bypass it
// with a modifier key.
//
// This module is the backstop: no webContents may open a window, and
// none may navigate away from PwrSnap's own content. A URL that clears
// the SAME allowlist `app:openExternal` uses is handed to the user's
// browser instead; everything else is refused and logged.
//
// What this is NOT
// ────────────────
// Not a replacement for `app:openExternal`. That verb stays the way the
// renderer asks for a link to be opened; this is what happens when
// something bypasses it. Both consult `isAllowedExternalUrl` from
// external-url-allowlist.ts on purpose — two copies of a security
// predicate drift.

import { app, shell } from "electron";
import { fileURLToPath } from "node:url";
import { join, normalize } from "node:path";
import { isAllowedExternalUrl } from "./external-url-allowlist";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:navigation-guard");

/**
 * What the guard knows about "PwrSnap's own content" at the moment a
 * navigation is proposed. Passed in rather than read from module scope
 * so the decision function is pure and testable without faking
 * `__dirname`, `app.isPackaged` or the environment.
 */
export type NavigationContext = {
  /** Absolute path of the packaged renderer entry (`…/out/renderer/index.html`). */
  rendererEntryPath: string;
  /** Vite dev-server URL in `pnpm dev`; `undefined` in a packaged build. */
  devServerUrl: string | undefined;
  /** The URL the webContents is on right now, for the self-reload case. */
  currentUrl: string;
};

export type NavigationDecision =
  | { action: "allow" }
  | { action: "external"; url: string }
  | { action: "block" };

/** `file:` path of a URL, or `undefined` when it is not a parseable file URL. */
function filePathOf(url: URL): string | undefined {
  if (url.protocol !== "file:") return undefined;
  try {
    return normalize(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

/**
 * Is `rawUrl` PwrSnap's own content — somewhere a renderer may navigate
 * without leaving the app?
 *
 * Deliberately STRICTER than `isTrustedRendererUrl` in
 * media-permissions.ts, which answers a different question ("did this
 * request come from a page we loaded?") and accepts ANY `file:` URL and
 * ANY loopback port. Those are fine when classifying a request that has
 * already been made; they are too loose as a navigation TARGET, where
 * accepting any `file:` would let a renderer pull an arbitrary local
 * HTML file — a downloaded one, say — into a window that still has our
 * preload attached. Keep them separate; unifying them can only loosen
 * this one.
 *
 * The three things that are legitimately reachable:
 *
 * - the packaged renderer entry. Every window loads the same
 *   `index.html` and distinguishes itself by a `#stage=` hash, so one
 *   path covers all of them.
 * - the Vite dev-server origin, so `pnpm dev` and its HMR full-reloads
 *   keep working. Origin-compared, not "any loopback": another app's
 *   dev server on another port is not ours.
 * - the page the webContents is already on. `location.reload()` is
 *   renderer-initiated, so unlike a main-process `loadURL` it can reach
 *   `will-navigate` — and the renderer error boundary's Reload button is
 *   the recovery path when everything else has failed. Allowing a
 *   navigation to where we already are grants nothing new, and makes
 *   that button immune to a path-normalization difference that would
 *   only show up in a packaged build.
 *
 * `devtools:` is allowed because DevTools is a webContents like any
 * other and navigates itself internally; blocking it would break the
 * inspector without protecting anything.
 */
export function isAppNavigationTarget(rawUrl: string, ctx: NavigationContext): boolean {
  if (rawUrl === "") return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol === "devtools:") return true;

  const targetPath = filePathOf(url);
  if (targetPath !== undefined) {
    if (targetPath === normalize(ctx.rendererEntryPath)) return true;
    // Self-navigation (reload) of a file: page we are already showing.
    try {
      const current = new URL(ctx.currentUrl);
      const currentPath = filePathOf(current);
      if (currentPath !== undefined && currentPath === targetPath) return true;
    } catch {
      /* no current URL to compare against */
    }
    return false;
  }

  if (ctx.devServerUrl !== undefined) {
    try {
      if (url.origin === new URL(ctx.devServerUrl).origin) return true;
    } catch {
      /* malformed ELECTRON_RENDERER_URL — treat as no dev server */
    }
  }

  return false;
}

/**
 * The single decision every hook below shares. `allowSameApp` is false
 * for `window.open`: navigating to our own entry is ordinary, but
 * OPENING A SECOND WINDOW at it is not something any PwrSnap surface
 * does, and the window it would get carries our preload.
 */
export function decideNavigation(
  rawUrl: string,
  ctx: NavigationContext,
  options: { allowSameApp: boolean }
): NavigationDecision {
  if (options.allowSameApp && isAppNavigationTarget(rawUrl, ctx)) {
    return { action: "allow" };
  }
  if (isAllowedExternalUrl(rawUrl)) return { action: "external", url: rawUrl };
  return { action: "block" };
}

/** Hand an allowlisted URL to the user's browser. */
function openExternally(url: string, reason: string): void {
  void shell.openExternal(url).catch((cause: unknown) => {
    log.warn("failed to open external URL", {
      url,
      reason,
      error: cause instanceof Error ? cause.message : String(cause)
    });
  });
}

/**
 * Install the policy for every webContents in this process — the
 * windows that exist now and any created later, including DevTools.
 *
 * Must be called BEFORE any window loads. `web-contents-created` is not
 * replayed for webContents that already exist, so a late install leaves
 * whatever booted first unguarded.
 */
export function installNavigationGuard(): void {
  app.on("web-contents-created", (_event, contents) => {
    const context = (): NavigationContext => {
      let currentUrl = "";
      try {
        currentUrl = contents.getURL();
      } catch {
        /* destroyed mid-navigation */
      }
      return {
        rendererEntryPath: join(__dirname, "../renderer/index.html"),
        // Read per-call, not once at module load: the dev server URL is
        // an environment input and `app.isPackaged` is the production
        // kill switch for it.
        devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
        currentUrl
      };
    };

    // No PwrSnap surface opens a window this way, so the answer is
    // always "deny" — the question is only whether the URL was worth
    // handing to the browser. This is the hook a middle-click or a
    // cmd-click on an `<a href>` actually reaches.
    contents.setWindowOpenHandler(({ url, disposition }) => {
      const decision = decideNavigation(url, context(), { allowSameApp: false });
      if (decision.action === "external") {
        openExternally(decision.url, "window-open");
      } else {
        log.warn("blocked window open", { url, disposition });
      }
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => {
      const decision = decideNavigation(url, context(), { allowSameApp: true });
      if (decision.action === "allow") return;
      event.preventDefault();
      if (decision.action === "external") {
        openExternally(decision.url, "will-navigate");
      } else {
        log.warn("blocked navigation", { url });
      }
    });

    // `will-frame-navigate` is a superset of `will-navigate` — it fires
    // for the main frame AND every subframe. Main-frame navigations are
    // already handled above, so this arm takes ONLY subframes; acting on
    // both would open an allowlisted URL twice. PwrSnap renders no
    // iframes today, which is exactly why this is here: a subframe that
    // appears later inherits the policy instead of silently escaping it.
    //
    // A subframe is refused outright, with no external hand-off even for
    // an allowlisted URL: a hidden iframe that can pop browser tabs is a
    // worse gadget than the navigation it was trying to make.
    contents.on("will-frame-navigate", (details) => {
      if (details.isMainFrame) return;
      const decision = decideNavigation(details.url, context(), { allowSameApp: true });
      if (decision.action === "allow") return;
      details.preventDefault();
      log.warn("blocked subframe navigation", { url: details.url });
    });
  });
}
