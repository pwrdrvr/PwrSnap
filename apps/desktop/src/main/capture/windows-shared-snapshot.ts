import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  WINDOWS_SNAPSHOT_HEADER_BYTES,
  parseWindowsSnapshotHeader,
  validateWindowsSnapshotDescriptor,
  type WindowsSnapshotHeader
} from "./windows-snapshot-format";

const PRODUCTION_HELPER_NAME = "PwrSnapScreenSnapshot.exe";
const DEV_HELPER_NAME = "screen-snapshot.exe";
const MAPPING_PREFIX = "Local\\PwrSnapSnapshot-";
const HELPER_TIMEOUT_MS = 10_000;
const STDERR_LIMIT_BYTES = 16 * 1024;
const READY_LIMIT_BYTES = 16 * 1024;

export type ElectronBitmapPixelFormat = "bgra8" | "rgba8";

export type WindowsSharedSnapshot = Readonly<{
  header: WindowsSnapshotHeader;
  read: () => Promise<Buffer>;
  release: () => Promise<void>;
}>;

export class WindowsSharedSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsSharedSnapshotError";
  }
}

let helperPathOverrideForTest: string | null = null;

export function __setWindowsSnapshotHelperPathForTest(path: string | null): void {
  helperPathOverrideForTest = path;
}

export function resolveWindowsSnapshotHelperPath(): string | null {
  if (helperPathOverrideForTest !== null) return helperPathOverrideForTest;
  if (process.platform !== "win32") return null;
  const candidates = [
    typeof process.resourcesPath === "string"
      ? join(process.resourcesPath, PRODUCTION_HELPER_NAME)
      : null,
    join(__dirname, "..", "..", "build", "native", DEV_HELPER_NAME),
    join(__dirname, "..", "..", "..", "build", "native", DEV_HELPER_NAME),
    join(process.cwd(), "apps", "desktop", "build", "native", DEV_HELPER_NAME)
  ].filter((candidate): candidate is string => candidate !== null);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

function boundedStderr(child: ChildProcessWithoutNullStreams): () => string {
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.byteLength >= STDERR_LIMIT_BYTES) return;
    const remaining = STDERR_LIMIT_BYTES - stderr.byteLength;
    stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
  });
  return () => stderr.toString("utf8").trim();
}

async function readyLine(child: ChildProcessWithoutNullStreams): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    let done = false;
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new WindowsSharedSnapshotError("helper ready timeout")), HELPER_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (cause: Error | null, value?: unknown): void => {
      if (done) return;
      done = true;
      cleanup();
      if (cause !== null) reject(cause);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > READY_LIMIT_BYTES) {
        finish(new WindowsSharedSnapshotError("helper ready response exceeded its bound"));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(buffered.subarray(0, newline).toString("utf8")) as unknown);
      } catch {
        finish(new WindowsSharedSnapshotError("helper returned malformed ready metadata"));
      }
    };
    const onError = (): void => finish(new WindowsSharedSnapshotError("helper failed before ready"));
    const onClose = (): void => finish(new WindowsSharedSnapshotError("helper exited before ready"));
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function parseReadyMetadata(value: unknown, expected: WindowsSnapshotHeader): void {
  if (typeof value !== "object" || value === null) {
    throw new WindowsSharedSnapshotError("helper ready metadata was not an object");
  }
  const metadata = value as Record<string, unknown>;
  let byteLength: number;
  let totalByteLength: number;
  try {
    const byteLengthBig = BigInt(metadata.byteLength as string);
    const totalByteLengthBig = BigInt(metadata.totalByteLength as string);
    if (
      byteLengthBig > BigInt(Number.MAX_SAFE_INTEGER) ||
      totalByteLengthBig > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("unsafe length");
    }
    byteLength = Number(byteLengthBig);
    totalByteLength = Number(totalByteLengthBig);
  } catch {
    throw new WindowsSharedSnapshotError("helper ready metadata contained invalid lengths");
  }
  if (
    metadata.ok !== true ||
    metadata.version !== expected.version ||
    metadata.width !== expected.width ||
    metadata.height !== expected.height ||
    metadata.stride !== expected.stride ||
    byteLength !== expected.byteLength ||
    totalByteLength !== expected.totalByteLength
  ) {
    throw new WindowsSharedSnapshotError("helper ready metadata did not match the requested mapping");
  }
}

async function writeBitmap(
  child: ChildProcessWithoutNullStreams,
  bitmap: Buffer
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(bitmap, (cause) => {
      if (cause !== null && cause !== undefined) reject(cause);
      else resolve();
    });
  });
}

