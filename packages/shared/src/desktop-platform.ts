/**
 * User-facing desktop nouns and executable-path examples shared by main and
 * renderer. Keep platform branching here so Windows never inherits Finder or
 * Homebrew copy from a macOS-first call site.
 */

export function desktopFileManagerName(platform: string | undefined): string {
  if (platform === "darwin") return "Finder";
  if (platform === "win32") return "File Explorer";
  return "file manager";
}

export function revealInFileManagerLabel(platform: string | undefined): string {
  return `Reveal in ${desktopFileManagerName(platform)}`;
}

export type CapturesFolderLocation = "documents" | "home";

export function capturesFolderDisplayPath(
  platform: string | undefined,
  location: CapturesFolderLocation
): string {
  if (platform === "win32") {
    return location === "home"
      ? String.raw`%USERPROFILE%\PwrSnap`
      : String.raw`Documents\PwrSnap`;
  }
  return location === "home" ? "~/PwrSnap" : "~/Documents/PwrSnap";
}

export function chatsFolderDisplayPath(
  platform: string | undefined,
  location: CapturesFolderLocation = "documents",
  rootOverridden: boolean = false
): string {
  if (rootOverridden) return "inside your active captures folder";
  const capturesPath = capturesFolderDisplayPath(platform, location);
  return platform === "win32"
    ? `${capturesPath}\\Chats`
    : `${capturesPath}/Chats`;
}

export type ChatStoragePlatformCopy = {
  cloudSync: string;
  indexing: string;
  encryption: string;
};

export function chatStoragePlatformCopy(
  platform: string | undefined,
  location: CapturesFolderLocation = "documents",
  rootOverridden: boolean = false
): ChatStoragePlatformCopy {
  const cloudSync = rootOverridden
    ? "These files may sync depending on where you chose to place your active captures folder."
    : location === "home"
      ? "The home fallback is outside Documents, so Documents sync settings do not automatically include these files."
      : null;
  if (platform === "win32") {
    return {
      cloudSync:
        cloudSync ??
        "If Documents is backed up by OneDrive, these files may sync to it.",
      indexing: "Windows Search may index this folder unless you exclude it.",
      encryption:
        "Turn on BitLocker or Windows device encryption for at-rest protection."
    };
  }
  if (platform === "darwin") {
    return {
      cloudSync:
        cloudSync ??
        "If you have iCloud Drive Desktop & Documents enabled, these files sync to iCloud.",
      indexing: "Spotlight indexing is disabled for this folder.",
      encryption: "Turn on FileVault for at-rest encryption."
    };
  }
  return {
    cloudSync:
      cloudSync ??
      "If Documents is managed by a cloud-sync service, these files may sync to it.",
    indexing: "Your desktop search service may index this folder.",
    encryption: "Use full-disk encryption for at-rest protection."
  };
}

export function executablePathExample(
  platform: string | undefined,
  executable: string
): string {
  if (platform === "win32") {
    return executable === "codex"
      ? String.raw`C:\Program Files\OpenAI\Codex\bin\codex.exe`
      : `${String.raw`C:\Users\you\AppData\Roaming\npm`}\\${executable}.cmd`;
  }
  if (platform === "darwin") {
    return executable === "codex"
      ? "/opt/homebrew/bin/codex"
      : `/Users/you/.nvm/versions/node/vXX/bin/${executable}`;
  }
  return executable === "codex"
    ? "/home/you/.local/bin/codex"
    : `/home/you/.local/bin/${executable}`;
}

/**
 * Validate the documented "manual executable path" contract without using
 * the host's path implementation. This keeps Windows drive and UNC behavior
 * testable on macOS CI and rejects drive-relative/device-namespace spellings.
 */
export function isAbsoluteExecutablePath(
  platform: string | undefined,
  candidate: string
): boolean {
  if (candidate.length === 0 || /[\0\r\n]/.test(candidate)) return false;
  if (platform !== "win32") return candidate.startsWith("/");
  const normalized = candidate.replaceAll("/", "\\");
  if (/[*?"<>|]/.test(normalized)) return false;
  if (
    normalized.startsWith("\\??\\") ||
    normalized.startsWith("\\\\?\\") ||
    normalized.startsWith("\\\\.\\")
  ) {
    return false;
  }
  if (/^[A-Za-z]:\\/.test(normalized)) return true;
  if (!normalized.startsWith("\\\\")) return false;
  const [server = "", share = ""] = normalized.slice(2).split("\\");
  const invalidPart = /[\\/:*?"<>|]/;
  return (
    server.length > 0 &&
    share.length > 0 &&
    !invalidPart.test(server) &&
    !invalidPart.test(share)
  );
}

export type ManualExecutablePathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Normalize one path pasted into a manual executable field. Explorer's
 * "Copy as path" wraps the path in one pair of double quotes; those quotes
 * describe clipboard text rather than the filename, so remove exactly that
 * safe pair. Other quoting stays invalid because the executable is launched
 * directly and no shell syntax belongs in this field.
 */
export function normalizeManualExecutablePath(
  platform: string | undefined,
  input: string
): ManualExecutablePathResult {
  let candidate = input.trim();
  if (platform === "win32" && (candidate.startsWith('"') || candidate.endsWith('"'))) {
    const paired =
      candidate.length >= 2 &&
      candidate.startsWith('"') &&
      candidate.endsWith('"');
    const inner = paired ? candidate.slice(1, -1) : "";
    if (!paired || inner.length === 0 || inner.includes('"')) {
      return {
        ok: false,
        error: "Paste one full Windows executable path without shell quoting."
      };
    }
    candidate = inner;
  }
  if (!isAbsoluteExecutablePath(platform, candidate)) {
    return {
      ok: false,
      error:
        platform === "win32"
          ? String.raw`Enter a drive-absolute path such as C:\tools\agent.exe or a UNC path such as \\server\share\agent.cmd.`
          : "Enter an absolute executable path beginning with /."
    };
  }
  return { ok: true, path: candidate };
}
