// Windows Explorer file-ingest boundary.
//
// Explorer copies existing files through the predefined numeric CF_HDROP
// format. Electron's string-based readBuffer API cannot reliably address that
// predefined format, so the bundled PwrSnapWindowList.exe helper reads it with
// DragQueryFileW and emits a small verified JSON envelope. This module owns the
// no-shell spawn, acknowledgement validation, and one fully-qualified image
// selection contract consumed by capture:pasteFromClipboard. The shared paste
// safety validator owns all on-disk checks immediately before the file read.

import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from "node:child_process";
import { extname, win32 } from "node:path";
import { resolveWindowListHelperPath } from "../capture/window-list";

const HELPER_TIMEOUT_MS = 5_000;
const MAX_HELPER_OUTPUT_BYTES = 1024 * 1024;

const IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp"
]);

type WindowsClipboardFilesAck = {
  ok: true;
  format: "CF_HDROP";
  files: string[];
};

type SpawnClipboardReader = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export type WindowsClipboardImageErrorCode =
  | "clipboard_read_failed"
  | "multiple_files"
  | "invalid_file_path"
  | "not_image_file"
  | "clipboard_file_unavailable";

export type WindowsClipboardImageReadResult =
  | { ok: true; path: string | null }
  | {
      ok: false;
      error: {
        code: WindowsClipboardImageErrorCode;
        message: string;
        /** Selection errors must not silently fall back to a bitmap flavor. */
        terminal: boolean;
        cause?: unknown;
      };
    };

class WindowsClipboardImageError extends Error {
  readonly code: WindowsClipboardImageErrorCode;
  readonly terminal: boolean;

  constructor(
    code: WindowsClipboardImageErrorCode,
    message: string,
    options: { terminal: boolean; cause?: unknown }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WindowsClipboardImageError";
    this.code = code;
    this.terminal = options.terminal;
  }
}

/** Path-only image check shared with the existing macOS file-URL fallback. */
export function isSupportedClipboardImagePath(filePath: string): boolean {
  const extension = isFullyQualifiedWindowsPath(filePath)
    ? win32.extname(filePath)
    : extname(filePath);
  return IMAGE_FILE_EXTENSIONS.has(extension.toLowerCase());
}

/**
 * Synchronous menu-enablement hint only. The actual paste command always asks
 * the native helper and validates its paths. No CF_HDROP bytes are read here.
 */
export function windowsClipboardFormatsMayContainFiles(
  formats: readonly string[],
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "win32") return false;
  return formats.some((format) => {
    const normalized = format.trim().toLowerCase();
    // Chromium exposes Explorer's CF_HDROP as text/uri-list on current
    // Electron releases. This remains an enablement hint only: the command
    // never reads that representation and asks the native helper for format
    // 15 directly.
    return (
      normalized === "cf_hdrop" ||
      normalized === "text/uri-list" ||
      normalized === "filenamew" ||
      normalized === "filename"
    );
  });
}

function parseHelperAck(stdout: string): WindowsClipboardFilesAck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (cause) {
    throw new WindowsClipboardImageError(
      "clipboard_read_failed",
      "Windows clipboard helper returned invalid JSON",
      { terminal: false, cause }
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Partial<WindowsClipboardFilesAck>).ok !== true ||
    (parsed as Partial<WindowsClipboardFilesAck>).format !== "CF_HDROP" ||
    !Array.isArray((parsed as Partial<WindowsClipboardFilesAck>).files) ||
    !(parsed as Partial<WindowsClipboardFilesAck>).files!.every(
      (path): path is string => typeof path === "string" && path.length > 0 && !path.includes("\0")
    )
  ) {
    throw new WindowsClipboardImageError(
      "clipboard_read_failed",
      "Windows clipboard helper returned an invalid CF_HDROP acknowledgement",
      { terminal: false }
    );
  }
  return parsed as WindowsClipboardFilesAck;
}

