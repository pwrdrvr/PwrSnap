// Which app bundle the permission guide hands the user, and which other
// copies of it are on this Mac.
//
// The handle must drag the RUNNING copy. macOS lists every bundle with
// PwrSnap's ID as "PwrSnap", so with two copies on disk (an old download, a
// DMG still mounted, a test build) the user cannot tell from the list which
// one a row means, and a grant to the wrong one does nothing for the one
// that is running. Resolve the path from the process, never from a guessed
// install location.

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `/Applications/PwrSnap.app/Contents/MacOS/PwrSnap` →
 * `/Applications/PwrSnap.app`. Null when the executable is not inside a
 * `.app` bundle (a bare binary, a non-macOS layout).
 */
export function appBundlePathFromExe(exePath: string): string | null {
  const marker = ".app/Contents/MacOS/";
  const at = exePath.lastIndexOf(marker);
  if (at < 0) return null;
  return exePath.slice(0, at + ".app".length);
}

/** `/Applications/PwrSnap.app` → `PwrSnap`. */
export function appNameFromBundlePath(bundlePath: string): string {
  const base = bundlePath.slice(bundlePath.lastIndexOf("/") + 1);
  return base.endsWith(".app") ? base.slice(0, -".app".length) : base;
}

export function abbreviateHome(path: string, home: string = homedir()): string {
  if (home.length > 1 && (path === home || path.startsWith(home + "/"))) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/**
 * Paths from `mdfind` output other than the running bundle. Bundles inside
 * another bundle (a helper app shipped in Contents/) and anything in the
 * Trash are dropped: neither can be a row the user is looking at.
 */
export function otherCopiesFromMdfind(stdout: string, ownRealPath: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || !line.endsWith(".app")) continue;
    if (line === ownRealPath) continue;
    if (line.includes(".app/")) continue;
    if (line.includes("/.Trash/")) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** Spotlight lookup for other bundles with `bundleId`. Best-effort: any
 *  failure (Spotlight disabled, timeout) reports none. */
export async function findOtherCopies(bundleId: string, ownBundlePath: string): Promise<string[]> {
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) return [];
  let own = ownBundlePath;
  try {
    own = await realpath(ownBundlePath);
  } catch {
    // keep the unresolved path
  }
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/mdfind",
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { timeout: 2_000 }
    );
    const found = otherCopiesFromMdfind(stdout, own);
    const resolved: string[] = [];
    for (const path of found) {
      let real = path;
      try {
        real = await realpath(path);
      } catch {
        // a vanished path still counts as reported
      }
      if (real !== own) resolved.push(path);
    }
    return resolved;
  } catch {
    return [];
  }
}
