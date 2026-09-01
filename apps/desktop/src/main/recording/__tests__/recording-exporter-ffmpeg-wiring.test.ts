import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoCaptureMetadata } from "@pwrsnap/shared";

type FakeChildProcess = EventEmitter & { stderr: EventEmitter };
type SpawnCall = {
  command: string;
  args: string[];
  options: { shell?: boolean };
};

const state = vi.hoisted(() => ({
  appPath: "",
  cacheRoot: "",
  spawnCalls: [] as SpawnCall[]
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => state.appPath }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

vi.mock("../../persistence/paths", () => ({
  getCacheRoot: () => state.cacheRoot
}));

vi.mock("../../persistence/video-repo", () => ({
  lookupExport: () => null,
  recordExport: () => undefined
}));

vi.mock("node:child_process", () => ({
  spawn: (
    command: string,
    args: string[],
    options: { shell?: boolean }
  ): FakeChildProcess => {
    state.spawnCalls.push({ command, args, options });
    const child = new EventEmitter() as FakeChildProcess;
    child.stderr = new EventEmitter();
    setImmediate(() => {
      const outputPath = args.at(-1);
      if (outputPath !== undefined) writeFileSync(outputPath, "encoded-media");
      child.emit("exit", 0);
    });
    return child;
  }
}));

const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const originalFfmpegPath = process.env.PWRSNAP_FFMPEG_PATH;
const originalResourcesDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = join(
    tmpdir(),
    `pwrsnap-exporter-ffmpeg-wiring-${Date.now()}-${tempRoots.length}`
  );
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function setResourcesPath(value: string): void {
  Object.defineProperty(process, "resourcesPath", { value, configurable: true });
}

async function importFreshExporter(): Promise<typeof import("../recording-exporter")> {
  vi.resetModules();
  return await import("../recording-exporter");
}

const video: VideoCaptureMetadata = {
  durationSec: 1,
  containerFormat: "mp4",
  hasSystemAudio: false,
  hasMicrophoneAudio: false,
  defaultRange: { start: 0, end: 1 },
  previewPath: null,
  previewStatus: "ready"
};

function exportInput(sourcePath: string) {
  return {
    record: {
      id: "resolver-wiring-capture",
      kind: "video",
      legacy_src_path: sourcePath,
      width_px: 320,
      height_px: 180
    } as CaptureRecord,
    video,
    format: "gif" as const,
    preset: "low" as const,
    range: { start: 0, end: 1 },
    audio: { includeSystemAudio: false, includeMicrophone: false }
  };
}

beforeEach(() => {
  setPlatform("win32");
  process.env.PATH = "";
  delete process.env.PWRSNAP_FFMPEG_PATH;
  state.spawnCalls.length = 0;
  state.appPath = makeTempRoot();
  state.cacheRoot = makeTempRoot();
  setResourcesPath(makeTempRoot());
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  process.env.PATH = originalPath;
  if (originalFfmpegPath === undefined) {
    delete process.env.PWRSNAP_FFMPEG_PATH;
  } else {
    process.env.PWRSNAP_FFMPEG_PATH = originalFfmpegPath;
  }
  if (originalResourcesDescriptor === undefined) {
    Reflect.deleteProperty(process, "resourcesPath");
  } else {
    Object.defineProperty(process, "resourcesPath", originalResourcesDescriptor);
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("recording exporter FFmpeg resolver wiring", () => {
  test("spawns a native Windows override directly with the shell disabled", async () => {
    const override = join(makeTempRoot(), "controlled ffmpeg.com");
    writeFileSync(override, "stub");
    process.env.PWRSNAP_FFMPEG_PATH = override;
    const sourcePath = join(makeTempRoot(), "source clip.mp4");
    writeFileSync(sourcePath, "source");
    const { exportVideoRange } = await importFreshExporter();

    await expect(exportVideoRange(exportInput(sourcePath))).resolves.toMatchObject({
      byteSize: 13,
      fromCache: false
    });

    expect(state.spawnCalls).toHaveLength(1);
    expect(state.spawnCalls[0]).toMatchObject({
      command: override,
      options: { shell: false }
    });
  });

  test("surfaces an actionable error from an existing Windows script override", async () => {
    const override = join(makeTempRoot(), "ffmpeg shim.cmd");
    writeFileSync(override, "stub");
    process.env.PWRSNAP_FFMPEG_PATH = override;
    const sourcePath = join(makeTempRoot(), "source.mp4");
    writeFileSync(sourcePath, "source");
    const { exportVideoRange } = await importFreshExporter();

    await expect(exportVideoRange(exportInput(sourcePath))).rejects.toThrow(
      /PWRSNAP_FFMPEG_PATH[\s\S]*\.cmd[\s\S]*native \.exe or \.com[\s\S]*shell disabled/
    );
    expect(state.spawnCalls).toHaveLength(0);
  });
});
