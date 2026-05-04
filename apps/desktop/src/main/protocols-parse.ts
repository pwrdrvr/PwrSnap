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
  screen: "pwrsnap-screen"
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
 */
export function parseCacheUrl(url: string): CacheUrlParts | null {
  const prefix = `${SCHEMES.cache}://r/`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const match = rest.match(/^([a-zA-Z0-9_-]+)\/(\d+)w\.(png|webp)\/?$/);
  if (match === null) return null;
  const [, captureId, widthStr, format] = match;
  if (captureId === undefined || widthStr === undefined || format === undefined) return null;
  const width = Number.parseInt(widthStr, 10);
  if (!Number.isFinite(width) || width < 1 || width > 8192) return null;
  return { captureId, width, format: format as "png" | "webp" };
}
