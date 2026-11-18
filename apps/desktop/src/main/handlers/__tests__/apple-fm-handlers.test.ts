// `appleFm:status`, `appleFm:test` and `appleFm:openTerminal` against a
// scripted tool and a recorded shell.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));
vi.mock("electron", (): Partial<typeof import("electron")> => ({
  shell: { openExternal: vi.fn() } as unknown as typeof import("electron").shell
}));

import type { AppleFmStatus } from "@pwrsnap/shared";
import { bus } from "../../command-bus";
import { AppleFmTimeoutError, assertAppleFmArgs, type FmRunOptions, type FmRunResult } from "../../ai/apple-fm/fm-cli";
import { AppleFmStatusService } from "../../ai/apple-fm/status";
import { APPLE_FM_TEST_PROMPT, MACOS_TERMINAL_APP, registerAppleFmHandlers } from "../apple-fm-handlers";

const READY: AppleFmStatus = {
  state: "ready", modelLabel: "AFM 3 Core", detail: null, macosVersion: "27.2", checkedAt: 1
};
let probed: AppleFmStatus = READY;
const probe = vi.fn(async () => probed);
const status = new AppleFmStatusService(probe);
const runs: Array<{ args: string[]; options: FmRunOptions }> = [];
let answer: Partial<FmRunResult> | Error = { stdout: "OK\n" };
const scratchDir = await mkdtemp(join(tmpdir(), "pwrsnap-afm-handlers-"));
afterAll(() => rm(scratchDir, { recursive: true, force: true }));

let platform: NodeJS.Platform = "darwin";
const opened: string[] = [];
let openFailure = "";

// Registered once: the bus throws on a duplicate register.
registerAppleFmHandlers({
  status,
  scratchDir,
  platform: () => platform,
  openPath: async (path) => {
    opened.push(path);
    return openFailure;
  },
  run: async (args, options) => {
    assertAppleFmArgs(args);
    runs.push({ args: [...args], options });
    if (answer instanceof Error) throw answer;
    return { code: 0, signal: null, stdout: "", stderr: "", ...answer };
  }
});

beforeEach(() => {
  platform = "darwin";
  opened.length = 0;
  openFailure = "";
  probed = READY;
  answer = { stdout: "OK\n" };
  runs.length = 0;
  probe.mockClear();
  status.invalidate();
});

