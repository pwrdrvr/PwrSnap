// Custom protocol handlers — the seam that lets renderers display
// captured images without ever crossing the structured-clone boundary.
//
// Two URL schemes:
//
//   pwrsnap-capture://<capture-id>
//     Resolves to the source PNG at captures.src_path. Used for
//     full-fidelity inspect / edit display.
//
//   pwrsnap-cache://<capture-id>/<width>w.<format>
//     Resolves through the render pipeline at the requested width. Hit
//     the disk cache when present, compose-on-demand on miss. Used for
//     library thumbnails, float-over preview, drag-out icons.
//     (Render coordinator + cache lands in Phase 1.6.)
//
// Both schemes are registered as `standard + secure + supportFetchAPI`
// so they behave like https:// to Chromium — survive `sandbox: true`,
// stream natively, support range requests, are CORS-clean. This is the
// pattern VS Code adopted when it migrated off file:// URLs to
// `vscode-file://`.

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { app, protocol } from "electron";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:protocols");

export const SCHEMES = {
  capture: "pwrsnap-capture",
  cache: "pwrsnap-cache"
} as const;

/**
 * Must be called BEFORE `app.whenReady()`. Registers the schemes as
 * privileged so they don't trip Chromium's sandbox / CSP guards.
 */
export function registerSchemesAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEMES.capture,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        corsEnabled: true,
        stream: true
      }
    },
    {
      scheme: SCHEMES.cache,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        corsEnabled: true,
        stream: true
      }
    }
  ]);
}

export type ProtocolResolver = {
  /**
   * Resolve a capture id to its source PNG path. Returns null for
   * unknown / soft-deleted captures (renderer gets a 404).
   */
  captureSourcePath(captureId: string): Promise<string | null>;
  /**
   * Resolve `(captureId, width, format)` to a rendered cache file.
   * Phase 1.6 implementation will compose on miss; Phase 1's stub
   * returns null and renderer falls back to the source via the capture
   * scheme.
   */
  cacheFile(req: {
    captureId: string;
    width: number;
    format: "png" | "webp";
  }): Promise<string | null>;
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

function mimeForPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function fileResponse(filePath: string): Promise<Response> {
  // net.fetch with file:// URLs is unreliable from inside a
  // protocol.handle callback (Electron's network stack can refuse the
  // scheme even when the schemes don't overlap). Read directly with
  // fs.readFile and construct the Response by hand — no scheme gymnastics,
  // and Content-Type / Content-Length come from the file itself.
  const [body, stats] = await Promise.all([readFile(filePath), stat(filePath)]);
  const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return new Response(arrayBuffer, {
    status: 200,
    headers: {
      "content-type": mimeForPath(filePath),
      "content-length": String(stats.size),
      "cache-control": "private, max-age=300"
    }
  });
}

/**
 * Wires both protocol handlers. Must be called inside `app.whenReady()`.
 */
export function installProtocolHandlers(resolver: ProtocolResolver): void {
  protocol.handle(SCHEMES.capture, async (request) => {
    const captureId = parseCaptureId(request.url, SCHEMES.capture);
    if (captureId === null) {
      log.warn("capture: invalid url", { url: request.url });
      return new Response("invalid capture id", { status: 400 });
    }
    try {
      const filePath = await resolver.captureSourcePath(captureId);
      if (filePath === null) {
        log.warn("capture: not found", { captureId });
        return new Response("not found", { status: 404 });
      }
      return await fileResponse(filePath);
    } catch (cause) {
      log.error("capture handler threw", {
        captureId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return new Response("internal error", { status: 500 });
    }
  });

  protocol.handle(SCHEMES.cache, async (request) => {
    const parsed = parseCacheUrl(request.url);
    if (parsed === null) {
      log.warn("cache: invalid url", { url: request.url });
      return new Response("invalid cache url", { status: 400 });
    }
    try {
      const filePath = await resolver.cacheFile(parsed);
      if (filePath === null) {
        log.warn("cache: not found", { ...parsed });
        return new Response("not found", { status: 404 });
      }
      return await fileResponse(filePath);
    } catch (cause) {
      log.error("cache handler threw", {
        ...parsed,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return new Response("internal error", { status: 500 });
    }
  });

  log.info("protocol handlers installed", {
    schemes: Object.values(SCHEMES).join(",")
  });
}

/**
 * Parse `pwrsnap-capture://<id>` → `<id>`. Tolerates trailing slashes.
 */
function parseCaptureId(url: string, scheme: string): string | null {
  const prefix = `${scheme}://`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length).replace(/^\/+/, "").replace(/\/+$/, "");
  if (rest.length === 0) return null;
  // Allow letters, digits, dashes — UUID-friendly but doesn't strictly enforce
  // UUID shape (the renderer might use slugs in the future).
  if (!/^[a-zA-Z0-9_-]+$/.test(rest)) return null;
  return rest;
}

/**
 * Parse `pwrsnap-cache://<id>/<width>w.<format>` → structured.
 * Width is clamped to [1, 8192] (DoS guard).
 */
function parseCacheUrl(
  url: string
): { captureId: string; width: number; format: "png" | "webp" } | null {
  const prefix = `${SCHEMES.cache}://`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const match = rest.match(/^([a-zA-Z0-9_-]+)\/(\d+)w\.(png|webp)\/?$/);
  if (match === null) return null;
  const [, captureId, widthStr, format] = match;
  if (captureId === undefined || widthStr === undefined || format === undefined) return null;
  const width = Number.parseInt(widthStr, 10);
  if (!Number.isFinite(width) || width < 1 || width > 8192) return null;
  return { captureId, width, format: format as "png" | "webp" };
}

// `app` is imported for type augmentation only when this module is
// loaded under non-test paths; at runtime, callers wrap install in
// `app.whenReady()`.
void app;
