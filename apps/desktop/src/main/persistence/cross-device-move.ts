// Move one file without assuming its source and destination share a volume.
//
// The fast path is still a single `rename`, preserving the atomic same-volume
// behavior used throughout persistence. Node does not fall back to copy+unlink
// when `rename` crosses a filesystem boundary: it rejects with EXDEV. Only for
// that error, stage a copy beside the destination, fsync it, atomically rename
// the completed staging file into place, and delete the source last.
//
// Crash/failure posture: the source is never deleted before the destination is
// complete. A failure before the staging rename removes only the staging file.
// If deleting the source fails after the destination is installed, both copies
// are deliberately retained; preserving user data is more important than
// trying to manufacture move-like cleanup after the durable copy exists.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type FileMoveOperations = {
  rename: (sourcePath: string, destinationPath: string) => Promise<void>;
  copyFile: (sourcePath: string, destinationPath: string, mode: number) => Promise<void>;
  syncFile: (path: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  uniqueSuffix: () => string;
};

async function syncFile(path: string): Promise<void> {
  // Windows FlushFileBuffers requires a handle opened with write access.
  // `r+` does not truncate or modify the completed staging copy.
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const DEFAULT_OPERATIONS: FileMoveOperations = {
  rename,
  copyFile,
  syncFile,
  unlink,
  uniqueSuffix: randomUUID
};

function isCrossDeviceError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "EXDEV";
}

/**
 * Rename `sourcePath` to `destinationPath`, with a data-safe EXDEV fallback.
 *
 * `operationOverrides` exists for deterministic failure-injection tests. The
 * production path always uses the Node filesystem operations above.
 */
export async function moveFileWithExdevFallback(
  sourcePath: string,
  destinationPath: string,
  operationOverrides: Partial<FileMoveOperations> = {}
): Promise<void> {
  const operations: FileMoveOperations = { ...DEFAULT_OPERATIONS, ...operationOverrides };

  try {
    await operations.rename(sourcePath, destinationPath);
    return;
  } catch (cause) {
    if (!isCrossDeviceError(cause)) throw cause;
  }

  const stagingPath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.move-${process.pid}-${operations.uniqueSuffix()}.tmp`
  );
  let stagingInstalled = false;
  try {
    // COPYFILE_EXCL prevents an unexpected pre-existing entry (including a
    // symlink) from being overwritten in a user-visible captures directory.
    await operations.copyFile(sourcePath, stagingPath, constants.COPYFILE_EXCL);
    await operations.syncFile(stagingPath);
    await operations.rename(stagingPath, destinationPath);
    stagingInstalled = true;
  } finally {
    if (!stagingInstalled) {
      await operations.unlink(stagingPath).catch(() => undefined);
    }
  }

  // Source deletion is intentionally last. If it fails, leave the completed
  // destination in place as a second recoverable copy and surface the error.
  await operations.unlink(sourcePath);
}
