// Resolve a `ToolColor` (named token or free-form CSS string) into a
// concrete `#rrggbb` hex string that the v1 Overlay schemas accept.
//
// Why this helper exists: tool style state carries `ToolColor` (a union
// of `ColorToken | string`) so the popover can persist either a named
// swatch ("red", "accent") OR an arbitrary hex from the OS color
// picker. The overlay schemas, by contrast, only accept the literal
// "auto" sentinel OR a strict `^#[0-9a-f]{6}$` hex. When the user
// picks "red" in the popover and we plumb it straight into an
// ArrowOverlay's `color` field, the zod boundary in the bus rejects
// the row (`color: "red"` matches neither alternative) and the arrow
// vanishes.
//
// The resolution is hardcoded against the dark-theme `--swatch-*`
// values in `apps/desktop/src/renderer/src/styles/tokens.css`. That's a
// deliberate v2-editor-Phase-3.1 compromise: theme-aware resolution
// would need a `getComputedStyle` read on the renderer's documentElement,
// which is awkward to call from a write-path helper that may run during
// drag commit (no DOM reflow guarantees). The light-theme swatches are
// designed to be perceptually similar to dark-theme — the brand accent
// is the only one that differs significantly, and that's documented as
// a TODO for the future theme-aware resolver.
//
// Free-form strings (already a hex from the Custom… dialog) pass
// through unchanged. The downstream zod gate in `overlay-schemas.ts`
// will reject anything that doesn't match `^#[0-9a-f]{6}$` so we don't
// need to validate here — the regex itself becomes the validator.

import type { ColorToken, ToolColor } from "@pwrsnap/shared";
import { isColorToken } from "@pwrsnap/shared";

/** Dark-theme swatch hex values. MUST stay in lockstep with `--swatch-*`
 *  custom properties in `apps/desktop/src/renderer/src/styles/tokens.css`.
 *  The light-theme palette is intentionally close to these; the brand
 *  accent diverges (dark `#ff8a1f` → light `#c45200`) and is the open
 *  TODO for a future theme-aware variant. */
const SWATCH_HEX: Record<ColorToken, string> = {
  red: "#ff5f57",
  yellow: "#facc15",
  green: "#28c840",
  blue: "#1f7cff",
  gray: "#8b8a87",
  black: "#0a0a0a",
  white: "#f5efe3",
  // `accent` resolves to the dark-theme brand tangerine. Light-theme
  // resolution lives in tokens.css's `[data-theme="light"]` block;
  // theme-aware resolution lands when the bake-side renderer needs it
  // (Phase 4+). For Phase 3.1, the dark-theme hex is what the user
  // sees in the popover preview AND in the editor canvas after commit.
  accent: "#ff8a1f"
};

/**
 * Resolve a ToolColor into a concrete `#rrggbb` hex string the v1
 * Overlay schemas accept. Pass-through for already-hex strings;
 * lookup for named tokens; fallback to the "auto" sentinel for
 * anything else (lets the renderer keep its derive-from-image-short-
 * side default for ambiguous inputs).
 *
 * Return value is always either `"auto"` (no override) or a strict
 * 7-char hex string. Both are valid for every overlay color field
 * (the `z.union([z.literal("auto"), …hex regex…])` shape).
 */
export function resolveToolColor(color: ToolColor): "auto" | string {
  if (typeof color !== "string") return "auto";
  if (color === "auto") return "auto";
  if (color.startsWith("#")) {
    // Pass-through. Downstream zod will validate the regex; if it fails
    // there, the upsert returns Result.err and we log + drop. (Same
    // shape as a corrupt arrow.) Returning the raw string here is
    // intentional — we don't want to silently coerce a malformed hex
    // into "auto" because the user explicitly chose it.
    return color;
  }
  if (isColorToken(color)) {
    return SWATCH_HEX[color];
  }
  // Unknown free-form string (e.g. "rgb(…)"). Fall back to "auto" so
  // the schema accepts the row; the renderer applies its image-short-
  // side default. This branch should be unreachable in practice — the
  // popover only emits tokens or hex strings — but defensive in case
  // a future control widens the union without updating this helper.
  return "auto";
}
