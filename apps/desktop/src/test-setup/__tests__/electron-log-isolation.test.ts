// Pins that no desktop-main test can write into the operator's real app log.
// See ../electron-log-isolation.ts for why the default path is wrong here.
//
// Every write below happens only after the path it would land in has been
// asserted, so a regression fails this file without appending a line to
// the real log.
//
// Deliberately does NOT import ../electron-log-isolation: importing it
// applies the redirect, which would keep this file green even with the
// setupFiles entry in vitest.workspace.ts deleted.
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeLog from "electron-log/node.js";
import { describe, expect, test, vi } from "vitest";

const VITEST_LOG_DIR = join(tmpdir(), "pwrsnap-vitest-logs");
const REAL_APP_LOG_DIR = join(homedir(), "Library", "Logs", "PwrSnap");

describe("electron-log under vitest", () => {
  test("runs under vitest, so the setup file is in force", () => {
    expect(process.env.VITEST).toBeTruthy();
  });

  test("the main logger's file transport resolves into the vitest temp dir", async () => {
    const { getMainLogFilePath } = await import("../../main/log");
    const path = getMainLogFilePath();

    expect(path).toBeDefined();
    expect(dirname(path!)).toBe(VITEST_LOG_DIR);
    expect(path!.startsWith(REAL_APP_LOG_DIR)).toBe(false);
    expect(path!.startsWith(join(homedir(), "Library", "Logs"))).toBe(false);
  });

  test("a fresh module graph still gets the redirected transport", async () => {
    vi.resetModules();
    const { getMainLogFilePath } = await import("../../main/log");

    expect(dirname(getMainLogFilePath()!)).toBe(VITEST_LOG_DIR);
  });

  test("electron-log's node entry is redirected too", () => {
    expect(dirname(nodeLog.transports.file.getFile().path)).toBe(VITEST_LOG_DIR);
  });

  test("a scoped warning lands in the temp log, not the app's", async () => {
    const { getMainLogFilePath, getMainLogger } = await import("../../main/log");
    const path = getMainLogFilePath()!;
    // Re-asserted here so the write below can never reach the real log.
    expect(dirname(path)).toBe(VITEST_LOG_DIR);

    const marker = `electron-log-isolation ${process.pid} ${Date.now()}`;
    getMainLogger("pwrsnap:settings-service").warn(marker);

    // Every worker appends to this one file, and electron-log rotates it to
    // `<name>.old.log` at maxSize, so a sibling's write can move the marker.
    const rotated = path.replace(/\.log$/, ".old.log");
    const written = [path, rotated]
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(written).toContain(marker);
  });
});
