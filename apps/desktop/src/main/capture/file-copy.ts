// Copying a recording for `capture:duplicate`: a clone when the volume can
// make one, a streamed byte copy with progress and cancellation when not.
//
// Why two functions rather than one `copyFile`:
//
//   Node's `COPYFILE_FICLONE` does NOT clone on macOS. libuv has no
//   clonefile path there (measured on Node 24 / libuv 1.51:
//   `COPYFILE_FICLONE_FORCE` fails with ENOSYS, and a 2 GB `FICLONE` copy
//   on APFS took 10.5 s, slower than a plain copy). `/bin/cp -c` calls
//   clonefile(2) and finishes the same file in under 10 ms. On Linux the
//   FICLONE ioctl is real (Btrfs, XFS); on Windows libuv implements
//   neither, so every copy there is a byte copy.
//
//   And a byte copy through `copyFile` cannot report progress or be
//   stopped. A multi-gigabyte recording on an external drive is a copy
//   the user watches and may want to call off, so the slow path is our
//   own read/write loop.
//
// Neither function touches anything but the two paths it is given, and
// both remove their destination on any failure. Both are async: the
// captures root is TCC-gated (see AGENTS.md).

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * How long `cp -c` may run before it is taken to have fallen back to a
 * byte copy. A clone is metadata only — measured under 10 ms for 2 GB —
 * but cp gives no sign that it fell back (its man page: "cp will fallback
 * to using copyfile(2) instead"), and a fallback copy has no progress and
 * no cancel. Past this the clone attempt is killed and the streamed copy
 * starts over. Generous on purpose: a heavily fragmented file clones
 * slower than a fresh one, and a false "too slow" only costs a re-copy.
 */
export const CLONE_GRACE_MS = 750;

/** Bytes per read/write in the streamed copy. Big enough that syscall
 *  overhead disappears on a fast SSD, small enough that progress and
 *  cancellation stay responsive on a slow USB stick (~100 ms per chunk at
 *  40 MB/s). */
export const STREAM_COPY_CHUNK_BYTES = 4 * 1024 * 1024;

export type CloneOptions = {
  platform?: NodeJS.Platform;
  graceMs?: number;
};

/**
 * Clone `src` to `dest` (which must not exist) if the volume can do it
 * near-instantly. `true` means `dest` is a complete copy. `false` means no
 * clone was made and `dest` does not exist — the caller byte-copies.
 * Never throws for "cannot clone"; callers treat any failure here as a
 * reason to take the slow path, which reports real errors properly.
 */
export async function cloneFileFast(
  src: string,
  dest: string,
  options: CloneOptions = {}
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return cloneWithCp(src, dest, options.graceMs ?? CLONE_GRACE_MS);
  }
  if (platform === "linux") {
    try {
      await copyFile(
        src,
        dest,
        fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE
      );
      return true;
    } catch {
      await rm(dest, { force: true }).catch(() => undefined);
      return false;
    }
  }
  // Windows: libuv answers FICLONE_FORCE with ENOSYS. Don't spend a call.
  return false;
}

async function cloneWithCp(src: string, dest: string, graceMs: number): Promise<boolean> {
  // clonefile(2) only works within one volume, and cp silently byte-copies
  // across two. Different devices → don't start a copy we'd have to kill.
  try {
    const [srcStat, destDirStat] = await Promise.all([stat(src), stat(dirname(dest))]);
    if (srcStat.dev !== destDirStat.dev) return false;
  } catch {
    return false;
  }

  const outcome = await new Promise<"cloned" | "failed" | "too-slow">((resolve) => {
    let settled = false;
    const child = spawn("/bin/cp", ["-c", "--", src, dest], { stdio: "ignore" });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Wait for the kill to land, so the rm below cannot race cp
      // recreating the file it was still writing.
      child.once("close", () => resolve("too-slow"));
      child.kill("SIGKILL");
    }, graceMs);
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve("failed");
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? "cloned" : "failed");
    });
  });
  if (outcome === "cloned") return true;
  await rm(dest, { force: true }).catch(() => undefined);
  return false;
}

export type StreamCopyOptions = {
  signal?: AbortSignal;
  /** Called after every chunk is written. Throttle in the caller. */
  onProgress?: (bytesCopied: number, totalBytes: number) => void;
  chunkBytes?: number;
};

/**
 * Byte-copy `src` to `dest` (created exclusively; it must not exist),
 * reporting progress and honouring `signal`. The data is flushed to disk
 * before this resolves, because the caller renames `dest` into place and
 * records it as a finished capture: a power cut after that must not leave
 * a capture whose file is a hole.
 *
 * On any failure, including an abort, `dest` is removed and the error is
 * rethrown (for an abort, `signal.reason`).
 */
export async function streamCopyFile(
  src: string,
  dest: string,
  options: StreamCopyOptions = {}
): Promise<number> {
  const { signal, onProgress } = options;
  const chunkBytes = options.chunkBytes ?? STREAM_COPY_CHUNK_BYTES;
  signal?.throwIfAborted();

  const input = await open(src, "r");
  let output: Awaited<ReturnType<typeof open>> | null = null;
  try {
    output = await open(dest, "wx");
    const totalBytes = (await input.stat()).size;
    onProgress?.(0, totalBytes);
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let copied = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, chunkBytes, copied);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await output.write(buffer, written, bytesRead - written, copied + written);
        written += bytesWritten;
      }
      copied += bytesRead;
      onProgress?.(copied, totalBytes);
    }
    signal?.throwIfAborted();
    await output.datasync();
    await output.close();
    output = null;
    return copied;
  } catch (cause) {
    if (output !== null) await output.close().catch(() => undefined);
    // Only remove what we created: an EEXIST from `wx` means `dest` is
    // someone else's file.
    if (output !== null || !isErrno(cause, "EEXIST")) {
      await rm(dest, { force: true }).catch(() => undefined);
    }
    throw cause;
  } finally {
    await input.close().catch(() => undefined);
  }
}

function isErrno(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === code;
}
