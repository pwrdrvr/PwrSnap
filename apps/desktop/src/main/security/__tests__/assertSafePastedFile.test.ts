// Unit tests for the Phase 5 paste/drop security gate.
//
// Exercises the four reject cases the gate guarantees:
//
//   1. Symlinks → refuse (could redirect at ~/.ssh/id_rsa).
//   2. Non-regular files (directories, fifos) → refuse.
//   3. Paths inside privileged dirs → refuse.
//   4. Missing files → refuse (with a sanitized "Invalid file" message).
//
// Plus the happy path: a plain image file passes through with the
// resolved absolute path returned.
//
// The privileged-dir list is overridden via the test-only setter so we
// don't have to write inside ~/.ssh or /private/etc to exercise the
// branch.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  __setPrivilegedPrefixesForTest,
  assertSafePastedFile,
  UnsafePastedFileError
} from "../assertSafePastedFile";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pwrsnap-paste-test-"));
});

afterEach(async () => {
  __setPrivilegedPrefixesForTest(null);
  await rm(dir, { recursive: true, force: true });
});

describe("assertSafePastedFile", () => {
  test("happy path: plain regular file returns resolved path", async () => {
    const file = join(dir, "ok.png");
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await assertSafePastedFile(file);
    expect(result).toBe(resolve(file));
  });

  test("refuses symlinks (UnsafePastedFileError code=symlink)", async () => {
    const target = join(dir, "target.png");
    const link = join(dir, "link.png");
    await writeFile(target, Buffer.from([0x89]));
    await symlink(target, link);
    await expect(assertSafePastedFile(link)).rejects.toMatchObject({
      name: "UnsafePastedFileError",
      code: "symlink",
      sanitizedMessage: "Invalid file"
    });
  });

  test("refuses directories (UnsafePastedFileError code=not_regular_file)", async () => {
    const subdir = join(dir, "subdir");
    await mkdir(subdir);
    await expect(assertSafePastedFile(subdir)).rejects.toMatchObject({
      name: "UnsafePastedFileError",
      code: "not_regular_file",
      sanitizedMessage: "Invalid file"
    });
  });

  test("refuses missing files (UnsafePastedFileError code=stat_failed)", async () => {
    const missing = join(dir, "nope.png");
    await expect(assertSafePastedFile(missing)).rejects.toMatchObject({
      name: "UnsafePastedFileError",
      code: "stat_failed",
      sanitizedMessage: "Invalid file"
    });
  });

  test("refuses paths inside privileged dirs (code=privileged_path)", async () => {
    // Override the privileged-prefix list to point at our temp dir so
    // we can write a file "inside" a privileged prefix without
    // touching ~/.ssh.
    const fakePrivileged = join(dir, "fake-privileged");
    await mkdir(fakePrivileged);
    __setPrivilegedPrefixesForTest([fakePrivileged]);
    const insidePrivileged = join(fakePrivileged, "secret.png");
    await writeFile(insidePrivileged, Buffer.from([0x89]));
    await expect(assertSafePastedFile(insidePrivileged)).rejects.toMatchObject({
      name: "UnsafePastedFileError",
      code: "privileged_path",
      sanitizedMessage: "Invalid file"
    });
  });

  test("refuses path-traversal into privileged dirs", async () => {
    // `<dir>/safe/../fake-privileged/secret.png` resolves to
    // `<dir>/fake-privileged/secret.png` — must be rejected even though
    // the literal prefix in the input string doesn't match.
    const fakePrivileged = join(dir, "fake-privileged");
    await mkdir(fakePrivileged);
    __setPrivilegedPrefixesForTest([fakePrivileged]);
    const insidePrivileged = join(fakePrivileged, "secret.png");
    await writeFile(insidePrivileged, Buffer.from([0x89]));
    const traversal = join(dir, "safe", "..", "fake-privileged", "secret.png");
    await expect(assertSafePastedFile(traversal)).rejects.toMatchObject({
      name: "UnsafePastedFileError",
      code: "privileged_path"
    });
  });

  // Case-insensitive filesystems (Windows always; macOS/APFS by default) must
  // reject a differently-cased path inside a privileged dir — `resolve()`
  // preserves case, so a naive case-sensitive `startsWith` would let it
  // through. Gated to win32, where case-insensitivity is guaranteed (a
  // case-sensitive APFS volume would make the miscased path a genuinely
  // different, non-existent file); the fold itself still applies on macOS.
  test.runIf(process.platform === "win32")(
    "refuses a differently-cased path inside a privileged dir",
    async () => {
      const fakePrivileged = join(dir, "fake-privileged");
      await mkdir(fakePrivileged);
      __setPrivilegedPrefixesForTest([fakePrivileged]);
      const insidePrivileged = join(fakePrivileged, "secret.png");
      await writeFile(insidePrivileged, Buffer.from([0x89]));
      // Flip the case of the privileged segment; on a case-insensitive FS this
      // resolves to the very same file and must still be refused.
      const miscased = insidePrivileged.replace("fake-privileged", "FAKE-PRIVILEGED");
      await expect(assertSafePastedFile(miscased)).rejects.toMatchObject({
        name: "UnsafePastedFileError",
        code: "privileged_path"
      });
    }
  );

  test("UnsafePastedFileError exposes raw message via .message + sanitized via .sanitizedMessage", async () => {
    const file = join(dir, "nope.png");
    let caught: unknown = null;
    try {
      await assertSafePastedFile(file);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsafePastedFileError);
    if (!(caught instanceof UnsafePastedFileError)) throw new Error("type guard");
    // .message is for main-side logs and includes the path.
    expect(caught.message).toContain(file);
    // .sanitizedMessage is what handlers return to renderers — never
    // includes the path.
    expect(caught.sanitizedMessage).toBe("Invalid file");
    expect(caught.sanitizedMessage).not.toContain(file);
  });
});