/** Invoke `--read-file-clipboard` without a command shell and require JSON. */
export async function runWindowsClipboardFileReader(
  helperPath: string,
  spawnReader: SpawnClipboardReader = spawn
): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnReader(helperPath, ["--read-file-clipboard"], {
        shell: false,
        windowsHide: true
      });
    } catch (cause) {
      reject(
        new WindowsClipboardImageError(
          "clipboard_read_failed",
          "Windows clipboard helper could not be started",
          { terminal: false, cause }
        )
      );
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
    const failForOversizedOutput = (): void => {
      try {
        child.kill();
      } catch {
        // The bounded-output failure below is already authoritative.
      }
      finish(() =>
        reject(
          new WindowsClipboardImageError(
            "clipboard_read_failed",
            "Windows clipboard helper returned too much data",
            { terminal: false }
          )
        )
      );
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best effort: timeout is already a hard failure for this read.
      }
      finish(() =>
        reject(
          new WindowsClipboardImageError(
            "clipboard_read_failed",
            "Windows clipboard helper timed out",
            { terminal: false }
          )
        )
      );
    }, HELPER_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
        failForOversizedOutput();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
        failForOversizedOutput();
      }
    });
    child.on("error", (cause) => {
      finish(() =>
        reject(
          new WindowsClipboardImageError(
            "clipboard_read_failed",
            "Windows clipboard helper failed",
            { terminal: false, cause }
          )
        )
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          const detail = stderr.trim().slice(0, 500);
          reject(
            new WindowsClipboardImageError(
              "clipboard_read_failed",
              `Windows clipboard helper exited with code ${String(code)}${
                detail.length > 0 ? `: ${detail}` : ""
              }`,
              { terminal: false }
            )
          );
          return;
        }
        try {
          resolve(parseHelperAck(stdout).files);
        } catch (cause) {
          reject(cause);
        }
      });
    });
    child.stdin.end();
  });
}

function isFullyQualifiedWindowsPath(filePath: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return true;
  // Standard UNC only: \\server\share\path. Device namespaces (\\?\ / \\.\)
  // are intentionally outside the renderer-triggered paste contract.
  return /^\\\\(?![?.][\\/])[^\\/]+[\\/][^\\/]+[\\/]/.test(filePath);
}

/**
 * Enforce the Windows selection shape before the caller reaches the shared
 * on-disk safety gate. Existence, regular-file, symlink/junction, and
 * privileged-parent checks deliberately belong to `assertSafePastedFile`,
 * which is applied to Windows CF_HDROP and file-URL inputs together in the
 * capture handler.
 */
export async function validateWindowsClipboardImageFiles(
  files: readonly string[]
): Promise<string | null> {
  if (files.length === 0) return null;
  if (files.length !== 1) {
    throw new WindowsClipboardImageError(
      "multiple_files",
      `PwrSnap can paste one image file at a time; the clipboard contains ${files.length} files.`,
      { terminal: true }
    );
  }

  const filePath = files[0]!;
  if (!isFullyQualifiedWindowsPath(filePath)) {
    throw new WindowsClipboardImageError(
      "invalid_file_path",
      "The Windows clipboard returned a file path that is not fully qualified.",
      { terminal: true }
    );
  }
  if (!isSupportedClipboardImagePath(filePath)) {
    throw new WindowsClipboardImageError(
      "not_image_file",
      `The copied file is not a supported image: ${win32.basename(filePath)}`,
      { terminal: true }
    );
  }

  return filePath;
}

export async function readWindowsClipboardImageFile(options: {
  platform?: NodeJS.Platform;
  helperPath?: string | null;
  spawnReader?: SpawnClipboardReader;
} = {}): Promise<WindowsClipboardImageReadResult> {
  if ((options.platform ?? process.platform) !== "win32") {
    return { ok: true, path: null };
  }

  const helperPath =
    options.helperPath === undefined ? resolveWindowListHelperPath() : options.helperPath;
  if (helperPath === null) {
    return {
      ok: false,
      error: {
        code: "clipboard_read_failed",
        message:
          "Windows file clipboard helper is unavailable; reinstall PwrSnap or rebuild native helpers.",
        terminal: false
      }
    };
  }

  try {
    const files = await runWindowsClipboardFileReader(helperPath, options.spawnReader ?? spawn);
    const path = await validateWindowsClipboardImageFiles(files);
    return { ok: true, path };
  } catch (cause) {
    if (cause instanceof WindowsClipboardImageError) {
      return {
        ok: false,
        error: {
          code: cause.code,
          message: cause.message,
          terminal: cause.terminal,
          ...(cause.cause !== undefined ? { cause: cause.cause } : {})
        }
      };
    }
    return {
      ok: false,
      error: {
        code: "clipboard_read_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        terminal: false,
        cause
      }
    };
  }
}
