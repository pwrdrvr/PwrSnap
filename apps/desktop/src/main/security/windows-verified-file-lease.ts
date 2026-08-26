import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type WindowsVerifiedFileLeaseErrorCode =
  | "native_verifier_unavailable"
  | "native_verifier_failed"
  | "invalid_path"
  | "stat_failed"
  | "canonicalize_failed"
  | "symlink"
  | "not_regular_file"
  | "open_failed";

const ERROR_MESSAGES: Readonly<
  Record<WindowsVerifiedFileLeaseErrorCode, string>
> = {
  native_verifier_unavailable: "Native file verifier is unavailable",
  native_verifier_failed: "Native file verifier failed",
  invalid_path: "Invalid file path",
  stat_failed: "Unable to inspect file",
  canonicalize_failed: "Unable to resolve file",
  symlink: "Linked files are not allowed",
  not_regular_file: "Only regular files are allowed",
  open_failed: "Unable to open file"
};

export class WindowsVerifiedFileLeaseError extends Error {
  readonly code: WindowsVerifiedFileLeaseErrorCode;

  constructor(code: WindowsVerifiedFileLeaseErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "WindowsVerifiedFileLeaseError";
    this.code = code;
  }
}

export type WindowsVerifiedFileLease = {
  finalPath: string;
  size: bigint;
  dev: bigint;
  ino: bigint;
  release: () => Promise<void>;
};

const PRODUCTION_HELPER_NAME = "PwrSnapVerifiedFile.exe";
const DEV_HELPER_NAME = "verified-file.exe";
const METADATA_LIMIT_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 10_000;

let helperPathOverrideForTest: string | null = null;

export function __setWindowsVerifiedFileHelperPathForTest(
  path: string | null
): void {
  helperPathOverrideForTest = path;
}

export function resolveWindowsVerifiedFileHelperPath(): string | null {
  if (process.platform !== "win32") return null;
  if (helperPathOverrideForTest !== null) return helperPathOverrideForTest;

  const candidates = [
    typeof process.resourcesPath === "string"
      ? join(process.resourcesPath, PRODUCTION_HELPER_NAME)
      : null,
    // electron-vite bundle: apps/desktop/out/main -> apps/desktop/build
    join(__dirname, "..", "..", "build", "native", DEV_HELPER_NAME),
    // source-form Vitest: apps/desktop/src/main/security -> apps/desktop/build
    join(__dirname, "..", "..", "..", "build", "native", DEV_HELPER_NAME),
    join(process.cwd(), "apps", "desktop", "build", "native", DEV_HELPER_NAME)
  ].filter((candidate): candidate is string => candidate !== null);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

type HelperMetadata = {
  ok: true;
  finalPath: string;
  size: string;
  dev: string;
  ino: string;
};

function isHelperMetadata(value: unknown): value is HelperMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.ok === true &&
    typeof candidate.finalPath === "string" &&
    typeof candidate.size === "string" &&
    typeof candidate.dev === "string" &&
    typeof candidate.ino === "string"
  );
}

function helperErrorCode(value: unknown): WindowsVerifiedFileLeaseErrorCode {
  if (typeof value !== "object" || value === null) {
    return "native_verifier_failed";
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code !== "string" || !(code in ERROR_MESSAGES)) {
    return "native_verifier_failed";
  }
  return code as WindowsVerifiedFileLeaseErrorCode;
}

function terminateHelper(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

async function readMetadataLine(
  child: ChildProcessWithoutNullStreams,
  filePath: string
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      finish(new WindowsVerifiedFileLeaseError("native_verifier_failed"));
    }, HELPER_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== null) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > METADATA_LIMIT_BYTES) {
        finish(new WindowsVerifiedFileLeaseError("native_verifier_failed"));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const line = buffered.subarray(0, newline).toString("utf8").trim();
        finish(null, JSON.parse(line) as unknown);
      } catch {
        finish(new WindowsVerifiedFileLeaseError("native_verifier_failed"));
      }
    };
    const onError = (): void => {
      finish(new WindowsVerifiedFileLeaseError("native_verifier_failed"));
    };
    // `exit` can precede delivery of the helper's final stdout bytes. `close`
    // runs after stdio closes, so a path-free semantic rejection (for example
    // `symlink`) cannot be misclassified as a generic helper crash.
    const onClose = (): void => {
      finish(new WindowsVerifiedFileLeaseError("native_verifier_failed"));
    };

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.write(`${filePath}\n`, "utf8", (cause) => {
      if (cause !== null && cause !== undefined) onError();
    });
  });
}

async function releaseHelper(
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode === 0) return;
    throw new WindowsVerifiedFileLeaseError("native_verifier_failed");
  }

  const outcome = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      terminateHelper(child);
      reject(new WindowsVerifiedFileLeaseError("native_verifier_failed"));
    }, HELPER_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new WindowsVerifiedFileLeaseError("native_verifier_failed"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.stdin.end("release\n");
  });
  if (outcome !== 0) {
    throw new WindowsVerifiedFileLeaseError("native_verifier_failed");
  }
}

/**
 * Atomically open and hold a Windows leaf with reparse traversal disabled.
 * The helper withholds write/delete sharing until `release`, covering the
 * gap while Node opens and validates its read-only FileHandle.
 */
export async function acquireWindowsVerifiedFileLease(
  filePath: string
): Promise<WindowsVerifiedFileLease> {
  const helperPath = resolveWindowsVerifiedFileHelperPath();
  if (helperPath === null) {
    throw new WindowsVerifiedFileLeaseError("native_verifier_unavailable");
  }

  const child = spawn(helperPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let metadataValue: unknown;
  try {
    metadataValue = await readMetadataLine(child, filePath);
  } catch (cause) {
    terminateHelper(child);
    throw cause;
  }
  if (!isHelperMetadata(metadataValue)) {
    const code = helperErrorCode(metadataValue);
    terminateHelper(child);
    throw new WindowsVerifiedFileLeaseError(code);
  }

  try {
    const size = BigInt(metadataValue.size);
    const dev = BigInt(metadataValue.dev);
    const ino = BigInt(metadataValue.ino);
    if (size < 0n || dev < 0n || ino < 0n) throw new Error("negative metadata");
    let released = false;
    return {
      finalPath: metadataValue.finalPath,
      size,
      dev,
      ino,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        await releaseHelper(child);
      }
    };
  } catch {
    terminateHelper(child);
    throw new WindowsVerifiedFileLeaseError("native_verifier_failed");
  }
}
