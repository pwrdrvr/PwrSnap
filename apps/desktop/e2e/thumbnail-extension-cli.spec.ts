// Thumbnail extension CLI spec — runs the prebuilt
// pwrsnap-thumbnail-cli binary against a freshly-packed fixture
// bundle and asserts the output decodes as the expected JPEG/PNG.
//
// macOS-only by construction (the CLI is a Swift Mach-O), and gated
// on the binary existing — `pnpm dev` doesn't compile native targets
// for the desktop suite, only `scripts/build-native.mjs` (run as
// part of `pnpm --filter @pwrsnap/desktop package` or explicitly by
// dev). The fixture skips with an informative message instead of
// failing when the binary isn't present, so the suite stays green
// in environments that haven't built native targets yet.
//
// What this catches:
//   - Bundle-format drift between the TS writer (bundle-store.ts)
//     and the Swift reader (zip-reader.swift). If yazl's central-
//     directory layout changes, or the entry names get renamed, or
//     the fallback chain (composite_thumbnail.jpg →
//     composite.png → source.png) loses a step, this spec breaks
//     before the extension misrenders in users' Finders.
//   - CLI exit-code regressions (1 for unreadable, 2 for no
//     thumbnail entry, 3 for IO/usage errors).
//   - Sandbox-incompatible code paths sneaking into the extraction
//     logic — the CLI runs without the sandbox so anything that
//     works here but fails in the real extension is a sandbox
//     denial, easy to spot from logs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import yazl from "yazl";

const __filename = fileURLToPath(import.meta.url);
const desktopRoot = resolve(__filename, "..", "..");
const cliPath = join(desktopRoot, "build", "native", "pwrsnap-thumbnail-cli");

const isMac = process.platform === "darwin";

/** Smallest valid PNG: 8x8 fully red pixel grid (RGBA, no filtering
 *  beyond zlib's deflate). Hand-rolled so the spec has no runtime
 *  dependency on sharp / canvas / native imaging — the bytes here
 *  decode through `file` and Apple's NSImage just fine. */
function makeRedPng(): Buffer {
  // Pre-encoded 8×8 RGBA red PNG. Bytes captured from
  // `sharp({ create: { width: 8, height: 8, channels: 4, background:
  // { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()` and
  // inlined so the spec has no async fixture-prep step.
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVQYV2P8z" +
    "8DwnwEHYBxVCAcAQA4HARkbAAAAAElFTkSuQmCC";
  return Buffer.from(base64, "base64");
}

/** Smallest valid JPEG. Same shape rationale as makeRedPng — keeps
 *  the spec self-contained. */
function makeRedJpeg(): Buffer {
  const base64 =
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQ" +
    "oHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBD" +
    "AQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB" +
    "QUFBQUFBQUFBQUFBQUFBQUFBT/wgARCAAIAAgDASIAAhEBAxEB/8QAFwABAQEB" +
    "AAAAAAAAAAAAAAAAAAUGB//EABUBAQEAAAAAAAAAAAAAAAAAAAAB/9oADAMBAA" +
    "IQAxAAAAFmKAB//EABYQAQEBAAAAAAAAAAAAAAAAAAEAEv/aAAgBAQABBQI8//" +
    "EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8BH//EABQRAQAAAAAAAAAAAA" +
    "AAAAAAACD/2gAIAQIBAT8BH//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEABj" +
    "8CH//EABUQAQEAAAAAAAAAAAAAAAAAAAAB/9oACAEBAAE/IT//2gAMAwEAAgADAA" +
    "AAEIB//8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAwEBPxAf/8QAFBEBAAAAAA" +
    "AAAAAAAAAAAAAAIP/aAAgBAgEBPxAf/8QAFRABAQAAAAAAAAAAAAAAAAAAAAH/2g" +
    "AIAQEAAT8QP//Z";
  return Buffer.from(base64, "base64");
}

/** Pack a synthetic `.pwrsnap` bundle with the given entries at a
 *  temp path. Returns the path. We use yazl directly (rather than
 *  `bundle-store.ts#packBundle`) because the spec wants control
 *  over which entries are present — testing the fallback chain
 *  means writing variants the production writer no longer emits. */
