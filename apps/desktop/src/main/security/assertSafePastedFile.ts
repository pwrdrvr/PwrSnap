// Phase 5 multi-image paste/drop — security gate for Finder-dropped
// files.
//
// The renderer hands main an absolute filesystem path on drag-drop.
// That path is attacker-controllable (any process can spoof a drag
// payload) so we refuse anything that could be used to read off-path:
//
//   1. Symlink → could redirect us at any file the user has TCC for
//      (Keychain, SSH keys, AWS creds, Mail). lstat (NOT stat) so we
//      see the link itself, not the target.
//   2. Non-regular file (directory, fifo, socket, block dev) → not
//      somethink we can ingest as image bytes; the only legitimate
//      input is a plain file.
//   3. Privileged-dir prefix → refuse paths inside dirs that hold
//      secrets even if they're regular files. Closes the "user drags
//      ~/.ssh/id_rsa thinking it's a key.png" mistake AND the trojan
//      where an attacker convinces the user to drag a "wallpaper" they
//      placed inside the user's secret stash.
//
// Mirrors `assertSafeBundleFile` semantics from bundle-store.ts:123.
// Throws on rejection; callers catch and translate to a sanitized
// command-bus error. The error message includes the offending path so
// main-side logs can debug, but handlers MUST sanitize before returning
// to the renderer.

import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Path prefixes we refuse to read from, regardless of user intent.
 * Computed at module-load time from `homedir()` so per-user dirs
 * resolve to the running user's actual paths.
 *
 * The list is intentionally narrow: directories that hold secrets the
 * user almost certainly didn't mean to share. We don't try to be a
 * general access-control system — the OS TCC layer is the source of
 * truth there. This is a "don't accidentally ingest a credential"
 * belt-and-suspenders gate.
 */
function buildPrivilegedPrefixes(): readonly string[] {
  const home = homedir();
  return [
    // System dirs — never legitimate user content.
    "/private/etc",
    "/private/var",
    "/System",
    "/Volumes/.timemachine.local",
    // Per-user secret stores.
    resolve(home, "Library/Keychains"),
    resolve(home, ".ssh"),
    resolve(home, ".aws"),
    resolve(home, ".gnupg"),
    resolve(home, ".config/gh") // GitHub CLI tokens
  ];
}

const PRIVILEGED_PREFIXES = buildPrivilegedPrefixes();

/**
 * Fold a path for the privileged-prefix comparison on case-insensitive
 * filesystems (Windows always; macOS/APFS by default). `resolve()` preserves
 * input case and `startsWith` is case-sensitive, so without this a differently-
 * cased path (`c:\users\…` vs `C:\Users\…`, `~/.SSH` vs `~/.ssh`) slips past the
 * guard on those platforms. Linux is case-sensitive — folding there would
 * wrongly conflate distinct paths, so it's a no-op. Comparison only: the
 * original-case path is what we lstat and return.
 */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
function foldForCompare(path: string): string {
  return CASE_INSENSITIVE_FS ? path.toLowerCase() : path;
}

/**
 * Test-only override hook. Lets unit tests inject a temp-dir prefix
 * so the privileged-dir branch is exercisable without writing to the
 * real ~/.ssh.
 */
let testPrefixOverride: readonly string[] | null = null;
export function __setPrivilegedPrefixesForTest(
  prefixes: readonly string[] | null
): void {
  testPrefixOverride = prefixes;
}

export class UnsafePastedFileError extends Error {
  readonly code:
    | "symlink"
    | "not_regular_file"
    | "privileged_path"
    | "stat_failed";
  /** Sanitized — never includes the offending path. Use for renderer
   *  / bus error messages. */
  readonly sanitizedMessage: string;

  constructor(
    code: UnsafePastedFileError["code"],
    sanitizedMessage: string,
    message: string
  ) {
    super(message);
    this.name = "UnsafePastedFileError";
    this.code = code;
    this.sanitizedMessage = sanitizedMessage;
  }
}

/**
 * Refuse to read a pasted/dropped file whose on-disk shape would let
 * an attacker redirect us off-path. Throws `UnsafePastedFileError` on
 * rejection — callers catch and translate to a Result error using the
 * sanitized message (NEVER the raw error message, which contains the
 * offending absolute path).
 *
 * Returns the resolved absolute path on success. Use the returned path
 * for subsequent reads — the input might be a relative or
 * tilde-expanded form.
 */
export async function assertSafePastedFile(filePath: string): Promise<string> {
  // Resolve to an absolute path with all `..` segments collapsed so
  // the prefix check below can't be bypassed via
  // `/Users/me/foo/../../private/etc/passwd`.
  const abs = resolve(filePath);

  // Privileged-dir check FIRST — we want to refuse before even lstat'ing,
  // so we never touch the filesystem inside a secret dir (which could
  // trigger TCC prompts on macOS).
  const prefixes = testPrefixOverride ?? PRIVILEGED_PREFIXES;
  const foldedAbs = foldForCompare(abs);
  for (const prefix of prefixes) {
    // `sep` (not a hardcoded "/") so the containment check works on Windows,
    // where `resolve()` yields `\`-separated paths. Folded comparison so a
    // differently-cased path can't slip past on case-insensitive filesystems
    // (see foldForCompare). Without both, the per-user secret-dir protection is
    // silently bypassed on Windows / macOS.
    const foldedPrefix = foldForCompare(prefix);
    if (foldedAbs === foldedPrefix || foldedAbs.startsWith(foldedPrefix + sep)) {
      throw new UnsafePastedFileError(
        "privileged_path",
        "Invalid file",
        `refusing pasted file inside privileged dir: ${abs}`
      );
    }
  }

  let stat;
  try {
    stat = await lstat(abs);
  } catch (cause) {
    throw new UnsafePastedFileError(
      "stat_failed",
      "Invalid file",
      `lstat failed for ${abs}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  if (stat.isSymbolicLink()) {
    throw new UnsafePastedFileError(
      "symlink",
      "Invalid file",
      `refusing to follow symlink at ${abs}`
    );
  }
  if (!stat.isFile()) {
    throw new UnsafePastedFileError(
      "not_regular_file",
      "Invalid file",
      `${abs} is not a regular file`
    );
  }
  return abs;
}
