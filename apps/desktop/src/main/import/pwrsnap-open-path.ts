import { posix, win32 } from "node:path";

export type OpenPathPlatform = "darwin" | "linux" | "win32";

export class InvalidPwrsnapOpenPathError extends Error {
  readonly code:
    | "empty_path"
    | "file_url_not_supported"
    | "device_path_not_supported"
    | "drive_relative_path_not_supported"
    | "relative_path_not_supported"
    | "noncanonical_path"
    | "not_a_pwrsnap_file";

  constructor(code: InvalidPwrsnapOpenPathError["code"], message: string) {
    super(message);
    this.name = "InvalidPwrsnapOpenPathError";
    this.code = code;
  }
}

/**
 * Normalize a native path delivered by Electron's open-file/argv surfaces.
 *
 * Electron delivers filesystem paths, not file URLs. Keeping that contract
 * explicit avoids the two dangerous failure modes of accepting URL syntax:
 * percent-decoding can change path segments, and `file://host/...` means a UNC
 * authority on Windows but not on POSIX. Windows drive and UNC paths are
 * accepted as native paths; device namespaces are intentionally rejected.
 */
export function normalizePwrsnapOpenPath(
  input: string,
  options: {
    platform?: OpenPathPlatform | undefined;
    cwd?: string | undefined;
  } = {}
): string {
  if (input.length === 0 || input.includes("\0")) {
    throw new InvalidPwrsnapOpenPathError("empty_path", "The open-file path is empty or invalid.");
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    throw new InvalidPwrsnapOpenPathError(
      "file_url_not_supported",
      "PwrSnap expects a native filesystem path, not a URL."
    );
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return normalizeWindowsPath(input, options.cwd);
  }
  return normalizePosixPath(input, options.cwd);
}

function normalizeWindowsPath(input: string, cwd: string | undefined): string {
  if (/^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(input)) {
    throw new InvalidPwrsnapOpenPathError(
      "device_path_not_supported",
      "Windows device-namespace paths cannot be opened as PwrSnap files."
    );
  }
  if (/^[A-Za-z]:[^\\/]/.test(input)) {
    throw new InvalidPwrsnapOpenPathError(
      "drive_relative_path_not_supported",
      "Drive-relative Windows paths are ambiguous and cannot be opened safely."
    );
  }

  const isDriveAbsolute = /^[A-Za-z]:[\\/]/.test(input);
  const isUnc = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(input);
  if (!isDriveAbsolute && !isUnc) {
    throw new InvalidPwrsnapOpenPathError(
      "relative_path_not_supported",
      "Windows file-open paths must be absolute drive-letter or UNC paths."
    );
  }

  const withoutDrive = isDriveAbsolute ? input.slice(2) : input;
  const segments = withoutDrive.split(/[\\/]/).filter((segment) => segment.length > 0);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        /[. ]$/.test(segment) ||
        /[<>:"|?*\u0000-\u001f]/.test(segment) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment)
    )
  ) {
    throw new InvalidPwrsnapOpenPathError(
      "noncanonical_path",
      "The Windows path contains a reserved or noncanonical segment."
    );
  }

  // `cwd` is retained in the public options for callers that classify paths
  // for diagnostics; relative paths are intentionally never resolved against
  // it because a second-instance argv belongs to a different process cwd.
  void cwd;
  const normalized = win32.normalize(input);
  assertPwrsnapExtension(normalized, win32.extname(normalized));
  return normalized;
}

function normalizePosixPath(input: string, cwd: string | undefined): string {
  if (!posix.isAbsolute(input)) {
    throw new InvalidPwrsnapOpenPathError(
      "relative_path_not_supported",
      "File-open paths must be absolute."
    );
  }
  if (/[/](?:\.{1,2})(?:[/]|$)/.test(input) || input.includes("//") || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new InvalidPwrsnapOpenPathError(
      "noncanonical_path",
      "The path contains a noncanonical segment."
    );
  }
  void cwd;
  const normalized = posix.normalize(input);
  assertPwrsnapExtension(normalized, posix.extname(normalized));
  return normalized;
}

function assertPwrsnapExtension(path: string, extension: string): void {
  if (extension.toLowerCase() !== ".pwrsnap") {
    throw new InvalidPwrsnapOpenPathError(
      "not_a_pwrsnap_file",
      `${path.length > 0 ? "The selected file" : "This path"} is not a .pwrsnap bundle.`
    );
  }
}