function packFixtureBundle(
  entries: Record<string, Buffer>
): Promise<string> {
  return new Promise((resolveBundle, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "pwrsnap-cli-spec-"));
    const path = join(dir, "fixture.pwrsnap");
    const zip = new yazl.ZipFile();
    for (const [name, buf] of Object.entries(entries)) {
      // PNG / JPEG go STORE to match production layout. JSON entries
      // we don't include here (the CLI doesn't validate manifests).
      zip.addBuffer(buf, name, { compress: false });
    }
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => {
      writeFileSync(path, Buffer.concat(chunks));
      resolveBundle(path);
    });
    zip.outputStream.on("error", reject);
    zip.end();
  });
}

/** Invoke the CLI with `-o <outPath>` and return `{ exitCode,
 *  stderr, output }`. Errors throw with full context so the test
 *  failure surfaces what actually happened. */
function runCli(
  bundlePath: string
): { exitCode: number; stderr: string; output: Buffer | null } {
  const outPath = join(
    mkdtempSync(join(tmpdir(), "pwrsnap-cli-spec-out-")),
    "thumb.bin"
  );
  const result = spawnSync(cliPath, [bundlePath, "-o", outPath], {
    encoding: "buffer"
  });
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr?.toString("utf-8") ?? "",
    output: existsSync(outPath) ? readFileSync(outPath) : null
  };
}

test.describe("pwrsnap-thumbnail-cli", () => {
  test.skip(!isMac, "CLI is a macOS Swift binary");
  test.skip(
    !existsSync(cliPath),
    `CLI not built — run \`pnpm --filter @pwrsnap/desktop package\` ` +
    `or \`node apps/desktop/scripts/build-native.mjs\` to compile it ` +
    `(expected at ${cliPath})`
  );

  test("returns composite_thumbnail.jpg when present (preferred path)", async () => {
    const jpeg = makeRedJpeg();
    const png = makeRedPng();
    const bundle = await packFixtureBundle({
      "manifest.json": Buffer.from(
        JSON.stringify({ bundle_format_version: 1, capture_id: "test-fixture" })
      ),
      "overlays.json": Buffer.from("{}"),
      "source.png": png,
      "composite_thumbnail.jpg": jpeg
    });
    const { exitCode, stderr, output } = runCli(bundle);
    expect(exitCode, stderr).toBe(0);
    expect(output, "no output written").not.toBeNull();
    expect(output!.equals(jpeg), "should have returned the JPEG verbatim").toBe(true);
  });

  test("falls back to composite.png when no thumbnail is present (legacy bundles)", async () => {
    const png = makeRedPng();
    const composite = makeRedPng();
    const bundle = await packFixtureBundle({
      "manifest.json": Buffer.from(
        JSON.stringify({ bundle_format_version: 1, capture_id: "test-fixture" })
      ),
      "source.png": png,
      "composite.png": composite
    });
    const { exitCode, stderr, output } = runCli(bundle);
    expect(exitCode, stderr).toBe(0);
    expect(output, "no output written").not.toBeNull();
    expect(output!.equals(composite), "should have returned composite.png").toBe(true);
  });

  test("falls back to source.png for small captures (no thumbnail, no composite)", async () => {
    const png = makeRedPng();
    const bundle = await packFixtureBundle({
      "manifest.json": Buffer.from(
        JSON.stringify({ bundle_format_version: 1, capture_id: "test-fixture" })
      ),
      "source.png": png
    });
    const { exitCode, stderr, output } = runCli(bundle);
    expect(exitCode, stderr).toBe(0);
    expect(output, "no output written").not.toBeNull();
    expect(output!.equals(png), "should have returned source.png").toBe(true);
  });

  test("exits non-zero with no-composite-entry on bundles missing every image", async () => {
    const bundle = await packFixtureBundle({
      "manifest.json": Buffer.from(
        JSON.stringify({ bundle_format_version: 1, capture_id: "test-fixture" })
      ),
      "overlays.json": Buffer.from("{}")
    });
    const { exitCode, stderr, output } = runCli(bundle);
    // Exit code 2 = no eligible entry per cli.swift contract.
    expect(exitCode, stderr).toBe(2);
    expect(stderr).toContain("no composite or source entry");
    expect(output).toBeNull();
  });

  test("exits non-zero with malformed-zip on truncated bundle", async () => {
    const bundle = await packFixtureBundle({
      "manifest.json": Buffer.from("{}"),
      "source.png": makeRedPng()
    });
    // Truncate by writing only the first 32 bytes — well short of
    // the End-of-Central-Directory record.
    writeFileSync(bundle, readFileSync(bundle).subarray(0, 32));
    const { exitCode, stderr } = runCli(bundle);
    // Exit code 1 = bundle unreadable / not a ZIP per cli.swift.
    expect(exitCode, stderr).toBe(1);
  });
});
