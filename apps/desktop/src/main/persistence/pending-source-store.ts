import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  getCacheSourcePath,
  getPendingSourceCaptureDir,
  getPendingSourcePath
} from "./paths";

const SOURCE_SHA_RE = /^[a-f0-9]{64}$/;

let tmpCounter = 0;

export class PendingSourceMissingError extends Error {
  constructor() {
    super("pending-source-store: source does not exist");
    this.name = "PendingSourceMissingError";
  }
}

export type PendingSourceMaterialization = {
  pendingCreated: boolean;
  cacheCreated: boolean;
};

/**
 * Materialize a raster source that has a live layer row but has not
 * yet been folded into the `.pwrsnap` bundle by the debounced repack.
 * The pending-sources copy is durable; the render-cache copy is only
 * an accelerator and may be cleared at any time.
 */
export async function materializePendingSourceForCapture(
  captureId: string,
  sha: string,
  bytes: Buffer
): Promise<PendingSourceMaterialization> {
  assertSourceSha(sha);
  const computed = createHash("sha256").update(bytes).digest("hex");
  if (computed !== sha) {
    throw new Error("pending-source-store: source content-hash mismatch");
  }

  const pendingCreated = await atomicWrite(
    getPendingSourcePath(captureId, sha),
    bytes
  );

  const cachePath = getCacheSourcePath(captureId).replace(/source\.png$/, `${sha}.png`);
  try {
    const cacheCreated = await atomicWrite(cachePath, bytes);
    return { pendingCreated, cacheCreated };
  } catch (cause) {
    if (pendingCreated) {
      await unlinkIfPresent(getPendingSourcePath(captureId, sha)).catch(
        () => undefined
      );
    }
    throw cause;
  }
}

/**
 * Roll back only files created by one materialization attempt. Callers must
 * first prove that no committed layer references the source hash.
 */
export async function rollbackPendingSourceMaterialization(
  captureId: string,
  sha: string,
  materialization: PendingSourceMaterialization
): Promise<void> {
  assertSourceSha(sha);
  const removals: Promise<void>[] = [];
  if (materialization.pendingCreated) {
    removals.push(unlinkIfPresent(getPendingSourcePath(captureId, sha)));
  }
  if (materialization.cacheCreated) {
    const cachePath = getCacheSourcePath(captureId).replace(
      /source\.png$/,
      `${sha}.png`
    );
    removals.push(unlinkIfPresent(cachePath));
  }
  await Promise.all(removals);
}

export async function readPendingSourceForCapture(
  captureId: string,
  sha: string
): Promise<Buffer> {
  assertSourceSha(sha);
  let bytes: Buffer;
  try {
    bytes = await readFile(getPendingSourcePath(captureId, sha));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      throw new PendingSourceMissingError();
    }
    throw cause;
  }

  const computed = createHash("sha256").update(bytes).digest("hex");
  if (computed !== sha) {
    throw new Error("pending-source-store: source content-hash mismatch");
  }
  return bytes;
}

export async function deletePendingSourcesForCapture(
  captureId: string,
  shas?: Iterable<string>
): Promise<void> {
  if (shas === undefined) {
    await rm(getPendingSourceCaptureDir(captureId), { recursive: true, force: true });
    return;
  }

  await Promise.allSettled(
    [...shas].map(async (sha) => {
      assertSourceSha(sha);
      await unlink(getPendingSourcePath(captureId, sha)).catch((cause) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          return;
        }
        throw cause;
      });
    })
  );
}

function assertSourceSha(sha: string): void {
  if (!SOURCE_SHA_RE.test(sha)) {
    throw new Error("pending-source-store: invalid source hash");
  }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<boolean> {
  const existed = await pathExists(path);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${tmpCounter++}`;
  try {
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, path);
    return !existed;
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((cause) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return;
    }
    throw cause;
  });
}
