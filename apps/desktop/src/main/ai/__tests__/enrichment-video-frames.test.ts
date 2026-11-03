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

class Extractor extends EventEmitter {
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
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
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("prepareEnrichmentVideoFrames", () => {
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
