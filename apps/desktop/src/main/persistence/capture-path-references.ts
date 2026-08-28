/**
 * SQLite path-reference matching for durable capture columns. Historical
 * Windows rows can contain either slash style, while current Node paths use
 * backslashes. SQLite's built-in lower() only folds ASCII, so both the stored
 * path and root must pass through the same JavaScript Unicode case folding.
 * The trailing separator keeps `PwrSnap-old` from aliasing `PwrSnap`.
 */

import type Database from "better-sqlite3";

export const CAPTURE_PATH_HAS_PREFIX_SQL_FUNCTION =
  "pwrsnap_capture_path_has_prefix";

const registeredDatabases = new WeakSet<object>();

function normalizeWindowsCapturePath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

/** Register the Unicode-aware Windows prefix matcher before preparing a query
 * that references it. Kept lazy so repository tests with in-memory databases
 * receive the same behavior as the production connection. */
export function registerCapturePathReferenceFunctions(
  db: Pick<Database.Database, "function">
): void {
  if (registeredDatabases.has(db)) return;
  db.function(
    CAPTURE_PATH_HAS_PREFIX_SQL_FUNCTION,
    { deterministic: true },
    (storedPath: unknown, normalizedPrefix: unknown): number => {
      if (typeof storedPath !== "string" || typeof normalizedPrefix !== "string") {
        return 0;
      }
      return normalizeWindowsCapturePath(storedPath).startsWith(normalizedPrefix)
        ? 1
        : 0;
    }
  );
  registeredDatabases.add(db);
}

export function capturePathReferencePrefix(
  root: string,
  platform: string = process.platform
): string {
  const normalized =
    platform === "win32" ? normalizeWindowsCapturePath(root) : root;
  return `${normalized.replace(/\/+$/, "")}/`;
}

export function capturePathReferencePredicate(
  column: string,
  platform: string = process.platform
): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
    throw new TypeError(`invalid capture path column: ${column}`);
  }
  if (platform === "win32") {
    return `${CAPTURE_PATH_HAS_PREFIX_SQL_FUNCTION}(${column}, @prefix) = 1`;
  }
  return `substr(${column}, 1, length(@prefix)) = @prefix`;
}
