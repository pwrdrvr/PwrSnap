// Bundle-icon cache: per-bundle-id PNG extracted from the installed
// .app via the Swift helper (`--extract-app-icon`), addressed by the
// `pwrsnap-app-icon://` protocol.
//
// Layout (under `getAppIconsRoot()`):
//
//   <bundleId>.png      — the icon PNG (1024px)
//   <bundleId>.json     — sidecar: { appPath, infoPlistMtimeMs,
//                                     extractedAt, version }
//
// Validity rule: a cached PNG is fresh when the sidecar's
// `infoPlistMtimeMs` matches the live `Info.plist` mtime at the
// recorded `appPath`. Apps update their bundle icon through
// install/auto-update, both of which rewrite Info.plist. If the file
// moved (Finder drag), we re-resolve via NSWorkspace and re-extract.
//
// In-flight dedup: two parallel `pwrsnap-app-icon://` requests for
// the same bundle id share one extraction. Negative results
// (uninstalled apps, blocklisted bundle ids) are cached in-memory
// with a TTL so we don't shell out to the helper repeatedly while
// the sidebar repaints.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractAppIcon } from "../capture/window-list";
import { getMainLogger } from "../log";
import { getAppIconsRoot } from "../persistence/paths";

const log = getMainLogger("pwrsnap:app-icons");

type Sidecar = {
  version: 1;
  bundleId: string;
  appPath: string;
  infoPlistMtimeMs: number;
  extractedAt: number;
};

/** Extract size (px) passed to the Swift helper. AppKit doubles for
 *  Retina representations, so 128 → a 256×256 PNG (~40-100KB depending
 *  on icon complexity). Plenty for the largest in-app surface (the
 *  26px AppTag tile on a 3× display = 78 actual pixels) and small
 *  enough to keep the per-bundle cache file tiny. */
const EXTRACT_SIZE_PX = 128;

/** Negative-cache TTL. Long enough to absorb repaint storms, short
 *  enough that installing the app and reloading the library "just
 *  works" within a couple of minutes. */
const NEGATIVE_TTL_MS = 5 * 60_000;

/** Bundle ids we will never resolve to a real icon — the curated
 *  blocklist + the synthetic `"any"` placeholder used by the
 *  renderer when no bundle id was captured. Short-circuits before we
 *  even hit the Swift helper. */
const PERMANENT_MISS: ReadonlySet<string> = new Set<string>([
  "any",
  "unknown",
  ""
]);

const inFlight = new Map<string, Promise<string | null>>();
const negativeCache = new Map<string, number>();
let rootEnsured = false;

async function ensureRoot(): Promise<void> {
  if (rootEnsured) return;
  await mkdir(getAppIconsRoot(), { recursive: true });
  rootEnsured = true;
}

function pngPathFor(bundleId: string): string {
  return join(getAppIconsRoot(), `${bundleId}.png`);
}

function sidecarPathFor(bundleId: string): string {
  return join(getAppIconsRoot(), `${bundleId}.json`);
}

async function readSidecar(bundleId: string): Promise<Sidecar | null> {
  try {
    const buf = await readFile(sidecarPathFor(bundleId), "utf8");
    const parsed = JSON.parse(buf) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      return null;
    }
    return parsed as Sidecar;
  } catch {
    return null;
  }
}

async function writeSidecar(sidecar: Sidecar): Promise<void> {
  // tmp + rename so a crash mid-write doesn't leave a half-flushed
  // JSON sidecar that parses but lies.
  const finalPath = sidecarPathFor(sidecar.bundleId);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(sidecar), "utf8");
  await rename(tmpPath, finalPath);
}

async function infoPlistMtime(appPath: string): Promise<number | null> {
  try {
    const st = await stat(join(appPath, "Contents", "Info.plist"));
    return st.mtimeMs;
  } catch {
    return null;
  }
}

async function pngExists(bundleId: string): Promise<boolean> {
  try {
    await stat(pngPathFor(bundleId));
    return true;
  } catch {
    return false;
  }
}

/** Validate `bundleId` matches the allow-list the Swift helper and
 *  protocol parser use — letters, digits, dot, underscore, dash. The
 *  protocol layer rejects malformed urls earlier; this is defence-
 *  in-depth so we never `${bundleId}` an unescaped string into a
 *  file path. */
function isValidBundleId(bundleId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(bundleId);
}

/**
 * Return a path to a fresh icon PNG for `bundleId`, or `null` when
 * we can't produce one (bundle not installed locally, helper not
 * available, etc.). Safe to call concurrently — duplicate requests
 * coalesce into one extraction.
 */
export async function getAppIconPath(bundleId: string): Promise<string | null> {
  if (PERMANENT_MISS.has(bundleId)) return null;
  if (!isValidBundleId(bundleId)) return null;

  const negUntil = negativeCache.get(bundleId);
  if (negUntil !== undefined && negUntil > Date.now()) return null;
  if (negUntil !== undefined) negativeCache.delete(bundleId);

  const existing = inFlight.get(bundleId);
  if (existing !== undefined) return existing;

  const work = (async (): Promise<string | null> => {
    try {
      await ensureRoot();

      const sidecar = await readSidecar(bundleId);
      if (sidecar !== null && (await pngExists(bundleId))) {
        const liveMtime = await infoPlistMtime(sidecar.appPath);
        if (liveMtime !== null && liveMtime === sidecar.infoPlistMtimeMs) {
          return pngPathFor(bundleId);
        }
      }

      const outPath = pngPathFor(bundleId);
      const result = await extractAppIcon(bundleId, outPath, EXTRACT_SIZE_PX);
      if (!result.ok) {
        log.info("app-icon extract miss", { bundleId, message: result.message });
        negativeCache.set(bundleId, Date.now() + NEGATIVE_TTL_MS);
        return null;
      }
      const liveMtime = await infoPlistMtime(result.appPath);
      await writeSidecar({
        version: 1,
        bundleId,
        appPath: result.appPath,
        infoPlistMtimeMs: liveMtime ?? 0,
        extractedAt: Date.now()
      });
      return outPath;
    } catch (cause) {
      log.warn("app-icon resolve threw", {
        bundleId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      negativeCache.set(bundleId, Date.now() + NEGATIVE_TTL_MS);
      return null;
    } finally {
      inFlight.delete(bundleId);
    }
  })();

  inFlight.set(bundleId, work);
  return work;
}
