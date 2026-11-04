import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  token: "", closed: false,
  load: undefined as (() => Promise<void>) | undefined,
  methods: [] as string[],
}));
vi.mock("../camera-worker", () => ({
  CameraWorker: class {
    window = { id: 731 };
    async load() {
      state.closed = false;
      await state.load?.();
    }
    async call(method: string, ...args: unknown[]) {
      state.methods.push(method);
      const clock = Number(process.hrtime.bigint()) / 1e6 - 1000;
      if (method === "clock") return clock;
      if (method === "record") {
        state.token = args[1] as string;
        return {
          startedAt: clock,
          width: 1280,
          height: 720,
          mimeType: "video/mp4",
        };
      }
      if (method === "stop") return { durationSec: 5 };
      throw new Error("Unexpected camera operation");
    }
    close() {
      state.closed = true;
    }
  },
}));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
import {
  acceptCameraChunk,
  beginCameraRecording,
  cancelCameraRecording,
  finishCameraRecording,
  markCameraScreenStart,
  markCameraScreenStartUtc,
} from "../camera-recording";
import { resolveCameraSource } from "../camera-track-store";
let root: string | undefined;
afterEach(async () => {
  await cancelCameraRecording();
  state.load = undefined;
  state.methods.length = 0;
  if (root) await rm(root, { recursive: true, force: true });
});
test("only the selected internal recorder can append; adoption saves exact bytes and the screen offset", async () => {
  root = await mkdtemp(join(tmpdir(), "pwrsnap-camera-record-test-"));
  await beginCameraRecording({ deviceId: "chosen-camera" });
  markCameraScreenStart(Number(process.hrtime.bigint()) / 1e6 + 2000);
  markCameraScreenStart(); // A late generic start event must not replace the exact epoch.
  expect(await acceptCameraChunk("guessed-token", 731, [1, 2])).toBe(false);
  expect(await acceptCameraChunk(state.token, 732, [1, 2])).toBe(false);
  expect(await acceptCameraChunk(state.token, 731, [999])).toBe(false);
  expect(await acceptCameraChunk(state.token, 731, [0, 1, 255])).toBe(true);
  expect(await acceptCameraChunk(state.token, 731, [42, 43])).toBe(true);
  const stopped = await finishCameraRecording();
  expect(state.closed).toBe(true);
  const screen = join(root, "screen.mp4");
  const metadata = await stopped!.adopt(screen, "camera-recording");
  const original = Buffer.from([0, 1, 255, 42, 43]);
  expect(
    await readFile((await resolveCameraSource(screen, "camera-recording"))!),
  ).toEqual(original);
  expect(metadata.sha256).toBe(
    createHash("sha256").update(original).digest("hex"),
  );
  expect(metadata.offsetSec).toBeCloseTo(-2, 1);
  expect(await acceptCameraChunk(state.token, 731, [44])).toBe(false);
});
test("cancellation closes the camera and rejects late chunks", async () => {
  await beginCameraRecording({ deviceId: "chosen-camera" });
  await cancelCameraRecording();
  expect(state.closed).toBe(true);
  expect(await acceptCameraChunk(state.token, 731, [1])).toBe(false);
  expect(await finishCameraRecording()).toBeNull();
});

test("native UTC bridges a host clock separated from Node by hours of sleep", async () => {
  root = await mkdtemp(join(tmpdir(), "pwrsnap-camera-sleep-test-"));
  await beginCameraRecording({ deviceId: "chosen-camera" });
  // CoreMedia could report an uptime 36,280 seconds behind libuv. Its UTC
  // sample still identifies the same epoch as this calibrated camera clock.
  markCameraScreenStartUtc(Date.now() + 3000);
  await acceptCameraChunk(state.token, 731, [0, 1, 2]);
  const stopped = await finishCameraRecording();
  const metadata = await stopped!.adopt(join(root, "screen.mp4"), "sleep-clock");
  expect(metadata.offsetSec).toBeCloseTo(-3, 1);
});


test("cancelling during worker load prevents late calibration and camera capture", async () => {
  let loaded!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { loaded = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  state.load = () => { loaded(); return gate; };
  const starting = beginCameraRecording({ deviceId: "chosen-camera" }).catch((error: Error) => error);
  await entered;
  const first = cancelCameraRecording();
  const repeated = cancelCameraRecording();
  release();
  await Promise.all([first, repeated]);
  expect(await starting).toMatchObject({ message: "cancelled" });
  expect(state.closed).toBe(true);
  expect(state.methods).toEqual([]);
  expect(await finishCameraRecording()).toBeNull();
});
