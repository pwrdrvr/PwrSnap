import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  stat,
  type FileHandle
} from "node:fs/promises";
import { normalize, resolve } from "node:path";

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
  | "close_failed";

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
  close_failed: "Unable to close file"
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
   * Called for both the lexically resolved path and its canonical real path.
   * Domain-specific validators may throw their own path-free typed error.
   */
  validatePath?: VerifiedPathValidator;
};

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

async function inspectLeaf(filePath: string): Promise<BigIntStats> {
  let inspected: BigIntStats;
  try {
    inspected = await lstat(filePath, { bigint: true });
  } catch {
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

async function canonicalize(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    throw new VerifiedFileError("canonicalize_failed");
  }
}

async function inspectFollowing(filePath: string): Promise<BigIntStats> {
  let inspected: BigIntStats;
  try {
    inspected = await stat(filePath, { bigint: true });
  } catch {
    throw new VerifiedFileError("stat_failed");
  }
  if (!inspected.isFile()) {
    throw new VerifiedFileError("not_regular_file");
  }
  return inspected;
}

async function inspectHandle(handle: FileHandle): Promise<BigIntStats> {
  let inspected: BigIntStats;
  try {
    inspected = await handle.stat({ bigint: true });
  } catch {
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
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
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
 * leaf or parent replacement. Consumers must read from `handle`, never reopen
 * a pathname; a final fstat rejects in-place mutation during consumption.
 */
export async function withVerifiedFileHandle<T>(
  filePath: string,
  options: VerifiedFileOptions,
  consume: VerifiedFileConsumer<T>
): Promise<T> {
  const maxBytes = checkedMaxBytes(options.maxBytes);
  const resolvedPath = resolve(filePath);
  await options.validatePath?.(resolvedPath);

  const initialRawStat = await inspectLeaf(resolvedPath);
  const canonicalPath = await canonicalize(resolvedPath);
  await options.validatePath?.(canonicalPath);

  await beforeOpenHookForTest?.();

  // O_NOFOLLOW closes the final-component link race on POSIX. Windows does
  // not implement this flag; the explicit lstat plus identity checks below
  // provide the cross-platform defense there.
  const openFlags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;

  let handle: FileHandle;
  try {
    handle = await open(canonicalPath, openFlags);
  } catch (cause) {
    if (isErrno(cause, "ELOOP")) {
      throw new VerifiedFileError("symlink");
    }
    throw new VerifiedFileError("open_failed");
  }

  let completed = false;
  try {
    const openedStat = await inspectHandle(handle);
    if (maxBytes !== null && openedStat.size > maxBytes) {
      throw new VerifiedFileError("size_cap_exceeded");
    }

    // Re-check the caller's raw path after the canonical path is open. This
    // catches both a replaced leaf and a retargeted parent link/junction.
    const postRawLstat = await inspectLeaf(resolvedPath);
    await options.validatePath?.(resolvedPath);
    const postCanonicalPath = await canonicalize(resolvedPath);
    await options.validatePath?.(postCanonicalPath);
    const postRawStat = await inspectFollowing(resolvedPath);

    if (
      !sameCanonicalPath(canonicalPath, postCanonicalPath) ||
      !sameIdentity(initialRawStat, openedStat) ||
      !sameIdentity(postRawLstat, openedStat) ||
      !sameIdentity(postRawStat, openedStat)
    ) {
      throw new VerifiedFileError("file_changed");
    }

    const value = await consume(handle, openedStat);
    const finalHandleStat = await inspectHandle(handle);
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
