// The PNG on the macOS general pasteboard, read through AppKit instead of
// Electron. For the E2E bridge only.
//
// Electron 44's `clipboard.read()` cannot see the image a PwrSnap copy
// writes. Every copy puts `public.png` and `public.file-url` on one
// pasteboard item (clipboard/named-image-pasteboard.ts), and two rules
// then hide the PNG:
//
//   • Chromium's `ClipboardMac::GetStandardFormats` reports `image/png`
//     only when no file URL is present. Finder's Cmd+C puts a file's icon
//     beside the file (crbug.com/553686), so an image next to a file is
//     treated as that icon.
//   • Electron drops `public.png` from the raw `osclipboard` formats it
//     lists, because PNG is a standard format.
//
// Pre-44 `clipboard.readImage()` read the PNG regardless. Production paste
// does not need this: it falls back to the file URL and loads that file.
// The specs do need it, because what they assert is the pasteboard PNG
// that other apps receive.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const READ_PNG_SCRIPT = `ObjC.import("AppKit");
const data = $.NSPasteboard.generalPasteboard.dataForType("public.png");
data.isNil() ? "" : data.base64EncodedStringWithOptions(0).js;`;

/** The general pasteboard's `public.png` bytes, or null when it has none. */
export async function readMacPasteboardPng(): Promise<Buffer | null> {
  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", READ_PNG_SCRIPT],
    { timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024 }
  );
  const base64 = stdout.trim();
  return base64.length === 0 ? null : Buffer.from(base64, "base64");
}
