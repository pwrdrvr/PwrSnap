import { copyFile, link, mkdir, rm } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

/**
 * Create a stable, human-friendly file path for APIs whose visible
 * filename comes from the source path basename. The alias points at
 * the exact render-cache bytes, using a hardlink when the filesystem
 * supports it and a copy fallback otherwise.
 */
export async function prepareRenderedPngAlias(cachePath: string): Promise<string> {
  const aliasDir = join(dirname(cachePath), "clipboard", parse(cachePath).name);
  const aliasPath = join(aliasDir, "image.png");

  await mkdir(aliasDir, { recursive: true });
  await rm(aliasPath, { force: true });

  try {
    await link(cachePath, aliasPath);
  } catch {
    await copyFile(cachePath, aliasPath);
  }

  return aliasPath;
}
