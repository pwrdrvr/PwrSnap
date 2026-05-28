// HTML-text rasterizer for the v2 bake — renders persisted
// TextOverlays via a hidden, transparent Electron BrowserWindow and
// captures the result as a transparent PNG that `sharp.composite()`
// lays over the baked accumulator. Closes the editor=baked-PNG
// WYSIWYG loop:
//
//   editor display ────┐
//                      ├── all three use `computeTextHtmlStyle`
//   editor edit ───────┤   from @pwrsnap/shared → identical CSS
//                      │   → identical Chromium font rendering
//   bake (this file) ──┘
//
// Pre-fix (and on `main` until this PR) the bake used SVG text via
// librsvg/sharp (`compose.ts textSvgForV2`). librsvg's text engine is
// completely separate from Chromium's — different font-family
// resolution (it looks up `Helvetica` not `-apple-system`), different
// kerning, different stroke rendering, different antialiasing. The
// editor showed crisp halos in a system font; the export showed
// thinner glyphs in Helvetica with palette-quantized halos. Now the
// bake's text goes through the SAME pipeline the user sees in the
// editor.
//
// Architecture
// ────────────
//   • Lazy-initialized SINGLETON BrowserWindow. First text overlay
//     in a bake creates it; subsequent overlays + bakes reuse. Empty
//     hidden window memory footprint is small; reusing saves
//     ~50-200 ms of window-creation cost per overlay.
//   • Per-overlay capture (one BW load+capture per text overlay in
//     the bake). Could batch into one capture-per-bake later if
//     profiling shows it's a hotspot — for typical 1-3 text-overlay
//     captures the per-overlay cost is well under a second total.
//   • Fonts.ready awaited before capture so first-paint racing the
//     Apple-system font load doesn't leave us with a fallback-font
//     rasterization.
//
// Spike validation
// ────────────────
// Before this code was written, `scripts/spike-transparent-capture.mjs`
// (deleted post-validation) confirmed that `transparent: true` +
// `webContents.capturePage()` produces a clean RGBA PNG on macOS
// Electron 41 — alpha=0 outside the glyph, correct color + alpha=255
// inside. The spike's verdict: PASS. If alpha rendering regresses on
// a future Electron version, fall back to `compose.ts textSvgForV2`
// (still exported) until restored.
//
// Fallback
// ────────
// When this code runs in a non-Electron context (unit tests with no
// app.whenReady) the BrowserWindow constructor throws "Cannot create
// BrowserWindow before app is ready". `compose-tree-vector.ts`
// catches that specific error and routes the overlay through the
// SVG bake instead — production gets HTML-bake, tests get SVG-bake.

import { BrowserWindow } from "electron";
import sharp from "sharp";

import type { Overlay } from "@pwrsnap/shared";
import {
  computeTextHtmlStyle,
  readTextWeight,
  serializeStyleAttribute
} from "@pwrsnap/shared";

/** Auto-resolved color hex when an overlay carries `color: "auto"`.
 *  Matches the editor's `--accent` value so display + bake agree on
 *  the default. Kept in lockstep with `compose.ts AUTO_ACCENT_HEX`. */
const AUTO_ACCENT_HEX = "#ff8a1f";

// Singleton pool — null before first bake.
let poolWindow: BrowserWindow | null = null;

// Serialization queue. The pool BrowserWindow is shared across all
// concurrent bake calls — `webContents.loadURL` cancels any in-flight
// load on the same webContents (rejecting it with ERR_ABORTED -3).
// When the renderer fans out bakes in parallel (library grid scroll,
// capture flow), unserialized access to the pool causes the loser of
// each race to fail with ERR_ABORTED and crash the bake.
//
// Pattern mirrors DesktopSettingsService.write() — chain via .catch
// → .then so a rejected task doesn't poison the queue for the next.
// Cost: parallel bakes become sequential on the pool. For ~6-12
// captures on a library scroll burst that's ~100-200ms × N, well
// inside the user-perceptible budget for thumbnail rendering.
let poolQueue: Promise<unknown> = Promise.resolve();

