// Cache + invalidation tests for app-icon-cache.
//
// Hot path: every sidebar repaint hits this through the
// `pwrsnap-app-icon://` protocol. The four behaviors we lock down:
//
//   1. Synthetic placeholders (`any` / `unknown`) and invalid bundle
//      ids never shell out to the helper — short-circuited at the top.
//   2. A fresh sidecar matching the live Info.plist mtime serves the
//      cached PNG directly (no helper call).
//   3. A stale sidecar (mtime changed) re-extracts.
//   4. Negative results (helper miss) are cached so we don't hammer
//      the helper while every sidebar row repaints.
//   5. Two concurrent calls for the same bundle id share one extract.
//
// Implementation lives in `../app-icons/app-icon-cache.ts`. Mocks the
// Swift helper wrapper + the icons-root path so tests run in a tmpdir
// without touching `<userData>`.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    iconsRoot: "" as string,
    extractAppIcon: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  };
});

vi.mock("../capture/window-list", () => ({
  extractAppIcon: mocks.extractAppIcon
}));

vi.mock("../persistence/paths", () => ({
  getAppIconsRoot: () => mocks.iconsRoot
}));

vi.mock("../log", () => ({
  getMainLogger: () => mocks.log
}));

async function freshModule(): Promise<typeof import("../app-icons/app-icon-cache")> {
  vi.resetModules();
  // dynamic import after resetModules so the module-level Maps + the
  // `rootEnsured` flag start clean per test.
  return (await import("../app-icons/app-icon-cache"));
}

function makeFakeApp(rootDir: string, bundleId: string, plistMtimeMs?: number): string {
  // Build a fake .app skeleton so `infoPlistMtime` has something to
  // stat. `appPath/Contents/Info.plist` is the only path read.
  const appPath = join(rootDir, `${bundleId}.app`);
  mkdirSync(join(appPath, "Contents"), { recursive: true });
  const plistPath = join(appPath, "Contents", "Info.plist");
  writeFileSync(plistPath, "<plist/>", "utf8");
  if (plistMtimeMs !== undefined) {
    // Round-trip through Date so atimeMs/mtimeMs land cleanly.
    const t = new Date(plistMtimeMs);
    // utimesSync via node:fs — sync equivalent for tests.
    // Use a fixed mtime so the sidecar comparison is deterministic.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    fs.utimesSync(plistPath, t, t);
  }
  return appPath;
}

