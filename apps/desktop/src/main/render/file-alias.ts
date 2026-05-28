import { copyFile, link, mkdir, rm } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

/**
 * Create a stable, human-friendly file path for OS-native consumers
 * (drag-and-drop, file-promise clipboard writes) whose visible
 * filename comes from the source path basename. The alias points at
 * the exact render-cache bytes — hardlink when the filesystem
 * supports it (zero extra storage), copy fallback otherwise.
 *
 * Layout: `<cache-dir-of-source>/clipboard/<source-basename-stem>/<displayName>`.
 * The intermediate `<source-basename-stem>` directory disambiguates
 * concurrent aliases for different cache files (e.g. dragging GIF
 * LOW and MP4 HIGH back-to-back ends up with two separate alias
 * directories, never colliding on the displayName).
 *
 * Existing aliases at the target path are removed first — the bytes
 * may have changed even if the path collides (cache eviction +
 * re-encode rotates the underlying file).
 */
export async function prepareRenderedFileAlias(
  cachePath: string,
  displayName: string
): Promise<string> {
  const aliasDir = join(dirname(cachePath), "clipboard", parse(cachePath).name);
  const aliasPath = join(aliasDir, displayName);

  await mkdir(aliasDir, { recursive: true });
  await rm(aliasPath, { force: true });

  try {
    await link(cachePath, aliasPath);
  } catch {
    await copyFile(cachePath, aliasPath);
  }

  return aliasPath;
}

/**
 * @deprecated Use `prepareRenderedFileAlias(cachePath, "image.png")`.
 * Kept as a thin wrapper so existing image callers don't churn in
 * the same PR that introduces the video equivalents.
 */
export async function prepareRenderedPngAlias(cachePath: string): Promise<string> {
  return prepareRenderedFileAlias(cachePath, "image.png");
}
