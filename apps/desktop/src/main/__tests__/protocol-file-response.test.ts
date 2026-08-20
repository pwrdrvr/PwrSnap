// Header + conditional-request behavior for the protocol handlers'
// file → Response builder. The renderer's <video> playback rides
// Range requests through this code on every seek, and VideoStage's
// loop-in-range wraps via a JS seek — so the cache posture here
// decides whether a looping 2s clip replays from Chromium's HTTP
// cache or re-reads bytes through the main process on every wrap.
//
// Locked down:
//   1. 200 and 206 carry the SAME cache-control (the old code sent
//      `no-cache` on 206 while 200 said `max-age=300` — incoherent
//      for one URL, and the media stack mostly sends Range).
//   2. Every 200/206/304 carries a STRONG ETag + Last-Modified, so
//      `no-cache` arms revalidate with a bodyless 304 instead of a
//      full refetch, and Chromium may cache partial (206) content
//      (it requires a strong validator to do so).
//   3. If-None-Match / If-Modified-Since → 304; If-Range mismatch
//      falls back to a full 200 (RFC 7233 §3.2 strong-only match).
//   4. Range semantics (206 slice bytes, 416 unsatisfiable) are
//      unchanged from the pre-split implementation.
//   5. Bodies are streamed — the Response is constructed from a
//      ReadableStream, not a copied ArrayBuffer.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fileResponse } from "../protocol-file-response";

let dir = "";
let filePath = "";
const CONTENT = Buffer.from("0123456789abcdefghij"); // 20 bytes

function req(headers: Record<string, string> = {}): Request {
  return new Request("pwrsnap-capture://r/test", { headers });
}

function expectedEtag(path: string): string {
  const stats = statSync(path);
  return `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pwrsnap-file-response-"));
  filePath = join(dir, "clip.mp4");
  writeFileSync(filePath, CONTENT);
  // Pin mtime to a whole second so Last-Modified (second resolution)
  // and mtimeMs agree exactly — mirrors the common on-disk case and
  // keeps the If-Modified-Since assertions deterministic.
  const pinned = new Date("2026-08-01T12:00:00Z");
  utimesSync(filePath, pinned, pinned);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("whole-file responses", () => {
  test("200 carries validators, accept-ranges, and the arm's cache-control", async () => {
    const res = await fileResponse(filePath, req(), {
      cacheControl: "private, max-age=86400, immutable"
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(res.headers.get("etag")).toBe(expectedEtag(filePath));
    expect(res.headers.get("last-modified")).toBe(new Date("2026-08-01T12:00:00Z").toUTCString());
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(CONTENT.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT);
  });

  test("body is a stream, not a pre-copied buffer", async () => {
    const res = await fileResponse(filePath, req());
    expect(res.body).toBeInstanceOf(ReadableStream);
  });

  test("empty file serves 200 with content-length 0", async () => {
    const empty = join(dir, "empty.png");
    writeFileSync(empty, "");
    const res = await fileResponse(empty, req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });
});

describe("range responses", () => {
  test("206 slice is correct and cache-control MATCHES the 200 policy", async () => {
    const res = await fileResponse(filePath, req({ range: "bytes=4-9" }), {
      cacheControl: "private, max-age=86400, immutable"
    });
    expect(res.status).toBe(206);
    // The regression this file exists to prevent: 206 used to be
    // hardwired `no-cache` regardless of the 200 policy.
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(res.headers.get("etag")).toBe(expectedEtag(filePath));
    expect(res.headers.get("content-range")).toBe(`bytes 4-9/${CONTENT.length}`);
    expect(res.headers.get("content-length")).toBe("6");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT.subarray(4, 10));
  });

  test("open-ended range runs to EOF", async () => {
    const res = await fileResponse(filePath, req({ range: "bytes=15-" }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 15-19/${CONTENT.length}`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT.subarray(15));
  });

  test("unsatisfiable range → 416 with bytes */total", async () => {
    const res = await fileResponse(filePath, req({ range: `bytes=${CONTENT.length}-` }));
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${CONTENT.length}`);
  });
});

describe("conditional requests", () => {
  test("If-None-Match with the current ETag → bodyless 304 with validators", async () => {
    const res = await fileResponse(filePath, req({ "if-none-match": expectedEtag(filePath) }), {
      cacheControl: "no-cache"
    });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get("etag")).toBe(expectedEtag(filePath));
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("If-None-Match uses weak comparison and accepts a list", async () => {
    const res = await fileResponse(
      filePath,
      req({ "if-none-match": `"nope", W/${expectedEtag(filePath)}` })
    );
    expect(res.status).toBe(304);
  });

  test("stale If-None-Match falls through to 200", async () => {
    const res = await fileResponse(filePath, req({ "if-none-match": '"deadbeef-0"' }));
    expect(res.status).toBe(200);
  });

  test("If-Modified-Since at/after mtime → 304; before mtime → 200", async () => {
    const at = await fileResponse(filePath, req({ "if-modified-since": new Date("2026-08-01T12:00:00Z").toUTCString() }));
    expect(at.status).toBe(304);
    const before = await fileResponse(filePath, req({ "if-modified-since": new Date("2026-08-01T11:00:00Z").toUTCString() }));
    expect(before.status).toBe(200);
  });

  test("If-Range with matching strong ETag honors the Range", async () => {
    const res = await fileResponse(
      filePath,
      req({ range: "bytes=0-3", "if-range": expectedEtag(filePath) })
    );
    expect(res.status).toBe(206);
  });

  test("If-Range mismatch (or weak ETag) ignores the Range → full 200", async () => {
    const stale = await fileResponse(
      filePath,
      req({ range: "bytes=0-3", "if-range": '"deadbeef-0"' })
    );
    expect(stale.status).toBe(200);
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(CONTENT);
    // Weak validators never match If-Range (RFC 7233 §3.2), even when
    // the opaque tag is current.
    const weak = await fileResponse(
      filePath,
      req({ range: "bytes=0-3", "if-range": `W/${expectedEtag(filePath)}` })
    );
    expect(weak.status).toBe(200);
  });

  test("If-Range with matching Last-Modified date honors the Range", async () => {
    const res = await fileResponse(
      filePath,
      req({ range: "bytes=0-3", "if-range": new Date("2026-08-01T12:00:00Z").toUTCString() })
    );
    expect(res.status).toBe(206);
  });
});
