import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";

import {
  runUtf8Tee,
  windowsE2ECommand,
  windowsE2EEnvironment
} from "./run-windows.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function captureText() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    }),
    text: () => Buffer.concat(chunks).toString("utf8")
  };
}

describe("Windows E2E UTF-8 launcher", () => {
  test("PowerShell bridge configures UTF-8 and avoids its native-output pipeline", async () => {
    const launcherBytes = await readFile(
      join(repositoryRoot, "scripts/e2e/run-windows.ps1")
    );
    const launcher = launcherBytes.toString("utf8");

    // Windows PowerShell 5.1 treats a BOM-free script as the active ANSI code
    // page, so keep this small bridge ASCII-only as well as BOM-free.
    expect(launcherBytes.every((byte) => byte <= 0x7f)).toBe(true);
    expect(launcher).toContain("New-Object System.Text.UTF8Encoding($false)");
    expect(launcher).toContain("[Console]::OutputEncoding = $utf8NoBom");
    expect(launcher).toContain("$OutputEncoding = $utf8NoBom");
    expect(launcher).not.toMatch(/Tee-Object|ForEach-Object/);
  });

  test("tees split Unicode output to a BOM-free UTF-8 log", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pwrsnap-e2e-utf8-"));
    const logPath = join(temporaryDirectory, "playwright.log");
    const stdout = captureText();
    const stderr = captureText();
    const fixture = [
      "const value = Buffer.from('✓  ok e2e\\\\editor.spec.ts › editor: saves\\n');",
      "process.stdout.write(value.subarray(0, 1));",
      "setTimeout(() => {",
      "  process.stdout.write(value.subarray(1));",
      "  process.stderr.write('  failed: ✘\\n');",
      "}, 5);"
    ].join("\n");

    try {
      const exitCode = await runUtf8Tee({
        command: process.execPath,
        arguments: ["-e", fixture],
        cwd: repositoryRoot,
        environment: process.env,
        logPath,
        stdout: stdout.stream,
        stderr: stderr.stream
      });

      expect(exitCode).toBe(0);
      expect(stdout.text()).toContain("✓  ok e2e\\editor.spec.ts › editor: saves");
      expect(stderr.text()).toContain("failed: ✘");

      const log = await readFile(logPath);
      expect(log.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(log.toString("utf8")).toContain(
        "✓  ok e2e\\editor.spec.ts › editor: saves"
      );
      expect(log.toString("utf8")).not.toContain("Γ");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("normalizes CI and ANSI behavior only inside the Windows launcher", () => {
    expect(windowsE2EEnvironment({ KEEP_ME: "yes", FORCE_COLOR: "1" })).toEqual({
      KEEP_ME: "yes",
      CI: "1",
      FORCE_COLOR: "0"
    });
  });

  test("uses cmd.exe for the pnpm.cmd lifecycle on Windows", () => {
    expect(
      windowsE2ECommand("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      arguments: ["/d", "/s", "/c", "pnpm.cmd run test:desktop-e2e"]
    });
  });

  test("returns the child command's failure exit code", async () => {
    const stdout = captureText();
    const stderr = captureText();
    const exitCode = await runUtf8Tee({
      command: process.execPath,
      arguments: ["-e", "process.exit(23)"],
      cwd: repositoryRoot,
      environment: process.env,
      stdout: stdout.stream,
      stderr: stderr.stream
    });

    expect(exitCode).toBe(23);
  });
});
