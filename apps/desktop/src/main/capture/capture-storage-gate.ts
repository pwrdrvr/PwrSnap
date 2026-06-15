// Pre-capture storage gate — confirm the captures directory is actually
// WRITABLE (i.e. the macOS Documents-folder TCC grant is in hand) BEFORE
// any capture UI (region selector, countdown HUD) appears.
//
// Why this exists: capture bundles persist to `~/Documents/PwrSnap`
// (persistence/paths.ts), and `~/Documents` is a macOS TCC-protected
// folder ("Files & Folders → Documents"). The first protected-folder
// access makes macOS show its "Allow Documents folder" consent dialog and
// BLOCKS until the user answers. If that happens at persist time (mid-
// capture), the dialog pops UNDER the region selector — an `alwaysOnTop`
// screen-saver-level (1000) window — so the user sees the orange picker
// floating over a consent dialog they can't reach, and the write is
// parked waiting for an answer they can't give.
//
// CRUCIAL: `mkdir(recursive)` is NOT a reliable trigger. macOS only
// prompts on an access that actually needs the grant; if `~/Documents/
// PwrSnap` already exists (any prior capture, or a real install behind a
// throwaway test profile — captures live OUTSIDE userData), `mkdir` is a
// no-op that never touches the protected folder, so the prompt defers to
// the first real WRITE (the persist, under the selector). We therefore
// do a real write probe — create + delete a tiny file inside the captures
// root — which forces the prompt here, on a clean screen, exactly like
// the persist would. Cached per-session so we probe once, not per capture.
//
// See docs/solutions/2026-06-12-macos-tcc-captures-folder-denials.md and
// docs/solutions/2026-06-14-first-run-screen-recording-permission.md.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { getCapturesRoot } from "../persistence/paths";
import { isPermissionDenial } from "../storage/captures-access-health";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:capture-storage-gate");

const PROBE_NAME = ".pwrsnap-access-probe";

/** Once a write probe (or a real capture) has confirmed access this
 *  session, skip re-probing — pulling the prompt forward only matters
 *  for the first capture; after that a probe per capture is pointless
 *  write+delete churn in the user's Documents folder. */
let accessConfirmedThisSession = false;

/** Test seam — reset the per-session cache between specs. */
export function resetCaptureStorageGateForTests(): void {
  accessConfirmedThisSession = false;
}

/**
 * Ensure the captures root is writable. Returns `null` when the caller
 * may proceed, or a `Result.err` to short-circuit the command. Used
 * exactly like {@link guardScreenCapture}:
 *
 *   const blocked = await ensureCapturesDirReady();
 *   if (blocked) return blocked;
 *
 * Distinguishes a macOS TCC denial (`EPERM`/`EACCES` → actionable
 * "grant Documents access" copy) from any other write failure.
 */
export async function ensureCapturesDirReady(): Promise<Result<never, PwrSnapError> | null> {
  if (accessConfirmedThisSession) return null;

  const root = getCapturesRoot();
  const probe = join(root, PROBE_NAME);
  try {
    // mkdir first so the probe write has a parent (and so a never-created
    // captures dir prompts here too). Then a REAL write — the only thing
    // that reliably forces the Documents TCC prompt when the dir already
    // exists. Delete the probe immediately (best-effort).
    await mkdir(root, { recursive: true });
    await writeFile(probe, "");
    await rm(probe, { force: true }).catch(() => undefined);
    accessConfirmedThisSession = true;
    return null;
  } catch (cause) {
    const denied = isPermissionDenial(cause);
    log.warn("ensureCapturesDirReady: captures folder not writable", {
      root,
      denied,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    // Best-effort cleanup in case the write landed but a later step threw.
    await rm(probe, { force: true }).catch(() => undefined);
    return err({
      kind: "capture",
      code: denied ? "captures_dir_denied" : "captures_dir_unwritable",
      message: denied
        ? "PwrSnap needs access to your Documents folder to save captures. Allow it in System Settings → Privacy & Security → Files & Folders → Documents, then capture again."
        : `PwrSnap couldn't write to its captures folder (${root}). Make sure it's writable, then capture again.`,
      cause
    });
  }
}
