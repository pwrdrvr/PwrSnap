import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  frontmostPid: 4242 as number | null,
  listWindowsSnapshot: vi.fn(),
  activateApp: vi.fn(async () => undefined)
}));

vi.mock("../../capture/window-list", () => ({
  listWindowsSnapshot: mocks.listWindowsSnapshot,
  activateApp: mocks.activateApp
}));

const {
  snapshotRecordingForeground,
  withRecordingForegroundRestored
} = await import("../recording-foreground");

beforeEach(() => {
  mocks.frontmostPid = 4242;
  mocks.listWindowsSnapshot.mockReset();
  mocks.listWindowsSnapshot.mockImplementation(async () => ({
    windows: [],
    frontmostPid: mocks.frontmostPid,
    frontmostBundleId: null
  }));
  mocks.activateApp.mockClear();
});

describe("recording foreground restoration", () => {
  test("restores the snapshot exactly once", async () => {
    const foreground = await snapshotRecordingForeground();

    await foreground.restore();
    await foreground.restore();

    expect(foreground.pid).toBe(4242);
    expect(mocks.activateApp).toHaveBeenCalledTimes(1);
    expect(mocks.activateApp).toHaveBeenCalledWith(4242);
  });

  test("restores before the caller continues to the selector", async () => {
    const events: string[] = [];
    mocks.activateApp.mockImplementationOnce(async () => {
      events.push("restore");
    });

    await withRecordingForegroundRestored(async () => {
      events.push("permission");
    });
    events.push("selector");

    expect(events).toEqual(["permission", "restore", "selector"]);
  });

  test("restores after a cancelled or failed permission operation", async () => {
    await expect(
      withRecordingForegroundRestored(async () => {
        throw new Error("cancelled");
      })
    ).rejects.toThrow("cancelled");

    expect(mocks.activateApp).toHaveBeenCalledWith(4242);
  });

  test("missing foreground evidence degrades to a no-op", async () => {
    mocks.frontmostPid = null;
    const foreground = await snapshotRecordingForeground();

    await foreground.restore();

    expect(foreground.pid).toBeNull();
    expect(mocks.activateApp).not.toHaveBeenCalled();
  });

  test("the shipped Windows helper implements the activation boundary", async () => {
    const source = await readFile(
      new URL("../../../../native/window-list-win/main.cpp", import.meta.url),
      "utf8"
    );

    expect(source).toContain('std::wstring(argv[1]) == L"--activate-pid"');
    expect(source).toContain("ShowWindowAsync(context.window, SW_RESTORE)");
    expect(source).toContain("SetForegroundWindow(context.window)");
  });

  test("production restores required-preflight focus before opening the selector", async () => {
    const source = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const preflight = source.indexOf(
      "const requiredPreflight = await withRecordingForegroundRestored(() =>"
    );
    const selector = source.indexOf("const selection = await pickRegion({", preflight);

    expect(preflight).toBeGreaterThan(-1);
    expect(selector).toBeGreaterThan(preflight);
  });
});
