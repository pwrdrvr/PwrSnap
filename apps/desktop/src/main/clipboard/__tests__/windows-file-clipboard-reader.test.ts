import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, test, vi } from "vitest";

vi.mock("../../capture/window-list", () => ({
  resolveWindowListHelperPath: () => null
}));

const {
  isSupportedClipboardImagePath,
  readWindowsClipboardImageFile,
  runWindowsClipboardFileReader,
  validateWindowsClipboardImageFiles,
  windowsClipboardFormatsMayContainFiles
} = await import("../windows-file-clipboard-reader");

function scriptProcess(script: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["-e", script], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function readerProcess(json: unknown): ChildProcessWithoutNullStreams {
  return scriptProcess(`process.stdout.write(${JSON.stringify(JSON.stringify(json))})`);
}

describe("Windows CF_HDROP helper protocol", () => {
  test("spawns the packaged helper without a shell and accepts an empty file list", async () => {
    let invocation:
      | { command: string; args: readonly string[]; shell: boolean | string | undefined }
      | undefined;
    const files = await runWindowsClipboardFileReader(
      "C:\\Program Files\\PwrSnap\\resources\\PwrSnapWindowList.exe",
      (command, args, options) => {
        invocation = { command, args, shell: options.shell };
        return readerProcess({ ok: true, format: "CF_HDROP", files: [] });
      }
    );

    expect(invocation).toEqual({
      command: "C:\\Program Files\\PwrSnap\\resources\\PwrSnapWindowList.exe",
      args: ["--read-file-clipboard"],
      shell: false
    });
    expect(files).toEqual([]);
  });

  test("preserves drive and UNC paths from the verified JSON acknowledgement", async () => {
    const expected = [
      "C:\\Users\\Ada Lovelace\\Pictures\\launch review.PNG",
      "\\\\fileserver\\PwrSnap shots\\team\\roadmap.gif"
    ];
    await expect(
      runWindowsClipboardFileReader("helper.exe", () =>
        readerProcess({ ok: true, format: "CF_HDROP", files: expected })
      )
    ).resolves.toEqual(expected);
  });

  test("rejects invalid JSON, the wrong format, and non-string file entries", async () => {
    await expect(
      runWindowsClipboardFileReader("helper.exe", () =>
        scriptProcess('process.stdout.write("not json")')
      )
    ).rejects.toThrow("invalid JSON");

    await expect(
      runWindowsClipboardFileReader("helper.exe", () =>
        readerProcess({ ok: true, format: "public.file-url", files: [] })
      )
    ).rejects.toThrow("invalid CF_HDROP acknowledgement");

    await expect(
      runWindowsClipboardFileReader("helper.exe", () =>
        readerProcess({ ok: true, format: "CF_HDROP", files: [42] })
      )
    ).rejects.toThrow("invalid CF_HDROP acknowledgement");
  });

  test("surfaces a busy/nonzero helper instead of treating it as no files", async () => {
    await expect(
      runWindowsClipboardFileReader("helper.exe", () =>
        scriptProcess('process.stderr.write("clipboard is busy");process.exit(5)')
      )
    ).rejects.toThrow("clipboard is busy");
  });
});

describe("Windows Explorer image-file contract", () => {
  test("menu detection recognizes Windows file formats without reading CF_HDROP bytes", () => {
    expect(windowsClipboardFormatsMayContainFiles(["CF_HDROP"], "win32")).toBe(true);
    expect(windowsClipboardFormatsMayContainFiles(["text/uri-list"], "win32")).toBe(true);
    expect(windowsClipboardFormatsMayContainFiles(["FileNameW"], "win32")).toBe(true);
    expect(windowsClipboardFormatsMayContainFiles(["CF_HDROP"], "darwin")).toBe(false);
  });

  for (const filePath of [
    "C:\\Users\\Ada Lovelace\\Pictures\\launch review.PNG",
    "\\\\fileserver\\PwrSnap shots\\team\\roadmap.gif"
  ]) {
    test(`accepts one fully qualified image path at ${filePath}`, async () => {
      await expect(validateWindowsClipboardImageFiles([filePath])).resolves.toBe(filePath);
      expect(isSupportedClipboardImagePath(filePath)).toBe(true);
    });
  }

  test("returns null only for an absent CF_HDROP file list", async () => {
    await expect(validateWindowsClipboardImageFiles([])).resolves.toBeNull();
  });

  test("rejects multiple Explorer files clearly", async () => {
    const result = await readWindowsClipboardImageFile({
      platform: "win32",
      helperPath: "helper.exe",
      spawnReader: () =>
        readerProcess({
          ok: true,
          format: "CF_HDROP",
          files: ["C:\\shots\\one.png", "C:\\shots\\two.png"]
        })
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "multiple_files", terminal: true }
    });
    if (!result.ok) expect(result.error.message).toMatch(/one image file at a time/i);
  });

  test("rejects a sole non-image file instead of reading it as bytes", async () => {
    const result = await readWindowsClipboardImageFile({
      platform: "win32",
      helperPath: "helper.exe",
      spawnReader: () =>
        readerProcess({
          ok: true,
          format: "CF_HDROP",
          files: ["C:\\Users\\Ada\\Videos\\demo.mp4"]
        })
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "not_image_file", terminal: true }
    });
    if (!result.ok) expect(result.error.message).toContain("demo.mp4");
  });

  test("rejects relative paths before the shared paste safety gate", async () => {
    const relative = await readWindowsClipboardImageFile({
      platform: "win32",
      helperPath: "helper.exe",
      spawnReader: () =>
        readerProcess({ ok: true, format: "CF_HDROP", files: ["shots\\demo.png"] })
    });
    expect(relative).toMatchObject({
      ok: false,
      error: { code: "invalid_file_path", terminal: true }
    });
  });
});
