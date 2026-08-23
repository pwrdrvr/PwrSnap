import { describe, expect, test } from "vitest";
import { validateSettingsWrite } from "../settings-validators";

function validateOverride(path: string, platform: string) {
  return validateSettingsWrite(
    { ai: { acp: { agents: { qwen: { overridePath: path } } } } },
    platform
  );
}

function validateCodex(path: string, platform: string) {
  return validateSettingsWrite({ codex: { pinnedPath: path } }, platform);
}

describe("validateSettingsWrite — local-agent executable paths", () => {
  test("the default platform accepts the host's native absolute fixture", () => {
    const hostPath =
      process.platform === "win32"
        ? String.raw`C:\tools\codex.exe`
        : "/opt/codex";
    expect(validateSettingsWrite({ codex: { pinnedPath: hostPath } }).ok).toBe(
      true
    );
  });

  test("accepts Windows drive and UNC override paths", () => {
    expect(validateOverride(String.raw`C:\tools\qwen.cmd`, "win32").ok).toBe(
      true
    );
    expect(
      validateOverride(
        String.raw`\\agent-share\local agents\qwen.cmd`,
        "win32"
      ).ok
    ).toBe(true);
    expect(validateCodex(String.raw`C:\tools\codex.exe`, "win32").ok).toBe(
      true
    );
    expect(
      validateCodex(
        String.raw`\\agent-share\local agents\codex.cmd`,
        "win32"
      ).ok
    ).toBe(true);
  });

  test("rejects Windows drive-relative and device-namespace override paths", () => {
    expect(validateOverride(String.raw`C:qwen.cmd`, "win32").ok).toBe(false);
    expect(
      validateOverride(String.raw`\\?\C:\tools\qwen.cmd`, "win32").ok
    ).toBe(false);
    expect(validateCodex(String.raw`C:codex.exe`, "win32").ok).toBe(false);
    expect(
      validateCodex(String.raw`\\.\C:\tools\codex.exe`, "win32").ok
    ).toBe(false);
  });

  test("preserves POSIX absolute paths on macOS", () => {
    expect(validateOverride("/opt/homebrew/bin/qwen", "darwin").ok).toBe(true);
    expect(validateCodex("/opt/homebrew/bin/codex", "darwin").ok).toBe(true);
    expect(validateOverride(String.raw`C:\tools\qwen.cmd`, "darwin").ok).toBe(
      false
    );
    expect(validateCodex("codex", "darwin").ok).toBe(false);
  });

  test("keeps discovered selected commands compatible with bare names", () => {
    expect(
      validateSettingsWrite(
        { ai: { acp: { agents: { qwen: { selectedPath: "qwen" } } } } },
        "win32"
      ).ok
    ).toBe(true);
  });
});
