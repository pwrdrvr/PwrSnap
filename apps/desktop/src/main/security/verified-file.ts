import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  stat,
  type FileHandle
} from "node:fs/promises";
import { normalize, resolve } from "node:path";
import { normalizeWindowsPathForPolicy } from "./windows-path";
import {
  acquireWindowsVerifiedFileLease,
  WindowsVerifiedFileLeaseError,
  type WindowsVerifiedFileLease
} from "./windows-verified-file-lease";

export type VerifiedFileErrorCode =
  | "invalid_size_limit"
  | "stat_failed"
  | "canonicalize_failed"
  | "symlink"
  | "not_regular_file"
  | "open_failed"
  | "file_changed"
  | "size_cap_exceeded"
  | "read_failed"
  | "close_failed"
  | "native_verifier_unavailable"
  | "native_verifier_failed";

const ERROR_MESSAGES: Readonly<Record<VerifiedFileErrorCode, string>> = {
  invalid_size_limit: "Invalid file size limit",
  stat_failed: "Unable to inspect file",
  canonicalize_failed: "Unable to resolve file",
  symlink: "Linked files are not allowed",
  not_regular_file: "Only regular files are allowed",
  open_failed: "Unable to open file",
  file_changed: "File changed while it was being opened",
  size_cap_exceeded: "File is too large",
  read_failed: "Unable to read file",
  close_failed: "Unable to close file",
  native_verifier_unavailable: "Native file verifier is unavailable",
  native_verifier_failed: "Native file verifier failed"
};

/**
 * A deliberately path-free error for untrusted external-file reads. Neither
 * the message nor any public property contains the candidate path or a raw
 * filesystem error, so this object is safe to translate into logs or a bus
 * Result without accidentally disclosing a private absolute path.
 */
export class VerifiedFileError extends Error {
  readonly code: VerifiedFileErrorCode;

  constructor(code: VerifiedFileErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VerifiedFileError";
    this.code = code;
  }
}

export type VerifiedPathValidator = (
  candidatePath: string
) => void | Promise<void>;

export type VerifiedFileOptions = {
  /** Refuse the file before consumption when its opened size exceeds this. */
  maxBytes?: number;
  /**
   * Internal accounting hook invoked with a raw filesystem failure before it
   * is replaced by a path-free VerifiedFileError. Callers must not surface or
   * persist the raw error; this exists so trusted-path health accounting can
   * recognize platform errno values such as macOS TCC's EPERM.
   */
  onFileSystemError?: (cause: unknown) => void;
  /**
   * Called for both the lexically resolved path and its canonical real path.
   * Domain-specific validators may throw their own path-free typed error.
   */
  validatePath?: VerifiedPathValidator;
};

/**
 * Read-only staging callback. It may build private temporary/staged output,
 * but the caller must not publish that output until the wrapper resolves.
 */
export type VerifiedFileConsumer<T> = (
  handle: FileHandle,
  openedStat: BigIntStats
) => T | Promise<T>;

type BeforeOpenHook = () => void | Promise<void>;
let beforeOpenHookForTest: BeforeOpenHook | null = null;

/** Test-only deterministic seam for replacing a candidate before `open()`. */
export function __setVerifiedFileBeforeOpenHookForTest(
  hook: BeforeOpenHook | null
): void {
  beforeOpenHookForTest = hook;
}

function isErrno(cause: unknown, code: string): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === code
  );
}

function reportFileSystemError(options: VerifiedFileOptions, cause: unknown): void {
  try {
    options.onFileSystemError?.(cause);
  } catch {
    // Observability must never replace the verifier's path-free typed error.
  }
}

async function inspectLeaf(
  filePath: string,
  options: VerifiedFileOptions
): Promise<BigIntStats> {
  let inspected: BigIntStats;
  try {
    inspected = await lstat(filePath, { bigint: true });
  } catch (cause) {
    reportFileSystemError(options, cause);
    throw new VerifiedFileError("stat_failed");
  }
  if (inspected.isSymbolicLink()) {
    // On Windows, directory junctions are surfaced by lstat as symbolic links
    // too. Keep this explicit even though O_NOFOLLOW provides a second POSIX
    // defense at open time.
    throw new VerifiedFileError("symlink");
  }
  if (!inspected.isFile()) {
    throw new VerifiedFileError("not_regular_file");
  }
  return inspected;
}

async function canonicalize(
  filePath: string,
  options: VerifiedFileOptions
): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (cause) {
    reportFileSystemError(options, cause);
    throw new VerifiedFileError("canonicalize_failed");
  }
}

async function inspectFollowing(
  filePath: string,
  options: VerifiedFileOptions
): Promise<BigIntStats> {
  let inspected: BigIntStats;
  try {
    inspected = await stat(filePath, { bigint: true });
  } catch (cause) {
    reportFileSystemError(options, cause);
    throw new VerifiedFileError("stat_failed");
  }
  if (!inspected.isFile()) {
    throw new VerifiedFileError("not_regular_file");
  }
  return inspected;
}

