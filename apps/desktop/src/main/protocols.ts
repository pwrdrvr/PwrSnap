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
//   pwrsnap-cache://v/<capture-id>/<asset>
//     Serve-only arm for derived video assets written by `video:frames`
//     (filmstrip contact strip) and `video:audio` (extracted m4a) under
//     <render-cache>/video/<id>/. Asset names are whitelisted in
//     protocols-parse.ts; misses 404 (the IPC verbs are what extract).
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

import { app, protocol } from "electron";
import type { CaptureLatencyTrace } from "./capture/capture-latency-trace";
import { getSnapshotProtocolTarget } from "./capture/screen-snapshot";
import { getMainLogger } from "./log";
import {
  fileResponse,
  type FileResponseObserver
} from "./protocol-file-response";
import {
  parseAppIconBundleId,
  parseCacheUrl,
  parseCaptureId,
  parseSourceUrl,
  parseVideoAssetUrl,
  SCHEMES
} from "./protocols-parse";
import { markStartup, startupProfilingEnabled } from "./startup-profiler";
import { reportCapturesAccessFailure } from "./storage/captures-access-health";

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
   * Resolve `(captureId, sha256)` to a non-base raster layer source PNG
   * path, extracting it from the capture's bundle on first request.
   * Backs `pwrsnap-capture://s/<id>/<sha>` so the editor can render each
   * raster layer's bytes without re-baking the composite. Returns null
   * (renderer 404) for unknown captures or a sha the bundle lacks.
   */
  sourceBytesPath(captureId: string, sha256: string): Promise<string | null>;
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
   * Resolve `(captureId, asset)` to a derived video asset (filmstrip
   * contact strip / extracted audio) that a `video:frames` /
   * `video:audio` call already wrote under the capture's render-cache
   * dir. Serve-only — never extracts on miss; returns null (404) when
   * the file isn't there.
   */
  videoAssetPath(captureId: string, asset: string): Promise<string | null>;
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

// File → Response construction (Range / 206, conditional-request 304s,
// ETag + Last-Modified validators, streamed bodies) lives in
// ./protocol-file-response.ts so it stays unit-testable without an
// electron import.

/**
 * Capture source bytes (`r/<id>` and `s/<id>/<sha>`) are write-once:
 * the source-store owns `<capturesRoot>` under a source-immutability
 * invariant, layer sources are content-addressed by sha, video trim /
 * canvas crop are metadata-only, and every visual edit renders to a
 * NEW `pwrsnap-cache://` asset behind an `?v=edits_version` buster.
 * Only the file's LOCATION can change (trash rename, lazy re-extract)
 * — never its bytes for a given URL. So the raw source is safe to
 * cache hard: a day of freshness plus `immutable` means image-class
 * loads (the editor's source PNG, layer sources) are served straight
 * from Chromium's HTTP cache across documents with zero handler
 * requests. Video loads measure differently (Electron 41): within a
 * document the media element's own buffer serves loop wraps and
 * remounts (zero requests), while cross-document loads bypass the
 * HTTP cache regardless of headers — for those the win is the
 * streamed body + cheaper resolve, not the cache. Details:
 * docs/solutions/2026-08-20-protocol-http-cache-measurements.md.
 */
const CAPTURE_SOURCE_CACHE_CONTROL = "private, max-age=86400, immutable";

function screenSnapshotFileObserver(
  trace: CaptureLatencyTrace
): FileResponseObserver {
  let openStage: ReturnType<CaptureLatencyTrace["begin"]> | undefined;
  let readStage: ReturnType<CaptureLatencyTrace["begin"]> | undefined;
  return {
    onOpenStarted: () => {
      openStage = trace.begin("screen_protocol_file_open");
    },
    onOpenFinished: ({ outcome, expectedBytes }) => {
      if (openStage === undefined) return;
      trace.end(openStage, { outcome, expectedBytes });
      openStage = undefined;
    },
    onReadStarted: () => {
      readStage = trace.begin("screen_protocol_file_read");
    },
    onReadFinished: ({ outcome, expectedBytes, bytesRead }) => {
      if (readStage === undefined) return;
      trace.end(readStage, { outcome, expectedBytes, bytesRead });
      readStage = undefined;
    }
  };
}

/**
 * Wires both protocol handlers. Must be called inside `app.whenReady()`.
 */
