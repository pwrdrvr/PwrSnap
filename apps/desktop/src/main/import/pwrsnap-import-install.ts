import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  unlink
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { PwrsnapImportError } from "./pwrsnap-import-reader";

type FileHandleLike = {
  writeFile(data: Buffer): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

export type ImportInstallFileOps = {
  copyFile(source: string, destination: string, mode: number): Promise<void>;
  createReadStream(path: string): AsyncIterable<Buffer | string>;
  link(source: string, destination: string): Promise<void>;
  lstat(path: string): Promise<{ size: number }>;
  mkdir(path: string, options: { recursive: true; mode?: number }): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<FileHandleLike>;
  unlink(path: string): Promise<void>;
};

const defaultFileOps: ImportInstallFileOps = {
  copyFile,
  createReadStream: (path) => createReadStream(path),
  link,
  lstat,
  mkdir,
  open,
  unlink
};

export async function writeImportStage(
  dataRoot: string,
  contents: Buffer,
  fileOps: ImportInstallFileOps = defaultFileOps
): Promise<string> {
  const stageDir = join(dataRoot, "import-staging");
  await fileOps.mkdir(stageDir, { recursive: true, mode: 0o700 });
  const stagePath = join(stageDir, `.pwrsnap-import-${randomUUID()}.tmp`);
  let handle: FileHandleLike | null = null;
  try {
    handle = await fileOps.open(stagePath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    return stagePath;
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await fileOps.unlink(stagePath).catch(() => undefined);
    throw new PwrsnapImportError(
      "storage",
      "stage_write_failed",
      "PwrSnap could not stage the imported bundle safely.",
      { cause }
    );
  }
}

/**
 * Publish an app-owned staged file without ever replacing an existing path.
 * A hard link is Node's portable atomic no-clobber primitive: on the common
 * same-volume path it publishes the staged inode through a destination-local name;
 * EXDEV falls back to a destination-local exclusive copy that is verified and
 * fsynced first. A second hard link publishes either local temp atomically and
 * fails with EEXIST if another process wins the destination race.
 *
 * No operation after the final link is allowed to turn a successful publish
 * into an error. That keeps the service from leaving an owned library file
 * without its DB transaction merely because best-effort temp cleanup failed.
 */
export async function publishStagedImport(
  stagePath: string,
  destinationPath: string,
  fileOps: ImportInstallFileOps = defaultFileOps
): Promise<"renamed" | "copied_cross_volume"> {
  const destinationDir = dirname(destinationPath);
  await fileOps.mkdir(destinationDir, { recursive: true });
  await assertDestinationAbsent(destinationPath, fileOps);

  const localTemp = join(
    destinationDir,
    `.${basename(destinationPath)}.import-${randomUUID()}.tmp`
  );
  const state: {
    localHandle: FileHandleLike | null;
    installMode: "renamed" | "copied_cross_volume";
  } = { localHandle: null, installMode: "renamed" };
  try {
    try {
      await fileOps.link(stagePath, localTemp);
    } catch (cause) {
      if (!isErrno(cause, "EXDEV")) throw cause;
      state.installMode = "copied_cross_volume";
      await fileOps.copyFile(stagePath, localTemp, constants.COPYFILE_EXCL);
      state.localHandle = await fileOps.open(localTemp, "r+");
      await state.localHandle.sync();
      await state.localHandle.close();
      state.localHandle = null;
      await verifyCopiedStage(stagePath, localTemp, fileOps);
    }

    try {
      await fileOps.link(localTemp, destinationPath);
    } catch (cause) {
      if (isErrno(cause, "EEXIST")) {
        throw new PwrsnapImportError(
          "storage",
          "destination_exists",
          "PwrSnap refused to overwrite an existing file in the capture library.",
          { cause }
        );
      }
      throw cause;
    }

    await syncDirectoryBestEffort(destinationDir, fileOps);
    await fileOps.unlink(localTemp).catch(() => undefined);
    await fileOps.unlink(stagePath).catch(() => undefined);
    return state.installMode;
  } catch (cause) {
    await state.localHandle?.close().catch(() => undefined);
    await fileOps.unlink(localTemp).catch(() => undefined);
    if (cause instanceof PwrsnapImportError) throw cause;
    // The captures storage gate must see the real errno/path/dest to detect a
    // macOS Documents TCC denial and retry in the sticky home fallback.
    if (isPermissionDenial(cause)) throw cause;
    throw new PwrsnapImportError(
      "storage",
      state.installMode === "copied_cross_volume"
        ? "publish_copy_failed"
        : "publish_rename_failed",
      state.installMode === "copied_cross_volume"
        ? "PwrSnap could not safely copy the imported bundle across storage volumes."
        : "PwrSnap could not place the imported bundle in the capture library.",
      { cause }
    );
  }
}

export async function removeImportArtifact(
  path: string | null,
  fileOps: Pick<ImportInstallFileOps, "unlink"> = defaultFileOps
): Promise<void> {
  if (path === null) return;
  try {
    await fileOps.unlink(path);
  } catch (cause) {
    if (!isErrno(cause, "ENOENT")) throw cause;
  }
}

async function verifyCopiedStage(
  stagePath: string,
  localTemp: string,
  fileOps: ImportInstallFileOps
): Promise<void> {
  const [stageStat, copiedStat] = await Promise.all([
    fileOps.lstat(stagePath),
    fileOps.lstat(localTemp)
  ]);
  if (stageStat.size !== copiedStat.size) {
    throw new PwrsnapImportError(
      "storage",
      "cross_volume_size_mismatch",
      "The cross-volume import copy failed its size check."
    );
  }
  const stageDigest = await digestFile(stagePath, fileOps);
  const copiedDigest = await digestFile(localTemp, fileOps);
  if (stageDigest !== copiedDigest) {
    throw new PwrsnapImportError(
      "storage",
      "cross_volume_hash_mismatch",
      "The cross-volume import copy failed its integrity check."
    );
  }
}

async function assertDestinationAbsent(
  destinationPath: string,
  fileOps: Pick<ImportInstallFileOps, "lstat">
): Promise<void> {
  try {
    await fileOps.lstat(destinationPath);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return;
    throw cause;
  }
  throw new PwrsnapImportError(
    "storage",
    "destination_exists",
    "PwrSnap refused to overwrite an existing file in the capture library."
  );
}

async function syncDirectoryBestEffort(
  directory: string,
  fileOps: Pick<ImportInstallFileOps, "open">
): Promise<void> {
  let handle: FileHandleLike | null = null;
  try {
    handle = await fileOps.open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unsupported by some Windows/filesystem drivers.
    // The same-volume final hard-link publication remains atomic without this
    // power-loss durability step.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function digestFile(
  path: string,
  fileOps: Pick<ImportInstallFileOps, "createReadStream">
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fileOps.createReadStream(path)) {
    hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return hash.digest("hex");
}

function isErrno(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === code
  );
}

function isPermissionDenial(cause: unknown): boolean {
  return isErrno(cause, "EACCES") || isErrno(cause, "EPERM");
}