async function inspectHandle(
  handle: FileHandle,
  options: VerifiedFileOptions
): Promise<BigIntStats> {
  let inspected: BigIntStats;
  try {
    inspected = await handle.stat({ bigint: true });
  } catch (cause) {
    reportFileSystemError(options, cause);
    throw new VerifiedFileError("stat_failed");
  }
  if (!inspected.isFile()) {
    throw new VerifiedFileError("not_regular_file");
  }
  return inspected;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameStableSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameCanonicalPath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    const normalizedLeft = normalizeWindowsPathForPolicy(left);
    const normalizedRight = normalizeWindowsPathForPolicy(right);
    return (
      normalizedLeft !== null &&
      normalizedRight !== null &&
      normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    );
  }
  return normalize(left) === normalize(right);
}

function sameLeaseIdentity(
  lease: WindowsVerifiedFileLease,
  openedStat: BigIntStats
): boolean {
  return lease.dev === openedStat.dev && lease.ino === openedStat.ino;
}

function checkedMaxBytes(maxBytes: number | undefined): bigint | null {
  if (maxBytes === undefined) return null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new VerifiedFileError("invalid_size_limit");
  }
  return BigInt(maxBytes);
}

/**
 * Open an untrusted pathname once, prove the opened handle is the regular file
 * that was validated, and keep that handle alive only for the awaited callback.
 *
 * Opening the canonical path prevents a parent symlink/junction from being
 * retargeted between validation and open. The post-open raw-path checks detect
 * leaf or parent replacement. On Windows, a narrow native helper atomically
 * opens the leaf without following a reparse point and holds a no-write,
 * no-delete lease through the final fstat.
 *
 * The consumer is a staging callback, not a commit callback: it must read only
 * from `handle`, must not reopen the pathname or close the handle, and must not
 * publish externally visible side effects. It may return privately staged
 * data. The caller commits that data only after this wrapper resolves, because
 * resolution occurs after the final stability check and handle/lease cleanup.
 */
export async function withVerifiedFileHandle<T>(
  filePath: string,
  options: VerifiedFileOptions,
  consume: VerifiedFileConsumer<T>
): Promise<T> {
  const maxBytes = checkedMaxBytes(options.maxBytes);
  const resolvedPath = resolve(filePath);
  await options.validatePath?.(resolvedPath);

  if (process.platform === "win32") {
    if (normalizeWindowsPathForPolicy(resolvedPath) === null) {
      throw new VerifiedFileError("open_failed");
    }
    const initialRawStat = await inspectLeaf(resolvedPath, options);
    return await withWindowsVerifiedFileHandle(
      resolvedPath,
      initialRawStat,
      maxBytes,
      options,
      consume
    );
  }

  const initialRawStat = await inspectLeaf(resolvedPath, options);
  const canonicalPath = await canonicalize(resolvedPath, options);
  await options.validatePath?.(canonicalPath);

  await beforeOpenHookForTest?.();

  // O_NOFOLLOW closes the final-component link race on POSIX. O_NONBLOCK is
  // load-bearing too: a raced regular-file-to-FIFO replacement must fail at
  // fstat instead of parking the worker at open while it waits for a writer.
  const openFlags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

  let handle: FileHandle;
  try {
    handle = await open(canonicalPath, openFlags);
  } catch (cause) {
    reportFileSystemError(options, cause);
    if (isErrno(cause, "ELOOP")) {
      throw new VerifiedFileError("symlink");
    }
    throw new VerifiedFileError("open_failed");
  }

  let completed = false;
  try {
    const openedStat = await inspectHandle(handle, options);
    if (maxBytes !== null && openedStat.size > maxBytes) {
      throw new VerifiedFileError("size_cap_exceeded");
    }

    // Re-check the caller's raw path after the canonical path is open. This
    // catches both a replaced leaf and a retargeted parent link/junction.
    const postRawLstat = await inspectLeaf(resolvedPath, options);
    await options.validatePath?.(resolvedPath);
    const postCanonicalPath = await canonicalize(resolvedPath, options);
    await options.validatePath?.(postCanonicalPath);
    const postRawStat = await inspectFollowing(resolvedPath, options);

    if (
      !sameCanonicalPath(canonicalPath, postCanonicalPath) ||
      !sameIdentity(initialRawStat, openedStat) ||
      !sameIdentity(postRawLstat, openedStat) ||
      !sameIdentity(postRawStat, openedStat)
    ) {
      throw new VerifiedFileError("file_changed");
    }

    const value = await consume(handle, openedStat);
    const finalHandleStat = await inspectHandle(handle, options);
    if (!sameStableSnapshot(openedStat, finalHandleStat)) {
      throw new VerifiedFileError("file_changed");
    }
    completed = true;
    return value;
  } finally {
    try {
      await handle.close();
    } catch {
      // Preserve a more useful callback/verification failure. If all prior
      // work succeeded, surface a typed, path-free close failure.
      if (completed) throw new VerifiedFileError("close_failed");
    }
  }
}