async function readMapping(
  helperPath: string,
  mappingName: string,
  expected: WindowsSnapshotHeader
): Promise<Buffer> {
  const child = spawn(
    helperPath,
    ["--read", mappingName, expected.nonceHex, String(expected.totalByteLength)],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  ) as ChildProcessWithoutNullStreams;
  child.stdin.end();
  const stderr = boundedStderr(child);
  return await new Promise<Buffer>((resolve, reject) => {
    let done = false;
    let offset = 0;
    const output = Buffer.allocUnsafe(expected.totalByteLength);
    const timer = setTimeout(() => {
      terminateChild(child);
      finish(new WindowsSharedSnapshotError("snapshot read helper timed out"));
    }, HELPER_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (cause: Error | null, value?: Buffer): void => {
      if (done) return;
      done = true;
      cleanup();
      if (cause !== null) reject(cause);
      else resolve(value!);
    };
    const onData = (chunk: Buffer): void => {
      if (offset + chunk.byteLength > output.byteLength) {
        terminateChild(child);
        finish(new WindowsSharedSnapshotError("snapshot reader exceeded the declared mapping length"));
        return;
      }
      chunk.copy(output, offset);
      offset += chunk.byteLength;
    };
    const onError = (): void => finish(new WindowsSharedSnapshotError("snapshot reader failed"));
    const onClose = (code: number | null): void => {
      if (code !== 0 || offset !== output.byteLength) {
        finish(
          new WindowsSharedSnapshotError(
            `snapshot reader failed (${code ?? "signal"}): ${stderr() || "incomplete output"}`
          )
        );
        return;
      }
      try {
        const header = parseWindowsSnapshotHeader(output, expected);
        if (header.totalByteLength !== output.byteLength) {
          throw new WindowsSharedSnapshotError("snapshot reader returned a mismatched length");
        }
        finish(null, output.subarray(WINDOWS_SNAPSHOT_HEADER_BYTES));
      } catch (cause) {
        finish(
          cause instanceof Error
            ? cause
            : new WindowsSharedSnapshotError("snapshot reader returned an invalid header")
        );
      }
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function releaseOwner(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      terminateChild(child);
      finish();
    }, HELPER_TIMEOUT_MS);
    child.once("close", finish);
    child.once("error", finish);
    try {
      child.stdin.end("release\n");
    } catch {
      terminateChild(child);
      finish();
    }
  });
}

/**
 * Copy Electron's platform bitmap into a normalized pagefile mapping.
 * The returned read operation always returns RGBA8/sRGB/opaque bytes.
 */
export async function createWindowsSharedSnapshot(args: {
  bitmap: Buffer;
  width: number;
  height: number;
  sourcePixelFormat: ElectronBitmapPixelFormat;
}): Promise<WindowsSharedSnapshot> {
  const helperPath = resolveWindowsSnapshotHelperPath();
  if (helperPath === null) {
    throw new WindowsSharedSnapshotError("Windows snapshot helper is unavailable");
  }
  const nonceHex = randomBytes(16).toString("hex");
  const stride = args.width * 4;
  const header = validateWindowsSnapshotDescriptor({
    width: args.width,
    height: args.height,
    stride,
    byteLength: args.bitmap.byteLength,
    nonceHex
  });
  const mappingName = `${MAPPING_PREFIX}${nonceHex}`;
  const child = spawn(
    helperPath,
    [
      "--create",
      mappingName,
      nonceHex,
      String(header.width),
      String(header.height),
      String(header.stride),
      args.sourcePixelFormat
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );
  const stderr = boundedStderr(child);
  try {
    const [metadata] = await Promise.all([readyLine(child), writeBitmap(child, args.bitmap)]);
    parseReadyMetadata(metadata, header);
  } catch (cause) {
    terminateChild(child);
    const detail = stderr();
    throw new WindowsSharedSnapshotError(
      `${cause instanceof Error ? cause.message : String(cause)}${detail ? `: ${detail}` : ""}`
    );
  }

  let released = false;
  let ownerAlive = true;
  child.once("close", () => {
    ownerAlive = false;
  });
  return {
    header,
    read: async (): Promise<Buffer> => {
      if (released || !ownerAlive) {
        throw new WindowsSharedSnapshotError("snapshot mapping is no longer available");
      }
      return await readMapping(helperPath, mappingName, header);
    },
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      await releaseOwner(child);
    }
  };
}
