// Custom protocol handlers — the seam that lets renderers display
// captured images without ever crossing the structured-clone boundary.
//
// Core URL schemes:
//
//   pwrsnap-capture://r/<capture-id>
//     Resolves to the source PNG. For pre-bundle captures this is
//     captures.legacy_src_path; for bundle captures the resolver
//     extracts source.png from the bundle into a per-capture cache
//     under <userData>/cache/<id>/source.png (added with the
//     bundle-flow rewire). Used for full-fidelity inspect / edit
//     display.
//
//   pwrsnap-cache://r/<capture-id>/<width>w.<format>
//     Resolves through the render pipeline at the requested width. Hit
//     the disk cache when present, compose-on-demand on miss. Used for
//     library thumbnails, float-over preview, drag-out icons.
//
//   pwrsnap-sizzle://r/<project-id>
//     Resolves to a rendered sizzle-reel output movie for Library
//     hover previews. Unknown, unrendered, or missing outputs 404.
//
// Note the literal "r" host segment. Chromium normalizes the URL
// authority (host) component to lowercase per RFC 3986 §3.2.2 for any
// scheme registered as `standard: true` — and `nanoid()` capture ids
// use mixed-case `A-Za-z0-9_-`. Putting the id in the host would
// lowercase it during parsing and the DB lookup would 404 every time.
// The literal "r" satisfies the standard-scheme "must have a host"
// requirement and the case-sensitive id sits in the path component.
//
// Both schemes are registered as `standard + secure + supportFetchAPI`
// so they behave like https:// to Chromium — survive `sandbox: true`,
// stream natively, support range requests, are CORS-clean. This is the
// pattern VS Code adopted when it migrated off file:// URLs to
// `vscode-file://`.

import { open, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { app, protocol } from "electron";
import { getMainLogger } from "./log";
import { getSnapshotPath } from "./capture/screen-snapshot";
import { parseAppIconBundleId, parseCacheUrl, parseCaptureId, SCHEMES } from "./protocols-parse";
import { markStartup, startupProfilingEnabled } from "./startup-profiler";

const log = getMainLogger("pwrsnap:protocols");

export { SCHEMES };

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
    },
    {
      scheme: SCHEMES.screen,
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
      scheme: SCHEMES.appIcon,
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
      scheme: SCHEMES.sizzle,
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
  /**
   * Resolve a bundle id to a cached app-icon PNG. Returns null when
   * the app isn't installed locally or extraction failed — renderer
   * gets a 404 and falls back to procedural initials.
   */
  appIconPath(bundleId: string): Promise<string | null>;
  /**
   * Resolve a sizzle project id to its rendered movie output. Returns
   * null for unknown projects and projects that have not been rendered.
   */
  sizzleOutputPath(projectId: string): Promise<string | null>;
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  // Video sources. ScreenCaptureKit defaults to .mp4 (H.264 + AAC);
  // the float-over <video> element + native drag-out both rely on
  // the right Content-Type to render correctly.
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".gif": "image/gif"
};

function mimeForPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Read a file and produce a Response. Honors HTTP Range requests
 * (`Range: bytes=START-END`) with 206 Partial Content — required
 * for HTML5 `<video>` playback over this scheme. Chromium's media
 * stack issues Range requests as soon as the video element loads;
 * without 206 + `Content-Range` + `Accept-Ranges` headers the
 * player either hangs on the loading spinner or refuses to seek.
 *
 * Range branch reads ONLY the requested chunk via `fs.open` +
 * `read(start, length)` — never loads the whole video into memory
 * even for the long-tail "seek to the end of a 30s clip" case.
 * Non-Range branch keeps the existing read-the-whole-file fast
 * path for small assets (PNG thumbnails, screen snapshots).
 */
async function fileResponse(
  filePath: string,
  request: Request,
  options: { cacheControl?: string } = {}
): Promise<Response> {
  const cacheControl = options.cacheControl ?? "private, max-age=300";
  const stats = await stat(filePath);
  const total = stats.size;
  const rangeHeader = request.headers.get("range");
  if (rangeHeader !== null) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (match !== null) {
      const start = Number.parseInt(match[1]!, 10);
      const endRaw = match[2]!;
      const end = endRaw.length > 0 ? Number.parseInt(endRaw, 10) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < total) {
        const length = end - start + 1;
        const fh = await open(filePath, "r");
        try {
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, start);
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
          return new Response(ab, {
            status: 206,
            headers: {
              "content-type": mimeForPath(filePath),
              "content-length": String(length),
              "content-range": `bytes ${start}-${end}/${total}`,
              "accept-ranges": "bytes",
              "cache-control": "no-cache"
            }
          });
        } finally {
          await fh.close();
        }
      }
      // Unsatisfiable range — RFC 7233 §4.4 says 416 + Content-Range:
      // bytes */<total>. The video element will retry without Range.
      return new Response("range not satisfiable", {
        status: 416,
        headers: {
          "content-range": `bytes */${total}`,
          "accept-ranges": "bytes"
        }
      });
    }
  }
  // No Range header (or unparseable) — return the whole file. Still
  // advertise Accept-Ranges so the media element knows it can ask
  // for a partial range next.
  const body = await readFile(filePath);
  const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return new Response(ab, {
    status: 200,
    headers: {
      "content-type": mimeForPath(filePath),
      "content-length": String(total),
      "accept-ranges": "bytes",
      "cache-control": cacheControl
    }
  });
}

