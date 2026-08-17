// Native app-icon cache: per-platform-identifier PNG extracted from the
// installed macOS bundle or Windows executable, addressed by the
// `pwrsnap-app-icon://` protocol.
//
// Layout (under `getAppIconsRoot()`):
//
//   <cacheKey>.png      — the icon PNG (`EXTRACT_SIZE_PX` × scale,
//                          typically 256×256 on Retina)
//   <cacheKey>.json     — sidecar: { identifier, sourcePath,
//                                     sourceMtimeMs, extractedAt, version }
//
// Reverse-DNS bundle ids are already filename-safe and remain readable as
// cache keys. Windows executable paths are SHA-256 keyed so drive separators
// can never become filesystem structure under the cache root.
//
// Validity rule: a cached PNG is fresh when the sidecar's
// `sourceMtimeMs` matches the live `Info.plist` (macOS) or executable
// (Windows) mtime at the recorded path. App updates rewrite that source;
// moves and missing sources force re-resolution and extraction.
//
// In-flight dedup: two parallel `pwrsnap-app-icon://` requests for
// the same bundle id share one extraction. Negative results
// (uninstalled apps, blocklisted bundle ids) are cached in-memory
// with a TTL so we don't shell out to the helper repeatedly while
// the sidebar repaints.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractAppIcon } from "../capture/window-list";
import { getMainLogger } from "../log";
import { getAppIconsRoot } from "../persistence/paths";

const log = getMainLogger("pwrsnap:app-icons");

type LegacySidecar = {
  version: 1;
  bundleId: string;
  appPath: string;
  infoPlistMtimeMs: number;
  extractedAt: number;
};

type Sidecar = {
  version: 2;
  identifier: string;
  sourcePath: string;
  sourceMtimeMs: number;
  extractedAt: number;
};

type AnySidecar = LegacySidecar | Sidecar;

/** Extract size (px) passed to the native helper. AppKit may add a Retina
 *  representation; Windows asks the shell for the best icon at this size.
 *  Plenty for the largest in-app surface (the
 *  26px AppTag tile on a 3× display = 78 actual pixels) and small
 *  enough to keep the per-bundle cache file tiny. */
const EXTRACT_SIZE_PX = 128;

/** Negative-cache TTL. Long enough to absorb repaint storms, short
 *  enough that installing the app and reloading the library "just
 *  works" within a couple of minutes. */
const NEGATIVE_TTL_MS = 5 * 60_000;

/** Synthetic placeholders the renderer may pass when no real bundle
 *  id was captured (`"any"` from `mapBundleIdToAppId`, or `"unknown"`
 *  for legacy fixtures). Short-circuits before we hit the Swift
 *  helper or even the regex validator. Empty / malformed strings are
 *  already rejected by `isValidIdentifier` below — no need to enumerate
 *  them here. */
const PERMANENT_MISS: ReadonlySet<string> = new Set<string>([
  "any",
  "unknown"
]);

/** PwrSnap-synthetic bundle ids — captures that didn't come from an
 *  identifiable running macOS app, so a Launch Services lookup would
 *  always miss. These are expected to be unresolvable, so we
 *  short-circuit BEFORE the extract call to skip both the miss log
 *  and the roundtrip to the native helper. The renderer's
 *  `AppIcon` component renders a domain-specific glyph for each
 *  (e.g., a clipboard for `com.pwrsnap.clipboard`).
 *
 *  Currently:
 *    • `com.pwrsnap.clipboard` — paste-from-clipboard captures
 *      (PR #48). Stamped by `capture-handlers.ts` when ingesting
 *      an image from the clipboard. */
const SYNTHETIC_BUNDLE_IDS: ReadonlySet<string> = new Set<string>([
  "com.pwrsnap.clipboard"
]);

const inFlight = new Map<string, Promise<string | null>>();
const negativeCache = new Map<string, number>();
let rootEnsured = false;

async function ensureRoot(): Promise<void> {
  if (rootEnsured) return;
  await mkdir(getAppIconsRoot(), { recursive: true });
  rootEnsured = true;
}

function cacheKeyFor(identifier: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(identifier)) return identifier;
  return `win-${createHash("sha256").update(identifier).digest("hex")}`;
}

function pngPathFor(identifier: string): string {
  return join(getAppIconsRoot(), `${cacheKeyFor(identifier)}.png`);
}

function sidecarPathFor(identifier: string): string {
  return join(getAppIconsRoot(), `${cacheKeyFor(identifier)}.json`);
}

async function readSidecar(identifier: string): Promise<AnySidecar | null> {
  try {
    const buf = await readFile(sidecarPathFor(identifier), "utf8");
    const parsed = JSON.parse(buf) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      ((parsed as { version?: unknown }).version !== 1 &&
        (parsed as { version?: unknown }).version !== 2)
    ) {
      return null;
    }
    return parsed as AnySidecar;
  } catch {
    return null;
  }
}