export function installProtocolHandlers(resolver: ProtocolResolver): void {
  protocol.handle(SCHEMES.capture, async (request) => {
    // Per-layer raster source: `pwrsnap-capture://s/<id>/<sha>`. Checked
    // before the base `r/<id>` shape since both share the scheme. The
    // editor's raster LayerView loads each layer's bytes through here.
    const sourceUrl = parseSourceUrl(request.url);
    if (sourceUrl !== null) {
      try {
        const filePath = await resolver.sourceBytesPath(sourceUrl.captureId, sourceUrl.sha256);
        if (filePath === null) {
          return new Response("not found", { status: 404 });
        }
        return await fileResponse(filePath, request, {
          cacheControl: CAPTURE_SOURCE_CACHE_CONTROL,
          // CORS-readable: the Border Auto sampler draws capture
          // rasters into a canvas via crossorigin="anonymous".
          cors: true
        });
      } catch (cause) {
        log.error("capture source handler threw", {
          captureId: sourceUrl.captureId,
          message: cause instanceof Error ? cause.message : String(cause)
        });
        return new Response("internal error", { status: 500 });
      }
    }
    const captureId = parseCaptureId(request.url);
    if (captureId === null) {
      log.warn("capture: invalid url", { url: request.url });
      return new Response("invalid capture id", { status: 400 });
    }
    try {
      const profiling = startupProfilingEnabled();
      const startedAt = profiling ? Date.now() : 0;
      const filePath = await resolver.captureSourcePath(captureId);
      if (filePath === null) {
        log.warn("capture: not found", { captureId });
        return new Response("not found", { status: 404 });
      }
      const response = await fileResponse(filePath, request, {
        cacheControl: CAPTURE_SOURCE_CACHE_CONTROL,
        // CORS-readable — see the layer-source handler above.
        cors: true
      });
      if (profiling) {
        markStartup(`protocol capture ${captureId} ${Date.now() - startedAt}ms`);
      }
      return response;
    } catch (cause) {
      // Videos and flat sources read straight off ~/Documents/PwrSnap
      // (no bundle-store chokepoint), so a macOS TCC denial must be
      // reported from here. Node errno errors carry the failing path.
      const errnoPath = (cause as NodeJS.ErrnoException).path;
      if (typeof errnoPath === "string") {
        reportCapturesAccessFailure(errnoPath, cause);
      }
      log.error("capture handler threw", {
        captureId,
        code: (cause as NodeJS.ErrnoException).code,
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
      const target = getSnapshotProtocolTarget(id);
      if (target === null) {
        // Snapshot already released — selector dismissed mid-fetch
        // is a normal race. Quiet log + 404.
        log.info("screen: not found", { id });
        return new Response("not found", { status: 404 });
      }
      return await fileResponse(target.filePath, request, {
        ...(target.latencyTrace !== undefined
          ? { observer: screenSnapshotFileObserver(target.latencyTrace) }
          : {})
      });
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
      // fileResponse now stamps an ETag/Last-Modified, so those
      // revalidations resolve as bodyless 304s rather than refetches.
      return await fileResponse(filePath, request, {
        cacheControl: "no-cache"
      });
    } catch (cause) {
      log.error("app-icon handler threw", {
        bundleId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return new Response("internal error", { status: 500 });
    }
  });

  protocol.handle(SCHEMES.cache, async (request) => {
    // Derived video assets: `pwrsnap-cache://v/<id>/<asset>`. Checked
    // before the `r/` render-cache shape since both share the scheme.
    const videoAsset = parseVideoAssetUrl(request.url);
    if (videoAsset !== null) {
      try {
        const filePath = await resolver.videoAssetPath(videoAsset.captureId, videoAsset.asset);
        if (filePath === null) {
          return new Response("not found", { status: 404 });
        }
        return await fileResponse(filePath, request);
      } catch (cause) {
        log.error("video-asset handler threw", {
          ...videoAsset,
          message: cause instanceof Error ? cause.message : String(cause)
        });
        return new Response("internal error", { status: 500 });
      }
    }
    const parsed = parseCacheUrl(request.url);
    if (parsed === null) {
      log.warn("cache: invalid url", { url: request.url });
      return new Response("invalid cache url", { status: 400 });
    }
    try {
      const profiling = startupProfilingEnabled();
      const startedAt = profiling ? Date.now() : 0;
      const filePath = await resolver.cacheFile(parsed);
      if (filePath === null) {
        if (profiling) {
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
      if (profiling) {
        markStartup(
          `protocol cache ${parsed.captureId} ${parsed.width}w.${parsed.format} ${
            Date.now() - startedAt
          }ms`
        );
      }
      return response;
    } catch (cause) {
      // Bundle reads already report TCC denials via the bundle-store
      // chokepoint (dedup makes a second report for the same path a
      // no-op); this catches denials on non-bundle reads the render
      // path makes directly.
      const errnoPath = (cause as NodeJS.ErrnoException).path;
      if (typeof errnoPath === "string") {
        reportCapturesAccessFailure(errnoPath, cause);
      }
      log.error("cache handler threw", {
        ...parsed,
        code: (cause as NodeJS.ErrnoException).code,
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
      // Sizzle outputs ARE replaced in place on re-render at the same
      // project id, and callers may use the bare URL (no `?v=` buster),
      // so `no-cache` stays. The ETag/Last-Modified that fileResponse
      // stamps makes each revalidation a stat + 304 instead of a full
      // refetch, which is what keeps hover-preview loops cheap.
      return await fileResponse(filePath, request, {
        cacheControl: "no-cache"
      });
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
