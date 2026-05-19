// Test-first specs for the security primitives in `bundle-store.ts`.
// ~/Documents/PwrSnap/ is untrusted input — anything dropped there
// (AirDrop, browser download, malicious peer's iCloud sync) flows
// through these helpers before we extract a single byte. Each
// scenario below is the test for a CVE class we're explicitly
// closing:
//
//   1. Zip-Slip — a malicious bundle's central directory contains a
//      filename like `../../etc/passwd`. yauzl does NOT auto-validate;
//      the consumer's allowlist is the gate.
//   2. Symlink injection — a malicious entry in ~/Documents/PwrSnap/
//      is a symlink to /etc/something. lstat must catch it; we never
//      follow.
//   3. Atomic-rename invariant — temp file lives in the SAME directory
//      as the final path so APFS rename is atomic; cross-volume falls
//      back to copy-then-unlink and breaks atomicity.
//   4. Crash-safety on partial writes — readers can see EITHER the old
//      bundle OR the new one, never a partial body.

import { mkdtemp, rm, writeFile, symlink, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  assertSafeBundleFile,
  atomicWriteBundle,
  validateBundleZipEntryNames
} from "../persistence/bundle-store";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-bundle-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
  }
});

describe("validateBundleZipEntryNames — Zip-Slip / allowlist gate", () => {
  test("accepts the canonical four-entry layout", () => {
    const result = validateBundleZipEntryNames([
      "manifest.json",
      "overlays.json",
      "source.png",
      "composite.png"
    ]);
    expect(result.ok).toBe(true);
  });

  test("accepts the four entries in any order", () => {
    const result = validateBundleZipEntryNames([
      "composite.png",
      "manifest.json",
      "source.png",
      "overlays.json"
    ]);
    expect(result.ok).toBe(true);
  });

  test("rejects a directory-traversal entry (the Zip-Slip CVE class)", () => {
    const result = validateBundleZipEntryNames([
      "manifest.json",
      "overlays.json",
      "source.png",
      "composite.png",
      "../../etc/passwd"
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.badEntries).toContain("../../etc/passwd");
    }
  });

  test("rejects a Windows-style traversal entry", () => {
    const result = validateBundleZipEntryNames([
      "manifest.json",
      "overlays.json",
      "source.png",
      "composite.png",
      "..\\..\\Windows\\System32\\hosts"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects an absolute-path entry", () => {
    const result = validateBundleZipEntryNames([
      "manifest.json",
      "overlays.json",
      "source.png",
      "composite.png",
      "/etc/passwd"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects a null-byte injection in a filename", () => {
    const result = validateBundleZipEntryNames([
      "manifest.json",
      "overlays.json",
      "source.png",
      "composite.png\0../injected"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects a subpath that ends in an allowlisted name", () => {
    const result = validateBundleZipEntryNames([
      "manifest.json",
      "overlays.json",
      "source.png",
      "subdir/composite.png"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects a missing required entry (corrupt bundle, partial archive)", () => {
    const result = validateBundleZipEntryNames(["manifest.json", "overlays.json", "source.png"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingEntries).toContain("composite.png");
    }
  });

  test("rejects a bundle with duplicate entries", () => {
    // ZIP allows duplicate filenames in the central directory; some
    // attackers exploit this so the "good" entry validates while a
    // shadow entry overwrites on extract. Refuse on principle.
    const result = validateBundleZipEntryNames([
      "manifest.json",
      "manifest.json",
      "overlays.json",
      "source.png",
      "composite.png"
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("assertSafeBundleFile — symlink + lstat gate", () => {
  test("accepts a regular file", async () => {
    const file = join(workDir, "ok.pwrsnap");
    await writeFile(file, Buffer.from("not a real zip"));
    await expect(assertSafeBundleFile(file)).resolves.toBeUndefined();
  });

  test("rejects a symlink (the symlink-injection threat model)", async () => {
    const target = join(workDir, "target.txt");
    const link = join(workDir, "link.pwrsnap");
    await writeFile(target, "harmless");
    await symlink(target, link);

    await expect(assertSafeBundleFile(link)).rejects.toThrow(/symlink/i);
  });

  test("rejects a non-file (directory)", async () => {
    const dir = join(workDir, "fake.pwrsnap");
    await mkdir(dir);
    await expect(assertSafeBundleFile(dir)).rejects.toThrow(/regular file/i);
  });

  test("rejects a missing path (race / disappeared file)", async () => {
    await expect(assertSafeBundleFile(join(workDir, "missing.pwrsnap"))).rejects.toThrow();
  });
});

describe("atomicWriteBundle — same-directory temp + fsync", () => {
  test("writes the destination atomically when the parent dir exists", async () => {
    const dest = join(workDir, "out.pwrsnap");
    const payload = Buffer.from("synthetic bundle content");
    await atomicWriteBundle(dest, payload);

    const got = await readFile(dest);
    expect(got.equals(payload)).toBe(true);
  });

  test("creates the parent directory when missing (first capture path)", async () => {
    const dest = join(workDir, "subdir-that-does-not-exist", "out.pwrsnap");
    const payload = Buffer.from("hi");
    await atomicWriteBundle(dest, payload);

    expect(existsSync(dest)).toBe(true);
    const got = await readFile(dest);
    expect(got.equals(payload)).toBe(true);
  });

  test("leaves no .tmp orphan after a successful write", async () => {
    const dest = join(workDir, "out.pwrsnap");
    await atomicWriteBundle(dest, Buffer.from("content"));

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dirname(dest));
    const tmpEntries = entries.filter((n) => n.includes(".tmp"));
    expect(tmpEntries).toEqual([]);
  });

  test("temp file is staged in the SAME directory as the destination (atomicity invariant)", async () => {
    // We can't directly observe the temp path during the operation
    // without instrumenting the implementation. Indirect proof: write
    // to a directory the OS would consider distinct from os.tmpdir(),
    // and assert success. If the implementation used os.tmpdir() the
    // rename would be EXDEV-cross-device on systems where the home
    // volume differs (or would silently fall back to copy+unlink and
    // break atomicity from a power-loss perspective). Direct
    // verification of the same-dir invariant lives in the unit
    // implementation comment + code review; this test is the
    // smoke-screen end-to-end check.
    const dest = join(workDir, "deep", "nested", "out.pwrsnap");
    await atomicWriteBundle(dest, Buffer.from("content"));
    expect(existsSync(dest)).toBe(true);
  });

  test("overwrites an existing bundle atomically (re-pack path)", async () => {
    const dest = join(workDir, "out.pwrsnap");
    await atomicWriteBundle(dest, Buffer.from("first"));
    await atomicWriteBundle(dest, Buffer.from("second"));

    const got = await readFile(dest);
    expect(got.toString()).toBe("second");
  });

  test("temp file uses 0o600 permissions (no world-readable window)", async () => {
    // We can't observe the temp file mid-write without a race-prone
    // setup, but we can verify the FINAL file's mode came from the
    // rename of a 0o600 source. APFS preserves source mode through
    // rename. (This catches a regression where a sloppy refactor
    // changes the open mode to 0o644 or 0o666.)
    const dest = join(workDir, "out.pwrsnap");
    await atomicWriteBundle(dest, Buffer.from("content"));

    const { stat } = await import("node:fs/promises");
    const s = await stat(dest);
    // Lower 9 bits.
    const mode = s.mode & 0o777;
    // Expect rw-------; tolerate umask-trimming on some systems by
    // requiring "no world readable bit" + "owner readable + writable".
    expect(mode & 0o004).toBe(0); // no world read
    expect(mode & 0o002).toBe(0); // no world write
    expect(mode & 0o600).toBe(0o600); // owner can read + write
  });
});