/**
 * Wires both protocol handlers. Must be called inside `app.whenReady()`.
 */
export function installProtocolHandlers(resolver: ProtocolResolver): void {
  protocol.handle(SCHEMES.capture, async (request) => {
    const captureId = parseCaptureId(request.url);
    if (captureId === null) {
      log.warn("capture: invalid url", { url: request.url });
      return new Response("invalid capture id", { status: 400 });
    }
    try {
      const startedAt = startupProfilingEnabled() ? Date.now() : 0;
      const filePath = await resolver.captureSourcePath(captureId);
      if (filePath === null) {
        log.warn("capture: not found", { captureId });
        return new Response("not found", { status: 404 });
      }
      const response = await fileResponse(filePath, request);
      if (startupProfilingEnabled()) {
        markStartup(`protocol capture ${captureId} ${Date.now() - startedAt}ms`);
      }
      return response;
    } catch (cause) {
      log.error("capture handler threw", {
        captureId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return new Response("internal error", { status: 500 });
    }
  });

  protocol.handle(SCHEMES.screen, async (request) => {
    // Path-segment id, same shape as `pwrsnap-capture://r/<id>`.
    const id = parseCaptureId(request.url, SCHEMES.screen);
    if (id === null) {
      log.warn("screen: invalid url", { url: request.url });
      return new Response("invalid screen snapshot id", { status: 400 });
    }
    try {
      const filePath = getSnapshotPath(id);
      if (filePath === null) {
        // Snapshot already released — selector dismissed mid-fetch
        // is a normal race. Quiet log + 404.
        log.info("screen: not found", { id });
        return new Response("not found", { status: 404 });
      }
      return await fileResponse(filePath, request);
    } catch (cause) {
      log.error("screen handler threw", {
        id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return new Response("internal error", { status: 500 });
    }
  });

  protocol.handle(SCHEMES.appIcon, async (request) => {
    const bundleId = parseAppIconBundleId(request.url);
    if (bundleId === null) {
      log.warn("app-icon: invalid url", { url: request.url });
      return new Response("invalid bundle id", { status: 400 });
    }
    try {
      const filePath = await resolver.appIconPath(bundleId);
      if (filePath === null) {
        // Not installed locally / extraction missed. Renderer's <img>
        // onError handler swaps to the procedural fallback — quiet 404.
        return new Response("not found", { status: 404 });
      }
      // `no-cache` (not `no-store`) so Chromium keeps the bytes but
      // revalidates with us before serving. Our handler is in-process
      // and `appIconPath` already mtime-validates the on-disk cache,
      // so a "revalidation" is a single fast file stat. Without this,
      // Chromium's default 5-min HTTP cache would serve a stale PNG
      // for up to 5 minutes after an app auto-update changed the icon.
      return await fileResponse(filePath, request, { cacheControl: "no-cache" });
    } catch (cause) {
      log.error("app-icon handler threw", {
        bundleId,
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
      const startedAt = startupProfilingEnabled() ? Date.now() : 0;
      const filePath = await resolver.cacheFile(parsed);
      if (filePath === null) {
        if (startupProfilingEnabled()) {
          markStartup(
            `protocol cache ${parsed.captureId} ${parsed.width}w.${parsed.format} MISS ${
              Date.now() - startedAt
            }ms`
          );
        }
        log.warn("cache: not found", { ...parsed });
        return new Response("not found", { status: 404 });
      }
      const response = await fileResponse(filePath, request);
      if (startupProfilingEnabled()) {
        markStartup(
          `protocol cache ${parsed.captureId} ${parsed.width}w.${parsed.format} ${
            Date.now() - startedAt
          }ms`
        );
      }
      return response;
    } catch (cause) {
      log.error("cache handler threw", {
        ...parsed,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return new Response("internal error", { status: 500 });
    }
  });

  protocol.handle(SCHEMES.sizzle, async (request) => {
    const projectId = parseCaptureId(request.url, SCHEMES.sizzle);
    if (projectId === null) {
      log.warn("sizzle-output: invalid url", { url: request.url });
      return new Response("invalid sizzle project id", { status: 400 });
    }
    try {
      const filePath = await resolver.sizzleOutputPath(projectId);
      if (filePath === null) {
        return new Response("not found", { status: 404 });
      }
      return await fileResponse(filePath, request, { cacheControl: "no-cache" });
    } catch (cause) {
      log.error("sizzle-output handler threw", {
        projectId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return new Response("internal error", { status: 500 });
    }
  });

  log.info("protocol handlers installed", {
    schemes: Object.values(SCHEMES).join(",")
  });
}

// `app` is imported for type augmentation only when this module is
// loaded under non-test paths; at runtime, callers wrap install in
// `app.whenReady()`.
void app;
