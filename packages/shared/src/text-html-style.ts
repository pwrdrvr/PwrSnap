// Shared text-overlay HTML styling — the single source of truth for
// how a TextOverlay renders as HTML in the EDITOR (display + edit).
// Both `TextHtml.tsx` (read-only display div) and `TextDraftInput.tsx`
// (visible display div + invisible-textarea input layer) feed every
// CSS value through this helper, so any change moves both surfaces in
// lockstep. The contract "editor display = editor edit" is enforced
// by construction.
//
// The bake side (compose.ts `textSvgForV2`) still generates SVG via
// librsvg/sharp — a future PR is planned to unify bake rendering
// through a hidden BrowserWindow capture so editor-display =
// editor-edit = baked-PNG end-to-end. This helper lives in shared
// already because the bake unification would also consume it (no
// renderer-only dependency in here).
//
// Returns plain string/number maps so callers can apply them as
// needed: renderer casts to React.CSSProperties (camelCase already
// matches React's prop names); main-process callers (when the bake
// unifies) will serialize via `serializeStyleAttribute()` to an
// inline `style="..."` attribute string on the bake's HTML div.

import { computeTextGlyphSize, type TextSizeBucket } from "./text-glyph-size";

/** Inputs the helper needs to produce a fully-resolved style object.
 *  Caller resolves the editing-vs-tool-style decision (size bucket,
 *  weight, color hex) BEFORE calling — see
 *  apps/desktop/.../text-draft-style.ts for that resolver. */
