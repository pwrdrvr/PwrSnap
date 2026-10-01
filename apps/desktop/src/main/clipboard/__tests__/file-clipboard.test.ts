import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  clipboard: {
    read: vi.fn(async () => []),
    write: vi.fn(async () => undefined)
  },
  ClipboardItem: class {},
  nativeImage: {}
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

const {
  runWindowsFileClipboardHelper,
  windowsFileClipboardHelperCandidates,
  writeFileToClipboard,
  writeMacFileToClipboard
} = await import("../file-clipboard");

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    })
  );
});

describe("Windows file clipboard helper paths", () => {
  test("resolves packaged and dev helpers with win32 drive separators", () => {
    expect(
      windowsFileClipboardHelperCandidates({
        resourcesPath: "C:\\Program Files\\PwrSnap\\resources",
        moduleDir: "C:\\src\\PwrSnap\\apps\\desktop\\out\\main"
      })
    ).toEqual([
      "C:\\Program Files\\PwrSnap\\resources\\PwrSnapWindowList.exe",
      "C:\\src\\PwrSnap\\apps\\desktop\\build\\native\\window-list.exe"
    ]);
  });

  test("preserves a packaged UNC resource root", () => {
    expect(
      windowsFileClipboardHelperCandidates({
        resourcesPath: "\\\\fileserver\\apps\\PwrSnap\\resources",
        moduleDir: "\\\\fileserver\\src\\PwrSnap\\apps\\desktop\\out\\main"
      })
    ).toEqual([
      "\\\\fileserver\\apps\\PwrSnap\\resources\\PwrSnapWindowList.exe",
      "\\\\fileserver\\src\\PwrSnap\\apps\\desktop\\build\\native\\window-list.exe"
    ]);
  });
});

describe("native file clipboard contracts", () => {
  test("macOS writes the public.file-url UTI and verifies it as text/uri-list", async () => {
    // Electron 44 lists a raw `public.file-url` write only as `text/uri-list`
    // and rejects a read by the UTI (measured on 44.4.5); the fake does too.
    const written: Array<{ format: string; bytes: Buffer }> = [];
    let fileUrl: Buffer | null = null;
    const api = {
      writeRaw: async (format: string, bytes: Buffer): Promise<void> => {
        written.push({ format, bytes: Buffer.from(bytes) });
        fileUrl = format === "public.file-url" ? Buffer.from(bytes) : null;
      },
      readBuffer: async (format: string): Promise<Buffer> =>
        format === "text/uri-list" && fileUrl !== null ? fileUrl : Buffer.alloc(0)
    };

    await writeMacFileToClipboard("/tmp/PwrSnap roadmap & notes.gif", api);

    expect(written.map((entry) => entry.format)).toEqual(["public.file-url"]);
    expect(written[0]!.bytes.toString("utf8")).toBe(
      pathToFileURL("/tmp/PwrSnap roadmap & notes.gif").toString()
    );
  });

  test("macOS rejects an API call that leaves an empty clipboard", async () => {
    await expect(
      writeMacFileToClipboard("/tmp/export.mp4", {
        writeRaw: async () => undefined,
        readBuffer: async () => Buffer.alloc(0)
      })
    ).rejects.toThrow("did not retain");
  });

  test("macOS rejects a different file URL even when text/uri-list is present", async () => {
    await expect(
      writeMacFileToClipboard("/tmp/export.mp4", {
        writeRaw: async () => undefined,
        readBuffer: async () => Buffer.from(pathToFileURL("/tmp/other.mp4").toString())
      })
    ).rejects.toThrow("did not retain");
  });

  for (const filePath of [
    "C:\\Users\\Ada Lovelace\\Videos\\PwrSnap demo.mp4",
    "\\\\fileserver\\PwrSnap exports\\launch review.gif"
  ]) {
    test(`passes ${filePath} as one argv value and requires a CF_HDROP ack`, async () => {
      let invocation:
        | { command: string; args: readonly string[]; shell: boolean | string | undefined }
        | undefined;
      await runWindowsFileClipboardHelper(
        "C:\\Program Files\\PwrSnap\\resources\\PwrSnapWindowList.exe",
        filePath,
        (command, args, options) => {
          invocation = { command, args, shell: options.shell };
          return spawn(
            process.execPath,
            [
              "-e",
              'process.stdout.write(JSON.stringify({ok:true,format:"CF_HDROP",files:1,dropEffect:"copy"}))'
            ],
            { shell: false, windowsHide: true }
          );
        }
      );

      expect(invocation).toEqual({
        command: "C:\\Program Files\\PwrSnap\\resources\\PwrSnapWindowList.exe",
        args: ["--write-file-clipboard", filePath],
        shell: false
      });
    });
  }

  test("rejects exit zero when the native format was not verified", async () => {
    await expect(
      runWindowsFileClipboardHelper("helper.exe", "C:\\export.gif", () =>
        spawn(process.execPath, ["-e", 'process.stdout.write("{\\\"ok\\\":true}")'])
      )
    ).rejects.toThrow("did not verify a CF_HDROP");
  });

  test("surfaces a native helper failure instead of reporting copy success", async () => {
    await expect(
      runWindowsFileClipboardHelper("helper.exe", "C:\\export.mp4", () =>
        spawn(process.execPath, ["-e", 'process.stderr.write("clipboard is busy");process.exit(5)'])
      )
    ).rejects.toThrow("clipboard is busy");
  });
});

describe("export file validation", () => {
  test("rejects missing and zero-byte exports before any platform write", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwrsnap-file-clipboard-"));
    tempRoots.push(root);
    const empty = join(root, "empty.gif");
    await writeFile(empty, Buffer.alloc(0));

    await expect(writeFileToClipboard(join(root, "missing.mp4"))).rejects.toThrow(
      "missing export file"
    );
    await expect(writeFileToClipboard(empty)).rejects.toThrow("empty export file");
  });
});
