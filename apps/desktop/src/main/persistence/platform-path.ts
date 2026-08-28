import { randomUUID } from "node:crypto";
import { lstat, readdir, rename } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

type StatIdentity = (filePath: string) => Promise<FileIdentity>;
type ReadDirectory = (dirPath: string) => Promise<string[]>;
type RenameFile = (oldPath: string, newPath: string) => Promise<void>;
export type PathImplementation = {
  basename(filePath: string): string;
  dirname(filePath: string): string;
  extname(filePath: string): string;
  join(...parts: string[]): string;
};

const hostPath: PathImplementation = { basename, dirname, extname, join };

export type RenameDestination =
  | { kind: "same-path" }
  | { kind: "absent" }
  | {
      kind: "same-entry";
      currentNamePresent: boolean;
      desiredNamePresent: boolean;
    }
  | { kind: "occupied" }
  | { kind: "ambiguous" };

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sameReliableIdentity(left: FileIdentity, right: FileIdentity): boolean {
  // Some virtual/network filesystems report zero file IDs. Failing closed is
  // safer than treating two names as aliases and replacing a distinct file.
  return (
    left.ino !== 0n &&
    right.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

async function statIdentity(filePath: string): Promise<FileIdentity> {
  const stats = await lstat(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

/**
 * Classify a rename destination using the filesystem's identity, not an OS
 * case-sensitivity assumption. Darwin volumes, Windows directories, and SMB
 * shares can each have different case rules.
 */
export async function inspectRenameDestination(
  currentPath: string,
  desiredPath: string,
  options: {
    statFile?: StatIdentity | undefined;
    readDirectory?: ReadDirectory | undefined;
    pathImpl?: PathImplementation | undefined;
  } = {}
): Promise<RenameDestination> {
  if (currentPath === desiredPath) return { kind: "same-path" };

  const statFile = options.statFile ?? statIdentity;
  const readDirectory = options.readDirectory ?? (async (dirPath) => readdir(dirPath));
  const pathImpl = options.pathImpl ?? hostPath;
  const currentIdentity = await statFile(currentPath);
  let desiredIdentity: FileIdentity;
  try {
    desiredIdentity = await statFile(desiredPath);
  } catch (error) {
    if (isMissing(error)) return { kind: "absent" };
    throw error;
  }

  if (!sameReliableIdentity(currentIdentity, desiredIdentity)) {
    if (
      currentIdentity.dev === desiredIdentity.dev &&
      currentIdentity.ino === desiredIdentity.ino
    ) {
      return { kind: "ambiguous" };
    }
    return { kind: "occupied" };
  }

  const names = await readDirectory(pathImpl.dirname(currentPath));
  const currentName = pathImpl.basename(currentPath);
  const desiredName = pathImpl.basename(desiredPath);
  const currentNamePresent = names.includes(currentName);
  const desiredNamePresent = names.includes(desiredName);

  // Two exact directory entries with one identity are hard links (or another
  // filesystem alias), not a case-only spelling change. Never collapse them.
  if (currentName !== desiredName && currentNamePresent && desiredNamePresent) {
    return { kind: "occupied" };
  }
  if (!currentNamePresent && !desiredNamePresent) {
    return { kind: "ambiguous" };
  }
  return { kind: "same-entry", currentNamePresent, desiredNamePresent };
}

function recoveryPath(
  currentPath: string,
  pathImpl: PathImplementation
): string {
  const extension = pathImpl.extname(currentPath);
  return pathImpl.join(
    pathImpl.dirname(currentPath),
    `.pwrsnap-case-rename-${randomUUID()}${extension}`
  );
}

async function assertPathAbsent(
  filePath: string,
  statFile: StatIdentity
): Promise<void> {
  try {
    await statFile(filePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const error: NodeJS.ErrnoException = new Error(
    `rename destination already exists: ${filePath}`
  );
  error.code = "EEXIST";
  throw error;
}

/**
 * Rename without assuming platform case semantics. A case-only alias uses a
 * same-directory recovery name that preserves the real extension, so bundle
 * manifest/video hash startup repair can recover after either hop.
 */
export async function renameWithCaseSupport(
  currentPath: string,
  desiredPath: string,
  options: {
    renameFile?: RenameFile | undefined;
    statFile?: StatIdentity | undefined;
    readDirectory?: ReadDirectory | undefined;
    recoveryPath?: string | undefined;
    pathImpl?: PathImplementation | undefined;
  } = {}
): Promise<void> {
  const renameFile = options.renameFile ?? rename;
  const statFile = options.statFile ?? statIdentity;
  const pathImpl = options.pathImpl ?? hostPath;
  const destination = await inspectRenameDestination(currentPath, desiredPath, {
    statFile,
    readDirectory: options.readDirectory,
    pathImpl
  });

  if (destination.kind === "same-path") return;
  if (destination.kind === "absent") {
    await renameFile(currentPath, desiredPath);
    return;
  }
  if (
    destination.kind === "occupied" ||
    destination.kind === "ambiguous"
  ) {
    const error: NodeJS.ErrnoException = new Error(
      `rename destination is not safely replaceable: ${desiredPath}`
    );
    error.code = "EEXIST";
    throw error;
  }
  if (!destination.currentNamePresent && destination.desiredNamePresent) {
    return;
  }

  const intermediatePath =
    options.recoveryPath ?? recoveryPath(currentPath, pathImpl);
  await assertPathAbsent(intermediatePath, statFile);
  await renameFile(currentPath, intermediatePath);

  // Do not roll back if promotion fails. The intermediate retains .pwrsnap or
  // the video extension and is deliberately discoverable by boot repair.
  await assertPathAbsent(desiredPath, statFile);
  await renameFile(intermediatePath, desiredPath);
}
