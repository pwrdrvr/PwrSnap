// Feature flags — single source of truth for experimental behavior
// that's wired into main but not yet promoted to the default. The
// shape is intentionally minimal so this module can be replaced with
// a persisted Settings-table read once the renderer's Settings UI
// lands (see protocol.ts → Settings).
//
// Today each flag is sourced from an env var:
//   PWRSNAP_BUNDLE_V2=1   → opts in to the v2 layer-tree bundle
//                           write path. Read path is dual-format
//                           regardless of this flag; only NEW
//                           captures change shape.
//
// Why an env var (not a Settings row) for now:
//   The full v2 surface (layer panel UI, multi-image canvas, effect
//   palette, v1→v2 doctor promotion, cross-instance UTI roundtrip
//   verification) isn't built. Defaulting v2 on would break
//   `overlays:upsert` for every new capture — the editor's only
//   annotation IPC. The env var keeps the v2 code path live for
//   development + E2E without affecting normal users.
//
// Promotion path: once the layer-editor UI ships AND the v1→v2
// doctor lands AND Phase 6 E2E specs are green, flip the default in
// `isV2WriteEnabled()` and add a Settings → Experimental UI toggle
// behind the same getter.

/**
 * True when the user (or test harness) has opted in to writing new
 * captures as v2 layer-tree bundles. Read path is unaffected — v1
 * and v2 captures both render correctly regardless of this flag.
 */
export function isV2WriteEnabled(): boolean {
  // Truthy values: "1", "true", "yes", "on" (case-insensitive).
  // Anything else (including unset) → v1 write path.
  const raw = process.env.PWRSNAP_BUNDLE_V2;
  if (raw === undefined || raw === "") return false;
  const norm = raw.toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}
