// Native multi-format clipboard write — the one place PwrSnap performs
// a SINGLE NSPasteboard write that declares BOTH the private layer-
// fragment UTI and a flattened image (`public.png`; macOS lazily offers
// `public.tiff` from it for consumers that ask for TIFF).
//
// Why this exists: Electron cannot co-write a custom UTI and a standard
// image atomically. Every `clipboard.write*` call wraps a
// ScopedClipboardWriter that calls `[pasteboard clearContents]` on
// construction, so a `writeImage` after a `writeBuffer` wipes the
// buffer (and vice-versa), and `clipboard.write({...})` only accepts
// text/html/image/rtf/bookmark — no arbitrary UTIs. So an editor layer
// copy could previously carry EITHER the private fragment (PwrSnap→
// PwrSnap fidelity) OR a PNG (paste into Slack / Mail / Claude /
// Messages), never both. This module shells the bundled native helper
// with `--write-clipboard`, handing the bodies as base64 JSON on stdin;
// the helper performs one `declareTypes` + `setData` pass so the
// private UTI and the image coexist on the pasteboard. See
// `native/window-list/main.swift`'s `--write-clipboard` block.
//
// macOS-only (NSPasteboard). On every other platform — and when the
// helper binary hasn't been built yet — `writeMultiFormatClipboard`
// returns `false` and the caller falls back to Electron's
// `writeBuffer` (private UTI only), preserving PwrSnap→PwrSnap
// fidelity at the cost of the cross-app image co-write.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:native-clipboard");

// The `--write-clipboard` subcommand lives in the SAME native CLI used
// by `capture/window-list.ts`. These names must stay in sync with that
// module's PRODUCTION_HELPER_NAME / DEV_HELPER_NAME. Resolution is
// duplicated here (rather than imported) so this module never imports
// the electron `app` object — keeping it import-safe under Vitest,
// where `app` / `process.resourcesPath` are absent.
const PRODUCTION_HELPER_NAME = "PwrSnapWindowList";
const DEV_HELPER_NAME = "window-list";

let cachedHelperPath: string | null = null;
let helperPathForTests: string | null = null;

/**
 * Test seam: force a specific helper binary (e.g. a fake stdin-reading
 * script) so the spawn / stdin / exit-code plumbing can be unit-tested
 * without a real pasteboard. Pass `null` to clear. Bypasses the Vitest
 * auto-resolution guard below.
 */
export function __setNativeClipboardHelperForTests(path: string | null): void {
  helperPathForTests = path;
  cachedHelperPath = null;
}

function resolveHelperBinary(): string | null {
  if (helperPathForTests !== null) return helperPathForTests;

  // Unit tests must never touch the developer's real system pasteboard.
  // The dev path below can legitimately resolve to
  // apps/desktop/build/native/window-list on a machine where the helper
  // is built, and a Vitest worker's __dirname can land there too, so
  // gate auto-resolution off under Vitest. Production / `pnpm dev` are
  // unaffected — VITEST is unset there. Tests that DO want to exercise
  // the spawn path inject a fake via __setNativeClipboardHelperForTests.
  if (process.env.VITEST !== undefined) return null;

  // NSPasteboard is macOS-only. The Windows window-list.exe is
  // list-only and has no `--write-clipboard` subcommand.
  if (process.platform !== "darwin") return null;
  if (cachedHelperPath !== null) return cachedHelperPath;

  // Production: Contents/Resources/PwrSnapWindowList. `resourcesPath`
  // is undefined outside Electron — guard before join().
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    const productionPath = join(process.resourcesPath, PRODUCTION_HELPER_NAME);
    if (existsSync(productionPath)) {
      cachedHelperPath = productionPath;
      return productionPath;
    }
  }

  // Dev: apps/desktop/build/native/window-list. __dirname after the
  // electron-vite build is apps/desktop/out/main, so the native build
  // dir is two levels up — matching capture/window-list.ts.
  const devPath = join(__dirname, "..", "..", "build", "native", DEV_HELPER_NAME);
  if (existsSync(devPath)) {
    cachedHelperPath = devPath;
    return devPath;
  }
  return null;
}

export type MultiFormatClipboardPayload = {
  /** Private UTI for the layer-fragment bytes (e.g.
   *  `com.pwrdrvr.pwrsnap.layer-fragment`). */
  utiName: string;
  /** Serialized layer-fragment body — written under `utiName`. */
  utiBytes: Buffer;
  /** Flattened composite PNG. Optional, but in practice always present;
   *  without it the helper writes a UTI-only payload. */
  pngBytes?: Buffer;
  /** Flattened composite TIFF. Normally omitted: macOS lazily
   *  synthesizes `public.tiff` from the co-written `public.png` for apps
   *  that request TIFF, so the helper doesn't eagerly write a large
   *  uncompressed one. Supply only to force specific (e.g. compressed)
   *  TIFF bytes. */
  tiffBytes?: Buffer;
};

/**
 * Perform a single multi-type pasteboard write via the native helper.
 *
 * Resolves `true` when the helper performed the write, `false` when it
 * is unavailable (non-macOS, helper not built, Vitest) or failed — in
 * which case the caller should fall back to `clipboard.writeBuffer` so
 * at least the private UTI lands. Never throws and never rejects.
 */
export async function writeMultiFormatClipboard(
  payload: MultiFormatClipboardPayload
): Promise<boolean> {
  const helper = resolveHelperBinary();
  if (helper === null) return false;

  const request = JSON.stringify({
    utiName: payload.utiName,
    utiBase64: payload.utiBytes.toString("base64"),
    pngBase64: payload.pngBytes?.toString("base64"),
    tiffBase64: payload.tiffBytes?.toString("base64")
  });

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(helper, ["--write-clipboard"], {
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (cause) {
      log.warn("native clipboard helper spawn threw", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      settle(false);
      return;
    }

    let stderr = "";
    // Generous bound: the write itself is sub-millisecond, but a
    // multi-MB PNG has to travel over stdin first. Kill + fall back if
    // the helper wedges.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      log.warn("native clipboard helper timed out");
      settle(false);
    }, 10_000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Drain stdout (the helper only prints a tiny `{"ok":true}` ack, which
    // we don't read — we key off the exit code). Leaving a `pipe`d stdout
    // undrained would let the OS pipe buffer back-pressure the child if it
    // ever became chatty on stdout while we're still pushing the multi-MB
    // stdin. resume() puts it in flowing mode and discards the bytes.
    child.stdout.resume();
    child.on("error", (cause) => {
      clearTimeout(timer);
      log.warn("native clipboard helper errored", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      settle(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        settle(true);
        return;
      }
      log.warn("native clipboard helper exited non-zero", {
        code,
        stderr: stderr.trim().slice(0, 200)
      });
      settle(false);
    });

    // EPIPE if the child died before reading stdin — the exit / error
    // handlers above settle the promise, so swallow the async error here.
    child.stdin.on("error", () => undefined);
    // write()/end() can ALSO throw synchronously (e.g. ERR_STREAM_DESTROYED
    // if the child exited between spawn and this line). Guard it so the
    // executor never throws — a rejected promise here would bypass the
    // caller's writeBuffer fallback and fail the copy outright.
    try {
      child.stdin.write(request);
      child.stdin.end();
    } catch (cause) {
      log.warn("native clipboard helper stdin write threw", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      settle(false);
    }
  });
}
