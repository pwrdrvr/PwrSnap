/**
 * SQLite path-reference matching for durable capture columns. Historical
 * Windows rows can contain either slash style, while current Node paths use
 * backslashes. Normalize inside the query and include the trailing separator
 * in the prefix so `PwrSnap-old` never aliases `PwrSnap`.
 */

export function capturePathReferencePrefix(
  root: string,
  platform: string = process.platform
): string {
  const normalized =
    platform === "win32" ? root.replaceAll("\\", "/").toLowerCase() : root;
  return `${normalized.replace(/\/+$/, "")}/`;
}

export function capturePathReferencePredicate(
  column: string,
  platform: string = process.platform
): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
    throw new TypeError(`invalid capture path column: ${column}`);
  }
  const comparable =
    platform === "win32"
      ? `lower(replace(${column}, char(92), '/'))`
      : column;
  return `substr(${comparable}, 1, length(@prefix)) = @prefix`;
}
