import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, link, mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { PwrsnapImportError } from "./pwrsnap-import-reader";

const COPY_CHUNK_BYTES = 1024 * 1024;

type FileHandleLike = {
  writeFile(data: Buffer): Promise<void>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesWritten: number }>;
  stat(options: { bigint: true }): Promise<BigIntStats>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

export type ImportFileIdentity = {
  dev: string;
  ino: string;
  birthtimeNs: string;
  size: string;
};

export type ImportStageArtifact = {
  path: string;
  handle: FileHandleLike;
  identity: ImportFileIdentity;
  sha256: string;
  size: number;
};

export type PublishedImportArtifact = {
  path: string;
  identity: ImportFileIdentity;
  installMode: "renamed" | "copied_cross_volume";
};

export type ImportInstallFileOps = {
  link(source: string, destination: string): Promise<void>;
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  mkdir(path: string, options: { recursive: true; mode?: number }): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<FileHandleLike>;
  unlink(path: string): Promise<void>;
};

const defaultFileOps: ImportInstallFileOps = {
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
): Promise<ImportStageArtifact> {
  const stageDir = join(dataRoot, "import-staging");
  await fileOps.mkdir(stageDir, { recursive: true, mode: 0o700 });
  const stagePath = join(stageDir, `.pwrsnap-import-${randomUUID()}.tmp`);
  let handle: FileHandleLike | null = null;
  try {
    // Keep one read/write descriptor alive through publication. EXDEV copies
    // read from this descriptor rather than reopening the mutable pathname.
    handle = await fileOps.open(stagePath, "wx+", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    const artifact: ImportStageArtifact = {
      path: stagePath,
      handle,
      identity: identityFromStat(stat),
      sha256: createHash("sha256").update(contents).digest("hex"),
      size: contents.length
    };
    await assertPathMatchesArtifact(artifact, fileOps);
    return artifact;
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
 * Publish the exact staged inode without replacing an existing destination.
 *
 * The stage descriptor remains open for the whole operation. Same-volume
 * publication hard-links its pathname directly and then proves both paths are
 * the descriptor's inode. EXDEV copies from the descriptor (never by reopening
 * stage.path) into an exclusively-open destination-local temp, hashes while it
 * copies, and publishes that verified inode with another no-clobber hard link.
 */
export async function publishStagedImport(
  stage: ImportStageArtifact,
  destinationPath: string,
  fileOps: ImportInstallFileOps = defaultFileOps
): Promise<PublishedImportArtifact> {
  const destinationDir = dirname(destinationPath);
  await fileOps.mkdir(destinationDir, { recursive: true });
  await assertDestinationAbsent(destinationPath, fileOps);
  await assertPathMatchesArtifact(stage, fileOps);

  let localTemp: ImportStageArtifact | null = null;
  let finalIdentity: ImportFileIdentity | null = null;
  let installMode: PublishedImportArtifact["installMode"] = "renamed";
  try {
    try {
      await fileOps.link(stage.path, destinationPath);
      finalIdentity = await assertPublishedIdentity(stage, destinationPath, fileOps);
    } catch (cause) {
      if (!isErrno(cause, "EXDEV")) throw cause;
      installMode = "copied_cross_volume";
      localTemp = await copyStageFromHandle(stage, destinationDir, destinationPath, fileOps);
      await fileOps.link(localTemp.path, destinationPath);
      finalIdentity = await assertPublishedIdentity(localTemp, destinationPath, fileOps);
    }

    await syncDirectoryBestEffort(destinationDir, fileOps);
    if (localTemp !== null) {
      await closeImportArtifact(localTemp);
      await removeImportArtifact(localTemp, fileOps).catch(() => undefined);
      localTemp = null;
    }
    return {
      path: destinationPath,
      identity: finalIdentity,
      installMode
    };
  } catch (cause) {
    if (localTemp !== null) {
      await closeImportArtifact(localTemp);
      await removeImportArtifact(localTemp, fileOps).catch(() => undefined);
    }
    if (cause instanceof PwrsnapImportError) throw cause;
    if (isErrno(cause, "EEXIST")) {
      throw new PwrsnapImportError(
        "storage",
        "destination_exists",
        "PwrSnap refused to overwrite an existing file in the capture library.",
        { cause }
      );
    }
    if (isPermissionDenial(cause)) throw cause;
    throw new PwrsnapImportError(
      "storage",
      installMode === "copied_cross_volume"
        ? "publish_copy_failed"
        : "publish_rename_failed",
      installMode === "copied_cross_volume"
        ? "PwrSnap could not safely copy the imported bundle across storage volumes."
        : "PwrSnap could not place the imported bundle in the capture library.",
      { cause }
    );
  }
}

export async function closeImportArtifact(artifact: ImportStageArtifact): Promise<void> {
  await artifact.handle.close();
}

/** Remove only a path that still names the caller's verified identity. */
export async function removeImportArtifact(
  artifact: Pick<ImportStageArtifact, "path" | "identity"> | PublishedImportArtifact | null,
  fileOps: Pick<ImportInstallFileOps, "lstat" | "unlink"> = defaultFileOps
): Promise<"removed" | "missing"> {
  if (artifact === null) return "missing";
  let stat: BigIntStats;
  try {
    stat = await fileOps.lstat(artifact.path, { bigint: true });
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return "missing";
    throw cause;
  }
  if (!sameIdentity(artifact.identity, identityFromStat(stat))) {
    throw new PwrsnapImportError(
      "storage",
      "cleanup_identity_changed",
      "PwrSnap left an import recovery record because a staged file changed before cleanup."
    );
  }
  await fileOps.unlink(artifact.path);
  return "removed";
}

export function serializeImportIdentity(identity: ImportFileIdentity): string {
  return JSON.stringify(identity);
}

export function parseImportIdentity(value: string): ImportFileIdentity {
  const parsed = JSON.parse(value) as Partial<ImportFileIdentity>;
  for (const key of ["dev", "ino", "birthtimeNs", "size"] as const) {
    if (typeof parsed[key] !== "string" || !/^\d+$/u.test(parsed[key])) {
      throw new Error("Invalid persisted import file identity.");
    }
  }
  return parsed as ImportFileIdentity;
}

async function copyStageFromHandle(
  stage: ImportStageArtifact,
  destinationDir: string,
  destinationPath: string,
  fileOps: ImportInstallFileOps
): Promise<ImportStageArtifact> {
  const localPath = join(
    destinationDir,
    `.${basename(destinationPath)}.import-${randomUUID()}.tmp`
  );
  let handle: FileHandleLike | null = null;
  try {
    handle = await fileOps.open(localPath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(stage.size, 1)));
    let position = 0;
    while (position < stage.size) {
      const requested = Math.min(buffer.length, stage.size - position);
      const { bytesRead } = await stage.handle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) throw new Error("Staged import ended before its verified size.");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await handle.write(
          buffer,
          written,
          bytesRead - written,
          position + written
        );
        if (result.bytesWritten <= 0) throw new Error("Import copy made no progress.");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    const local: ImportStageArtifact = {
      path: localPath,
      handle,
      identity: identityFromStat(stat),
      sha256: hash.digest("hex"),
      size: position
    };
    if (local.size !== stage.size || local.sha256 !== stage.sha256) {
      throw new PwrsnapImportError(
        "storage",
        "cross_volume_hash_mismatch",
        "The cross-volume import copy failed its integrity check."
      );
    }
    await assertPathMatchesArtifact(local, fileOps);
    return local;
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await fileOps.unlink(localPath).catch(() => undefined);
    throw cause;
  }
}

async function assertPublishedIdentity(
  source: ImportStageArtifact,
  destinationPath: string,
  fileOps: Pick<ImportInstallFileOps, "lstat">
): Promise<ImportFileIdentity> {
  const [handleStat, sourceStat, destinationStat] = await Promise.all([
    source.handle.stat({ bigint: true }),
    fileOps.lstat(source.path, { bigint: true }),
    fileOps.lstat(destinationPath, { bigint: true })
  ]);
  const handleIdentity = identityFromStat(handleStat);
  const sourceIdentity = identityFromStat(sourceStat);
  const destinationIdentity = identityFromStat(destinationStat);
  if (
    !sameIdentity(source.identity, handleIdentity) ||
    !sameIdentity(source.identity, sourceIdentity) ||
    !sameIdentity(source.identity, destinationIdentity)
  ) {
    throw new PwrsnapImportError(
      "storage",
      "publish_identity_changed",
      "PwrSnap stopped the import because its staged file changed during publication."
    );
  }
  return destinationIdentity;
}

async function assertPathMatchesArtifact(
  artifact: ImportStageArtifact,
  fileOps: Pick<ImportInstallFileOps, "lstat">
): Promise<void> {
  const [handleStat, pathStat] = await Promise.all([
    artifact.handle.stat({ bigint: true }),
    fileOps.lstat(artifact.path, { bigint: true })
  ]);
  if (
    !sameIdentity(artifact.identity, identityFromStat(handleStat)) ||
    !sameIdentity(artifact.identity, identityFromStat(pathStat))
  ) {
    throw new PwrsnapImportError(
      "storage",
      "stage_identity_changed",
      "PwrSnap stopped the import because its staged file changed before publication."
    );
  }
}

function identityFromStat(stat: BigIntStats): ImportFileIdentity {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    size: stat.size.toString()
  };
}

function sameIdentity(left: ImportFileIdentity, right: ImportFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size
  );
}

async function assertDestinationAbsent(
  destinationPath: string,
  fileOps: Pick<ImportInstallFileOps, "lstat">
): Promise<void> {
  try {
    await fileOps.lstat(destinationPath, { bigint: true });
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
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
