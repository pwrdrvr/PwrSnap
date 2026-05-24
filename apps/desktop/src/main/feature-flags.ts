// Feature flags — single source of truth for experimental behavior
// that's wired into main but not yet promoted to the default. The
// shape is intentionally minimal so this module can be replaced with
// a persisted Settings-table read once the renderer's Settings UI
// lands (see protocol.ts → Settings).
//
// Today each flag is sourced from an env var:
//   PWRSNAP_BUNDLE_V2=0   → DEBUG ESCAPE HATCH — forces new captures
//                           back onto the v1 write path. Default
//                           (unset / any other value) is v2.
//
// Why an env var (not a Settings row) for the escape hatch:
//   The v2 layer-editor UI, the v1→v2 doctor, and the dual-read path
//   are all shipped — v2 is now the default for new captures. The
//   env var survives as a debug-only rollback knob for bisecting
//   v2-codepath regressions against an existing v1-only install
//   without requiring a downgrade. A future Settings → Experimental
//   toggle backed by the same getter can replace the env var once a
//   user-visible reason to expose it appears.

/**
 * True when new captures should be written as v2 layer-tree bundles.
 * Default is true (v2). The read path is dual-format — v1 and v2
 * captures both render correctly regardless of this flag.
 *
 * Set `PWRSNAP_BUNDLE_V2=0` (or `false`/`no`/`off`) to force the v1
 * write path for debugging / rollback.
 */
export function isV2WriteEnabled(): boolean {
  // Falsy values: "0", "false", "no", "off" (case-insensitive)
  // explicitly opt OUT and force v1 writes. Anything else
  // (including unset) → v2 write path.
  const raw = process.env.PWRSNAP_BUNDLE_V2;
  if (raw === undefined || raw === "") return true;
  const norm = raw.toLowerCase();
  if (norm === "0" || norm === "false" || norm === "no" || norm === "off") return false;
  return true;
}
