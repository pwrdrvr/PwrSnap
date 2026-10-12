// The clipboard's type names, listed without reading a single byte.
//
// A clipboard item from another device (Universal Clipboard) or a
// remote-desktop client is promised data: macOS lists its types and
// fetches a flavor's bytes, across the network, only when an app asks for
// them. Anything PwrSnap runs on its own, without the user asking to paste,
// may ask for types and nothing else.
//
// Electron 44 has no API that does that. Measured on macOS 26 against a
// pasteboard item whose every flavor was promised (an
// NSPasteboardItemDataProvider that logs each request):
//
//   • `clipboard.read()` and `clipboard.has()` fetch `public.url` and
//     `public.url-name` whenever they are listed. Electron probes for a
//     bookmark with Chromium's `ReadURL` on every enumeration. They also
//     fetch `org.w3.web-custom-format.map` to list W3C custom formats.
//   • `NSPasteboard.types` fetched nothing, for an image, a web link, a
//     Finder file, Chromium's custom data, W3C custom formats, plain text and
//     an image beside a file URL.
//
// So macOS lists types through AppKit, in the `--list-types` mode of the
// pasteboard helper PwrSnap already ships. On Windows, Chromium's `ReadURL`
// is a `GetClipboardData(CFSTR_INETURLW)` on every enumeration, which renders
// a delay-rendered (remote-desktop) format, and there is no measured
// types-only path there or on Linux. Those platforms get null: no listing.

import { execFile } from "node:child_process";
import { getMainLogger } from "../log";
import { resolvePasteboardWriterPath } from "./named-image-pasteboard";

const log = getMainLogger("pwrsnap:pasteboard-types");

// NSPasteboard can block inside pboard indefinitely; see
// named-image-pasteboard.ts. A menu hint is not worth waiting long for.
const LIST_TYPES_TIMEOUT_MS = 3_000;
const LIST_TYPES_MAX_BUFFER = 256 * 1024;

let warnedNoHelper = false;

/**
 * Every type name on the clipboard, read without fetching any flavor's
 * bytes. Null where no such listing exists (every platform but macOS) or
 * the listing failed. A caller must treat null as "unknown", never as
 * "empty".
 */
export async function listClipboardTypesWithoutReading(
  platform: NodeJS.Platform = process.platform
): Promise<string[] | null> {
  if (platform !== "darwin") return null;
  const helperPath = resolvePasteboardWriterPath();
  if (helperPath === null) {
    if (!warnedNoHelper) {
      warnedNoHelper = true;
      log.warn("pasteboard helper not found; clipboard types are unknown");
    }
    return null;
  }

  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        helperPath,
        ["--list-types"],
        {
          timeout: LIST_TYPES_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: LIST_TYPES_MAX_BUFFER,
          encoding: "utf8"
        },
        (error, out) => (error === null ? resolve(out) : reject(error))
      );
    });
  } catch (cause) {
    const failure = cause as { killed?: boolean; code?: string | number | null; signal?: string | null };
    log.warn("listing clipboard types failed", {
      timedOut: failure.killed === true,
      exitCode: failure.code ?? null,
      signal: failure.signal ?? null
    });
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed) && parsed.every((type) => typeof type === "string")) {
      return parsed;
    }
  } catch {
    // Reported below.
  }
  log.warn("pasteboard helper listed clipboard types in an unexpected shape");
  return null;
}
