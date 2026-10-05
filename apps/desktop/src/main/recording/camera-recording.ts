import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  open,
  mkdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CameraTrackMetadata, RecordingCamera } from "@pwrsnap/shared";
import { CameraWorker } from "./camera-worker";
import {
  cameraDirectory,
  cameraSourceFile,
  writeCameraManifest,
} from "./camera-track-store";

const now = () => Number(process.hrtime.bigint()) / 1e6;
let active: CameraRecording | null = null;

export class CameraRecording {
  readonly worker = new CameraWorker();
  readonly token = randomUUID();
  private file: FileHandle | null = null;
  private temp = "";
  private info: {
    startedAt: number;
    width: number;
    height: number;
    mimeType: CameraTrackMetadata["mimeType"];
  } | null = null;
  private clockOffset = 0;
  private screenStartedAt = 0;
  private durationSec = 0;
  private failed: Error | null = null;
  private serial: Promise<void> = Promise.resolve();
  private startup: Promise<void> | undefined;
  private cancelled = false;
  start(camera: RecordingCamera): Promise<void> {
    this.startup = this.open(camera);
    return this.startup;
  }
  private async open(camera: RecordingCamera): Promise<void> {
    this.temp = await mkdtemp(join(tmpdir(), "pwrsnap-camera-"));
    if (this.cancelled) throw new Error("cancelled");
    this.file = await open(join(this.temp, "source.partial"), "wx");
    if (this.cancelled) throw new Error("cancelled");
    await this.worker.load();
    let best = Infinity;
    // Calibrate renderer performance.now against main's monotonic clock.
    for (let i = 0; i < 5; i++) {
      const before = now();
      const remote = await this.worker.call<number>("clock");
      const after = now();
      if (after - before < best) {
        best = after - before;
        this.clockOffset = (before + after) / 2 - remote;
      }
    }
    this.info = await this.worker.call("record", camera.deviceId, this.token);
  }
  markScreenStart(hostTimeMs?: number): void {
    if (hostTimeMs !== undefined || !this.screenStartedAt)
      this.screenStartedAt = hostTimeMs ?? now();
  }
  async chunk(bytes: number[]): Promise<void> {
    this.serial = this.serial.then(async () => {
      if (!this.file) throw new Error("Camera recording is closed.");
      const buffer = Buffer.from(bytes);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await this.file.write(
          buffer,
          offset,
          buffer.length - offset,
        );
        if (bytesWritten === 0)
          throw new Error("Camera recording could not be written.");
        offset += bytesWritten;
      }
    });
    try {
      await this.serial;
    } catch (error) {
      this.failed = error as Error;
      throw error;
    }
  }
  async finish(): Promise<void> {
    try {
      const stopped = await this.worker.call<{ durationSec: number }>("stop");
      this.durationSec = stopped.durationSec;
      await this.serial;
      if (this.failed) throw this.failed;
      await this.file?.sync();
      await this.file?.close();
      this.file = null;
    } finally {
      this.worker.close();
    }
  }
  async adopt(
    screenPath: string,
    captureId: string,
  ): Promise<CameraTrackMetadata> {
    if (!this.info || !this.screenStartedAt || this.durationSec <= 0)
      throw new Error("The camera recording did not finish.");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(
      join(this.temp, "source.partial"),
    ))
      hash.update(chunk);
    const metadata: CameraTrackMetadata = {
      version: 1,
      durationSec: this.durationSec,
      width: this.info.width,
      height: this.info.height,
      offsetSec:
        (this.info.startedAt + this.clockOffset - this.screenStartedAt) / 1000,
      mimeType: this.info.mimeType,
      sha256: hash.digest("hex"),
    };
    const dest = cameraDirectory(screenPath, captureId);
    await mkdir(`${dest}.partial`, { recursive: true });
    const { moveFileWithExdevFallback } = await import(
      "../persistence/cross-device-move"
    );
    await moveFileWithExdevFallback(
      join(this.temp, "source.partial"),
      join(`${dest}.partial`, cameraSourceFile(metadata)),
    );
    await writeCameraManifest(`${dest}.partial`, metadata);
    await rename(`${dest}.partial`, dest);
    await rm(this.temp, { recursive: true, force: true });
    return metadata;
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.worker.close();
    await this.startup?.catch(() => undefined);
    await this.serial.catch(() => undefined);
    await this.file?.close();
    this.file = null;
    if (this.temp) await rm(this.temp, { recursive: true, force: true });
  }
}
export async function beginCameraRecording(
  camera?: RecordingCamera,
): Promise<void> {
  if (!camera) return;
  if (active) throw new Error("Camera already recording");
  const recording = new CameraRecording();
  active = recording;
  try {
    await recording.start(camera);
    if (active !== recording) throw new Error("cancelled");
  } catch (error) {
    if (active === recording) active = null;
    await recording.cancel();
    throw error;
  }
}
export function markCameraScreenStart(hostTimeMs?: number): void {
  active?.markScreenStart(hostTimeMs);
}
export async function finishCameraRecording(): Promise<CameraRecording | null> {
  const recording = active;
  if (recording) await recording.finish();
  active = null;
  return recording;
}
export async function cancelCameraRecording(): Promise<void> {
  const recording = active;
  active = null;
  await recording?.cancel();
}
export async function acceptCameraChunk(
  token: string,
  sourceWindowId: number | undefined,
  bytes: unknown,
): Promise<boolean> {
  if (
    !active ||
    token !== active.token ||
    sourceWindowId !== active.worker.window.id ||
    !Array.isArray(bytes) ||
    bytes.length > 256 * 1024 ||
    !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  )
    return false;
  await active.chunk(bytes);
  return true;
}
