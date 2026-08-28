// File → Response builder for the custom protocol handlers, split out
// of protocols.ts so it can be unit-tested without an electron import.
//
// Design goals (measurements in
// docs/solutions/2026-08-20-protocol-http-cache-measurements.md):
//
//   • Cacheable responses. The original handler stamped 206 responses
//     `cache-control: no-cache` (while 200s said `max-age=300` — two
//     policies for one URL) and no response carried a validator, so
//     every revalidation degraded to a full refetch. Now both 200 and
//     206 carry the SAME cache-control plus a strong ETag and
//     Last-Modified, and conditional requests (If-None-Match /
//     If-Modified-Since / If-Range) are answered with bodyless 304s.
//     Measured effect on Electron 41: image/fetch-class loads over
//     these schemes hit Chromium's HTTP cache across documents (pure
//     cache hits under max-age, 304 revalidations under no-cache);
//     <video> loads use the media element's own buffer within a
//     document (loop wraps issue zero requests) but bypass the HTTP
//     cache across documents regardless of headers.
//
//   • No per-request full-buffer copies. Bodies stream from an fs read
//     stream (Range and whole-file alike) instead of Buffer.alloc +
//     buffer.slice — the old path paid a byte-for-byte copy per
//     request and buffered entire files (videos included, when the
//     media stack sent no Range header) on the main thread.
//
// The strong ETag is `"<size>-<mtimeMs>"` (hex). Strong (no `W/`) on
// purpose: Chromium only caches/reuses partial (206) content across
// requests when the response carries a strong validator, and If-Range
// comparison is defined as strong-only (RFC 7233 §3.2). size+mtime is
// an honest strong validator here because every file served through
// these schemes is write-once — capture sources are immutable by the
// source-store invariant, layer sources and render-cache files are
// content-addressed, and files that CAN be replaced in place (sizzle
// outputs, app icons) are served `no-cache`, so they revalidate on
// every use and a new mtime flips the ETag.

import { open, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";

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

export function mimeForPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function strongEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
}

/**
 * If-None-Match uses WEAK comparison (RFC 7232 §3.2): `W/"x"` and
 * `"x"` compare equal, and the header may carry a comma-separated
 * list or `*`.
 */
function ifNoneMatchMatches(headerValue: string, etag: string): boolean {
  const trimmed = headerValue.trim();
  if (trimmed === "*") return true;
  const opaque = etag.startsWith("W/") ? etag.slice(2) : etag;
  return trimmed
    .split(",")
    .map((candidate) => candidate.trim())
    .map((candidate) => (candidate.startsWith("W/") ? candidate.slice(2) : candidate))
    .includes(opaque);
}

/**
 * HTTP dates carry second resolution, so compare mtime at second
 * granularity — otherwise a Last-Modified we just handed out never
 * "matches" the mtime it was derived from.
 */
function notModifiedSince(headerValue: string, mtimeMs: number): boolean {
  const sinceMs = Date.parse(headerValue);
  if (Number.isNaN(sinceMs)) return false;
  return Math.trunc(mtimeMs / 1000) <= Math.trunc(sinceMs / 1000);
}

/**
 * If-Range holds a single validator — an entity-tag or an HTTP-date —
 * and matching is STRONG-only (RFC 7233 §3.2): a weak ETag never
 * matches, and a date matches only exactly.
 */
function ifRangeMatches(headerValue: string, etag: string, lastModified: string): boolean {
  const trimmed = headerValue.trim();
  if (trimmed.startsWith("W/")) return false;
  if (trimmed.startsWith('"')) return trimmed === etag;
  const asDate = Date.parse(trimmed);
  return !Number.isNaN(asDate) && asDate === Date.parse(lastModified);
}

/**
 * Stream `[start, end]` (inclusive) of the file as a web ReadableStream.
 *
 * The FileHandle is opened by the caller BEFORE the Response is
 * constructed so open-time failures (ENOENT after a trash sweep, EPERM
 * from a macOS TCC denial) still throw into the protocol handler's
 * catch block — that's where captures-access health reporting lives.
 * Mid-stream failures after a successful open abort the response;
 * `Readable.toWeb` propagates cancel → destroy → autoClose.
 */
function fileStream(
  fh: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number
): ReadableStream {
  const nodeStream = fh.createReadStream({ start, end, autoClose: true });
  return Readable.toWeb(nodeStream) as unknown as ReadableStream;
}

export type FileResponseOptions = {
  /** Applied verbatim to 200, 206, AND 304 responses. */
  cacheControl?: string;
};

