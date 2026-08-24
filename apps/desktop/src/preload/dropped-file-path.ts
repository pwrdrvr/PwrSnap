// Narrow adapter around Electron's renderer-only webUtils API.
//
// Electron 32 removed the non-standard File.path property. A renderer with
// contextIsolation enabled must hand the browser File object to preload, where
// webUtils.getPathForFile can recover the OS-backed path. Keep the adapter
// deliberately tiny: callers receive one string for one user-dropped File;
// they never receive Electron's webUtils module (or the broader electron API).

export type FilePathResolver = (file: File) => string;

/**
 * Resolve an OS-backed File without letting Electron exceptions cross the
 * contextBridge boundary. JS-constructed Files legitimately resolve to an
 * empty string; the renderer treats that as an unavailable path.
 */
export function resolveDroppedFilePath(
  file: File,
  resolver: FilePathResolver
): string {
  try {
    const value = resolver(file);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
