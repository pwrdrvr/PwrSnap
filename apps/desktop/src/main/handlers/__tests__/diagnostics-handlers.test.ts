import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openPath: vi.fn(async () => ""),
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
    openPath: mocks.openPath
  } as unknown as typeof import("electron").shell
}));

import { bus } from "../../command-bus";
import { registerDiagnosticsHandlers } from "../diagnostics-handlers";

registerDiagnosticsHandlers();

const sessionName = "hot-cpu-2026-07-04-1543-8f0193";

function hotCpuRoot(): string {
  return path.join(mocks.userDataPath, "diagnostics", "hot-cpu");
}

beforeEach(async () => {
  mocks.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "pwrsnap-diag-test-"));
  mocks.openPath.mockClear();
});

afterEach(async () => {
  delete process.env.PWRSNAP_HOT_CPU_PROFILING_OUTPUT_ROOT;
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

    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  test("rejects unknown hot CPU sessions without shell access", async () => {
    const result = await bus.dispatch(
      "diagnostics:revealHotCpuSession",
      { sessionDirectoryName: sessionName },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("hot_cpu_session_not_found");
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
});
