import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { getMainLogger } from "../log";
import { PasteboardTimeoutError } from "./pasteboard-timeout";

const execFileAsync = promisify(execFile);
const log = getMainLogger("pwrsnap:named-image-pasteboard");

const PRODUCTION_HELPER_NAME = "PwrSnapPasteboardWriter";
const DEV_HELPER_NAME = "pasteboard-writer";

let cachedHelperPath: string | null | undefined;
let helperPathForTests: string | null = null;

/**
 * Test seam: force a specific helper binary (e.g. an argv-recording fake
 * script) so the spawn plumbing can be unit-tested without touching the
 * real pasteboard. Pass `null` to clear. Bypasses the Vitest
 * auto-resolution guard below — same pattern as native-clipboard.ts.
 */
export function __setNamedImagePasteboardHelperForTests(path: string | null): void {
  helperPathForTests = path;
  cachedHelperPath = undefined;
}

function resolvePasteboardWriterPath(): string | null {
  if (helperPathForTests !== null) return helperPathForTests;
  // Unit tests must never touch the developer's real system pasteboard —
  // gate auto-resolution off under Vitest (see native-clipboard.ts).
  if (process.env.VITEST !== undefined) return null;
  if (cachedHelperPath !== undefined) return cachedHelperPath;
  if (process.platform !== "darwin") {
    cachedHelperPath = null;
    return null;
  }

  const candidates = [join(__dirname, "..", "..", "build", "native", DEV_HELPER_NAME)];
  if (typeof process.resourcesPath === "string") {
    candidates.unshift(join(process.resourcesPath, PRODUCTION_HELPER_NAME));
  }
  try {
    candidates.push(join(app.getAppPath(), "build", "native", DEV_HELPER_NAME));
  } catch {
    // app.getAppPath can be unavailable before ready in some test harnesses.
  }

  cachedHelperPath = candidates.find((candidate) => existsSync(candidate)) ?? null;
  return cachedHelperPath;
}

export async function writeNamedPngToPasteboard(args: {
  pngPath: string;
  fileUrlPath: string;
  /** Optional JSON written as the private `com.pwrdrvr.pwrsnap.clip-meta`
   *  flavor on the same pasteboard item — a diagnostics marker so tools
   *  like PbScope can attribute the write to PwrSnap and correlate a
   *  specific copy with what a remote Mac receives. */
  metaJson?: string;
}): Promise<boolean> {
  const helperPath = resolvePasteboardWriterPath();
  if (helperPath === null) return false;

  const startedAt = Date.now();
  let helperPid: number | undefined;
  try {
    const helperArgs = ["--png", args.pngPath, "--file-url", args.fileUrlPath];
    if (args.metaJson !== undefined && args.metaJson.length > 0) {
      helperArgs.push("--meta", args.metaJson);
    }
    // NSPasteboard can block inside pboard indefinitely. Kill the one-shot
    // writer so it cannot complete a stale copy later, and keep that failure
    // out of the synchronous Electron fallback on the main thread.
    const execution = execFileAsync(helperPath, helperArgs, { timeout: 10_000, killSignal: "SIGKILL" });
    helperPid = execution.child.pid;
    await execution;
    return true;
  } catch (cause) {
    const failure = cause as { killed?: boolean; signal?: string; code?: string | number | null };
    const timedOut = failure.killed === true && failure.signal === "SIGKILL" && failure.code === null;
    const diagnostics = {
      helperPid,
      elapsedMs: Date.now() - startedAt,
      timedOut,
      exitCode: failure.code ?? null,
      signal: failure.signal ?? null
    };
    if (timedOut) {
      log.warn("named image pasteboard helper timed out; skipping Electron fallback", diagnostics);
      throw new PasteboardTimeoutError(cause);
    }
    log.warn("named image pasteboard helper failed; falling back to Electron image clipboard", diagnostics);
    return false;
  }
}