/**
 * Read a file and produce a Response. Honors HTTP Range requests
 * (`Range: bytes=START-END`) with 206 Partial Content — required
 * for HTML5 `<video>` playback over this scheme. Chromium's media
 * stack issues Range requests as soon as the video element loads;
 * without 206 + `Content-Range` + `Accept-Ranges` headers the
 * player either hangs on the loading spinner or refuses to seek.
 *
 * Every 200/206/304 carries a strong ETag + Last-Modified and one
 * coherent cache-control, and conditional requests short-circuit to
 * 304 — see the module header for why.
 */
export async function fileResponse(
  filePath: string,
  request: Request,
  options: FileResponseOptions = {}
): Promise<Response> {
  const cacheControl = options.cacheControl ?? "private, max-age=300";
  const stats = await stat(filePath);
  const total = stats.size;
  const etag = strongEtag(total, stats.mtimeMs);
  const lastModified = stats.mtime.toUTCString();
  const validatorHeaders = {
    etag,
    "last-modified": lastModified,
    "accept-ranges": "bytes",
    "cache-control": cacheControl,
    // The renderer's document origin (dev server / file://) differs
    // from the pwrsnap-* schemes, so a canvas that draws a capture
    // <img> is tainted unless the load is a CORS one. The editor's
    // auto contrast-border sampler reads pixels via a
    // crossorigin="anonymous" image; this header is what lets that
    // read succeed. All of these schemes serve the user's own local
    // content into our own sandboxed renderers, so a wildcard grants
    // nothing new.
    "access-control-allow-origin": "*"
  } as const;

  // Conditional GET → 304 (no body, no file open). If-None-Match wins
  // over If-Modified-Since when both are present (RFC 7232 §6).
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      return new Response(null, { status: 304, headers: validatorHeaders });
    }
  } else {
    const ifModifiedSince = request.headers.get("if-modified-since");
    if (ifModifiedSince !== null && notModifiedSince(ifModifiedSince, stats.mtimeMs)) {
      return new Response(null, { status: 304, headers: validatorHeaders });
    }
  }

  let rangeHeader = request.headers.get("range");
  if (rangeHeader !== null) {
    // If-Range: serve the partial only when the validator still
    // matches; otherwise fall through to a full 200 so the client
    // never splices ranges of two different representations.
    const ifRange = request.headers.get("if-range");
    if (ifRange !== null && !ifRangeMatches(ifRange, etag, lastModified)) {
      rangeHeader = null;
    }
  }
  if (rangeHeader !== null && /^bytes=0-$/.test(rangeHeader.trim())) {
    // `bytes=0-` asks for the entire file — it's how Chromium's media
    // stack opens every <video> load. A server MAY ignore Range and
    // answer 200 (RFC 9110 §14.2); we do, because the body is byte-
    // identical (whole file, streamed) and a 200 is a response the
    // HTTP cache in front of protocol.handle is willing to store,
    // while an externally-ranged 206 never is (measured on Electron
    // 41 — see docs/solutions/2026-08-20-protocol-http-cache-
    // measurements.md; media loads currently bypass that cache
    // regardless, so this is about not FORCING uncacheability for
    // any load class). The media stack still sees `accept-ranges:
    // bytes` and issues real mid-file ranges on seek, which keep
    // their 206 semantics below. Playback + loop wraps verified
    // unaffected by the 200 answer.
    rangeHeader = null;
  }
  if (rangeHeader !== null) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (match !== null) {
      const start = Number.parseInt(match[1]!, 10);
      const endRaw = match[2]!;
      const end = endRaw.length > 0 ? Number.parseInt(endRaw, 10) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < total) {
        const length = end - start + 1;
        const fh = await open(filePath, "r");
        return new Response(fileStream(fh, start, end), {
          status: 206,
          headers: {
            ...validatorHeaders,
            "content-type": mimeForPath(filePath),
            "content-length": String(length),
            "content-range": `bytes ${start}-${end}/${total}`
          }
        });
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
  // No Range header (or unparseable, or If-Range mismatch) — stream
  // the whole file. Still advertise Accept-Ranges so the media element
  // knows it can ask for a partial range next.
  const wholeFileHeaders = {
    ...validatorHeaders,
    "content-type": mimeForPath(filePath),
    "content-length": String(total)
  };
  if (total === 0) {
    return new Response(null, { status: 200, headers: wholeFileHeaders });
  }
  const fh = await open(filePath, "r");
  return new Response(fileStream(fh, 0, total - 1), {
    status: 200,
    headers: wholeFileHeaders
  });
}
