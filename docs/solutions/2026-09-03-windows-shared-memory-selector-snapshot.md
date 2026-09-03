# Windows shared-memory selector snapshot

**Status:** implemented behind a Windows-only runtime branch; native runtime
validation is still required on Windows. macOS and Linux keep the existing PNG
file transport.

## Problem

The Windows selector used `desktopCapturer` to make a `NativeImage`, encoded the
whole display as PNG, wrote that PNG to a temporary file, decoded it again in
the sandboxed selector renderer, and later decoded it again in main to crop the
committed rectangle. The file was valuable for one reason: it kept the
selector's painted pixels and the committed crop on one immutable generation.
The new transport must preserve that property while removing the eager
full-frame PNG encode and disk write.

## Transport

The fast path is deliberately a standalone Win32 executable, not a `.node`
addon. This keeps it independent of Electron's Node ABI and follows the existing
`window-list.exe` and `verified-file.exe` packaging model.

1. Main captures the selected display with `desktopCapturer` and calls
   `NativeImage.toBitmap()` once.
2. A one-pixel opaque-red runtime probe recognizes the installed Electron
   build's bitmap byte order. Any layout other than RGBA8 or BGRA8 disables the
   fast path.
3. Main starts `screen-snapshot.exe --create` with an unpredictable 128-bit
   identity and streams the bounded bitmap over stdin.
4. The helper creates a pagefile-backed `Local\PwrSnapSnapshot-<nonce>` mapping,
   normalizes the frame to opaque top-down RGBA8, writes a versioned header
   last, reports ready metadata, and remains alive as the mapping owner.
5. Main registers only an opaque snapshot id. The mapping name, nonce, and
   native handle never cross preload/contextBridge.
6. An authenticated, top-level selector IPC request starts a short-lived
   `--read` helper. It opens the mapping read-only, validates the complete
   header, and streams one bounded header plus pixel frame to main. Preload
   validates it again before exposing a `Uint8Array`; the renderer uploads it
   with `putImageData`.
7. Commit acquires another registry lease and reads the same mapping generation
   into Sharp's raw RGBA input for the selected crop.

The fixed 64-byte little-endian header carries magic, version, header size,
width, height, exact `width * 4` stride, pixel-format id, payload length, total
length, and the 128-bit nonce. Dimensions are capped at 32,768 pixels and the
payload at 512 MiB before allocation.

## Security and process boundary

- The mapping is in the current-session `Local\` namespace.
- Its explicit DACL grants the current user `FILE_MAP_READ` only. The creating
  handle can populate the mapping, but a later opener cannot obtain a writable
  view.
- The random mapping identity is passed only between main and native helpers.
- The renderer-facing descriptor contains dimensions and an opaque registry id,
  not a native object name or handle.
- Main admits a read only when all of these match: the active selector
  `webContents`, its top-level `WebFrameMain`, the active registry id, and a
  mapped snapshot transport.
- Preload exposes one purpose-built read method. It does not expose generic IPC,
  filesystem access, process spawning, or mapping operations.
- The helper validates every command argument and header field before mapping or
  allocating. Main and preload independently repeat the layout checks.

This prevents a compromised non-selector renderer or subframe from using the
transport as a shared-memory oracle. It does not try to protect screenshots from
another arbitrary process already running as the same Windows user; such a
process can use Windows screen-capture APIs directly. The read-only DACL does
protect the frozen generation from mutation through a reopened mapping.

## Generation and lifecycle invariants

One registry id owns one immutable pixel generation from selector paint through
crop:

- A successful mapping is the source for both canvas paint and crop.
- A canvas or bridge failure requests the existing `pwrsnap-screen://` URL.
  Only then does main encode a PNG from the existing mapping and write a temp
  file. The fallback never re-captures the live display.
- Failure before a mapping is registered can take a fresh PNG fallback because
  the selector has not yet been shown; that new file then backs both paint and
  crop.
- If the mapping itself becomes unreadable after registration, the selector is
  aborted instead of revealing an empty or mixed-generation background.
