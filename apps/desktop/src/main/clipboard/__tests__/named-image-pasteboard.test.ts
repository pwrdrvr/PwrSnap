// Unit coverage for the named-image pasteboard-writer wrapper.
//
// The real write targets NSPasteboard via the bundled Swift helper, which
// a vitest can't observe — so we inject an argv-recording fake script via
// __setNamedImagePasteboardHelperForTests and assert the spawn / argument
// plumbing: `--png` + `--file-url` always, `--meta <json>` only when the
// caller supplies the clip-meta diagnostics payload. The actual
// NSPasteboard behavior (public.png + public.file-url +
// com.pwrdrvr.pwrsnap.clip-meta, and NO eagerly-declared public.tiff) is
// verified at the binary level and via the clipboard-copy E2E spec.

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// named-image-pasteboard imports electron's `app` at module scope; the
// test seam + VITEST guard mean it's never called here, but the import
// itself must not explode under vitest.
vi.mock("electron", () => ({
  app: {
    getAppPath: () => {
      throw new Error("app.getAppPath unavailable in tests");
    }
  }
}));

const { writeNamedPngToPasteboard, __setNamedImagePasteboardHelperForTests } = await import(
  "../named-image-pasteboard"
);

let workDir: string;
let argsPath: string;

/** Write an executable fake helper that records its full argv, one arg
 *  per line, and exits with `FAKE_PBW_EXIT` (default 0). */
async function installFakeHelper(): Promise<string> {
  const scriptPath = join(workDir, "fake-pasteboard-writer.sh");
  await writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      ': > "$FAKE_PBW_ARGS"',
      'for arg in "$@"; do printf "%s\\n" "$arg" >> "$FAKE_PBW_ARGS"; done',
      'exit "${FAKE_PBW_EXIT:-0}"',
      ""
    ].join("\n")
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function recordedArgs(): Promise<string[]> {
  const body = await readFile(argsPath, "utf8");
  return body.length === 0 ? [] : body.replace(/\n$/, "").split("\n");
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-named-pbw-"));
  argsPath = join(workDir, "args.txt");
  process.env.FAKE_PBW_ARGS = argsPath;
  delete process.env.FAKE_PBW_EXIT;
});

afterEach(async () => {
  __setNamedImagePasteboardHelperForTests(null);
  delete process.env.FAKE_PBW_ARGS;
  delete process.env.FAKE_PBW_EXIT;
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

// macOS-only: the plumbing is exercised via a `#!/bin/sh` fake helper,
// which Windows can't spawn directly, and the real pasteboard-writer is
// macOS-only anyway — same policy as native-clipboard.test.ts.
describe.skipIf(process.platform !== "darwin")("writeNamedPngToPasteboard", () => {
  test("returns false (no spawn) when no helper is resolvable", async () => {
    // Seam cleared + VITEST set → auto-resolution is gated off, so the
    // caller falls back to Electron's image clipboard.
    const result = await writeNamedPngToPasteboard({
      pngPath: "/tmp/a.png",
      fileUrlPath: "/tmp/a-alias.png"
    });
    expect(result).toBe(false);
  });

  test("spawns the helper with --png and --file-url, no --meta when omitted", async () => {
    __setNamedImagePasteboardHelperForTests(await installFakeHelper());

    const result = await writeNamedPngToPasteboard({
      pngPath: "/tmp/render.png",
      fileUrlPath: "/tmp/PwrSnap-render.png"
    });

    expect(result).toBe(true);
    expect(await recordedArgs()).toEqual([
      "--png",
      "/tmp/render.png",
      "--file-url",
      "/tmp/PwrSnap-render.png"
    ]);
  });

  test("passes the clip-meta JSON through as --meta", async () => {
    __setNamedImagePasteboardHelperForTests(await installFakeHelper());
    const metaJson = JSON.stringify({
      captureId: "cap_123",
      preset: "med",
      seq: 7,
      ts: 1753900000000,
      pid: 4242
    });

    const result = await writeNamedPngToPasteboard({
      pngPath: "/tmp/render.png",
      fileUrlPath: "/tmp/PwrSnap-render.png",
      metaJson
    });

    expect(result).toBe(true);
    const args = await recordedArgs();
    expect(args.slice(0, 4)).toEqual([
      "--png",
      "/tmp/render.png",
      "--file-url",
      "/tmp/PwrSnap-render.png"
    ]);
    expect(args[4]).toBe("--meta");
    expect(JSON.parse(args[5]!)).toEqual({
      captureId: "cap_123",
      preset: "med",
      seq: 7,
      ts: 1753900000000,
      pid: 4242
    });
  });

  test("returns false when the helper exits non-zero", async () => {
    __setNamedImagePasteboardHelperForTests(await installFakeHelper());
    process.env.FAKE_PBW_EXIT = "3";

    const result = await writeNamedPngToPasteboard({
      pngPath: "/tmp/render.png",
      fileUrlPath: "/tmp/PwrSnap-render.png"
    });

    expect(result).toBe(false);
  });
});
