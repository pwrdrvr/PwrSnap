import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

async function importResolverWithExistingPaths(
  existingPaths: ReadonlySet<string>
): Promise<typeof import("../ffmpeg-resolver")> {
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
      ...actual,
      existsSync: (candidate: string) => existingPaths.has(candidate)
    };
  });
  return await importFreshResolver();
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
  test("builds Windows packaged + dev candidates with drive-letter paths", async () => {
    const { ffmpegLayoutCandidates } = await importFreshResolver();

    expect(
      ffmpegLayoutCandidates({
        platform: "win32",
        moduleDir: String.raw`C:\dev\PwrSnap\apps\desktop\out\main`,
        resourcesPath: String.raw`C:\Program Files\PwrSnap\resources`,
        appPath: String.raw`C:\Program Files\PwrSnap\resources\app.asar`
      })
    ).toEqual([
      String.raw`C:\Program Files\PwrSnap\resources\PwrSnapFFmpeg.exe`,
      String.raw`C:\dev\PwrSnap\apps\desktop\build\ffmpeg\ffmpeg.exe`,
      String.raw`C:\Program Files\PwrSnap\resources\app.asar\build\ffmpeg\ffmpeg.exe`
    ]);
  });

  test("preserves UNC roots in Windows packaged + dev candidates", async () => {
    const { ffmpegLayoutCandidates } = await importFreshResolver();

    expect(
      ffmpegLayoutCandidates({
        platform: "win32",
        moduleDir: String.raw`\\build-server\share\PwrSnap\apps\desktop\out\main`,
        resourcesPath: String.raw`\\fileserver\apps\PwrSnap\resources`,
        appPath: null
      })
    ).toEqual([
      String.raw`\\fileserver\apps\PwrSnap\resources\PwrSnapFFmpeg.exe`,
      String.raw`\\build-server\share\PwrSnap\apps\desktop\build\ffmpeg\ffmpeg.exe`
    ]);
  });

  test("splits Windows PATH with semicolons and discovers only native .exe/.com files", async () => {
    const { ffmpegPathCandidates, isRunnableFfmpegPath } = await importFreshResolver();
    const pathEnv = [
      String.raw`C:\Program Files\FFmpeg\bin`,
      String.raw`\\fileserver\media tools\bin`
    ].join(";");

    expect(ffmpegPathCandidates("win32", pathEnv)).toEqual([
      String.raw`C:\Program Files\FFmpeg\bin\ffmpeg.exe`,
      String.raw`C:\Program Files\FFmpeg\bin\ffmpeg.com`,
      String.raw`\\fileserver\media tools\bin\ffmpeg.exe`,
      String.raw`\\fileserver\media tools\bin\ffmpeg.com`
    ]);
    expect(isRunnableFfmpegPath("win32", String.raw`C:\tools\ffmpeg.exe`)).toBe(true);
    expect(isRunnableFfmpegPath("win32", String.raw`C:\tools\ffmpeg.COM`)).toBe(true);
    expect(isRunnableFfmpegPath("win32", String.raw`C:\tools\ffmpeg.cmd`)).toBe(false);
    expect(isRunnableFfmpegPath("win32", String.raw`C:\tools\ffmpeg.bat`)).toBe(false);
    expect(isRunnableFfmpegPath("win32", String.raw`C:\tools\ffmpeg.ps1`)).toBe(false);
    expect(ffmpegPathCandidates("win32", pathEnv).join(";")).not.toMatch(/\.cmd|\.bat/i);
  });

  test("resolves a native .com from inherited Windows PATH without considering script shims", async () => {
    setPlatform("win32");
    setResourcesPath(String.raw`C:\Program Files\PwrSnap\resources`);
    electronMock.appPath = String.raw`C:\Program Files\PwrSnap\resources\app.asar`;
    process.env.PATH = [
      String.raw`C:\shim-only`,
      String.raw`\\fileserver\media tools\bin`
    ].join(";");
    const nativeCom = String.raw`\\fileserver\media tools\bin\ffmpeg.com`;
    const filesThatExist = new Set([
      String.raw`C:\shim-only\ffmpeg.cmd`,
      String.raw`C:\shim-only\ffmpeg.bat`,
      nativeCom
    ]);

    try {
      const { resolveFfmpegPath } = await importResolverWithExistingPaths(filesThatExist);
      expect(resolveFfmpegPath()).toBe(nativeCom);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  test("does not resolve Windows PATH entries when only .cmd/.bat shims exist", async () => {
    setPlatform("win32");
    setResourcesPath(String.raw`C:\Program Files\PwrSnap\resources`);
    electronMock.appPath = String.raw`C:\Program Files\PwrSnap\resources\app.asar`;
    process.env.PATH = String.raw`C:\script-shims`;
    const filesThatExist = new Set([
      String.raw`C:\script-shims\ffmpeg.cmd`,
      String.raw`C:\script-shims\ffmpeg.bat`
    ]);

    try {
      const { resolveFfmpegPath } = await importResolverWithExistingPaths(filesThatExist);
      expect(resolveFfmpegPath()).toBeNull();
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  test.each(["exe", "com"])(
    "resolves an existing native Windows .%s explicit override",
    async (extension) => {
      setPlatform("win32");
      setResourcesPath(makeTempRoot());
      const override = join(makeTempRoot(), `controlled ffmpeg.${extension}`);
      writeFileSync(override, "stub");
      process.env.PWRSNAP_FFMPEG_PATH = override;

      const { resolveFfmpegPath } = await importFreshResolver();

      expect(resolveFfmpegPath()).toBe(override);
    }
  );

  test.each(["cmd", "bat"])(
    "rejects an existing Windows .%s explicit override instead of silently falling back",
    async (extension) => {
      setPlatform("win32");
      setResourcesPath(makeTempRoot());
      const override = join(makeTempRoot(), `ffmpeg shim.${extension}`);
      writeFileSync(override, "stub");
      process.env.PWRSNAP_FFMPEG_PATH = override;

      const { resolveFfmpegPath } = await importFreshResolver();

      expect(() => resolveFfmpegPath()).toThrow(
        new RegExp(
          `PWRSNAP_FFMPEG_PATH[\\s\\S]*\\.${extension}[\\s\\S]*native \\.exe or \\.com[\\s\\S]*shell disabled`
        )
      );
    }
  );

  test.each(["cmd", "bat"])(
    "rejects a stale Windows .%s explicit override before filesystem fallback",
    async (extension) => {
      setPlatform("win32");
      setResourcesPath(makeTempRoot());
      const missingOverride = join(makeTempRoot(), `removed ffmpeg shim.${extension}`);
      process.env.PWRSNAP_FFMPEG_PATH = missingOverride;

      const { resolveFfmpegPath } = await importFreshResolver();

      expect(() => resolveFfmpegPath()).toThrow(
        new RegExp(
          `PWRSNAP_FFMPEG_PATH[\\s\\S]*\\.${extension}[\\s\\S]*native \\.exe or \\.com[\\s\\S]*shell disabled`
        )
      );
    }
  );

  test("resolves packaged PwrSnapFFmpeg on macOS", async () => {
    setPlatform("darwin");
    const resources = makeTempRoot();
    setResourcesPath(resources);
    const packaged = join(resources, "PwrSnapFFmpeg");
    writeFileSync(packaged, "stub");

    const { resolveFfmpegPath } = await importFreshResolver();

    expect(resolveFfmpegPath()).toBe(packaged);
  });

  test("resolves an explicit override containing spaces", async () => {
    setPlatform("darwin");
    setResourcesPath(makeTempRoot());
    const overrideDir = join(makeTempRoot(), "controlled ffmpeg");
    mkdirSync(overrideDir, { recursive: true });
    const override = join(overrideDir, "ffmpeg");
    writeFileSync(override, "stub");
    process.env.PWRSNAP_FFMPEG_PATH = override;

    const { resolveFfmpegPath } = await importFreshResolver();

    expect(resolveFfmpegPath()).toBe(override);
  });
});
