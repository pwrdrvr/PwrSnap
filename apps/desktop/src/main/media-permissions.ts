// Chromium permission policy for PwrSnap's renderers.
//
// Why this exists
// ───────────────
// Electron's default, with no handler installed, is to GRANT every
// permission request a renderer makes. PwrSnap had no handler at all,
// so `notification`, `geolocation`, `midi`, `clipboard-read` and the
// rest were all reachable from any page we load. Nothing asked for
// them, which is exactly why it went unnoticed.
//
// It starts mattering now because the selector asks for `media`: it
// opens a microphone stream to drive the pre-flight level meter, and a
// camera stream to drive the preview. Turning that on without also
// deciding what the ANSWER is for every other permission would be
// widening the surface by accident.
//
// So: deny by default, allow exactly the two things a PwrSnap window
// legitimately needs, and only from windows PwrSnap itself created.
//
// What this is NOT
// ────────────────
// This is not the macOS TCC grant. Chromium's `media` permission and
// the OS microphone grant are separate gates and BOTH must pass: this
// handler decides whether the renderer may call `getUserMedia` at all,
// and macOS then decides whether the device opens — showing its own
// prompt the first time, which is the prompt the selector's "Allow"
// chip is there to trigger. Saying yes here says nothing about privacy;
// it just stops Chromium from refusing before the OS is ever asked.

import { session, type Session, type WebContents } from "electron";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:media-permissions");

/**
 * Permissions a PwrSnap renderer is allowed to hold.
 *
 * `media` — microphone and camera, for the selector's level meter and
 *   camera preview. Screen capture does NOT come through here; it goes
 *   through ScreenCaptureKit in the native recorder, or through
 *   `setDisplayMediaRequestHandler` for the renderer-owned selector
 *   snapshot path, neither of which consults this handler.
 *
 * `clipboard-sanitized-write` — Chromium asks for this on some
 *   `navigator.clipboard.write` paths. PwrSnap's copy affordances are
 *   user-initiated by construction.
 *
 * `fullscreen` — the Library's video transport has a Fullscreen button,
 *   and Electron routes `Element.requestFullscreen()` through this same
 *   handler. Leaving it out did not "keep the default"; it denied the
 *   request, and `VideoStage` swallows the rejection, so the button went
 *   quietly dead with no log and no UI feedback. Granting it reveals
 *   nothing — it makes an element we already render fill a window the
 *   user already has, and only for pages `isTrustedRendererUrl` accepts.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "media",
  "clipboard-sanitized-write",
  "fullscreen"
]);

/**
 * A request is only honored when it comes from a page PwrSnap loaded
 * itself. In dev that is the Vite dev server; in production the
 * packaged `file://` renderer. Anything else — a navigation that
 * escaped, an iframe, a devtools-injected page — is refused whatever
 * permission it asks for.
 */
export function isTrustedRendererUrl(rawUrl: string): boolean {
  if (rawUrl === "") return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === "file:") return true;
  // Vite dev server. Loopback only — a LAN-visible dev origin is still
  // not something we hand a microphone to.
  if (url.protocol === "http:" || url.protocol === "https:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return false;
}

/** Shared decision for both the request and the synchronous check. */
export function decidePermission(permission: string, requestingUrl: string): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  return isTrustedRendererUrl(requestingUrl);
}

/**
 * Install the policy on a session. Idempotent per session — Electron
 * keeps only the most recent handler for each hook, so calling this
 * twice replaces rather than stacks.
 *
 * Both hooks are installed on purpose. `setPermissionRequestHandler`
 * answers the asynchronous prompt path (`getUserMedia`), while
 * `setPermissionCheckHandler` answers the synchronous queries the
 * Permissions API and Chromium's own internals make
 * (`navigator.permissions.query`, and the pre-check `enumerateDevices`
 * consults before deciding whether to reveal device labels). Installing
 * only the first leaves the second at Chromium's default and the two
 * can then disagree.
 */
export function installMediaPermissionPolicy(target: Session = session.defaultSession): void {
  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = resolveRequestingUrl(webContents, details);
    const allowed = decidePermission(permission, requestingUrl);
    if (!allowed) {
      log.warn("permission request denied", { permission, requestingUrl });
    }
    callback(allowed);
  });

  target.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl =
      requestingOrigin !== "" ? requestingOrigin : resolveRequestingUrl(webContents, details);
    return decidePermission(permission, requestingUrl);
  });
}

function resolveRequestingUrl(
  webContents: WebContents | null,
  details?: { requestingUrl?: string }
): string {
  // `details.requestingUrl` is the authoritative origin of the request
  // — prefer it over the WebContents' current URL, which can already
  // have navigated by the time the callback runs.
  const fromDetails = details?.requestingUrl;
  if (typeof fromDetails === "string" && fromDetails !== "") return fromDetails;
  try {
    return webContents?.getURL() ?? "";
  } catch {
    return "";
  }
}
