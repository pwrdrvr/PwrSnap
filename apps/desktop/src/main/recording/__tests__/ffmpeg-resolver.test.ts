import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  appPath: ""
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => electronMock.appPath
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const originalFfmpegPath = process.env.PWRSNAP_FFMPEG_PATH;
const originalResourcesDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = join(tmpdir(), `pwrsnap-ffmpeg-resolver-${Date.now()}-${tempRoots.length}`);
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

async function importFreshResolver(): Promise<typeof import("../ffmpeg-resolver")> {
  vi.resetModules();
  return await import("../ffmpeg-resolver");
}

beforeEach(() => {
  delete process.env.PWRSNAP_FFMPEG_PATH;
  process.env.PATH = "";
  electronMock.appPath = makeTempRoot();
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

describe("resolveFfmpegPath", () => {
  test("resolves packaged PwrSnapFFmpeg.exe on Windows", async () => {
    setPlatform("win32");
    const resources = makeTempRoot();
    setResourcesPath(resources);
    const packaged = join(resources, "PwrSnapFFmpeg.exe");
    writeFileSync(packaged, "stub");

    const { resolveFfmpegPath } = await importFreshResolver();

    expect(resolveFfmpegPath()).toBe(packaged);
  });

  test("finds ffmpeg.exe on PATH on Windows", async () => {
    setPlatform("win32");
    setResourcesPath(makeTempRoot());
    const binDir = makeTempRoot();
    const ffmpeg = join(binDir, "ffmpeg.exe");
    writeFileSync(ffmpeg, "stub");
    process.env.PATH = [binDir, makeTempRoot()].join(delimiter);

    const { resolveFfmpegPath } = await importFreshResolver();

    expect(resolveFfmpegPath()).toBe(ffmpeg);
  });

  test("resolves packaged PwrSnapFFmpeg on macOS", async () => {
    setPlatform("darwin");
    const resources = makeTempRoot();
    setResourcesPath(resources);
    const packaged = join(resources, "PwrSnapFFmpeg");
    writeFileSync(packaged, "stub");

    const { resolveFfmpegPath } = await importFreshResolver();

    expect(resolveFfmpegPath()).toBe(packaged);
  });
});