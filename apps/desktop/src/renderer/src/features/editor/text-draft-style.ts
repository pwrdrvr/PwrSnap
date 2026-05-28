// Resolves the style props (colorHex, size bucket, weight, storedSizePx)
// that `TextDraftInput` should render with — the single decision point
// for "is this a fresh placement or a re-edit, and which style wins?"
//
// Why this exists as a named helper (not inline in Editor.tsx anymore):
// the rule "re-edit = mirror the persisted overlay, fresh placement =
// mirror the active tool style" sounds obvious but the inline version
// got it wrong on three fields (size / weight / color) for re-edits.
// The persisted-size override via `storedSizePx` masked the bug for
// new captures that have a `sizePx` written at placement time
// (pwrdrvr/PwrSnap#110); legacy rows without `sizePx` fell back to the
// bucket math + the tool-style bucket and visibly resized when the
// user clicked-to-edit.
//
// The fix: when `editingOverlay` is a text overlay, read color / size /
// weight / sizePx STRAIGHT off the row. The tool style is irrelevant
// during a re-edit because `commitText` only patches the body — every
// other field on the row survives the round trip. When `editingOverlay`
// is null (first-placement), fall through to the tool style so the
// draft input shows what the commit will produce.

import type { Overlay, TextToolStyle } from "@pwrsnap/shared";
import { readTextWeight } from "@pwrsnap/shared";
import { resolveToolColor } from "./resolveToolColor";

/** TextOverlay type — narrowed off the discriminated `Overlay` union.
 *  Imported as a value (`TextOverlay`) is the Zod schema, not a type;
 *  reach for it this way to get the inferred shape without the Zod
 *  dependency leaking into this helper. */
type TextOverlayData = Extract<Overlay, { kind: "text" }>;

export type TextSizeBucket = "small" | "medium" | "large";

/** Same logic as the popover-side `resolveTextSize` in Editor.tsx —
 *  inlined here so the helper is self-contained and the editor-side
 *  call sites can route through this module too once they migrate
 *  off the local copy. */
export function resolveTextSizeBucket(
  fontSize: TextToolStyle["fontSize"]
): TextSizeBucket {
  if (typeof fontSize === "number") return "medium";
  if (fontSize === "large") return "large";
  if (fontSize === "x-large") return "large";
  if (fontSize === "small") return "small";
  // "auto" + "medium" both resolve to medium.
  return "medium";
}

export interface ResolvedTextDraftStyle {
  /** CSS color or `var(--accent, #ff8a1f)` for the "auto" path. */
  colorHex: string;
  /** Bucket name forwarded to TextDraftInput (drives the CSS px size
   *  derivation when `storedSizePx` is undefined). */
  size: TextSizeBucket;
  /** Resolved CSS font-weight number. Driven by `readTextWeight` so
   *  the regular/bold/600 fallback matches what TextGlyph + the bake
   *  use. */
  weight: number;
  /** Persisted absolute px (pwrdrvr/PwrSnap#110). Pre-empts the bucket
   *  math inside `computeTextGlyphSize`. Undefined for fresh
   *  placements or for legacy text rows that pre-date the sizePx
   *  field — in either case the draft falls back to the bucket math
   *  computed from `size`. */
  storedSizePx: number | undefined;
  /** Clockwise rotation in radians from the persisted row. Forwarded
   *  to TextDraftInput → computeTextHtmlStyle so the in-progress
   *  edit text rotates with the visible glyph beneath. Undefined for
   *  first placements (no row yet) or for unrotated rows. */
  rotation: number | undefined;
}

export interface ResolveTextDraftStyleArgs {
  /** The text overlay row currently open for re-edit (`draft.editingId`
   *  resolved against the overlays list), or `null` for first
   *  placement. Non-text overlays should never appear here, but the
   *  helper accepts the union and ignores other kinds so callers
   *  don't have to narrow. */
  editingOverlay: { data: TextOverlayData } | null;
  /** Active text tool style (`toolState.activeStyle.style` when the
   *  active tool is text). `null` covers two cases: the tool isn't
   *  text right now, and re-edit flows where we already have the
   *  overlay's values and don't care about the tool style. */
  activeToolStyle: TextToolStyle | null;
}

/** Auto-resolved colorHex constant — kept inline so the helper stays
 *  free of UI-side fallback strings drifting independently. */
const AUTO_COLOR_HEX = "var(--accent, #ff8a1f)";

/** Default size bucket when neither the editing overlay nor the tool
 *  style tells us what to render. Picked to match `commitText`'s
 *  fallback so a tool-less draft commits at the same size it typed. */
const DEFAULT_SIZE: TextSizeBucket = "medium";

/** Default font-weight matches `readTextWeight`'s historical fallback
 *  (600) so a draft created before the popover wired up `weight`
 *  renders identically to a row persisted before that field existed. */
const DEFAULT_WEIGHT = 600;

export function resolveTextDraftStyle(
  args: ResolveTextDraftStyleArgs
): ResolvedTextDraftStyle {
  const { editingOverlay, activeToolStyle } = args;

  // Re-edit path — mirror the row, ignore the tool. This is the load-
  // bearing branch the original inline code missed.
  if (editingOverlay !== null && editingOverlay.data.kind === "text") {
    const data = editingOverlay.data;
    const resolvedColor = resolveToolColor(data.color);
    const colorHex = resolvedColor === "auto" ? AUTO_COLOR_HEX : resolvedColor;
    return {
      colorHex,
      size: data.size,
      weight: readTextWeight(data),
      storedSizePx: data.sizePx,
      rotation: data.rotation
    };
  }

  // First-placement path — mirror the tool style so the draft matches
  // what `commitText` is about to persist. `activeToolStyle === null`
  // (tool isn't text) falls back to defaults; this case is unreachable
  // in practice because `draft?.kind === "text"` already implies the
  // text tool, but the defaults keep the helper total.
  if (activeToolStyle === null) {
    return {
      colorHex: AUTO_COLOR_HEX,
      size: DEFAULT_SIZE,
      weight: DEFAULT_WEIGHT,
      storedSizePx: undefined,
      rotation: undefined
    };
  }

  const resolvedColor = resolveToolColor(activeToolStyle.color);
  const colorHex = resolvedColor === "auto" ? AUTO_COLOR_HEX : resolvedColor;
  return {
    colorHex,
    size: resolveTextSizeBucket(activeToolStyle.fontSize),
    weight: readTextWeight({ weight: activeToolStyle.weight }),
    storedSizePx: undefined,
    rotation: undefined
  };
}
