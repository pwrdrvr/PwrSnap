import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  clipboard: {
    availableFormats: vi.fn(() => []),
    readBuffer: vi.fn(() => Buffer.alloc(0)),
    writeBuffer: vi.fn()
  }
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
  test("macOS requires public.file-url readback before success", () => {
    const buffers = new Map<string, Buffer>();
    const api = {
      writeBuffer: (format: string, value: Buffer): void => {
        buffers.clear();
        buffers.set(format, Buffer.from(value));
      },
      availableFormats: (): string[] => [...buffers.keys()],
      readBuffer: (format: string): Buffer => buffers.get(format) ?? Buffer.alloc(0)
    };

    writeMacFileToClipboard("/tmp/PwrSnap roadmap & notes.gif", api);

    expect(api.availableFormats()).toEqual(["public.file-url"]);
    expect(api.readBuffer("public.file-url").toString("utf8")).toBe(
      pathToFileURL("/tmp/PwrSnap roadmap & notes.gif").toString()
    );
  });

  test("macOS rejects an API call that leaves an empty clipboard", () => {
    expect(() =>
      writeMacFileToClipboard("/tmp/export.mp4", {
        writeBuffer: () => undefined,
        availableFormats: () => [],
        readBuffer: () => Buffer.alloc(0)
      })
    ).toThrow("did not retain");
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
