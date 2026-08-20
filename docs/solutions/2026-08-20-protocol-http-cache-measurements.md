# What Chromium's caches actually do for `pwrsnap-*://` responses (Electron 41, measured)

**Date:** 2026-08-20
**Area:** `apps/desktop/src/main/protocols.ts`, `apps/desktop/src/main/protocol-file-response.ts`
**Trigger:** making `pwrsnap-capture://` video responses cacheable so a
2s clip looping in the library (VideoStage's JS-seek loop-in-range)
doesn't re-issue Range reads through the main-process handler.

## TL;DR — who caches what

| Load class | Within one document | Across documents (reload / new window) |
|---|---|---|
| `<img>` / `fetch()` | Blink memory cache serves repeats with **zero requests**, even under `no-cache` | **HTTP cache works**: pure cache hits under `max-age`; `If-None-Match` → bodyless **304** under `no-cache` (requires a validator!) |
| `<video>` (media stack) | Media element's own buffer serves loop wraps, seeks-into-buffered, and even element remounts with **zero requests** | **Bypasses the HTTP cache entirely** — full refetch of all bytes on every document load, no conditional headers sent, regardless of `cache-control`, validators, or whether we answer 200 or 206 |

Three practical consequences:

1. **The looping-video "problem" mostly isn't one.** A 2s clip (tested
   up to 6.3MB / 25Mbps 1080p) is fully held by the media element's
   buffer; loop wraps via `currentTime = start` issue **zero** protocol
   requests, before and after the header fix. The real per-request
   costs to attack were the full-buffer copies and the synchronous
   SQLite resolve (both fixed — bodies now stream, lookups are
   memoized/prepared-statement-cached).
2. **Validators are load-bearing for every non-media surface.**
   `no-cache` without an ETag/Last-Modified (the pre-fix state) forces
   a full body refetch on every cross-document revalidation. With the
   strong ETag, the same `no-cache` policy revalidates as a stat + 304
   with no body. The app-icon and sizzle arms keep their `no-cache`
   semantics but now get 304 revalidation for free.
3. **For video bytes across documents, headers cannot help** on this
   Electron. The handler still answers `bytes=0-` with a cacheable
   full 200 (a server MAY ignore Range, RFC 9110 §14.2; bytes are
   identical) so we never *force* uncacheability — but don't expect
   media loads to hit the HTTP cache until the media loader's cache
   behavior changes upstream.

## The experiments

Harness: a throwaway Electron main that registers `pwrsnap-capture`
with the production privileges, serves a generated 2s H.264 mp4
through either the pre-fix `fileResponse` (verbatim copy) or the real
compiled `protocol-file-response.ts`, loads a page from a second
custom scheme (`harness-app://` — see gotcha #1), and counts handler
invocations. Fresh temp `userData` per run so no cache carries over.

| Experiment | Legacy (206 no-cache, no validators) | New (validators + coherent cache-control) |
|---|---|---|
| `loop`: autoplay + rAF seek-to-0 wrap, 16s (8 wraps) | 1 request | 1 request |
| `stage`: exact VideoStage shape (`preload="metadata"`, play after metadata), 8 wraps | 1 request | 1 request |
| `remount`: destroy + recreate the `<video>` every 3s, same URL | 1 request | 1 request |
| `reload`: `webContents.reload()` every 4s (video) | 5× full 206, 31.6MB served | 5× full 200, 31.6MB served — **media bypasses the cache** |
| `imgreload`: reload every 2.5s, two `<img>`s | n/a | `max-age` icon: **1 request total** (pure cache hits after); `no-cache` icon: `If-None-Match` → **304** each reload, image renders fine |

## Gotchas that will eat an afternoon

1. **A `data:` test page disables the HTTP cache.** Opaque top-level
   origins have no serializable cache partition, so *nothing* is
   cached — every scheme response refetches, and it looks like
   protocol.handle bypasses the cache wholesale. Serve the test page
   from a `standard: true` scheme before concluding anything.
2. **Externally-ranged 206s are never stored** by the HTTP cache here,
   even with a strong ETag + Last-Modified + `immutable`. Only full
   200s get stored (and later served, range-sliced or revalidated,
   by the cache). This is why `fileResponse` treats `bytes=0-` as a
   whole-file 200.
3. **`protocol.handle` CAN return 304** and the renderer honors it —
   the conditional request comes in with `if-none-match`, the handler
   answers `304` with no body, and the consumer renders from cache.
   But a 304 is only ever correct for a request that carried a
   conditional header; `fileResponse` guards this.
4. **The media element's buffer masks everything within a document.**
   Remounting the `<video>` element does NOT re-request the URL (the
   per-document `UrlData` multibuffer survives the element), so
   in-app capture-switching doesn't refetch either. Only a document
   teardown drops it.
5. **Strong vs weak ETag matters twice**: If-Range comparison is
   strong-only (RFC 7233 §3.2), and Chromium requires a strong
   validator to reuse partial content. `"<size>-<mtimeMs>"` without
   the `W/` prefix is honestly strong for these write-once files.

## Why capture sources may cache "immutable"

`pwrsnap-capture://r/<id>` and `s/<id>/<sha>` bytes are write-once:
the source-store owns the captures dir under a source-immutability
invariant, layer sources are content-addressed, video trim and canvas
crop are metadata-only, and visual edits render to *new*
`pwrsnap-cache://` assets behind `?v=edits_version`. Only file
*location* changes (trash rename on soft-delete, lazy re-extract
after a cache trim) — never the bytes behind a URL. Hence
`private, max-age=86400, immutable` on both capture arms. The sizzle
arm stays `no-cache` because outputs ARE rewritten in place at the
same project id; the app-icon arm stays `no-cache` per its own
documented staleness rationale.

## Harness recipe (re-run in ~5 min)

```bash
# 1. compile the real module (no electron import, bundles clean):
node_modules/.pnpm/node_modules/.bin/esbuild \
  apps/desktop/src/main/protocol-file-response.ts \
  --bundle --platform=node --format=cjs --outfile=/tmp/pfr.cjs
# 2. generate a clip:
ffmpeg -f lavfi -i testsrc2=duration=2:size=1920x1080:rate=60 \
  -pix_fmt yuv420p -c:v libx264 -b:v 25M -movflags +faststart /tmp/clip.mp4
# 3. main.cjs: register scheme (production privileges), protocol.handle
#    → fileResponse(clip), serve the page from a second standard scheme,
#    count handler hits; MODE=legacy|new, EXP=loop|stage|remount|reload|
#    fetch|img|imgreload. Fresh mkdtemp userData per run.
apps/desktop/node_modules/.bin/electron /path/to/main.cjs
```

Related: the app-icon `no-cache` rationale in `protocols.ts` (its
"Chromium's default 5-min HTTP cache" staleness is the image-class
cache behavior measured here), and the unit suite
`apps/desktop/src/main/__tests__/protocol-file-response.test.ts`.