function runOnPool<T>(task: () => Promise<T>): Promise<T> {
  const next = poolQueue.then(task, task);
  // Insulate the queue tail from this task's rejection so the next
  // task starts cleanly. The original `next` still rejects to the
  // caller — only the chained `poolQueue` swallows the error.
  poolQueue = next.catch(() => undefined);
  return next;
}

/** Lazily creates or returns the pool window. Hidden (show: false) +
 *  transparent so its content can be captured directly to a
 *  transparent PNG. `hasShadow: false` matters because OS shadow
 *  paints AROUND the window perimeter — without disabling it,
 *  capturePage includes a soft gradient at the edges where the
 *  shadow would have been. */
function ensurePoolWindow(): BrowserWindow {
  if (poolWindow !== null && !poolWindow.isDestroyed()) {
    return poolWindow;
  }
  poolWindow = new BrowserWindow({
    width: 100, // resized per-bake via setContentSize
    height: 100,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    // Some Electron builds need an explicit fully-transparent RGBA
    // background even with `transparent: true` (Linux + sandbox
    // combos). Harmless on macOS where transparent: true is enough.
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Background throttling off — Chromium throttles hidden windows
      // by default, which can DELAY capturePage by hundreds of ms.
      // For a one-shot rasterize we want full speed.
      backgroundThrottling: false
    }
  });
  return poolWindow;
}

/** Builds the HTML page that renders ONE text overlay. Zero chrome
 *  (transparent body, no margins, no defaults). Two divs: wrapper
 *  (absolute at the overlay's anchor point) and inner glyph (font +
 *  color + stroke). Structure mirrors `TextHtml.tsx` in the renderer
 *  — both consume `computeTextHtmlStyle` so the rendered glyph is
 *  pixel-identical to what the editor shows. */
function buildBakeHtml(args: {
  data: Extract<Overlay, { kind: "text" }>;
  renderWidthPx: number;
  renderHeightPx: number;
  canvasWidthPx: number;
  canvasHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
}): string {
  const { data, renderWidthPx, renderHeightPx, canvasWidthPx, canvasHeightPx, sourceWidthPx, sourceHeightPx } =
    args;
  const colorHex = data.color === "auto" ? AUTO_ACCENT_HEX : data.color;
  const style = computeTextHtmlStyle({
    point: data.point,
    size: data.size,
    weight: readTextWeight(data),
    storedSizePx: data.sizePx,
    colorHex,
    sourceWidthPx,
    sourceHeightPx,
    // CANVAS dims (unscaled) so the helper's `sizePx` derivation
    // (which uses sourceShortSide for absolute physical size) stays
    // anchored to the row's persisted intent — see the formula in
    // packages/shared/src/text-html-style.ts:
    //   fontPx = (canvasCssHeight / canvasHeightPx) * sizePx
    canvasWidthPx,
    canvasHeightPx,
    // The actual surface we're rendering INTO is renderHeightPx tall.
    // For scale=1 bakes this equals canvasHeightPx → fontPx = sizePx
    // (source-pixel font in source-pixel canvas). For scale>1 bakes
    // canvasCssHeight > canvasHeightPx → fontPx > sizePx, so the
    // text renders proportionally larger in the scaled accumulator —
    // matching what the editor display does (canvasCssHeight is the
    // CSS-px box, fontPx is the on-screen glyph height).
    canvasCssHeight: renderHeightPx
  });
  const wrapperCss = serializeStyleAttribute(style.wrapper);
  const glyphCss = serializeStyleAttribute(style.glyph);
  // HTML-escape the body so user-typed `<`, `>`, `&` don't break out
  // of the inline div. `white-space: pre` on the glyph element
  // preserves \n as actual line breaks AND survives the escape.
  const escapedBody = escapeHtml(data.body);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: transparent !important; width: 100%; height: 100%; }
  body { position: relative; }
