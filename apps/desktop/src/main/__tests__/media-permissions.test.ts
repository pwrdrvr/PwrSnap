import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  session: { defaultSession: {} },
  app: { getAppPath: () => "/fake/app" }
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

import {
  decidePermission,
  installMediaPermissionPolicy,
  isTrustedRendererUrl
} from "../media-permissions";

describe("renderer trust", () => {
  test.each([
    "file:///Applications/PwrSnap.app/Contents/Resources/app.asar/out/renderer/index.html",
    "http://localhost:5173/index.html",
    "http://127.0.0.1:5173/index.html"
  ])("trusts a PwrSnap-loaded page: %s", (url) => {
    expect(isTrustedRendererUrl(url)).toBe(true);
  });

  test.each([
    ["a remote origin", "https://example.com/"],
    ["a LAN dev server", "http://192.168.1.20:5173/"],
    ["a non-loopback host that merely looks local", "http://localhost.evil.com/"],
    ["an unparseable url", "not a url"],
    ["an empty url", ""],
    ["a data url", "data:text/html,<script>navigator.mediaDevices.getUserMedia({audio:1})</script>"]
  ])("refuses %s", (_label, url) => {
    expect(isTrustedRendererUrl(url)).toBe(false);
  });
});

describe("permission policy", () => {
  test("allows only the permissions PwrSnap actually uses", () => {
    const trusted = "file:///app/index.html";
    expect(decidePermission("media", trusted)).toBe(true);
    expect(decidePermission("clipboard-sanitized-write", trusted)).toBe(true);
    // Electron routes `Element.requestFullscreen()` through this handler,
    // so omitting it does not leave the Fullscreen button alone — it
    // breaks it, silently, because the renderer swallows the rejection.
    expect(decidePermission("fullscreen", trusted)).toBe(true);
  });

  test("denies fullscreen to an untrusted origin", () => {
    expect(decidePermission("fullscreen", "https://example.com/")).toBe(false);
  });

  // The reason the handler exists at all: with no handler installed,
  // Electron grants every one of these.
  test.each([
    "geolocation",
    "notifications",
    "midi",
    "midiSysex",
    "clipboard-read",
    "display-capture",
    "openExternal",
    "pointerLock",
    "idle-detection",
    "hid",
    "serial",
    "usb"
  ])("denies %s even from a trusted page", (permission) => {
    expect(decidePermission(permission, "file:///app/index.html")).toBe(false);
  });

  test("denies media to an untrusted origin", () => {
    expect(decidePermission("media", "https://example.com/")).toBe(false);
  });
});

describe("installation", () => {
  function install(): {
    request: (wc: unknown, p: string, cb: (ok: boolean) => void, d?: unknown) => void;
    check: (wc: unknown, p: string, origin: string, d?: unknown) => boolean;
  } {
    let request: unknown;
    let check: unknown;
    installMediaPermissionPolicy({
      setPermissionRequestHandler: (handler: unknown) => {
        request = handler;
      },
      setPermissionCheckHandler: (handler: unknown) => {
        check = handler;
      }
    } as never);
    return {
      request: request as never,
      check: check as never
    };
  }

  // Both hooks, not one. The request handler answers getUserMedia; the
  // check handler answers navigator.permissions.query and the
  // pre-check enumerateDevices makes before revealing device labels.
  // Installing only one leaves the other at Chromium's default and the
  // two can disagree.
  test("installs both the request and the check handler", () => {
    const { request, check } = install();
    expect(typeof request).toBe("function");
    expect(typeof check).toBe("function");
  });

  test("prefers details.requestingUrl over the contents' current url", () => {
    const { request } = install();
    const seen: boolean[] = [];
    // A page that has already navigated somewhere trusted must not
    // launder a request that originated on a remote origin.
    request(
      { getURL: () => "file:///app/index.html" },
      "media",
      (ok: boolean) => seen.push(ok),
      { requestingUrl: "https://example.com/" }
    );
    expect(seen).toEqual([false]);
  });

  test("falls back to the contents url when details carry none", () => {
    const { request } = install();
    const seen: boolean[] = [];
    request({ getURL: () => "file:///app/index.html" }, "media", (ok: boolean) => seen.push(ok));
    expect(seen).toEqual([true]);
  });

  test("survives a destroyed WebContents", () => {
    const { request } = install();
    const seen: boolean[] = [];
    request(
      {
        getURL: () => {
          throw new Error("Object has been destroyed");
        }
      },
      "media",
      (ok: boolean) => seen.push(ok)
    );
    expect(seen).toEqual([false]);
  });

  test("check handler honors the origin it is given", () => {
    const { check } = install();
    expect(check(null, "media", "file:///app/index.html")).toBe(true);
    expect(check(null, "media", "https://example.com/")).toBe(false);
    expect(check(null, "geolocation", "file:///app/index.html")).toBe(false);
  });
});
