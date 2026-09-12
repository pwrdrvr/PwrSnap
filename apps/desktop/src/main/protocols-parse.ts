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
  /** Per-app icon, extracted lazily from the installed macOS bundle or
   *  Windows executable and cached under `<userData>/app-icons/`. URL shape:
   *  `pwrsnap-app-icon://r/<encoded-identifier>`. The identifier sits in the
   *  path so case survives Chromium's authority-lowercasing pass. */
  appIcon: "pwrsnap-app-icon",
  /** Rendered sizzle reel output. URL shape:
   *  `pwrsnap-sizzle://r/<project-id>`; the project id uses the same
   *  safe alphabet as capture ids (`sz_...`). */
  sizzle: "pwrsnap-sizzle"
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
  const noQuery = url.split(/[?#]/, 1)[0]!;
  const rest = noQuery.slice(prefix.length).replace(/\/+$/, "");
  if (rest.length === 0) return null;
  // Allow letters, digits, underscore, dash — matches nanoid alphabet.
  if (!/^[a-zA-Z0-9_-]+$/.test(rest)) return null;
  return rest;
}

/**
 * Parse `pwrsnap-capture://s/<id>/<sha256>` → `{ captureId, sha256 }`.
 * The "s" host marks a per-layer raster source (vs "r" = base source).
 * Both the capture id and the 64-char lowercase-hex content hash sit in
 * the path so their case survives Chromium's authority-lowercasing pass.
 * Strips any `?...` cache-buster suffix. Returns `null` for any
 * malformed URL (the sha must be exactly 64 hex chars — the editor only
 * ever requests sources that exist in the capture's bundle).
 */
export function parseSourceUrl(
  url: string
): { captureId: string; sha256: string } | null {
  const prefix = `${SCHEMES.capture}://s/`;
  if (!url.startsWith(prefix)) return null;
  const noQuery = url.split(/[?#]/, 1)[0]!;
  const rest = noQuery.slice(prefix.length).replace(/\/+$/, "");
  const match = rest.match(/^([a-zA-Z0-9_-]+)\/([a-f0-9]{64})$/);
  if (match === null) return null;
  const [, captureId, sha256] = match;
  if (captureId === undefined || sha256 === undefined) return null;
  return { captureId, sha256 };
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
 * Whitelisted derived-video asset filenames the `v/` arm may serve.
 *
 * The audio arm is version-generic on purpose: the mixed-audio filename is
 * derived from `AUDIO_PIPELINE_VERSION`, so pinning one version here meant a
 * pipeline bump needed a matching edit in a second file to keep serving.
 * `audio.m4a` is the pre-versioning name and `audio-mixed-vN.m4a` a
 * short-lived spelling of it; both stay addressable for any renderer holding
 * an old URL, and for caches written before the rename.
 */
/**
 * Every spelling the audio + playback derivatives have ever used, in one
 * list, because two consumers need the same answer: the resolver decides
 * what it may SERVE, and the orphan sweep decides what it may RECLAIM.
 * Writing that set out twice is how the sweep ended up skipping
 * `audio-mixed-vN.m4a` — a name this file still serves — so the orphan it
 * was added to collect survived every pipeline bump.
 *
 * Version-generic on purpose: the live filenames are derived from
 * `AUDIO_PIPELINE_VERSION`, so pinning one version here would need a
 * matching edit in a second file on every bump.
 */
const DERIVED_AUDIO_ASSET_ALTERNATIVES = [
  // Mixed audio for the waveform lane.
  String.raw`mixed-audio-v\d{1,3}\.m4a`,
  // Pre-versioning and short-lived spellings of the audio asset, still
  // addressable for a renderer holding an old URL.
  String.raw`audio\.m4a`,
  String.raw`audio-mixed-v\d{1,3}\.m4a`
];

/**
 * The prepared playback rendition. Two spellings, and both must stay
 * servable AND reclaimable:
 *
 *   `playback-mixed-audio-vN.mp4`          — #496, keyed by pipeline version
 *   `playback-mixed-audio-vN-<hex>.mp4`    — additionally keyed by source
 *                                            revision and the four track flags
 *
 * The unkeyed spelling is not merely history: a rendition written by #496
 * is sitting in some users' caches at SOURCE SIZE, so the sweep has to be
 * able to collect it. Dropping it from this list would strand those bytes
 * until the capture was hard-deleted.
 */
const DERIVED_PLAYBACK_ASSET_ALTERNATIVES = [
  String.raw`playback-mixed-audio-v\d{1,3}\.mp4`,
  String.raw`playback-mixed-audio-v\d{1,3}-[0-9a-f]{8,64}\.mp4`
];

const DERIVED_AUDIO_ASSET_PATTERN = new RegExp(
  `^(?:${DERIVED_AUDIO_ASSET_ALTERNATIVES.join("|")})$`
);

const DERIVED_PLAYBACK_ASSET_PATTERN = new RegExp(
  `^(?:${DERIVED_PLAYBACK_ASSET_ALTERNATIVES.join("|")})$`
);

/**
 * Whether `name` is a derived audio asset from ANY pipeline version — i.e.
 * the set the waveform lane's orphan sweep is allowed to reclaim. Callers
 * exclude the name currently in use themselves.
 */
export function isDerivedAudioAsset(name: string): boolean {
  return DERIVED_AUDIO_ASSET_PATTERN.test(name);
}

/**
 * Whether `name` is a prepared playback rendition from ANY pipeline version
 * or source revision — the set the playback lane's sweep may reclaim.
 *
 * Split from `isDerivedAudioAsset` because the two lanes now invalidate on
 * different facts and so must sweep separately: a pipeline bump retires
 * every audio asset at once, while a source rewrite retires ONE rendition
 * and leaves its siblings valid. One combined sweep could only be as
 * precise as its coarser half.
 */
export function isDerivedPlaybackAsset(name: string): boolean {
  return DERIVED_PLAYBACK_ASSET_PATTERN.test(name);
}

const VIDEO_ASSET_PATTERN = new RegExp(
  `^(?:${[
    // Timeline filmstrip.
    String.raw`frames-n\d{1,3}-w\d{1,4}\.jpg`,
    ...DERIVED_AUDIO_ASSET_ALTERNATIVES,
    ...DERIVED_PLAYBACK_ASSET_ALTERNATIVES
  ].join("|")})$`
);

export type VideoAssetUrlParts = {
  captureId: string;
  asset: string;
};

/**
 * Parse `pwrsnap-cache://v/<capture-id>/<asset>` → structured. The "v"
 * host marks a derived video asset (filmstrip contact strip, extracted
 * audio) living under `<render-cache>/video/<id>/`. The asset name is
 * matched against a strict whitelist — never a free-form path — so
 * the resolver can join it onto the per-capture directory without a
 * traversal check. Strips any `?…` cache-buster. Returns `null` for
 * anything malformed.
 */
export function parseVideoAssetUrl(url: string): VideoAssetUrlParts | null {
  const prefix = `${SCHEMES.cache}://v/`;
  if (!url.startsWith(prefix)) return null;
  const noQuery = url.split(/[?#]/, 1)[0]!;
  const rest = noQuery.slice(prefix.length).replace(/\/+$/, "");
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const captureId = rest.slice(0, slash);
  const asset = rest.slice(slash + 1);
  if (!/^[a-zA-Z0-9_-]+$/.test(captureId)) return null;
  if (!VIDEO_ASSET_PATTERN.test(asset)) return null;
  return { captureId, asset };
}

/** Build the renderer-facing URL for a derived video asset. */
export function videoAssetUrl(captureId: string, asset: string): string {
  return `${SCHEMES.cache}://v/${captureId}/${asset}`;
}

/**
 * Build the renderer-facing URL for a capture's own source bytes. Mirrors
 * `captureSrcUrl` in the renderer's `lib/pwrsnap`; both exist because
 * `video:playback` answers with one or the other and the answer is composed
 * in main.
 */
export function captureSrcUrl(captureId: string): string {
  return `${SCHEMES.capture}://r/${captureId}`;
}

/**
 * Parse `pwrsnap-app-icon://r/<identifier>` → the platform app identifier.
 * macOS bundle ids remain unescaped and use `A-Za-z0-9._-`. Windows absolute
 * executable paths are encodeURIComponent-encoded by the renderer and are
 * accepted only when they round-trip canonically and contain no traversal,
 * device/UNC prefix, or illegal Windows path characters.
 */
export function parseAppIconBundleId(url: string): string | null {
  const prefix = `${SCHEMES.appIcon}://r/`;
  if (!url.startsWith(prefix)) return null;
  const noQuery = url.split(/[?#]/, 1)[0]!;
  const rest = noQuery.slice(prefix.length).replace(/\/+$/, "");
  if (rest.length === 0 || rest.length > 6144) return null;
  if (rest.length <= 256 && /^[A-Za-z0-9._-]+$/.test(rest)) return rest;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (encodeURIComponent(decoded) !== rest) return null;
  if (decoded.length === 0 || decoded.length > 2048) return null;
  if (!/^[A-Za-z]:\\[^<>:"|?*\r\n]+\.exe$/i.test(decoded)) return null;
  if (/(?:^|\\)\.\.(?:\\|$)/.test(decoded)) return null;
  return decoded;
}