async function writeSidecar(sidecar: Sidecar): Promise<void> {
  // tmp + rename so a crash mid-write doesn't leave a half-flushed
  // JSON sidecar that parses but lies. If the rename itself fails,
  // best-effort unlink the tmp so it doesn't leak on disk forever.
  const finalPath = sidecarPathFor(sidecar.identifier);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(sidecar), "utf8");
  try {
    await rename(tmpPath, finalPath);
  } catch (cause) {
    await unlink(tmpPath).catch(() => undefined);
    throw cause;
  }
}

async function sourceMtime(sourcePath: string): Promise<number | null> {
  try {
    const statPath = sourcePath.toLowerCase().endsWith(".exe")
      ? sourcePath
      : join(sourcePath, "Contents", "Info.plist");
    const st = await stat(statPath);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

async function pngExists(identifier: string): Promise<boolean> {
  try {
    await stat(pngPathFor(identifier));
    return true;
  } catch {
    return false;
  }
}

/** Defence-in-depth for protocol input. Windows paths are never used as cache
 *  filenames (see cacheKeyFor), and traversal/device/UNC forms are rejected
 *  before the native shell sees them. */
function isValidIdentifier(identifier: string): boolean {
  if (identifier.length <= 256 && /^[A-Za-z0-9._-]+$/.test(identifier)) {
    return true;
  }
  if (identifier.length > 2048) return false;
  if (!/^[A-Za-z]:\\[^<>:"|?*\r\n]+\.exe$/i.test(identifier)) return false;
  return !/(?:^|\\)\.\.(?:\\|$)/.test(identifier);
}

/**
 * Return a path to a fresh icon PNG for `identifier`, or `null` when
 * we can't produce one (app not installed locally, helper not
 * available, etc.). Safe to call concurrently — duplicate requests
 * coalesce into one extraction.
 */
export async function getAppIconPath(identifier: string): Promise<string | null> {
  if (PERMANENT_MISS.has(identifier)) return null;
  if (!isValidIdentifier(identifier)) return null;

  const negUntil = negativeCache.get(identifier);
  if (negUntil !== undefined && negUntil > Date.now()) return null;
  if (negUntil !== undefined) negativeCache.delete(identifier);

  const existing = inFlight.get(identifier);
  if (existing !== undefined) return existing;

  // PwrSnap-synthetic bundle ids — captures that didn't come from an
  // identifiable running app (e.g., `com.pwrsnap.clipboard` for
  // paste-from-clipboard captures, PR #48). No installed `.app`
  // exists for these, so the macOS Launch Services lookup would
  // always miss. Short-circuit BEFORE the extract call so we don't
  // log a "miss" line for what's actually expected. The renderer's
  // `AppIcon` component has its own UI affordance for these (see
  // apps/desktop/src/renderer/src/features/shared/AppIcons.tsx).
  if (SYNTHETIC_BUNDLE_IDS.has(identifier)) {
    return null;
  }

  const work = (async (): Promise<string | null> => {
    try {
      await ensureRoot();

      const sidecar = await readSidecar(identifier);
      if (sidecar !== null && (await pngExists(identifier))) {
        const sidecarIdentifier = sidecar.version === 1
          ? sidecar.bundleId
          : sidecar.identifier;
        const sourcePath = sidecar.version === 1
          ? sidecar.appPath
          : sidecar.sourcePath;
        const recordedMtime = sidecar.version === 1
          ? sidecar.infoPlistMtimeMs
          : sidecar.sourceMtimeMs;
        const liveMtime = await sourceMtime(sourcePath);
        if (
          sidecarIdentifier === identifier &&
          liveMtime !== null &&
          liveMtime === recordedMtime
        ) {
          return pngPathFor(identifier);
        }
      }

      const outPath = pngPathFor(identifier);
      const result = await extractAppIcon(identifier, outPath, EXTRACT_SIZE_PX);
      if (!result.ok) {
        log.info("app-icon extract miss", { identifier, message: result.message });
        negativeCache.set(identifier, Date.now() + NEGATIVE_TTL_MS);
        return null;
      }
      const liveMtime = await sourceMtime(result.appPath);
      await writeSidecar({
        version: 2,
        identifier,
        sourcePath: result.appPath,
        sourceMtimeMs: liveMtime ?? 0,
        extractedAt: Date.now()
      });
      return outPath;
    } catch (cause) {
      log.warn("app-icon resolve threw", {
        identifier,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      negativeCache.set(identifier, Date.now() + NEGATIVE_TTL_MS);
      return null;
    } finally {
      inFlight.delete(identifier);
    }
  })();

  inFlight.set(identifier, work);
  return work;
}