</style>
</head>
<body>
  <div style="${wrapperCss}">
    <div style="${glyphCss}">${escapedBody}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Rasterizes ONE TextOverlay via the hidden BrowserWindow → PNG
 *  path. Returns a `sharp.OverlayOptions` ready to drop into the
 *  accumulator's composite list. Same return shape as
 *  `rasterizeSvgForV2` so `compose-tree-vector` can swap one for the
 *  other with a one-line change in the text case. */
export async function rasterizeTextHtmlForV2(
  data: Extract<Overlay, { kind: "text" }>,
  /** The accumulator's CURRENT dimensions — the BrowserWindow renders
   *  at this size, capturePage returns at OS-DPR × this, sharp
   *  resizes down to this. Equals canvas dims for scale=1 bakes;
   *  scaled-up for LOW/MED tiers on small captures. */
  renderWidthPx: number,
  renderHeightPx: number,
  /** Original canvas dims from the capture record. Drives the
   *  scale factor relationship via canvasCssHeight=renderHeightPx
   *  inside computeTextHtmlStyle. */
  canvasWidthPx: number,
  canvasHeightPx: number,
  /** Source raster dims for bucket → sizePx math. */
  sourceWidthPx: number,
  sourceHeightPx: number
): Promise<sharp.OverlayOptions> {
  // Pool window operations (setContentSize → loadURL → fonts.ready →
  // capturePage) all touch a shared webContents. Run through the
  // serialization queue so concurrent callers don't ERR_ABORTED each
  // other. The sharp.resize after capturePage doesn't need the pool
  // and runs outside the queue — frees the next bake to start
  // immediately after capturePage returns its bytes.
  const png = await runOnPool(async () => {
    const win = ensurePoolWindow();
    // Resize the pool window to the target render dims BEFORE loading
    // so first paint already lands at the right size. setContentSize
    // accepts CSS px; the OS may render at DPR-multiplied pixel dims,
    // which we normalize back to renderWidthPx × renderHeightPx via
    // sharp.resize below.
    win.setContentSize(renderWidthPx, renderHeightPx);
    const html = buildBakeHtml({
      data,
      renderWidthPx,
      renderHeightPx,
      canvasWidthPx,
      canvasHeightPx,
      sourceWidthPx,
      sourceHeightPx
    });
    // Data URL — no temp file, no http server. encodeURIComponent
    // wraps the inline `style="..."` attribute strings safely.
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // Await fonts to resolve before capturing. Without this the first
    // capture can land on a fallback font (Chromium hasn't loaded the
    // Apple system font yet). Inline literal — no user-controlled
    // string interpolation, safe per the project's executeJavaScript
    // caveat.
    await win.webContents.executeJavaScript(
      "document.fonts.ready.then(() => true)"
    );
    const image = await win.webContents.capturePage();
    return image.toPNG();
  });
  // capturePage returns at OS DPR (e.g., 2× on retina). sharp.resize
  // downscales to exact render dims. fit: "fill" because the captured
  // image already matches the render aspect — we just need to swap
  // resolution. The downscale acts as antialiasing supersample for
  // the text glyph, which improves perceived sharpness.
  const raw = await sharp(png)
    .resize(renderWidthPx, renderHeightPx, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return {
    input: raw,
    raw: { width: renderWidthPx, height: renderHeightPx, channels: 4 },
    top: 0,
    left: 0
  };
}

/** Test / shutdown hook — destroys the pool window. Production code
 *  shouldn't call this; the window lifetime tracks the app's.
 *  Useful for tests that want to verify clean teardown. */
export function destroyTextBakePool(): void {
  if (poolWindow !== null && !poolWindow.isDestroyed()) {
    poolWindow.close();
  }
  poolWindow = null;
}