export interface TextHtmlStyleArgs {
  /** Overlay anchor point in normalized [0,1] coords. Same shape as
   *  `TextOverlay.point` in overlay-schemas.ts. */
  point: { x: number; y: number };
  /** Resolved size bucket — drives bucket math when storedSizePx is
   *  absent. */
  size: TextSizeBucket;
  /** Resolved CSS font-weight number (e.g., 400 / 600 / 700). Pre-
   *  resolved via @pwrsnap/shared#readTextWeight so legacy fallback
   *  to 600 lives in one place. */
  weight: number;
  /** Persisted absolute text height in source/canvas px (pwrdrvr/
   *  PwrSnap#110). When defined, overrides bucket math. */
  storedSizePx: number | undefined;
  /** Resolved fill color as a CSS color string OR a CSS var()
   *  expression. The renderer is allowed to pass `var(--accent,...)`
   *  for the editor (the variable resolves via canvas CSS). The bake
   *  MUST pass a resolved hex — the hidden BrowserWindow doesn't
   *  inherit the editor's CSS variables. */
  colorHex: string;
  /** SOURCE raster dims. Drives `sizePx` via computeTextGlyphSize so
   *  the absolute size stays constant across crops. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** CANVAS pixel dims (record.width_px / record.height_px). */
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** CSS-pixel height of the surface this text is being rendered into.
   *  • Editor:  canvasRef.getBoundingClientRect().height
   *  • Bake:    canvasHeightPx (the hidden BrowserWindow is sized to
   *             the canvas's pixel dims, so CSS-px == image-px). */
  canvasCssHeight: number;
}

/** Result of the helper — three style maps. All values are
 *  CSS-property-compatible camelCase strings or numbers so React can
 *  consume directly via `style={result.wrapper}` etc. Main-process
 *  callers go through `serializeStyleAttribute()` below to produce an
 *  inline-style string. */
export interface TextHtmlStyle {
  /** Outer wrapper — absolute-positioned at the anchor point, vertically
   *  centered on it (via translateY -50%) to match the SVG
   *  `dominant-baseline="central"` behavior we used to have. */
  wrapper: Record<string, string | number>;
  /** Inner glyph element. Identical CSS regardless of whether the
   *  element is a <div> (display, bake) or <textarea> (edit) — both
   *  inherit the same rendering pipeline. */
  glyph: Record<string, string | number>;
  /** Resolved font-pixel size in the OUTPUT coordinate system. Exposed
   *  for callers that need the value separately (e.g., stroke width
   *  derivation already encoded in `glyph.WebkitTextStroke`, but a
   *  caller computing additional spacing might want the raw px). */
  fontPx: number;
}

/** Font-family stack — verbatim across renderer and bake. Apple system
 *  fonts render differently than HTML's `system-ui` alias on Chromium;
 *  being explicit pins the metrics. */
const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** Resolves all CSS needed to render a text overlay through Chromium's
 *  HTML pipeline. Pure function — no DOM access. */
export function computeTextHtmlStyle(args: TextHtmlStyleArgs): TextHtmlStyle {
  const {
    point,
    size,
    weight,
    storedSizePx,
    colorHex,
    sourceWidthPx,
    sourceHeightPx,
    canvasWidthPx,
    canvasHeightPx,
    canvasCssHeight
  } = args;

  // sizePx is in image-pixel units (= source pixel units in v2 since
  // crop is a viewport change). For the editor, multiply by the
  // CSS:image scale factor to get on-screen CSS px. For the bake the
  // scale factor is 1:1 (canvasCssHeight === canvasHeightPx).
  const { sizePx } = computeTextGlyphSize({
    size,
    sourceWidthPx,
    sourceHeightPx,
    canvasWidthPx,
    canvasHeightPx,
    storedSizePx
  });
  const fontPx =
    canvasCssHeight > 0 && canvasHeightPx > 0
      ? (canvasCssHeight / canvasHeightPx) * sizePx
      : 16;
  // Geometric outline matching the previous SVG stroke. Clamped to 1px
  // so small fonts still show a halo. -webkit-text-stroke draws a
  // centered stroke; paint-order:stroke makes the fill cover the
  // inside half. Net visible halo = fontPx * 0.04 outside the glyph.
  const strokePx = Math.max(1, fontPx * 0.08);

  // Wrapper — absolute-positioned at the click point. translateY(-50%)
  // centers the wrapper's vertical midpoint on the anchor; lineHeight:1
  // on the glyph means the wrapper's vertical center IS the first
  // line's glyph center. Match: SVG dominantBaseline="central".
  const wrapper: Record<string, string | number> = {
    position: "absolute",
    left: `${point.x * 100}%`,
    top: `${point.y * 100}%`,
    transform: "translateY(-50%)"
  };

  // Inner glyph element styling — IDENTICAL between display, edit and
  // (future) bake. Every property here matters; see TextDraftInput.tsx
  // for the long-form reasoning on the SVG-parity controls
  // (-webkit-font-smoothing, text-rendering, font-kerning, etc.).
  //
  // This block deliberately FUSES two concerns:
  //   • Layout properties — fontSize, lineHeight, whiteSpace, margin,
  //     padding. Drive the glyph's box dimensions and where characters
  //     land. Display/edit MUST agree on these to keep position parity.
  //   • Rendering properties — WebkitFontSmoothing, textRendering,
  //     fontKerning, fontFeatureSettings, fontVariantLigatures,
  //     WebkitTextStroke, paintOrder, color. Drive how Chromium PAINTS
  //     each glyph (weight, halo, antialiasing path). Display/edit
  //     MUST agree on these to keep visual parity.
  //
  // We fuse them because the contract is "one decision point per
  // overlay" — splitting layout vs rendering would mean two
  // synchronized property maps, two places to change in lockstep,
  // and two places to audit. The single-map design is the property
  // any reasonable caller (renderer or future bake) wants.
  const glyph: Record<string, string | number> = {
    fontFamily: FONT_FAMILY,
    fontWeight: weight,
    fontSize: `${fontPx}px`,
    lineHeight: 1,
    color: colorHex,
    // Match SVG-like rendering on macOS Chromium — HTML defaults are
    // subpixel-antialiased + optimizeLegibility which produce heavier,
    // tighter glyphs than the pre-unification SVG pipeline.
    WebkitFontSmoothing: "antialiased",
    textRendering: "geometricPrecision",
    fontKerning: "normal",
    fontFeatureSettings: "normal",
    fontVariantLigatures: "normal",
    WebkitTextStroke: `${strokePx}px rgba(0,0,0,0.6)`,
    paintOrder: "stroke",
    // pre = preserve whitespace + newlines without wrapping. The user
    // controls line breaks explicitly (Shift+Enter in edit mode); we
    // don't want the bake / display surfaces to wrap differently than
    // the textarea (which doesn't wrap because we set whiteSpace:pre
    // there too).
    whiteSpace: "pre",
    margin: 0,
    padding: 0
  };

  return { wrapper, glyph, fontPx };
}

/** Serializes a style map to an inline `style="..."` attribute value.
 *  Main-process callers use this when building the bake's HTML string;
 *  the renderer doesn't need it (React handles style objects
 *  directly).
 *
 *  React camelCase → CSS kebab-case conversion: split on uppercase
 *  ASCII letters, lowercase, join with "-". The leading uppercase
 *  letter on WebKit-prefixed properties (WebkitTextStroke,
 *  WebkitFontSmoothing) becomes a leading "-" then "webkit-..." per
 *  the CSS vendor-prefix convention React expects.
 *
 *  Values are not quoted — CSS allows bare values for all of our
 *  properties (font-family with sans-serif suffix already includes
 *  its own quotes for 'Segoe UI'). */
export function serializeStyleAttribute(
  style: Record<string, string | number>
): string {
  return Object.entries(style)
    .map(([key, value]) => `${camelToKebab(key)}: ${value}`)
    .join("; ");
}

function camelToKebab(camel: string): string {
  // Strip leading "Webkit" / "Moz" / "Ms" / "O" prefixes, prepend "-".
  // React's convention: WebkitFontSmoothing → "-webkit-font-smoothing".
  let s = camel;
  let prefix = "";
  if (/^Webkit/.test(s)) {
    s = s.slice("Webkit".length);
    prefix = "-webkit";
  } else if (/^Moz/.test(s)) {
    s = s.slice("Moz".length);
    prefix = "-moz";
  } else if (/^Ms/.test(s)) {
    s = s.slice("Ms".length);
    prefix = "-ms";
  }
  // Insert a hyphen before each remaining uppercase letter, lowercase.
  const kebabBody = s.replace(/([A-Z])/g, "-$1").toLowerCase();
  // If we had a prefix, kebabBody starts with "-" already (from the
  // first uppercase letter after stripping). Otherwise it might start
  // with "-" if the original was uppercase-leading (unlikely for valid
  // React style keys), so we strip a leading "-" defensively.
  const out = prefix === "" ? kebabBody.replace(/^-/, "") : prefix + kebabBody;
  return out;
}
