// Several files on the clipboard at once (the cart's Copy all). The rule: a
// copy reports success only when the clipboard names EVERY file, in order —
// a helper that verified one file, or a Linux clipboard that kept a
// different list, is a failed copy.

import { spawn } from "node:child_process";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  clipboard: {
    read: vi.fn(async () => []),
    write: vi.fn(async () => undefined)
  },
  ClipboardItem: class {},
  nativeImage: {}
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

const {
  linuxFileListFlavors,
  runWindowsFileClipboardHelper,
  uriListFilePaths,
  writeLinuxFilesToClipboard
} = await import("../file-clipboard");

/** A fake helper that acknowledges `files` paths. */
function ackHelper(files: number) {
  return () =>
    spawn(process.execPath, [
      "-e",
      `process.stdout.write(JSON.stringify({ok:true,format:"CF_HDROP",files:${files},dropEffect:"copy"}))`
    ]);
}

// Absolute POSIX paths with spaces, unicode and URL-reserved characters.
const segmentArb = fc
  .stringMatching(/^[A-Za-z0-9 ._()#%&+,;=@é漢-]{1,16}$/)
  .filter((s) => s !== "." && s !== "..");
const posixPathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => "/" + segments.join("/") + ".png");

describe("Windows multi-file CF_HDROP", () => {
  test("passes every path as its own argv value, in order", async () => {
    const paths = ["C:\\out\\Granola grid.png", "\\\\server\\share\\Oat milk.png", "C:\\out\\Bran.png"];
    let args: readonly string[] = [];
    await runWindowsFileClipboardHelper("helper.exe", paths, (_command, argv) => {
      args = argv;
      return ackHelper(3)();
    });
    expect(args).toEqual(["--write-file-clipboard", ...paths]);
  });

  test("an ack for fewer files than were written is a failed copy", async () => {
    // Before Copy all, the ack was required to say `files: 1` — a helper
    // that only wrote the first path would have passed.
    await expect(
      runWindowsFileClipboardHelper("helper.exe", ["C:\\a.png", "C:\\b.png"], ackHelper(1))
    ).rejects.toThrow("did not verify a CF_HDROP");
  });

  test("an ack that names more files than were written is a failed copy", async () => {
    await expect(runWindowsFileClipboardHelper("helper.exe", "C:\\a.png", ackHelper(2))).rejects.toThrow(
      "did not verify a CF_HDROP"
    );
  });

  test("no files is refused before the helper runs", async () => {
    const spawnHelper = vi.fn(ackHelper(0));
    await expect(runWindowsFileClipboardHelper("helper.exe", [], spawnHelper)).rejects.toThrow();
    expect(spawnHelper).not.toHaveBeenCalled();
  });
});

describe("Linux file list flavors", () => {
  test("text/uri-list round-trips every path, in order", () => {
    fc.assert(
      fc.property(fc.array(posixPathArb, { minLength: 1, maxLength: 12 }), (paths) => {
        const flavors = linuxFileListFlavors(paths);
        expect(uriListFilePaths(flavors["text/uri-list"]!)).toEqual(paths);
        // GNOME's flavor: the verb, then the same URIs.
        const gnome = flavors["x-special/gnome-copied-files"]!.toString("utf8").split("\n");
        expect(gnome[0]).toBe("copy");
        expect(gnome.slice(1)).toHaveLength(paths.length);
      })
    );
  });

  test("a clipboard that kept a different list is a failed copy", async () => {
    await expect(
      writeLinuxFilesToClipboard(["/tmp/a.png", "/tmp/b.png"], {
        write: async () => undefined,
        readBuffer: async () => linuxFileListFlavors(["/tmp/a.png"])["text/uri-list"]!
      })
    ).rejects.toThrow("did not retain");
  });

  test("a clipboard that kept the list succeeds", async () => {
    let written: Record<string, Buffer> = {};
    await writeLinuxFilesToClipboard(["/tmp/a b.png", "/tmp/c.png"], {
      write: async (raw) => {
        written = raw;
      },
      readBuffer: async (format) => written[format] ?? Buffer.alloc(0)
    });
    expect(Object.keys(written).sort()).toEqual(["text/uri-list", "x-special/gnome-copied-files"]);
  });
});
