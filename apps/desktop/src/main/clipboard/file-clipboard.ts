// Cross-platform "copy this exported file" clipboard boundary.
//
// macOS represents an existing file with the `public.file-url` pasteboard
// type. Windows does NOT: Explorer and attachment-aware paste targets consume
// the predefined numeric CF_HDROP format (id 15), whose HGLOBAL contains a
// DROPFILES header followed by fully-qualified UTF-16 paths. Electron's
// `clipboard.writeBuffer(format: string, ...)` can register a named custom
// format, but it cannot address that predefined numeric format. The bundled
// native helper therefore owns the Windows write and verifies it with
// DragQueryFileW before acknowledging success.

import { clipboard } from "electron";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:file-clipboard");

const WINDOWS_PRODUCTION_HELPER = "PwrSnapWindowList.exe";
const WINDOWS_DEV_HELPER = "window-list.exe";
const WINDOWS_HELPER_TIMEOUT_MS = 10_000;

type FileClipboardAck = {
  ok: true;
  format: "CF_HDROP";
  files: 1;
  dropEffect: "copy";
};

type ClipboardBufferApi = Pick<
  typeof clipboard,
  "availableFormats" | "readBuffer" | "writeBuffer"
>;

type SpawnFileClipboardHelper = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

let windowsHelperForTests: string | null = null;

/**
 * Test seam for exercising the spawn/ack protocol without touching the real
 * Windows clipboard. Production resolution is restored by passing `null`.
 */
export function __setWindowsFileClipboardHelperForTests(path: string | null): void {
  windowsHelperForTests = path;
}

/**
 * Build Windows helper candidates with `path.win32` explicitly. Tests run on
 * macOS/Linux too, so relying on the host's path implementation would turn a
 * drive path or UNC share into a misleading POSIX-shaped string.
 */
export function windowsFileClipboardHelperCandidates(args: {
  resourcesPath?: string;
  moduleDir: string;
}): string[] {
  const candidates: string[] = [];
  if (args.resourcesPath !== undefined && args.resourcesPath.length > 0) {
    candidates.push(win32.join(args.resourcesPath, WINDOWS_PRODUCTION_HELPER));
  }
  candidates.push(
    win32.resolve(
      args.moduleDir,
      "..",
      "..",
      "build",
      "native",
      WINDOWS_DEV_HELPER
    )
  );
  return [...new Set(candidates)];
}

function resolveWindowsHelper(): string | null {
  if (windowsHelperForTests !== null) return windowsHelperForTests;

  const candidates = windowsFileClipboardHelperCandidates({
    moduleDir: __dirname,
    ...(typeof process.resourcesPath === "string" && process.resourcesPath.length > 0
      ? { resourcesPath: process.resourcesPath }
      : {})
  });
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function assertClipboardFile(filePath: string): Promise<void> {
  let info;
  try {
    info = await stat(filePath);
  } catch (cause) {
    throw new Error(`Cannot copy missing export file to the clipboard: ${filePath}`, {
      cause
    });
  }
  if (!info.isFile()) {
    throw new Error(`Cannot copy a non-file path to the clipboard: ${filePath}`);
  }
  if (info.size <= 0) {
    throw new Error(`Cannot copy an empty export file to the clipboard: ${filePath}`);
  }
}

/**
 * macOS existing-file write with a synchronous readback. A successful API
 * call alone is insufficient: returning success after an empty pasteboard is
 * precisely the Windows regression this abstraction is intended to prevent.
 */
export function writeMacFileToClipboard(
  filePath: string,
  clipboardApi: ClipboardBufferApi = clipboard
): void {
  const expected = Buffer.from(pathToFileURL(filePath).toString(), "utf8");
  clipboardApi.writeBuffer("public.file-url", expected);

  const formats = clipboardApi.availableFormats();
  const actual = clipboardApi.readBuffer("public.file-url");
  if (!formats.includes("public.file-url") || actual.length === 0 || !actual.equals(expected)) {
    throw new Error("macOS clipboard did not retain the exported file URL");
  }
}

function parseWindowsAck(stdout: string): FileClipboardAck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (cause) {
    throw new Error("Windows clipboard helper returned an invalid acknowledgement", {
      cause
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Partial<FileClipboardAck>).ok !== true ||
    (parsed as Partial<FileClipboardAck>).format !== "CF_HDROP" ||
    (parsed as Partial<FileClipboardAck>).files !== 1 ||
    (parsed as Partial<FileClipboardAck>).dropEffect !== "copy"
  ) {
    throw new Error("Windows clipboard helper did not verify a CF_HDROP file copy");
  }
  return parsed as FileClipboardAck;
}

/**
 * Invoke the bundled helper without a shell so spaces, drive letters, UNC
 * prefixes, ampersands, and other command-shell characters remain one exact
 * argv value. Exit 0 is not enough: the helper must emit the acknowledgement
 * it produces only after reading CF_HDROP back through DragQueryFileW.
 */
export async function runWindowsFileClipboardHelper(
  helperPath: string,
  filePath: string,
  spawnHelper: SpawnFileClipboardHelper = spawn
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnHelper(helperPath, ["--write-file-clipboard", filePath], {
        shell: false,
        windowsHide: true
      });
    } catch (cause) {
      reject(new Error("Windows clipboard helper could not be started", { cause }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best effort: timeout is already a hard failure for the command.
      }
      finish(() => reject(new Error("Windows clipboard helper timed out")));
    }, WINDOWS_HELPER_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      finish(() => reject(new Error("Windows clipboard helper failed", { cause })));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          const detail = stderr.trim().slice(0, 500);
          reject(
            new Error(
              `Windows clipboard helper exited with code ${String(code)}${
                detail.length > 0 ? `: ${detail}` : ""
              }`
            )
          );
          return;
        }
        try {
          parseWindowsAck(stdout);
          resolve();
        } catch (cause) {
          reject(cause);
        }
      });
    });
    child.stdin.end();
  });
}

/** Copy one validated exported file using the platform's native file flavor. */
export async function writeFileToClipboard(filePath: string): Promise<void> {
  await assertClipboardFile(filePath);

  if (process.platform === "darwin") {
    writeMacFileToClipboard(filePath);
    return;
  }
  if (process.platform === "win32") {
    const helper = resolveWindowsHelper();
    if (helper === null) {
      throw new Error(
        "Windows file clipboard helper is unavailable; reinstall PwrSnap or rebuild native helpers"
      );
    }
    await runWindowsFileClipboardHelper(helper, filePath);
    return;
  }

  log.warn("file clipboard is unsupported on this platform", {
    platform: process.platform,
    path: filePath
  });
  throw new Error(`Copying exported files is unsupported on ${process.platform}`);
}
