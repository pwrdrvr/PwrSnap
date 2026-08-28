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
import { isAbsolute, join, relative, sep } from "node:path";
import {
  capturesFolderDisplayPath,
  err,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import type { CapturesLocation } from "@pwrsnap/shared";
import {
  getCapturesLocation,
  getCapturesRoot,
  getCapturesRootForLocation,
  isOverriddenDataRoot,
  setCapturesLocation
} from "../persistence/paths";
import { isPermissionDenial } from "../storage/captures-access-health";
import { getMainLogger } from "../log";
import { bus } from "../command-bus";

const log = getMainLogger("pwrsnap:capture-storage-gate");

const PROBE_NAME = ".pwrsnap-access-probe";

/** Once a write probe (or a real capture) has confirmed access this
 *  session, skip re-probing — pulling the prompt forward only matters
 *  for the first capture; after that a probe per capture is pointless
 *  write+delete churn in the user's Documents folder. */
type RootAccessState = "unknown" | "confirmed" | "denied";
const rootAccessStates = new Map<string, Exclude<RootAccessState, "unknown">>();
let fallbackSwitchPromise: Promise<
  | { ok: true }
  | { ok: false; error: PwrSnapError }
> | null = null;
let capturesRootOperationQueue: Promise<void> = Promise.resolve();

/** Whether a write probe / real capture has confirmed captures-folder
 *  access this session. Drives the Settings "Captures folder" row's
 *  positive state. */
export function isCapturesAccessConfirmed(): boolean {
  return rootAccessStates.get(getCapturesRoot()) === "confirmed";
}

export function getCapturesRootAccessState(location: CapturesLocation): RootAccessState {
  return rootAccessStates.get(getCapturesRootForLocation(location)) ?? "unknown";
}

/** Test seam — reset the per-session cache between specs. */
export function resetCaptureStorageGateForTests(): void {
  rootAccessStates.clear();
  fallbackSwitchPromise = null;
  capturesRootOperationQueue = Promise.resolve();
}

/**
 * Serialize operations that can create a durable capture with changes to the
 * selected captures root. Both callers must live in the agent process in
 * split mode; command routing pins the guarded switch-back handler there.
 */
export function runExclusiveCapturesRootOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const task = capturesRootOperationQueue
    .catch(() => undefined)
    .then(operation);
  capturesRootOperationQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

export class CapturesLocationFallbackError extends Error {
  readonly pwrSnapError: PwrSnapError;

  constructor(error: PwrSnapError) {
    super(error.message);
    this.name = "CapturesLocationFallbackError";
    this.pwrSnapError = error;
  }
}

type FallbackOutcome =
  | { kind: "not-applicable" }
  | { kind: "switched" }
  | { kind: "failed"; error: PwrSnapError };

function pathIsInsideRoot(path: string, root: string): boolean {
  const delta = relative(root, path);
  return (
    delta === "" ||
    (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
  );
}

/** Permission-denial errors from `open`/`rename` normally carry `path` and
 *  sometimes `dest`. If a platform omits both, the caller's operation is
 *  already scoped to `failedRoot`, so the errno classification is enough. */
function denialTargetsRoot(cause: unknown, root: string): boolean {
  if (!isPermissionDenial(cause)) return false;
  if (typeof cause !== "object" || cause === null) return false;
  const fsError = cause as NodeJS.ErrnoException & { dest?: unknown };
  const candidates = [fsError.path, fsError.dest].filter(
    (value): value is string => typeof value === "string"
  );
  return candidates.length === 0 || candidates.some((path) => pathIsInsideRoot(path, root));
}

async function persistHomeFallback(): Promise<
  { ok: true } | { ok: false; error: PwrSnapError }
> {
  if (getCapturesLocation() === "home") return { ok: true };
  if (fallbackSwitchPromise !== null) return fallbackSwitchPromise;

  const task = (async (): Promise<
    { ok: true } | { ok: false; error: PwrSnapError }
  > => {
    const written = await bus.dispatch(
      "settings:write",
      { storage: { capturesLocation: "home" } },
      // `capturesLocation` is main-owned: settings:write rejects this field
      // from renderer/RPC/MCP callers so the guarded switch-back command
      // cannot be bypassed. `bridge` marks an internal dispatch and also
      // survives forwarding in split mode.
      { principal: "bridge" }
    );
    if (!written.ok) {
      return {
        ok: false,
        error: {
          kind: "capture",
          code: "captures_fallback_failed",
          message:
            "PwrSnap couldn't remember its fallback captures folder, so it did not risk splitting your library across two locations.",
          cause: written.error
        }
      };
    }
    // The settings broadcast updates this in ordinary boots, but capture
    // fallback also runs in E2E/profiling modes where the broader settings
    // listener may not be installed. Switch synchronously before retrying.
    setCapturesLocation("home");
    log.warn(
      `Documents access denied — switched new captures to ${capturesFolderDisplayPath(
        process.platform,
        "home"
      )}`
    );
    return { ok: true };
  })();

  fallbackSwitchPromise = task;
  try {
    return await task;
  } finally {
    if (fallbackSwitchPromise === task) fallbackSwitchPromise = null;
  }
}

async function fallbackAfterDocumentsDenial(
  failedRoot: string,
  cause: unknown
): Promise<FallbackOutcome> {
  const documentsRoot = getCapturesRootForLocation("documents");
  if (
    isOverriddenDataRoot() ||
    failedRoot !== documentsRoot ||
    !denialTargetsRoot(cause, documentsRoot)
  ) {
    return { kind: "not-applicable" };
  }
  rootAccessStates.set(documentsRoot, "denied");

  // A concurrent capture may have completed the switch after this caller's
  // Documents write failed. In that case it should simply retry at home.
  if (getCapturesLocation() === "home") return { kind: "switched" };

  const switched = await persistHomeFallback();
  return switched.ok
    ? { kind: "switched" }
    : { kind: "failed", error: switched.error };
}

/**
 * Run a REAL capture persistence operation at the active root. If and only if
 * a Documents-scoped EPERM/EACCES escapes the operation, persist the sticky
 * home choice and retry once at ~/PwrSnap. This closes the hole left by the
 * preflight probe's per-session cache (Documents can be revoked later).
 */
export async function runWithCapturesDirFallback<T>(
  operation: (root: string) => Promise<T>
): Promise<T> {
  return runExclusiveCapturesRootOperation(async () => {
    const firstRoot = getCapturesRoot();
    try {
      return await operation(firstRoot);
    } catch (cause) {
      const fallback = await fallbackAfterDocumentsDenial(firstRoot, cause);
      if (fallback.kind === "not-applicable") throw cause;
      if (fallback.kind === "failed") {
        throw new CapturesLocationFallbackError(fallback.error);
      }
      return operation(getCapturesRoot());
    }
  });
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
 *
 * `opts.force` bypasses the per-session cache — the Settings "Check
 * access" button passes it so the user always gets a genuine re-probe
 * (which also re-triggers the OS prompt if macOS has no decision on file).
 */
export async function ensureCapturesDirReady(
  opts: {
    force?: boolean | undefined;
    location?: CapturesLocation | undefined;
    fallbackOnDenial?: boolean | undefined;
    platform?: string | undefined;
  } = {}
): Promise<Result<never, PwrSnapError> | null> {
  const platform = opts.platform ?? process.platform;
  const location = opts.location ?? getCapturesLocation();
  const root = getCapturesRootForLocation(location);
  if (!opts.force && rootAccessStates.get(root) === "confirmed") return null;

  const probe = join(root, PROBE_NAME);
  try {
    // mkdir first so the probe write has a parent (and so a never-created
    // captures dir prompts here too). Then a REAL write — the only thing
    // that reliably forces the Documents TCC prompt when the dir already
    // exists. Delete the probe immediately (best-effort).
    await mkdir(root, { recursive: true });
    await writeFile(probe, "");
    await rm(probe, { force: true }).catch(() => undefined);
    rootAccessStates.set(root, "confirmed");
    return null;
  } catch (cause) {
    const denied = isPermissionDenial(cause);
    if (denied) rootAccessStates.set(root, "denied");
    log.warn("ensureCapturesDirReady: captures folder not writable", {
      root,
      denied,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    // Best-effort cleanup in case the write landed but a later step threw.
    await rm(probe, { force: true }).catch(() => undefined);
    if (denied && location === "documents" && opts.fallbackOnDenial !== false) {
      const fallback = await fallbackAfterDocumentsDenial(root, cause);
      if (fallback.kind === "switched") {
        // Confirm the fallback root before showing any capture UI. Force the
        // probe because Documents and home have independent session states.
        return ensureCapturesDirReady({
          force: true,
          location: "home",
          fallbackOnDenial: false,
          platform
        });
      }
      if (fallback.kind === "failed") return err(fallback.error);
    }
    return err({
      kind: "capture",
      code: denied ? "captures_dir_denied" : "captures_dir_unwritable",
      message: denied
        ? capturesDirectoryDeniedMessage(location, platform)
        : `PwrSnap couldn't write to its captures folder (${root}). Make sure it's writable, then capture again.`,
      cause
    });
  }
}

export function capturesDirectoryDeniedMessage(
  location: CapturesLocation,
  platform: string
): string {
  if (location === "home") {
    return `PwrSnap couldn't write to its fallback folder (${capturesFolderDisplayPath(
      platform,
      "home"
    )}). Make sure your home folder is writable, then capture again.`;
  }
  if (platform === "darwin") {
    return "PwrSnap needs access to your Documents folder to save captures. Allow it in System Settings → Privacy & Security → Files & Folders → Documents, then capture again.";
  }
  if (platform === "win32") {
    return "Windows blocked PwrSnap from writing to Documents. Allow PwrSnap through Controlled Folder Access or antivirus protection, and check OneDrive folder permissions, then capture again.";
  }
  return "PwrSnap couldn't write to Documents. Check the folder permissions or sandbox access, then capture again.";
}
