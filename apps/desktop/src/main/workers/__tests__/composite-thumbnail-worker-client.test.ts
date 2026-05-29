// Lifecycle tests for the composite-thumbnail worker client. The real
// Worker is replaced with an EventEmitter-backed fake so we can drive
// 'message'/'exit'/'error' deterministically and assert the client's
// ownership semantics: a SINGLE worker reused across calls, responses
// routed back by id, and crash recovery that fails in-flight work then
// respawns. This is the contract the migration pattern depends on.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from "vitest";
import { Worker } from "node:worker_threads";
import {
  __setWorkerPathForTest,
  runCompositeThumbnailWorker,
  shutdownCompositeThumbnailWorker
} from "../composite-thumbnail-worker-client";

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWorker extends EventEmitter {
    static instances: FakeWorker[] = [];
    path: string;
    posted: Array<{ id: number; pngBytes: Uint8Array }> = [];
    terminated = false;
    constructor(path: string) {
      super();
      this.path = path;
      FakeWorker.instances.push(this);
    }
    postMessage(msg: { id: number; pngBytes: Uint8Array }): void {
      this.posted.push(msg);
    }
    terminate(): Promise<number> {
      this.terminated = true;
      return Promise.resolve(0);
    }
  }
  return { Worker: FakeWorker };
});

// Typed view of the mocked Worker so tests can reach the fake's statics.
type FakeInstance = {
  posted: Array<{ id: number; pngBytes: Uint8Array }>;
  terminated: boolean;
  emit: (event: string, ...args: unknown[]) => boolean;
};
const FakeWorker = Worker as unknown as {
  instances: FakeInstance[];
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Latest spawned fake worker. */
function latest(): FakeInstance {
  const w = FakeWorker.instances.at(-1);
  if (w === undefined) throw new Error("no worker spawned");
  return w;
}

/** The id of the most-recently-posted request on a worker. */
function lastRequestId(w: FakeInstance): number {
  const req = w.posted.at(-1);
  if (req === undefined) throw new Error("no request posted");
  return req.id;
}

beforeEach(() => {
  FakeWorker.instances.length = 0;
  __setWorkerPathForTest("/fake/composite-thumbnail-worker.js");
});

afterEach(() => {
  // Reset the module singleton between cases.
  shutdownCompositeThumbnailWorker();
  vi.useRealTimers();
});

describe("composite-thumbnail-worker-client", () => {
  test("reuses a single worker across sequential calls", async () => {
    const first = runCompositeThumbnailWorker(PNG);
    const w = latest();
    w.emit("message", {
      id: lastRequestId(w),
      ok: true,
      jpegBytes: new Uint8Array([1, 1, 1])
    });
    expect(Buffer.from(await first)).toEqual(Buffer.from([1, 1, 1]));

    const second = runCompositeThumbnailWorker(PNG);
    w.emit("message", {
      id: lastRequestId(w),
      ok: true,
      jpegBytes: new Uint8Array([2, 2, 2])
    });
    expect(Buffer.from(await second)).toEqual(Buffer.from([2, 2, 2]));

    // One worker spawned, reused for both calls — the whole point.
    expect(FakeWorker.instances.length).toBe(1);
  });

  test("routes concurrent responses back by id (out of order)", async () => {
    const a = runCompositeThumbnailWorker(PNG);
    const b = runCompositeThumbnailWorker(PNG);
    const w = latest();
    expect(FakeWorker.instances.length).toBe(1);
    const [idA, idB] = w.posted.map((r) => r.id);

    // Respond to B first, then A.
    w.emit("message", { id: idB, ok: true, jpegBytes: new Uint8Array([0xbb]) });
    w.emit("message", { id: idA, ok: true, jpegBytes: new Uint8Array([0xaa]) });

    expect(Buffer.from(await a)).toEqual(Buffer.from([0xaa]));
    expect(Buffer.from(await b)).toEqual(Buffer.from([0xbb]));
  });

  test("a worker-reported failure rejects only that request", async () => {
    const p = runCompositeThumbnailWorker(PNG);
    const w = latest();
    w.emit("message", {
      id: lastRequestId(w),
      ok: false,
      message: "decode failed"
    });
    await expect(p).rejects.toThrow("decode failed");
    // The worker is still healthy — a reported failure is not a crash.
    expect(FakeWorker.instances.length).toBe(1);
  });

  test("worker crash rejects in-flight work and respawns on next call", async () => {
    const crashed = runCompositeThumbnailWorker(PNG);
    const w1 = latest();
    w1.emit("exit", 1);
    await expect(crashed).rejects.toThrow(/exited with code 1/);

    // A late, stale 'exit' from the dead worker must not clobber state.
    w1.emit("exit", 1);

    const recovered = runCompositeThumbnailWorker(PNG);
    expect(FakeWorker.instances.length).toBe(2); // fresh worker spawned
    const w2 = latest();
    w2.emit("message", {
      id: lastRequestId(w2),
      ok: true,
      jpegBytes: new Uint8Array([9])
    });
    expect(Buffer.from(await recovered)).toEqual(Buffer.from([9]));
  });

  test("a stuck request times out and discards the worker", async () => {
    vi.useFakeTimers();
    const p = runCompositeThumbnailWorker(PNG, { timeoutMs: 1000 });
    const w1 = latest();
    // Attach the rejection handler BEFORE advancing the clock — otherwise
    // the timeout rejects during `advanceTimersByTimeAsync` while nothing
    // is awaiting `p`, tripping Node's unhandled-rejection detection.
    const settled = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(1001);
    await settled;
    expect(w1.terminated).toBe(true);

    // Next call respawns a clean worker.
    vi.useRealTimers();
    const next = runCompositeThumbnailWorker(PNG);
    expect(FakeWorker.instances.length).toBe(2);
    const w2 = latest();
    w2.emit("message", {
      id: lastRequestId(w2),
      ok: true,
      jpegBytes: new Uint8Array([7])
    });
    expect(Buffer.from(await next)).toEqual(Buffer.from([7]));
  });
});
