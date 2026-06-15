// Pre-capture storage gate — ensure the captures directory exists and is
// writable BEFORE any capture UI (region selector, countdown HUD) appears.
//
// Why this exists: capture bundles persist to `~/Documents/PwrSnap`
// (persistence/paths.ts), and `~/Documents` is a macOS TCC-protected
// folder ("Files & Folders → Documents"). The FIRST access — our
// `mkdir` of the captures root — makes macOS show its "Allow Documents
// folder" consent dialog and BLOCKS until the user answers.
//
// If we let that first access happen at persist time (mid-capture), the
// dialog pops UNDER the region selector, which is an `alwaysOnTop`
// screen-saver-level (1000) window — so the user sees the orange picker
// floating over a consent dialog they can't reach, and the persist write
// is parked waiting for an answer they can't give. Doing the `mkdir`
// here, before any overlay shows, pulls the prompt onto a clean screen.
// Idempotent and cheap once the grant exists (or once the dir is there).
//
// See docs/solutions/2026-06-12-macos-tcc-captures-folder-denials.md and
// docs/solutions/2026-06-14-first-run-screen-recording-permission.md.

import { mkdir } from "node:fs/promises";
import { err, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { getCapturesRoot } from "../persistence/paths";
import { isPermissionDenial } from "../storage/captures-access-health";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:capture-storage-gate");

/**
 * Ensure the captures root exists/writable. Returns `null` when the
 * caller may proceed, or a `Result.err` to short-circuit the command.
 * Used exactly like {@link guardScreenCapture}:
 *
 *   const blocked = await ensureCapturesDirReady();
 *   if (blocked) return blocked;
 *
 * Distinguishes a macOS TCC denial (`EPERM`/`EACCES` → actionable
 * "grant Documents access" copy) from any other mkdir failure.
 */
export async function ensureCapturesDirReady(): Promise<Result<never, PwrSnapError> | null> {
  const root = getCapturesRoot();
  try {
    await mkdir(root, { recursive: true });
    return null;
  } catch (cause) {
    const denied = isPermissionDenial(cause);
    log.warn("ensureCapturesDirReady: cannot prepare captures dir", {
      root,
      denied,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return err({
      kind: "capture",
      code: denied ? "captures_dir_denied" : "captures_dir_unwritable",
      message: denied
        ? "PwrSnap needs access to your Documents folder to save captures. Allow it in System Settings → Privacy & Security → Files & Folders → Documents, then capture again."
        : `PwrSnap couldn't prepare its captures folder (${root}). Make sure it's writable, then capture again.`,
      cause
    });
  }
}
