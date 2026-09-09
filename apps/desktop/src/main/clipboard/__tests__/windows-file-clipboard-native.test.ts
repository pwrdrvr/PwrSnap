// Real Windows guest smoke for the predefined numeric CF_HDROP contract.
//
// This deliberately runs only on Windows CI: it writes the process clipboard,
// which is appropriate on the disposable GitHub runner but not during an
// ordinary developer unit-test run. The Windows CI lane forces a clean helper
// compile immediately before enabling this spec, so a missing/invalid helper,
// custom-format impostor, malformed DROPFILES, or broken packaged subcommand
// fails before release.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => "" },
  clipboard: {
    availableFormats: () => [],
    readBuffer: () => Buffer.alloc(0),
    writeBuffer: () => undefined
  },
  screen: {}
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

const { runWindowsFileClipboardHelper } = await import("../file-clipboard");
const { readWindowsClipboardImageFile } = await import(
  "../windows-file-clipboard-reader"
);

let workRoot: string | null = null;

afterEach(async () => {
  if (workRoot !== null) {
    await rm(workRoot, { recursive: true, force: true });
    workRoot = null;
  }
});

test.skipIf(
  process.platform !== "win32" ||
    process.env.PWRSNAP_WINDOWS_NATIVE_CLIPBOARD_SMOKE !== "1"
)(
  "native helper writes and reads one real CF_HDROP image path",
  async () => {
    const helperPath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "build",
      "native",
      "window-list.exe"
    );
    workRoot = await mkdtemp(join(tmpdir(), "pwrsnap-cf-hdrop-smoke-"));
    const imagePath = resolve(workRoot, "PwrSnap CF_HDROP smoke.gif");
    // The native file contract validates existence/nonzero/extension; image
    // decoding belongs to the independent capture ingest tests.
    await writeFile(imagePath, Buffer.from("GIF89a", "ascii"));

    await runWindowsFileClipboardHelper(helperPath, imagePath);
    const result = await readWindowsClipboardImageFile({
      platform: "win32",
      helperPath
    });

    expect(result).toEqual({ ok: true, path: imagePath });
  },
  15_000
);
