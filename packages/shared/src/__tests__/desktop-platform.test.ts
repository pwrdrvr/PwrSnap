import { describe, expect, test } from "vitest";
import {
  capturesFolderDisplayPath,
  chatsFolderDisplayPath,
  chatStoragePlatformCopy,
  desktopFileManagerName,
  executablePathExample,
  isAbsoluteExecutablePath,
  normalizeManualExecutablePath,
  revealInFileManagerLabel
} from "../desktop-platform";

describe("desktop platform copy", () => {
  test("uses File Explorer and drive-absolute executable examples on Windows", () => {
    expect(desktopFileManagerName("win32")).toBe("File Explorer");
    expect(revealInFileManagerLabel("win32")).toBe("Reveal in File Explorer");
    expect(executablePathExample("win32", "codex")).toBe(
      String.raw`C:\Program Files\OpenAI\Codex\bin\codex.exe`
    );
    expect(executablePathExample("win32", "qwen")).toBe(
      String.raw`C:\Users\you\AppData\Roaming\npm\qwen.cmd`
    );
    expect(capturesFolderDisplayPath("win32", "home")).toBe(
      String.raw`%USERPROFILE%\PwrSnap`
    );
    expect(capturesFolderDisplayPath("win32", "documents")).toBe(
      String.raw`Documents\PwrSnap`
    );
    expect(chatsFolderDisplayPath("win32")).toBe(
      String.raw`Documents\PwrSnap\Chats`
    );
    expect(chatsFolderDisplayPath("win32", "home")).toBe(
      String.raw`%USERPROFILE%\PwrSnap\Chats`
    );
    expect(chatsFolderDisplayPath("win32", "home", true)).toBe(
      "inside your active captures folder"
    );
    expect(chatStoragePlatformCopy("win32")).toMatchObject({
      cloudSync: expect.stringContaining("OneDrive"),
      indexing: expect.stringContaining("Windows Search"),
      encryption: expect.stringMatching(/BitLocker|device encryption/)
    });
    expect(chatStoragePlatformCopy("win32", "home").cloudSync).toMatch(
      /outside Documents.*do not automatically/i
    );
    expect(chatStoragePlatformCopy("win32", "home").cloudSync).not.toContain(
      "OneDrive"
    );
    expect(chatStoragePlatformCopy("win32", "home", true).cloudSync).toMatch(
      /depending on where you chose/i
    );
  });

  test("recognizes Windows drive and UNC executable paths without host semantics", () => {
    expect(
      isAbsoluteExecutablePath("win32", String.raw`C:\tools\qwen.cmd`)
    ).toBe(true);
    expect(
      isAbsoluteExecutablePath(
        "win32",
        String.raw`\\agent-share\local agents\qwen.cmd`
      )
    ).toBe(true);
    expect(isAbsoluteExecutablePath("win32", String.raw`C:qwen.cmd`)).toBe(
      false
    );
    expect(
      isAbsoluteExecutablePath("win32", String.raw`\\?\C:\tools\qwen.cmd`)
    ).toBe(false);
    expect(
      isAbsoluteExecutablePath("win32", String.raw`\\.\C:\tools\qwen.cmd`)
    ).toBe(false);
    expect(
      isAbsoluteExecutablePath("win32", String.raw`\??\C:\tools\qwen.cmd`)
    ).toBe(false);
  });

  test("normalizes one Explorer Copy-as-path quote pair and rejects shell-style input", () => {
    expect(
      normalizeManualExecutablePath(
        "win32",
        String.raw`"C:\Program Files\Qwen\qwen.cmd"`
      )
    ).toEqual({
      ok: true,
      path: String.raw`C:\Program Files\Qwen\qwen.cmd`
    });
    expect(normalizeManualExecutablePath("win32", "qwen.cmd").ok).toBe(false);
    expect(
      normalizeManualExecutablePath("win32", "/opt/homebrew/bin/qwen").ok
    ).toBe(false);
    expect(
      normalizeManualExecutablePath(
        "win32",
        String.raw`"C:\tools\qwen.cmd" --version`
      ).ok
    ).toBe(false);
    expect(
      normalizeManualExecutablePath(
        "win32",
        String.raw`C:\tools\qwen".cmd`
      ).ok
    ).toBe(false);
  });

  test("preserves Finder and POSIX executable examples on macOS", () => {
    expect(desktopFileManagerName("darwin")).toBe("Finder");
    expect(revealInFileManagerLabel("darwin")).toBe("Reveal in Finder");
    expect(executablePathExample("darwin", "codex")).toBe(
      "/opt/homebrew/bin/codex"
    );
    expect(executablePathExample("darwin", "qwen")).toBe(
      "/Users/you/.nvm/versions/node/vXX/bin/qwen"
    );
    expect(isAbsoluteExecutablePath("darwin", "/usr/local/bin/qwen")).toBe(
      true
    );
    expect(isAbsoluteExecutablePath("darwin", String.raw`C:\tools\qwen.cmd`)).toBe(
      false
    );
    expect(capturesFolderDisplayPath("darwin", "home")).toBe("~/PwrSnap");
    expect(capturesFolderDisplayPath("darwin", "documents")).toBe(
      "~/Documents/PwrSnap"
    );
    expect(chatsFolderDisplayPath("darwin")).toBe("~/Documents/PwrSnap/Chats");
    expect(chatsFolderDisplayPath("darwin", "home")).toBe("~/PwrSnap/Chats");
    expect(chatStoragePlatformCopy("darwin")).toMatchObject({
      cloudSync: expect.stringContaining("iCloud"),
      indexing: expect.stringContaining("Spotlight"),
      encryption: expect.stringContaining("FileVault")
    });
    expect(chatStoragePlatformCopy("darwin", "home").cloudSync).not.toContain(
      "iCloud"
    );
    expect(chatStoragePlatformCopy("darwin", "home", true).cloudSync).toMatch(
      /depending on where you chose/i
    );
  });

  test("uses platform-neutral copy and Linux-style examples elsewhere", () => {
    expect(desktopFileManagerName("linux")).toBe("file manager");
    expect(revealInFileManagerLabel(undefined)).toBe("Reveal in file manager");
    expect(executablePathExample("linux", "codex")).toBe(
      "/home/you/.local/bin/codex"
    );
  });
});
