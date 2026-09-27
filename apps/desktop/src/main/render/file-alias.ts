import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function publishAlias(stagingPath: string, aliasPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(stagingPath, aliasPath);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // Windows can reject replacement while a consumer has the old alias
      // open. Leave that alias intact and retry briefly; permanent permission
      // failures still propagate after a bounded total wait of 310 ms.
      if ((code !== "EPERM" && code !== "EACCES") || attempt >= 5) throw cause;
      await delay(10 * 2 ** attempt);
    }
  }
}

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
 * Stage beside the destination and rename over it atomically. Existing
 * clipboard consumers can keep opening the published path while the bytes
 * are replaced (cache eviction + re-encode can rotate the underlying file).
 */
export async function prepareRenderedFileAlias(
  cachePath: string,
  displayName: string
): Promise<string> {
  const aliasDir = join(dirname(cachePath), "clipboard", parse(cachePath).name);
  const aliasPath = join(aliasDir, displayName);

  await mkdir(aliasDir, { recursive: true });
  const stagingPath = join(aliasDir, `.pwrsnap-alias-${randomUUID()}`);

  try {
    try {
      await link(cachePath, stagingPath);
    } catch {
      await copyFile(cachePath, stagingPath);
    }
    await publishAlias(stagingPath, aliasPath);
  } finally {
    // POSIX rename can be a no-op when both names already share an inode.
    // Also remove any partial staged copy after a failure, preserving the
    // previously published alias in either case.
    await rm(stagingPath, { force: true });
  }

  return aliasPath;
}
