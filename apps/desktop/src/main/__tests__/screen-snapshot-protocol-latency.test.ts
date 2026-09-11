import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureInvocation } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
  protocolTarget: null as {
    filePath: string;
    latencyTrace?: unknown;
  } | null
}));

vi.mock("electron", () => ({
  app: {},
  protocol: {
    handle: vi.fn(
      (scheme: string, handler: (request: Request) => Promise<Response>) => {
        mocks.handlers.set(scheme, handler);
      }
    )
  }
}));

vi.mock("../capture/screen-snapshot", () => ({
  getSnapshotProtocolTarget: () => mocks.protocolTarget
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

vi.mock("../startup-profiler", () => ({
  markStartup: () => undefined,
  startupProfilingEnabled: () => false
}));

vi.mock("../storage/captures-access-health", () => ({
  reportCapturesAccessFailure: () => undefined
}));

type LogEntry = {
  message: string;
  fields: Record<string, unknown>;
};

const invocation: CaptureInvocation = {
  id: "trace-screen-protocol-1",
  origin: "global_hotkey.window",
  triggerMonotonicMs: 200,
  dispatchMonotonicMs: 200,
  triggerWallTime: "2026-09-03T12:00:00.000Z"
};

let dir = "";
let filePath = "";
const content = Buffer.from("screen-png-fixture");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pwrsnap-screen-protocol-test-"));
  filePath = join(dir, "screen.png");
  writeFileSync(filePath, content);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.handlers.clear();
  mocks.protocolTarget = null;
});

describe("pwrsnap-screen protocol latency", () => {
  test("original ranges finish while background playback HEAD is still encoding", async () => {
    let publish!: (path: string) => void;
    const encoding = new Promise<string>((resolve) => { publish = resolve; });
    const { installProtocolHandlers } = await import("../protocols");
    installProtocolHandlers({
      captureSourcePath: async (_id, options) => options?.playback ? await encoding : filePath,
      sourceBytesPath: async () => null,
      cacheFile: async () => null,
      videoAssetPath: async () => null,
      appIconPath: async () => null,
      sizzleOutputPath: async () => null
    });
    const handler = mocks.handlers.get("pwrsnap-capture")!;
    let prepared = false;
    const head = handler(new Request("pwrsnap-capture://r/AbC_123?playback=1", { method: "HEAD" }))
      .then((response) => { prepared = true; return response; });
    try {
      const firstFrame = await handler(new Request("pwrsnap-capture://r/AbC_123", {
        headers: { Range: "bytes=0-5" }
      }));
      expect(firstFrame.status).toBe(206);
      expect(Buffer.from(await firstFrame.arrayBuffer())).toEqual(content.subarray(0, 6));
      expect(prepared).toBe(false);
    } finally {
      publish(filePath);
    }
    const response = await head;
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  test.each([false, true])("capture playback=%s keeps range serving on the resolved asset", async (playback) => {
    const captureSourcePath = vi.fn(async () => filePath);
    const { installProtocolHandlers } = await import("../protocols");
    installProtocolHandlers({
      captureSourcePath,
      sourceBytesPath: async () => null,
      cacheFile: async () => null,
      videoAssetPath: async () => null,
      appIconPath: async () => null,
      sizzleOutputPath: async () => null
    });
    const response = await mocks.handlers.get("pwrsnap-capture")!(new Request(
      `pwrsnap-capture://r/AbC_123${playback ? "?playback=1" : ""}`,
      { headers: { Range: "bytes=0-5" } }
    ));
    expect(captureSourcePath.mock.calls).toEqual(playback
      ? [["AbC_123", { playback: true }]]
      : [["AbC_123"]]);
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content.subarray(0, 6));
  });
  test("correlates file open and streamed read completion with the capture", async () => {
    const entries: LogEntry[] = [];
    const ticks = [201, 202, 203, 204, 205];
    const { CaptureLatencyTrace } = await import(
      "../capture/capture-latency-trace"
    );
    const trace = new CaptureLatencyTrace(invocation, "window", {
      monotonicNow: () => ticks.shift() ?? 205,
      wallNow: () => "2026-09-03T12:00:01.000Z",
      logger: {
        debug: (message, fields) => entries.push({ message, fields }),
        info: (message, fields) => entries.push({ message, fields })
      }
    });
    mocks.protocolTarget = { filePath, latencyTrace: trace };

    const { installProtocolHandlers } = await import("../protocols");
    installProtocolHandlers({
      captureSourcePath: async () => null,
      sourceBytesPath: async () => null,
      cacheFile: async () => null,
      videoAssetPath: async () => null,
      appIconPath: async () => null,
      sizzleOutputPath: async () => null
    });
    const handler = mocks.handlers.get("pwrsnap-screen");
    if (handler === undefined) throw new Error("screen protocol handler missing");

    const response = await handler(
      new Request("pwrsnap-screen://r/snapshot-fixture")
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
    trace.finish("presented");

    const stages = entries
      .filter((entry) => entry.fields.event === "capture_latency_stage")
      .filter((entry) =>
        ["screen_protocol_file_open", "screen_protocol_file_read"].includes(
          String(entry.fields.stage)
        )
      )
      .map((entry) => entry.fields);
    expect(stages.map((stage) => stage.stage)).toEqual([
      "screen_protocol_file_open",
      "screen_protocol_file_read"
    ]);
    expect(stages.map((stage) => stage.durationMs)).toEqual([1, 1]);
    expect(stages[0]).toMatchObject({
      outcome: "completed",
      expectedBytes: content.length,
      invocationId: invocation.id
    });
    expect(stages[1]).toMatchObject({
      outcome: "completed",
      expectedBytes: content.length,
      bytesRead: content.length,
      invocationId: invocation.id
    });
    expect(JSON.stringify(stages)).not.toContain(filePath);
  });
});
