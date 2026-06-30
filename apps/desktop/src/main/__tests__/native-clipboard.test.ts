// Unit coverage for the native multi-format clipboard write wrapper.
//
// The real write targets NSPasteboard, which a vitest can't observe —
// so instead of the bundled Swift helper we inject a fake stdin-reading
// shell script via __setNativeClipboardHelperForTests and assert the
// spawn / stdin-payload / exit-code plumbing. The actual NSPasteboard
// behavior (single declareTypes pass carrying the private UTI + PNG +
// TIFF) is verified at the binary level and via the manual dev paste
// round-trip documented in the PR.

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  writeMultiFormatClipboard,
  __setNativeClipboardHelperForTests
} from "../native-clipboard";

let workDir: string;
let capturePath: string;
let argsPath: string;

/** Write an executable fake helper that records the args + stdin it
 *  received and exits with `FAKE_CLIP_EXIT` (default 0). */
async function installFakeHelper(): Promise<string> {
  const scriptPath = join(workDir, "fake-helper.sh");
  await writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      // Record argv[1] and the full stdin body so the test can assert
      // the command shape + payload.
      'printf "%s" "$1" > "$FAKE_CLIP_ARGS"',
      'cat > "$FAKE_CLIP_OUT"',
      'exit "${FAKE_CLIP_EXIT:-0}"',
      ""
    ].join("\n")
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-native-clip-"));
  capturePath = join(workDir, "stdin.json");
  argsPath = join(workDir, "args.txt");
  process.env.FAKE_CLIP_OUT = capturePath;
  process.env.FAKE_CLIP_ARGS = argsPath;
  delete process.env.FAKE_CLIP_EXIT;
});

afterEach(async () => {
  __setNativeClipboardHelperForTests(null);
  delete process.env.FAKE_CLIP_OUT;
  delete process.env.FAKE_CLIP_ARGS;
  delete process.env.FAKE_CLIP_EXIT;
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("writeMultiFormatClipboard", () => {
  test("returns false (no spawn) when no helper is resolvable", async () => {
    // Default: helper override cleared + VITEST set → auto-resolution
    // is gated off, so the caller falls back to clipboard.writeBuffer.
    const result = await writeMultiFormatClipboard({
      utiName: "com.pwrdrvr.pwrsnap.layer-fragment",
      utiBytes: Buffer.from("frag"),
      pngBytes: Buffer.from("png")
    });
    expect(result).toBe(false);
  });

  test("spawns the helper with --write-clipboard and pipes the base64 payload on stdin", async () => {
    __setNativeClipboardHelperForTests(await installFakeHelper());

    const utiBytes = Buffer.from(JSON.stringify({ format_version: 1 }), "utf8");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // "‰PNG"

    const result = await writeMultiFormatClipboard({
      utiName: "com.pwrdrvr.pwrsnap.layer-fragment",
      utiBytes,
      pngBytes
    });

    expect(result).toBe(true);
    expect((await readFile(argsPath, "utf8")).trim()).toBe("--write-clipboard");

    const payload = JSON.parse(await readFile(capturePath, "utf8"));
    expect(payload.utiName).toBe("com.pwrdrvr.pwrsnap.layer-fragment");
    expect(payload.utiBase64).toBe(utiBytes.toString("base64"));
    expect(payload.pngBase64).toBe(pngBytes.toString("base64"));
    // No TIFF supplied → key omitted; the helper derives it from PNG.
    expect("tiffBase64" in payload).toBe(false);
  });

  test("passes through a caller-supplied TIFF body", async () => {
    __setNativeClipboardHelperForTests(await installFakeHelper());
    const tiffBytes = Buffer.from([0x49, 0x49, 0x2a, 0x00]); // little-endian TIFF magic

    const result = await writeMultiFormatClipboard({
      utiName: "com.pwrdrvr.pwrsnap.layer-fragment",
      utiBytes: Buffer.from("frag"),
      pngBytes: Buffer.from("png"),
      tiffBytes
    });

    expect(result).toBe(true);
    const payload = JSON.parse(await readFile(capturePath, "utf8"));
    expect(payload.tiffBase64).toBe(tiffBytes.toString("base64"));
  });

  test("returns false when the helper exits non-zero", async () => {
    __setNativeClipboardHelperForTests(await installFakeHelper());
    process.env.FAKE_CLIP_EXIT = "5";

    const result = await writeMultiFormatClipboard({
      utiName: "com.pwrdrvr.pwrsnap.layer-fragment",
      utiBytes: Buffer.from("frag"),
      pngBytes: Buffer.from("png")
    });

    expect(result).toBe(false);
  });

  test("returns false when the helper path does not exist (spawn error)", async () => {
    __setNativeClipboardHelperForTests(join(workDir, "does-not-exist"));

    const result = await writeMultiFormatClipboard({
      utiName: "com.pwrdrvr.pwrsnap.layer-fragment",
      utiBytes: Buffer.from("frag"),
      pngBytes: Buffer.from("png")
    });

    expect(result).toBe(false);
  });
});
