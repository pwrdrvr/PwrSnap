import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Copy beside the selected destination, then atomically replace it only
 * after the entire copy succeeds. A failed copy leaves any existing file
 * intact and removes its private staging directory. */
export async function publishRenderedFile(source: string, destination: string): Promise<void> {
  const stagingDir = await mkdtemp(join(dirname(destination), ".pwrsnap-save-"));
  try {
    const stagingPath = join(stagingDir, "image.png");
    await copyFile(source, stagingPath);
    await rename(stagingPath, destination);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
