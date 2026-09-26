import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";

/**
 * Remove the private mkdtemp directory returned by captureWindow().
 * Refuse every path except an immediate `pwrsnap-*` child of the OS temp
 * root; this helper must never become a renderer-controlled delete primitive.
 */
export async function releaseWindowCaptureTemp(tempPath: string): Promise<void> {
  const root = resolve(tmpdir());
  const directory = resolve(dirname(tempPath));
  const delta = relative(root, directory);
  const isImmediateChild =
    delta.length > 0 &&
    delta !== ".." &&
    !delta.startsWith(`..${sep}`) &&
    !isAbsolute(delta) &&
    !delta.includes(sep);

  if (!isImmediateChild || !basename(directory).startsWith("pwrsnap-")) {
    throw new Error("refusing to remove a non-PwrSnap capture temp path");
  }

  await rm(directory, { recursive: true, force: true });
}