- Cancel, supersede, selector close, top-level navigation, renderer crash, and
  normal hide request release. Commit transfers ownership to the capture
  handler, which releases after crop. In-flight reads and crops hold leases, so
  release waits for admitted operations.
- The owner helper exits when main writes its release line. A main-process crash
  closes the inherited stdin pipe; EOF makes the helper exit and the kernel
  destroys the last mapping handle.

## Copy and I/O accounting

This is a shared backing-store transport, not a claim of end-to-end zero copy.
On the successful selector path the remaining copies are:

1. Electron capture surface to `NativeImage.toBitmap()`.
2. Main's bitmap pipe into the mapped pages (with in-place BGRA normalization).
3. Read-only mapping to the main reader buffer.
4. Electron IPC/contextBridge structured clone into the renderer.
5. Canvas upload into Chromium's backing store.

The win is removing full-frame PNG compression, the eager full-frame temp-file
write/read, renderer PNG decompression, and crop PNG decompression. The selected
output crop is still encoded as PNG because that is the persisted capture input.

Logs and the existing latency trace expose:

- acquisition transport;
- source bitmap bytes and logical mapping-write bytes;
- full-screen PNG encode count, encoded bytes, and temp-file-write bytes;
- cumulative mapping-read, renderer-transfer, crop-read, and canvas-upload
  bytes at release;
- renderer path (`canvas` or `img`), read/upload bytes, and decode/upload time.

On a successful fast path, `fullScreenPngEncodeCount` and
`fullScreenTempFileWriteBytes` must both be zero. A lazy fallback must increment
them once, never once per protocol request.

## Windows validation checklist

This implementation was built and unit-tested on macOS, so the native checks
below are required before promoting the draft PR:

1. On `windows-latest` or the Windows lab, run `pnpm install`,
   `pnpm --filter @pwrsnap/desktop build:native`, `pnpm typecheck`, the unit
   suite, and the normal non-headed package/build checks. Confirm
   `screen-snapshot.exe` compiles with MSVC and is packaged as
   `resources\PwrSnapScreenSnapshot.exe`.
2. Exercise single- and multi-monitor capture at 100%, 125%, 150%, and 200%
   scaling. Confirm the requested display, canvas bounds, cursor hit testing,
   committed crop, and source pixels agree at every edge.
3. Use a test screen containing pure red, green, blue, black, white, and a
   one-pixel checkerboard. Confirm there is no R/B swap, vertical inversion,
   premultiplied-alpha darkening, row skew, or color-profile surprise.
4. Commit ordinary region, window-snap rect, and multi-window extent captures.
   Compare distinctive edge pixels between the visible selector and saved crop
   to prove the frozen-generation invariant.
5. Run cancel, rapid supersede, commit, renderer reload/crash, selector-window
   close, and app quit. Confirm owner helpers exit and no named mappings survive
   the PwrSnap process.
6. Exercise both fallbacks: start without the native helper (fresh PNG before
   show) and force a renderer canvas failure after mapping creation (lazy PNG
   from the mapping). Confirm the second path keeps the same generation and
   encodes/writes exactly once.
7. Collect at least 30 selector acquisitions before and after this change on the
   same monitor. Compare `screen_frame_acquisition`,
   `frozen_source_decode_ready`, first-visible paint, full-screen PNG counts,
   and byte counters. Inspect peak main/renderer/helper working sets as well as
   latency; raw RGBA trades compression CPU and disk I/O for transient memory.
8. Run the repository's Windows desktop E2E lane in its appropriate lab. Do not
   use a disruptive headed run on the operator's primary desktop.

## Main implementation files

- `apps/desktop/native/screen-snapshot-win/main.cpp`
- `apps/desktop/src/main/capture/windows-snapshot-format.ts`
- `apps/desktop/src/main/capture/windows-shared-snapshot.ts`
- `apps/desktop/src/main/capture/screen-snapshot.ts`
- `apps/desktop/src/main/capture/region-selector.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/features/region/RegionSelector.tsx`
