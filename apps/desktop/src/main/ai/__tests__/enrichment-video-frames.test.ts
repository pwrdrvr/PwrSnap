import { EventEmitter } from "node:events";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../recording/ffmpeg-resolver", () => ({ resolveFfmpegPath: () => "fixture-ffmpeg" }));
import { prepareEnrichmentVideoFrames } from "../enrichment-image";
import { EnrichmentQueue } from "../direct-api/enrichment-queue";

class Extractor extends EventEmitter {
  stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  kill = vi.fn(() => true);
  unref = vi.fn();
  constructor(readonly args: string[]) { super(); }
  get path(): string { return this.args.at(-1)!; }
  async complete(): Promise<void> {
    await sharp({ create: { width: 32, height: 16, channels: 3, background: "#123456" } })
      .jpeg().toFile(this.path);
    this.emit("exit", 0);
    this.emit("close", 0);
  }
  close(code: number | null = null): void {
    this.emit("exit", code);
    this.emit("close", code);
  }
}

const checkpoint = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
let root: string;
let children: Extractor[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pwrsnap-video-frames-"));
  children = [];
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = new Extractor(args);
    children.push(child);
    return child;
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("prepareEnrichmentVideoFrames", () => {
  test.each(["cancel", "failure"] as const)("%s escalates an unresponsive extractor to SIGKILL and drains before cleanup", async (scenario) => {
    const abort = new AbortController();
    let settled = false;
    const outcome = prepareEnrichmentVideoFrames("fixture.mp4", {
      durationSec: 10, tempRoot: root, abortSignal: abort.signal
    }).catch((error: unknown) => error).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(children).toHaveLength(2));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      if (scenario === "cancel") abort.abort();
      else children[0]!.close(9);
      await checkpoint();
      expect(children[1]!.kill.mock.calls).toEqual([["SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(999);
      expect(children[1]!.kill.mock.calls).toEqual([["SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(1);
      expect(children[1]!.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(settled).toBe(false);
      await expect(access(dirname(children[1]!.path))).resolves.toBeUndefined();
      for (const child of children) child.close();
      const error = await outcome;
      expect((error as Error).message).toMatch(scenario === "cancel" ? /aborted/ : /ffmpeg exited 9/);
      expect(await readdir(root)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(children).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      for (const child of children) child.close(1);
      await outcome;
    }
  });

  test.each(["unresponsive", "signaling throws"])("a missing close event cannot strand a single-slot connection (%s), and scratch waits for both children", async (scenario) => {
    const abort = new AbortController();
    const queue = new EnrichmentQueue();
    const first = queue.acquire("fixture-connection", 1, abort.signal);
    await first.ready;
    const next = queue.acquire("fixture-connection", 1, new AbortController().signal);
    let nextStarted = false;
    void next.ready.then(() => { nextStarted = true; });
    let settled = false;
    const outcome = prepareEnrichmentVideoFrames("fixture.mp4", {
      durationSec: 10, tempRoot: root, abortSignal: abort.signal
    }).catch((error: unknown) => error).finally(() => { settled = true; first.release(); });
    try {
      await vi.waitFor(() => expect(children).toHaveLength(2));
      if (scenario === "signaling throws") {
        for (const child of children) child.kill.mockImplementation(() => { throw new Error("signal failed"); });
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      abort.abort();
      await vi.advanceTimersByTimeAsync(6_000);
      await checkpoint();
      expect(settled).toBe(true);
      expect(await outcome).toMatchObject({ name: "AbortError" });
      await next.ready;
      expect(nextStarted).toBe(true);
      expect(children).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
      for (const child of children) {
        expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
        expect(child.unref).toHaveBeenCalledOnce();
        expect(child.stderr.destroy).toHaveBeenCalledOnce();
      }
      await expect(access(dirname(children[0]!.path))).resolves.toBeUndefined();
      children[0]!.close();
      await checkpoint();
      await expect(access(dirname(children[1]!.path))).resolves.toBeUndefined();
      children[1]!.close();
      vi.useRealTimers();
      await vi.waitFor(async () => expect(await readdir(root)).toEqual([]));
    } finally {
      vi.useRealTimers();
      for (const child of children) child.close(1);
      await outcome;
      next.release();
    }
  });

  test("a child that closes during the SIGTERM grace period never receives a delayed SIGKILL", async () => {
    const abort = new AbortController();
    const outcome = prepareEnrichmentVideoFrames("fixture.mp4", {
      durationSec: 10, tempRoot: root, abortSignal: abort.signal
    }).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(children).toHaveLength(2));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      abort.abort();
      for (const child of children) child.close();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      for (const child of children) expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    } finally {
      vi.useRealTimers();
      for (const child of children) child.close(1);
      await outcome;
    }
  });

  test("admits two samples, bounds active extractors, and returns sample order after out-of-order completion", async () => {
    const preparation = prepareEnrichmentVideoFrames("fixture.mp4", { durationSec: 10, tempRoot: root });
    try {
      await vi.waitFor(() => expect(children.length).toBeGreaterThan(0));
      await checkpoint();
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.args[2])).toEqual(["1.500", "5.000"]);
      await children[1]!.complete();
      await vi.waitFor(() => expect(children).toHaveLength(3));
      await children[2]!.complete();
      await children[0]!.complete();
      const result = await preparation;
      expect(result.frames.map((f) => f.positionPct)).toEqual([15, 50, 85]);
      expect(result.frames.map((f) => f.path)).toEqual(children.map((c) => c.path));
      expect(result.frames.every((f) => f.width === 32 && f.height === 16 && f.byteSize > 0)).toBe(true);
      await result.cleanup();
      expect(await readdir(root)).toEqual([]);
    } finally {
      for (const child of children) child.close(1);
      await preparation.catch(() => undefined);
    }
  });

  test.each(["failure", "cancel", "byte limit", "spawn error"] as const)("%s stops admission and drains children before removing scratch files", async (scenario) => {
    const abort = new AbortController();
    let settled = false;
    const preparation = prepareEnrichmentVideoFrames("fixture.mp4", {
      durationSec: 10, tempRoot: root, abortSignal: abort.signal,
      ...(scenario === "byte limit" ? { maxBytes: 1 } : {})
    });
    const outcome = preparation.catch((error: unknown) => error).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(children.length).toBeGreaterThan(0));
      await checkpoint();
      expect(children).toHaveLength(2);
      if (scenario === "failure") children[0]!.close(9);
      else if (scenario === "cancel") abort.abort();
      else if (scenario === "byte limit") await children[0]!.complete();
      else {
        children[0]!.emit("error", new Error("spawn failed"));
        children[0]!.close();
      }
      await vi.waitFor(() => expect(children[1]!.kill).toHaveBeenCalled());
      expect(children[1]!.kill).toHaveBeenCalledWith("SIGTERM");
      expect(settled).toBe(false);
      await expect(access(dirname(children[1]!.path))).resolves.toBeUndefined();
      children[0]!.close();
      children[1]!.close();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      const message = { failure: /ffmpeg exited 9/, cancel: /aborted/, "byte limit": /byte limit/, "spawn error": /spawn failed/ }[scenario];
      expect((error as Error).message).toMatch(message);
      expect(children).toHaveLength(2);
      expect(await readdir(root)).toEqual([]);
    } finally {
      for (const child of children) child.close(1);
      await outcome;
    }
  });

  test("an already cancelled request never spawns or creates scratch files", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(prepareEnrichmentVideoFrames("fixture.mp4", {
      durationSec: 10, tempRoot: root, abortSignal: abort.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(children).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });
});
