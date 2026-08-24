import { win32 } from "node:path";

const EXTENDED_PREFIX = "\\\\?\\";
const DEVICE_PREFIX = "\\\\.\\";
const NT_PREFIX = "\\??\\";

function isDriveAbsolute(path: string): boolean {
  return /^[A-Za-z]:\\/.test(path);
}

function isRejectedUncShare(path: string): boolean {
  if (!path.startsWith("\\\\")) return false;
  const [, share] = path.slice(2).split("\\");
  if (share === undefined) return true;
  const folded = share.toLowerCase();
  return /^[a-z]\$$/.test(folded) || folded === "admin$" || folded === "ipc$";
}

/**
 * Normalize Windows pathname aliases before security-policy comparison.
 *
 * Drive and UNC extended-length spellings have ordinary Win32 equivalents;
 * convert those. Object-manager/device/global-root namespaces and hidden
 * administrative shares do not have a safe user-content interpretation, so
 * return null and let callers fail closed.
 */
export function normalizeWindowsPathForPolicy(path: string): string | null {
  // Control characters are invalid Win32 filename components and would also
  // make the native verifier's newline-delimited stdin protocol ambiguous.
  if (path.length === 0 || /[\x00-\x1f]/.test(path)) return null;
  let candidate = path.replaceAll("/", "\\");
  let folded = candidate.toLowerCase();

  if (folded.startsWith(EXTENDED_PREFIX.toLowerCase())) {
    const rest = candidate.slice(EXTENDED_PREFIX.length);
    const foldedRest = rest.toLowerCase();
    if (foldedRest.startsWith("unc\\")) {
      candidate = `\\\\${rest.slice(4)}`;
    } else if (isDriveAbsolute(rest)) {
      candidate = rest;
    } else {
      return null;
    }
  } else if (folded.startsWith(DEVICE_PREFIX.toLowerCase())) {
    return null;
  } else if (folded.startsWith(NT_PREFIX.toLowerCase())) {
    const rest = candidate.slice(NT_PREFIX.length);
    const foldedRest = rest.toLowerCase();
    if (foldedRest.startsWith("unc\\")) {
      candidate = `\\\\${rest.slice(4)}`;
    } else if (isDriveAbsolute(rest)) {
      candidate = rest;
    } else {
      return null;
    }
  }

  folded = candidate.toLowerCase();
  if (
    folded.startsWith("\\device\\") ||
    folded.startsWith("globalroot\\") ||
    folded.includes("\\globalroot\\")
  ) {
    return null;
  }
  if (isRejectedUncShare(candidate)) return null;

  const normalized = win32.normalize(candidate);
  if (!isDriveAbsolute(normalized) && !normalized.startsWith("\\\\")) {
    return null;
  }
  return normalized;
}
