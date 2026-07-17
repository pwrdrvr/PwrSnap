import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openPath: vi.fn(async () => ""),
  showItemInFolder: vi.fn(),
  userDataPath: ""
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected app path: ${name}`);
      return mocks.userDataPath;
    }
  } as unknown as typeof import("electron").app,
  shell: {
    openPath: mocks.openPath,
    showItemInFolder: mocks.showItemInFolder
  } as unknown as typeof import("electron").shell
}));

import { bus } from "../../command-bus";
import {
  clearActiveHotCpuProfileSessionsForTests,
  markHotCpuProfileSessionActive
} from "../../diagnostics/hot-cpu-profile-active-sessions";
import { registerDiagnosticsHandlers } from "../diagnostics-handlers";

registerDiagnosticsHandlers();

const sessionName = "hot-cpu-2026-07-04-1543-8f0193";

function hotCpuRoot(): string {
  return path.join(mocks.userDataPath, "diagnostics", "hot-cpu");
}

beforeEach(async () => {
  mocks.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "pwrsnap-diag-test-"));
  mocks.openPath.mockClear();
  mocks.showItemInFolder.mockClear();
});

afterEach(async () => {
  delete process.env.PWRSNAP_HOT_CPU_PROFILING_OUTPUT_ROOT;
  clearActiveHotCpuProfileSessionsForTests();
  await fs.rm(mocks.userDataPath, { recursive: true, force: true });
});

describe("diagnostics handlers", () => {
  test("reveals the app-owned hot CPU diagnostics root", async () => {
    const result = await bus.dispatch(
      "diagnostics:revealHotCpuRoot",
      {},
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.openPath).toHaveBeenCalledWith(hotCpuRoot());
  });

  test("reveals the configured hot CPU diagnostics root", async () => {
    const configuredRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pwrsnap-diag-env-"));
    process.env.PWRSNAP_HOT_CPU_PROFILING_OUTPUT_ROOT = configuredRoot;

    const result = await bus.dispatch(
      "diagnostics:revealHotCpuRoot",
      {},
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.openPath).toHaveBeenCalledWith(configuredRoot);
    await fs.rm(configuredRoot, { recursive: true, force: true });
  });

  test("returns an error when the diagnostics root cannot be revealed", async () => {
    mocks.openPath.mockResolvedValueOnce("finder refused");

    const result = await bus.dispatch(
      "diagnostics:revealHotCpuRoot",
      {},
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("hot_cpu_diagnostics_reveal_failed");
  });

  test("reveals a known hot CPU session directory by basename", async () => {
    const sessionPath = path.join(hotCpuRoot(), sessionName);
    await fs.mkdir(sessionPath, { recursive: true });

    const result = await bus.dispatch(
      "diagnostics:revealHotCpuSession",
      { sessionDirectoryName: sessionName },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.openPath).toHaveBeenCalledWith(sessionPath);
  });

  test("returns an error when a session directory cannot be revealed", async () => {
    const sessionPath = path.join(hotCpuRoot(), sessionName);
    await fs.mkdir(sessionPath, { recursive: true });
    mocks.openPath.mockResolvedValueOnce("finder refused");

    const result = await bus.dispatch(
      "diagnostics:revealHotCpuSession",
      { sessionDirectoryName: sessionName },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("hot_cpu_diagnostics_reveal_failed");
  });

  test("rejects traversal and absolute session names without shell access", async () => {
    for (const invalid of [
      "../hot-cpu-2026-07-04-1543-8f0193",
      "/tmp/hot-cpu-2026-07-04-1543-8f0193",
      "hot-cpu-2026-07-04-1543-8f0193/child",
      "not-a-hot-cpu-session"
    ]) {
      const result = await bus.dispatch(
        "diagnostics:revealHotCpuSession",
        { sessionDirectoryName: invalid },
        { principal: "ipc" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_hot_cpu_session");
    }

    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  test("rejects unknown hot CPU sessions without shell access", async () => {
    const result = await bus.dispatch(
      "diagnostics:revealHotCpuSession",
      { sessionDirectoryName: sessionName },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("hot_cpu_session_not_found");
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  test("clears matching hot CPU sessions and leaves non-session entries", async () => {
    const sessionPath = path.join(hotCpuRoot(), sessionName);
    const otherPath = path.join(hotCpuRoot(), "not-a-session");
    await fs.mkdir(sessionPath, { recursive: true });
    await fs.mkdir(otherPath, { recursive: true });
    await fs.writeFile(path.join(sessionPath, "session.json"), "{}", "utf8");

    const result = await bus.dispatch(
      "diagnostics:clearHotCpuSessions",
      {},
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.deletedSessions).toBe(1);
    expect(result.value.skippedEntries).toBe(1);
    await expect(fs.stat(sessionPath)).rejects.toThrow();
    expect(await fs.stat(otherPath)).toBeDefined();
  });

  test("clear skips sessions that are active in this process", async () => {
    const activePath = path.join(hotCpuRoot(), sessionName);
    const inactiveName = "hot-cpu-2026-07-04-1644-9abcde";
    const inactivePath = path.join(hotCpuRoot(), inactiveName);
    await fs.mkdir(activePath, { recursive: true });
    await fs.mkdir(inactivePath, { recursive: true });
    markHotCpuProfileSessionActive(sessionName);

    const result = await bus.dispatch(
      "diagnostics:clearHotCpuSessions",
      {},
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.deletedSessions).toBe(1);
    expect(result.value.skippedEntries).toBe(1);
    expect(await fs.stat(activePath)).toBeDefined();
    await expect(fs.stat(inactivePath)).rejects.toThrow();
  });
});
