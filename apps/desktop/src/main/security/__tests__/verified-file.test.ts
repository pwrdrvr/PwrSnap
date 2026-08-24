import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  __setVerifiedFileBeforeOpenHookForTest,
  readVerifiedFileSnapshot,
  VerifiedFileError,
  withVerifiedFileHandle
} from "../verified-file";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pwrsnap-verified-file-"));
});

afterEach(async () => {
  __setVerifiedFileBeforeOpenHookForTest(null);
  await rm(dir, { recursive: true, force: true });
});

describe("verified external files", () => {
  test("reads a normal file as an exact bounded byte snapshot", async () => {
    const file = join(dir, "safe.bin");
    const expected = Buffer.from("safe snapshot");
    await writeFile(file, expected);

    await expect(
      readVerifiedFileSnapshot(file, { maxBytes: expected.byteLength })
    ).resolves.toEqual(expected);
  });

  test("rejects a regular-file replacement before open by handle identity", async () => {
    const file = join(dir, "candidate.bin");
    const original = join(dir, "original.bin");
    await writeFile(file, "trusted");
    let consumed = false;
    __setVerifiedFileBeforeOpenHookForTest(async () => {
      await rename(file, original);
      await writeFile(file, "replacement");
    });

    await expect(
      withVerifiedFileHandle(file, {}, async () => {
        consumed = true;
      })
    ).rejects.toMatchObject({
      name: "VerifiedFileError",
      code: "file_changed"
    });
    expect(consumed).toBe(false);
  });

  test("a replace-after-open consumer reads the opened inode, not the new path", async () => {
    const file = join(dir, "candidate.bin");
    const moved = join(dir, "opened-original.bin");
    await writeFile(file, "opened bytes");

    const observation: { consumed?: Buffer } = {};
    await expect(
      withVerifiedFileHandle(file, {}, async (handle) => {
        await rename(file, moved);
        await writeFile(file, "swapped bytes");
        observation.consumed = await handle.readFile();
      })
    ).rejects.toMatchObject({ code: "file_changed" });

    // The path now names attacker-controlled bytes, but the callback saw the
    // already-opened original. The final ctime check additionally rejects the
    // rename instead of treating this adversarial operation as success.
    expect(observation.consumed).toBeDefined();
    expect(observation.consumed?.toString()).toBe("opened bytes");
  });

  test("refuses oversize input before allocating or invoking the consumer", async () => {
    const file = join(dir, "large.bin");
    await writeFile(file, Buffer.alloc(9, 0x61));
    let consumed = false;

    let caught: unknown;
    try {
      await withVerifiedFileHandle(file, { maxBytes: 8 }, () => {
        consumed = true;
      });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(VerifiedFileError);
    expect(caught).toMatchObject({ code: "size_cap_exceeded" });
    expect(consumed).toBe(false);
  });

  test("typed errors never expose the candidate absolute path", async () => {
    const missing = join(dir, "private-name.bin");
    let caught: unknown;
    try {
      await readVerifiedFileSnapshot(missing, { maxBytes: 32 });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(VerifiedFileError);
    if (!(caught instanceof VerifiedFileError)) throw new Error("type guard");
    expect(caught.code).toBe("stat_failed");
    expect(caught.message).not.toContain(missing);
    expect(Object.values(caught)).not.toContain(missing);
  });
});