describe("getAppIconPath", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pwrsnap-app-icon-cache-"));
    mocks.iconsRoot = join(tmpRoot, "app-icons");
    mocks.extractAppIcon.mockReset();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("synthetic placeholder ids short-circuit without hitting the helper", async () => {
    const { getAppIconPath } = await freshModule();
    expect(await getAppIconPath("any")).toBeNull();
    expect(await getAppIconPath("unknown")).toBeNull();
    expect(mocks.extractAppIcon).not.toHaveBeenCalled();
  });

  test("invalid bundle id (slashes, spaces, empty) short-circuits without hitting the helper", async () => {
    const { getAppIconPath } = await freshModule();
    expect(await getAppIconPath("")).toBeNull();
    expect(await getAppIconPath("com.evil/../passwd")).toBeNull();
    expect(await getAppIconPath("com.spaces here")).toBeNull();
    expect(mocks.extractAppIcon).not.toHaveBeenCalled();
  });

  test("first call extracts; second call hits the on-disk cache (no second helper invocation)", async () => {
    const bundleId = "com.test.cache-hit";
    const appPath = makeFakeApp(tmpRoot, bundleId, 1_700_000_000_000);

    mocks.extractAppIcon.mockImplementation(async (_bid, outPath) => {
      writeFileSync(outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
      return { ok: true, appPath };
    });

    const { getAppIconPath } = await freshModule();
    const first = await getAppIconPath(bundleId);
    const second = await getAppIconPath(bundleId);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(mocks.extractAppIcon).toHaveBeenCalledTimes(1);
  });

  test("re-extracts when Info.plist mtime moves (app auto-updated)", async () => {
    const bundleId = "com.test.cache-miss-on-mtime";
    const appPath = makeFakeApp(tmpRoot, bundleId, 1_700_000_000_000);

    mocks.extractAppIcon.mockImplementation(async (_bid, outPath) => {
      writeFileSync(outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { ok: true, appPath };
    });

    const { getAppIconPath } = await freshModule();
    await getAppIconPath(bundleId);
    expect(mocks.extractAppIcon).toHaveBeenCalledTimes(1);

    // Bump the Info.plist mtime forward — simulates an app update.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    const newer = new Date(1_700_000_999_999);
    fs.utimesSync(join(appPath, "Contents", "Info.plist"), newer, newer);

    await getAppIconPath(bundleId);
    expect(mocks.extractAppIcon).toHaveBeenCalledTimes(2);
  });

  test("negative result is cached — second call doesn't re-shell-out", async () => {
    const bundleId = "com.test.never-installed";
    mocks.extractAppIcon.mockResolvedValue({
      ok: false,
      message: "no installed app for bundle id"
    });

    const { getAppIconPath } = await freshModule();
    expect(await getAppIconPath(bundleId)).toBeNull();
    expect(await getAppIconPath(bundleId)).toBeNull();
    expect(mocks.extractAppIcon).toHaveBeenCalledTimes(1);
  });

  test("concurrent calls for the same bundle id share one extract (in-flight dedup)", async () => {
    const bundleId = "com.test.in-flight";
    const appPath = makeFakeApp(tmpRoot, bundleId, 1_700_000_000_000);

    // Release the extract only when both sidebar callers have already
    // awaited it — proves they share one promise.
    let resolveExtract: ((value: { ok: true; appPath: string }) => void) | undefined;
    const extractPromise = new Promise<{ ok: true; appPath: string }>((resolve) => {
      resolveExtract = resolve;
    });
    mocks.extractAppIcon.mockImplementation(async (_bid, outPath) => {
      const result = await extractPromise;
      writeFileSync(outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return result;
    });

    const { getAppIconPath } = await freshModule();
    const [pA, pB] = [getAppIconPath(bundleId), getAppIconPath(bundleId)];
    // Yield a tick so both calls have registered on the in-flight map.
    await new Promise((r) => setImmediate(r));
    resolveExtract!({ ok: true, appPath });

    const [a, b] = await Promise.all([pA, pB]);
    expect(a).toEqual(b);
    expect(mocks.extractAppIcon).toHaveBeenCalledTimes(1);
  });

  test("missing Info.plist on the resolved app stores mtime=0 and triggers re-extract next call", async () => {
    const bundleId = "com.test.no-plist";
    const appPath = join(tmpRoot, `${bundleId}.app`);
    mkdirSync(appPath, { recursive: true }); // NB: no Contents/Info.plist

    mocks.extractAppIcon.mockImplementation(async (_bid, outPath) => {
      writeFileSync(outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { ok: true, appPath };
    });

    const { getAppIconPath } = await freshModule();
    const first = await getAppIconPath(bundleId);
    expect(first).not.toBeNull();

    // Sidecar stored mtime=0; liveMtime stays null; validation falls
    // through and we extract again. Acceptable — apps without a
    // readable Info.plist are exceptional, not a hot path.
    await getAppIconPath(bundleId);
    expect(mocks.extractAppIcon).toHaveBeenCalledTimes(2);
  });

  test("sidecar.json is written atomically (no .tmp file left on success)", async () => {
    const bundleId = "com.test.atomic-sidecar";
    const appPath = makeFakeApp(tmpRoot, bundleId, 1_700_000_000_000);

    mocks.extractAppIcon.mockImplementation(async (_bid, outPath) => {
      writeFileSync(outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { ok: true, appPath };
    });

    const { getAppIconPath } = await freshModule();
    await getAppIconPath(bundleId);

    // Sidecar lives at <iconsRoot>/<bundleId>.json. The tmp file
    // (<iconsRoot>/<bundleId>.json.tmp-<pid>) must NOT exist post-write.
    expect(() => statSync(join(mocks.iconsRoot, `${bundleId}.json`))).not.toThrow();
    expect(() => statSync(join(mocks.iconsRoot, `${bundleId}.json.tmp-${process.pid}`)))
      .toThrow();
  });
});