describe("appleFm:status", () => {
  test("serves the cached answer; only force asks macOS again", async () => {
    await bus.dispatch("appleFm:status", {}, { principal: "ipc" });
    await bus.dispatch("appleFm:status", { force: false }, { principal: "ipc" });
    expect(probe).toHaveBeenCalledTimes(1);
    const forced = await bus.dispatch("appleFm:status", { force: true }, { principal: "ipc" });
    expect(forced).toEqual({ ok: true, value: READY });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test("rejects a force that is not a boolean", async () => {
    const result = await bus.dispatch("appleFm:status", { force: "yes" } as never, { principal: "ipc" });
    expect(result).toMatchObject({ ok: false, error: { kind: "validation", code: "invalid_force" } });
    expect(probe).not.toHaveBeenCalled();
  });

  test("never runs a model turn", async () => {
    await bus.dispatch("appleFm:status", { force: true }, { principal: "ipc" });
    expect(runs).toEqual([]);
  });
});

describe("appleFm:test", () => {
  test("sends one fixed text prompt to the on-device model and times it", async () => {
    const result = await bus.dispatch("appleFm:test", {}, { principal: "ipc" });
    expect(result).toMatchObject({ ok: true, value: { modelLabel: "AFM 3 Core" } });
    if (result.ok) expect(result.value.ms).toBeGreaterThanOrEqual(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args).toEqual(["respond", "--no-stream", "--greedy", "--model", "system"]);
    // No image, no schema, nothing of the user's: the prompt is a constant.
    expect(runs[0]!.options.stdin).toBe(APPLE_FM_TEST_PROMPT);
    expect(runs[0]!.options.cwd).toBe(scratchDir);
  });

  test("asks macOS afresh first, and does not run when the model is not ready", async () => {
    await status.get();
    probed = { ...READY, state: "license-required", modelLabel: null };
    const result = await bus.dispatch("appleFm:test", {}, { principal: "ipc" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "apple_fm_not_ready", message: "Apple's terms haven't been agreed to on this Mac" }
    });
    expect(runs).toEqual([]);
  });

  test("a failed turn is reported in words, and a setup failure drops the cached status", async () => {
    answer = { code: 1, stderr: "Error: The model is not available. Try again later.\n" };
    const result = await bus.dispatch("appleFm:test", {}, { principal: "ipc" });
    expect(result).toMatchObject({ ok: false, error: { code: "apple_fm_test_failed" } });
    if (!result.ok) expect(result.error.message).toMatch(/^The on-device model isn't available right now/);
    expect(status.peek()).toBeNull();
  });

  test("an empty answer is a failure", async () => {
    answer = { stdout: "  \n" };
    expect(await bus.dispatch("appleFm:test", {}, { principal: "ipc" })).toMatchObject({
      ok: false, error: { code: "apple_fm_test_failed" }
    });
  });

  test("a wedged run is reported, not thrown", async () => {
    answer = new AppleFmTimeoutError(60_000);
    expect(await bus.dispatch("appleFm:test", {}, { principal: "ipc" })).toMatchObject({
      ok: false, error: { message: "The on-device model didn't answer in time." }
    });
  });
});

describe("appleFm:openTerminal", () => {
  test("launches Terminal from its fixed path, and does nothing else", async () => {
    probed = { ...READY, state: "license-required", modelLabel: null };
    expect(await bus.dispatch("appleFm:openTerminal", {}, { principal: "ipc" })).toEqual({
      ok: true,
      value: undefined
    });
    expect(opened).toEqual([MACOS_TERMINAL_APP]);
    expect(MACOS_TERMINAL_APP).toBe("/System/Applications/Utilities/Terminal.app");
    // No model turn, no probe: launching Terminal is all it does.
    expect(runs).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  test("property: whatever the request carries, only the fixed path is opened", async () => {
    for (const req of [{}, { path: "/tmp/evil.command" }, { app: "Calculator" }, { command: "sudo rm -rf /" }]) {
      opened.length = 0;
      await bus.dispatch("appleFm:openTerminal", req as never, { principal: "ipc" });
      expect(opened).toEqual([MACOS_TERMINAL_APP]);
    }
  });

  test("refuses every caller that is not a person in a window", async () => {
    // MCP is stopped by the bus's local-agent floor before the handler; the
    // others reach the handler and stop there. Either way nothing opens.
    for (const principal of ["rpc", "mcp", "seeder", "bridge"] as const) {
      expect(await bus.dispatch("appleFm:openTerminal", {}, { principal })).toMatchObject({
        ok: false,
        error: { kind: "permission" }
      });
    }
    expect(await bus.dispatch("appleFm:openTerminal", {}, { principal: "rpc" })).toMatchObject({
      error: { code: "apple_fm_terminal_ui_only" }
    });
    expect(opened).toEqual([]);
  });

  test("refuses off macOS without opening anything", async () => {
    for (const other of ["win32", "linux"] as const) {
      platform = other;
      expect(await bus.dispatch("appleFm:openTerminal", {}, { principal: "ipc" })).toMatchObject({
        ok: false,
        error: { code: "apple_fm_unsupported_platform" }
      });
    }
    expect(opened).toEqual([]);
  });

  test("a launch failure is reported in words", async () => {
    openFailure = "Failed to open path";
    expect(await bus.dispatch("appleFm:openTerminal", {}, { principal: "ipc" })).toMatchObject({
      ok: false,
      error: { code: "apple_fm_terminal_failed", message: "Terminal couldn't be opened." }
    });
  });
});
