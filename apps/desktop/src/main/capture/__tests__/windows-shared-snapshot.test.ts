import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

import {
  __setWindowsSnapshotHelperPathForTest,
  createWindowsSharedSnapshot
} from "../windows-shared-snapshot";

type FailureMode = "write" | "release";

function pipeError(): Error {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

class FakePipe extends EventEmitter {
  destroy = vi.fn();
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakePipe();
  readonly stderr = new FakePipe();
  readonly stdin = new FakePipe() as FakePipe & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  exitCode: number | null = null;
  signalCode: string | null = null;
  killCalled = false;

  constructor(mode: FailureMode) {
    super();
    this.stdin.write = vi.fn(
      (_chunk: Buffer, callback?: (cause?: Error | null) => void): boolean => {
        queueMicrotask(() => {
          if (mode === "write") {
            const cause = pipeError();
            // Node reports a broken child pipe through BOTH surfaces. The
            // EventEmitter error is the dangerous one: without a persistent
            // listener it escapes the promise and crashes Electron main.
            this.stdin.emit("error", cause);
            callback?.(cause);
            return;
          }
          callback?.();
          this.stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                ok: true,
                version: 1,
                width: 1,
                height: 1,
                stride: 4,
                byteLength: "4",
                totalByteLength: "68"
              })}\n`
            )
          );
        });
        return true;
      }
    );
    this.stdin.end = vi.fn(() => {
      queueMicrotask(() => {
        if (mode === "release") {
          this.stdin.emit("error", pipeError());
          return;
        }
        this.exitCode = 0;
        this.emit("close", 0, null);
      });
    });
  }

  kill = (): boolean => {
    this.killCalled = true;
    this.signalCode = "SIGTERM";
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  };
}

let mode: FailureMode;
let child: FakeChild;

beforeEach(() => {
  mode = "write";
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    child = new FakeChild(mode);
    return child;
  });
  __setWindowsSnapshotHelperPathForTest("C:\\fake\\PwrSnapScreenSnapshot.exe");
});

afterEach(() => {
  __setWindowsSnapshotHelperPathForTest(null);
});

describe("Windows shared snapshot helper pipe failures", () => {
  test("rejects an early stdin EPIPE through the fallback boundary", async () => {
    await expect(
      createWindowsSharedSnapshot({
        bitmap: Buffer.from([10, 20, 30, 255]),
        width: 1,
        height: 1,
        sourcePixelFormat: "rgba8"
      })
    ).rejects.toThrow("write EPIPE");

    expect(child.killCalled).toBe(true);
    expect(child.stdin.listenerCount("error")).toBe(1);
    expect(() => child.stdin.emit("error", pipeError())).not.toThrow();
  });

  test("settles release when the owner pipe emits EPIPE", async () => {
    mode = "release";
    const snapshot = await createWindowsSharedSnapshot({
      bitmap: Buffer.from([10, 20, 30, 255]),
      width: 1,
      height: 1,
      sourcePixelFormat: "rgba8"
    });

    await expect(snapshot.release()).resolves.toBeUndefined();

    expect(child.killCalled).toBe(true);
    expect(child.stdin.listenerCount("error")).toBe(1);
    expect(() => child.stdin.emit("error", pipeError())).not.toThrow();
  });
});
