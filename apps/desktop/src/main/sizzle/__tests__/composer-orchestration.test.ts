import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ComposeRequest } from "../composer";

type FakeChildProcess = EventEmitter & {
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

const spawnQueue: Array<{
  child: FakeChildProcess;
  command: string;
  args: string[];
}> = [];

function makeFakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]): FakeChildProcess => {
    const child = makeFakeChild();
    spawnQueue.push({ child, command, args });
    return child;
  }
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined)
}));

vi.mock("../../recording/ffmpeg-resolver", () => ({
  resolveFfmpegPath: () =>
    "C:\\Program Files\\PwrSnap\\resources\\PwrSnapFFmpeg.exe"
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

const { compose, ComposeError } = await import("../composer");

function request(platform: NodeJS.Platform = "win32"): ComposeRequest {
  return {
    scenes: [
      {
        kind: "image",
        imagePath: "C:\\captures\\scene.png",
        audioPath: "C:\\captures\\scene.m4a",
        durationSec: 1,
        transition: "cut"
      }
    ],
    outputPath: "C:\\renders\\reel.mp4",
    width: 640,
    height: 360,
    fps: 30,
    platform
  };
}

async function waitForSpawn(): Promise<(typeof spawnQueue)[number]> {
  const startedAt = Date.now();
  while (spawnQueue.length === 0) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("ffmpeg child was not spawned");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return spawnQueue[0]!;
}

describe("compose ffmpeg orchestration", () => {
  beforeEach(() => {
    spawnQueue.length = 0;
  });

  test("compose forwards win32 encoder args to the ffmpeg child", async () => {
    const composing = compose(request());
    const spawned = await waitForSpawn();

    expect(spawned.command).toBe(
      "C:\\Program Files\\PwrSnap\\resources\\PwrSnapFFmpeg.exe"
    );
    expect(spawned.args[spawned.args.indexOf("-c:v") + 1]).toBe("h264_mf");
    expect(spawned.args).not.toContain("h264_videotoolbox");
    expect(spawned.args).not.toContain("-allow_sw");

    spawned.child.emit("close", 0, null);
    await composing;
  });

  test("compose exposes the encoder diagnostic on nonzero exit", async () => {
    const composing = compose(request()).then(
      () => null,
      (cause: unknown) => cause
    );
    const spawned = await waitForSpawn();
    const diagnostic = "Unknown encoder 'h264_mf'";
    spawned.child.stderr.emit(
      "data",
      Buffer.from(`${diagnostic}\nError opening output file C:\\renders\\reel.mp4\n`)
    );
    spawned.child.emit("close", 1, null);

    const caught = await composing;
    expect(caught).toBeInstanceOf(ComposeError);
    expect(caught).toMatchObject({ code: "ffmpeg_failed" });
    expect((caught as InstanceType<typeof ComposeError>).message).toContain(
      diagnostic
    );
    expect((caught as InstanceType<typeof ComposeError>).details).toContain(
      diagnostic
    );
  });

  test("compose redacts path-bearing stderr and bounds IPC-visible details", async () => {
    const composing = compose(request()).then(
      () => null,
      (cause: unknown) => cause
    );
    const spawned = await waitForSpawn();
    const privateInput = "C:\\Users\\Alice\\Secret Client\\input.png";
    const privateOutput = "/Users/alice/Documents/Private Launch/reel.mp4";
    const diagnostic = `[h264_mf @ 000001] Error while opening encoder for '${privateOutput}'`;
    spawned.child.stderr.emit(
      "data",
      Buffer.from(
        `Input #0 from '${privateInput}'\n${diagnostic}\n${"private-detail ".repeat(200)}\nError opening output file ${privateOutput}\n`
      )
    );
    spawned.child.emit("close", 1, null);

    const caught = await composing;
    expect(caught).toBeInstanceOf(ComposeError);
    const error = caught as InstanceType<typeof ComposeError>;
    expect(error.message).toContain("Error while opening encoder");
    expect(error.message).toContain("<home-path>");
    expect(error.message).not.toContain("Alice");
    expect(error.message).not.toContain("Private Launch");
    expect(error.message.length).toBeLessThanOrEqual(512);
    expect(error.details).toContain("<home-path>");
    expect(error.details).not.toContain("Secret Client");
    expect(error.details).not.toContain("Private Launch");
    expect(error.details!.length).toBeLessThanOrEqual(1024);
  });

  test("compose does not promote an arbitrary last stderr line", async () => {
    const composing = compose(request()).then(
      () => null,
      (cause: unknown) => cause
    );
    const spawned = await waitForSpawn();
    spawned.child.stderr.emit(
      "data",
      Buffer.from("Error opening output file C:\\Users\\Alice\\Secret\\reel.mp4\n")
    );
    spawned.child.emit("close", 1, null);

    const caught = await composing;
    expect(caught).toBeInstanceOf(ComposeError);
    const error = caught as InstanceType<typeof ComposeError>;
    expect(error.message).toBe("ffmpeg exited with code 1");
    expect(error.message).not.toContain("Alice");
    expect(error.details).toContain("<home-path>");
  });

  test("compose maps a child spawn error to ffmpeg_failed", async () => {
    const onProgress = vi.fn();
    const composing = compose({ ...request(), onProgress }).then(
      () => null,
      (cause: unknown) => cause
    );
    const spawned = await waitForSpawn();
    spawned.child.emit("error", new Error("spawn EACCES"));
    // Node can follow a child `error` event with `close`. The first failure
    // must settle the render; a later successful close cannot report 100%.
    spawned.child.emit("close", 0, null);

    const caught = await composing;
    expect(caught).toBeInstanceOf(ComposeError);
    expect(caught).toMatchObject({
      code: "ffmpeg_failed",
      message: expect.stringContaining("spawn EACCES")
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  test("compose rejects unsupported Linux before spawning ffmpeg", async () => {
    const caught = await compose(request("linux")).then(
      () => null,
      (cause: unknown) => cause
    );

    expect(caught).toBeInstanceOf(ComposeError);
    expect(caught).toMatchObject({
      code: "unsupported_platform",
      message: expect.stringContaining("linux")
    });
    expect(spawnQueue).toHaveLength(0);
  });
});
