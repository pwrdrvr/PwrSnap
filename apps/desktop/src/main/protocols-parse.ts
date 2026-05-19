// Pure URL parsers for the custom `pwrsnap-capture://` and
// `pwrsnap-cache://` schemes. Lives in its own file so it imports
// nothing from electron — protocols.ts (which calls protocol.handle)
// is not unit-testable, but the parser logic is.
//
// See protocols.ts for the full context on why the capture id sits
// in the path component instead of the host (Chromium lowercases the
// authority for any standard scheme; nanoid ids are mixed-case).

export const SCHEMES = {
  capture: "pwrsnap-capture",
  cache: "pwrsnap-cache",
  /** Per-pickRegion full-display snapshot. Resolves to a temp PNG
   *  taken at show() time; deleted when the selector dismisses. The
   *  url shape is `pwrsnap-screen://r/<id>` (same path/host trick as
   *  the capture scheme so nanoid case survives). */
  screen: "pwrsnap-screen",
  /** Per-bundle-id app icon, extracted lazily from the installed
   *  .app via the NSWorkspace helper and cached under
   *  `<userData>/app-icons/`. URL shape: `pwrsnap-app-icon://r/<bundle-id>`.
   *  Bundle ids contain dots and may carry case (`com.apple.Terminal`),
   *  so the id sits in the path component (Chromium lowercases the
   *  host for standard schemes; would collapse `Terminal` → `terminal`). */
  appIcon: "pwrsnap-app-icon"
} as const;

export type CacheUrlParts = {
  captureId: string;
  width: number;
  format: "png" | "webp";
};

/**
 * Parse `pwrsnap-capture://r/<id>` → `<id>`. The "r" host is literal —
 * the capture id sits in the path so its case survives Chromium's
 * authority-lowercasing pass. Tolerates trailing slashes. Returns
 * `null` for any malformed URL (caller surfaces 400 to the renderer).
 */
export function parseCaptureId(url: string, scheme: string = SCHEMES.capture): string | null {
  const prefix = `${scheme}://r/`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length).replace(/\/+$/, "");
  if (rest.length === 0) return null;
  // Allow letters, digits, underscore, dash — matches nanoid alphabet.
  if (!/^[a-zA-Z0-9_-]+$/.test(rest)) return null;
  return rest;
}

/**
 * Parse `pwrsnap-cache://r/<id>/<width>w.<format>` → structured.
 * Width is clamped to [1, 8192] (DoS guard — refuse a 1024×Infinity
 * request that would exhaust the render coordinator's worker pool).
 *
 * Strips any `?...` query suffix before matching. The renderer
 * appends `?v=<overlays_version>` as a cache-buster so Chromium
 * re-fetches after edits (otherwise its in-memory HTTP cache
 * serves the stale render under the same path); the suffix has
 * no semantic meaning to us, only to the browser cache.
 */
export function parseCacheUrl(url: string): CacheUrlParts | null {
  const prefix = `${SCHEMES.cache}://r/`;
  if (!url.startsWith(prefix)) return null;
  // Strip any query suffix (?v=...) and fragment (#...) before
  // matching the path portion. URL.parse would do this but it's
  // overkill for our handful of legal shapes.
  const noQuery = url.split(/[?#]/, 1)[0]!;
  const rest = noQuery.slice(prefix.length);
  const match = rest.match(/^([a-zA-Z0-9_-]+)\/(\d+)w\.(png|webp)\/?$/);
  if (match === null) return null;
  const [, captureId, widthStr, format] = match;
  if (captureId === undefined || widthStr === undefined || format === undefined) return null;
  const width = Number.parseInt(widthStr, 10);
  if (!Number.isFinite(width) || width < 1 || width > 8192) return null;
  return { captureId, width, format: format as "png" | "webp" };
}

/**
 * Parse `pwrsnap-app-icon://r/<bundle-id>` → `<bundle-id>`. Allows
 * `A-Za-z0-9._-` (the bundle-id alphabet). Strips any `?...` cache-
 * buster suffix the renderer might append. Returns `null` for any
 * malformed URL.
 */
export function parseAppIconBundleId(url: string): string | null {
  const prefix = `${SCHEMES.appIcon}://r/`;
  if (!url.startsWith(prefix)) return null;
  const noQuery = url.split(/[?#]/, 1)[0]!;
  const rest = noQuery.slice(prefix.length).replace(/\/+$/, "");
  if (rest.length === 0 || rest.length > 256) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(rest)) return null;
  return rest;
}