function translateWindowsLeaseError(cause: unknown): VerifiedFileError {
  if (!(cause instanceof WindowsVerifiedFileLeaseError)) {
    return new VerifiedFileError("native_verifier_failed");
  }
  switch (cause.code) {
    case "native_verifier_unavailable":
    case "native_verifier_failed":
    case "stat_failed":
    case "canonicalize_failed":
    case "symlink":
    case "not_regular_file":
    case "open_failed":
      return new VerifiedFileError(cause.code);
    case "invalid_path":
      return new VerifiedFileError("open_failed");
  }
}

async function withWindowsVerifiedFileHandle<T>(
  resolvedPath: string,
  initialRawStat: BigIntStats,
  maxBytes: bigint | null,
  options: VerifiedFileOptions,
  consume: VerifiedFileConsumer<T>
): Promise<T> {
  await beforeOpenHookForTest?.();

  let lease: WindowsVerifiedFileLease;
  try {
    lease = await acquireWindowsVerifiedFileLease(resolvedPath);
  } catch (cause) {
    throw translateWindowsLeaseError(cause);
  }
  let handle: FileHandle | null = null;
  let completed = false;
  try {
    await options.validatePath?.(lease.finalPath);
    try {
      handle = await open(lease.finalPath, constants.O_RDONLY);
    } catch (cause) {
      reportFileSystemError(options, cause);
      throw new VerifiedFileError("open_failed");
    }

    const openedStat = await inspectHandle(handle, options);
    if (
      !sameLeaseIdentity(lease, openedStat) ||
      !sameIdentity(initialRawStat, openedStat) ||
      lease.size !== openedStat.size
    ) {
      throw new VerifiedFileError("file_changed");
    }
    if (maxBytes !== null && openedStat.size > maxBytes) {
      throw new VerifiedFileError("size_cap_exceeded");
    }

    // The native lease makes replacement of the opened leaf fail while these
    // raw-path checks prove that a parent junction still names that leaf.
    const postRawLstat = await inspectLeaf(resolvedPath, options);
    await options.validatePath?.(resolvedPath);
    const postCanonicalPath = await canonicalize(resolvedPath, options);
    await options.validatePath?.(postCanonicalPath);
    const postRawStat = await inspectFollowing(resolvedPath, options);
    if (
      !sameCanonicalPath(lease.finalPath, postCanonicalPath) ||
      !sameIdentity(postRawLstat, openedStat) ||
      !sameIdentity(postRawStat, openedStat)
    ) {
      throw new VerifiedFileError("file_changed");
    }

    const value = await consume(handle, openedStat);
    const finalHandleStat = await inspectHandle(handle, options);
    if (!sameStableSnapshot(openedStat, finalHandleStat)) {
      throw new VerifiedFileError("file_changed");
    }
    completed = true;
    return value;
  } finally {
    let cleanupFailed = false;
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await lease.release();
    } catch {
      cleanupFailed = true;
    }
    if (completed && cleanupFailed) {
      throw new VerifiedFileError("close_failed");
    }
  }
}

async function readExactSnapshot(
  handle: FileHandle,
  openedStat: BigIntStats
): Promise<Buffer> {
  if (openedStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VerifiedFileError("size_cap_exceeded");
  }
  const size = Number(openedStat.size);
  let bytes: Buffer;
  try {
    bytes = Buffer.allocUnsafe(size);
  } catch {
    throw new VerifiedFileError("read_failed");
  }

  let offset = 0;
  try {
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) {
        throw new VerifiedFileError("file_changed");
      }
      offset += result.bytesRead;
    }

    // The pre-open fstat supplies the exact allocation size. Probe one byte at
    // the expected EOF so growth can never silently evade the memory bound.
    const eofProbe = Buffer.allocUnsafe(1);
    const probe = await handle.read(eofProbe, 0, 1, size);
    if (probe.bytesRead !== 0) {
      throw new VerifiedFileError("file_changed");
    }
  } catch (cause) {
    if (cause instanceof VerifiedFileError) throw cause;
    throw new VerifiedFileError("read_failed");
  }
  return bytes;
}

/** Read a bounded, immutable-in-time byte snapshot without reopening a path. */
export async function readVerifiedFileSnapshot(
  filePath: string,
  options: { maxBytes: number; validatePath?: VerifiedPathValidator }
): Promise<Buffer> {
  return await withVerifiedFileHandle(filePath, options, readExactSnapshot);
}
