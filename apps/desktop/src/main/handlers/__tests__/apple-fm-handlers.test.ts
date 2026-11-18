// `appleFm:status`, `appleFm:test` and `appleFm:openTerminal` against a
// scripted tool and a recorded shell.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));
const sentToWindows: Array<{ channel: string; payload: unknown }> = [];
vi.mock("electron", (): Partial<typeof import("electron")> => ({
  shell: { openExternal: vi.fn() } as unknown as typeof import("electron").shell,
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => { sentToWindows.push({ channel, payload }); } } },
      { isDestroyed: () => true, webContents: { send: () => { throw new Error("sent to a destroyed window"); } } }
    ]
  } as unknown as typeof import("electron").BrowserWindow
}));

import { EVENT_CHANNELS, type AppleFmStatus, type AppleFmStatusChangedEvent } from "@pwrsnap/shared";
import { bus } from "../../command-bus";
import { AppleFmTimeoutError, assertAppleFmArgs, type FmRunOptions, type FmRunResult } from "../../ai/apple-fm/fm-cli";
import { AppleFmStatusService } from "../../ai/apple-fm/status";
import {
  installRendererEventForwarder,
  uninstallRendererEventForwarderForTests
} from "../../process-split/event-relay";
import {
  APPLE_FM_TEST_PROMPT,
  MACOS_TERMINAL_APP,
  broadcastAppleFmStatusChanged,
  registerAppleFmHandlers
} from "../apple-fm-handlers";

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

const broadcasts: AppleFmStatusChangedEvent[] = [];
// Registered once: the bus throws on a duplicate register.
registerAppleFmHandlers({
  status,
  broadcast: (payload) => {
    broadcasts.push(payload);
  },
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
  broadcasts.length = 0;
  sentToWindows.length = 0;
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

describe("status changes reach every window", () => {
  // The Library and the Float-Over follow these instead of asking again, so
  // each way the cached answer can change must be announced.
  test("a first read, a forced re-read and an invalidation are each broadcast", async () => {
    await bus.dispatch("appleFm:status", {}, { principal: "ipc" });
    expect(broadcasts).toEqual([{ status: READY }]);

    // Served from the cache: nothing changed, nothing is sent.
    await bus.dispatch("appleFm:status", {}, { principal: "ipc" });
    expect(broadcasts).toHaveLength(1);

    probed = { ...READY, state: "model-not-ready", modelLabel: null, checkedAt: 2 };
    await bus.dispatch("appleFm:status", { force: true }, { principal: "ipc" });
    expect(broadcasts.at(-1)).toEqual({ status: probed });

    // What a failed caption run does (see codex-handlers).
    status.invalidate();
    expect(broadcasts.at(-1)).toEqual({ status: null });
    expect(broadcasts).toHaveLength(3);
  });

  test("a failed test run that disproves the status is announced too", async () => {
    await status.get();
    broadcasts.length = 0;
    answer = { code: 1, stderr: "Error: The model is not available. Try again later.\n" };
    await bus.dispatch("appleFm:test", {}, { principal: "ipc" });
    // The fresh read the test starts with, then the invalidation.
    expect(broadcasts).toEqual([{ status: READY }, { status: null }]);
  });

  test("the default broadcast reaches live windows and the peer process, on the status channel", () => {
    const relayed: Array<{ channel: string; payload: unknown }> = [];
    installRendererEventForwarder((channel, payload) => {
      relayed.push({ channel, payload });
    });
    try {
      broadcastAppleFmStatusChanged({ status: READY });
    } finally {
      uninstallRendererEventForwarderForTests();
    }
    const expected = [{ channel: EVENT_CHANNELS.appleFmStatusChanged, payload: { status: READY } }];
    expect(sentToWindows).toEqual(expected);
    expect(relayed).toEqual(expected);
  });
});

