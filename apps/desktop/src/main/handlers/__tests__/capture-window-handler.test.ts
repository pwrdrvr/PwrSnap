import {
  err,
  ok,
  type CaptureRecord,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import { describe, expect, test, vi } from "vitest";
import type { CommandContext } from "../../command-bus";
import type {
  WindowBounds,
  WindowInfo,
  WindowListSnapshot
} from "../../capture/window-list";
import {
  createCaptureWindowHandler,
  type CaptureWindowHandlerDependencies
} from "../capture-window-handler";

const context: CommandContext = {
  principal: "ipc",
  signal: new AbortController().signal
};

const persistedRecord = {
  id: "cap_window_1",
  kind: "image",
  bundle_format_version: 2,
  source_app_bundle_id: "com.example.Editor",
  source_app_name: "Editor"
} as CaptureRecord;

function attributedRecord(sourceWindow: WindowInfo): CaptureRecord {
  return {
    ...persistedRecord,
    source_app_bundle_id: sourceWindow.bundleId,
    source_app_name: sourceWindow.appName
  };
}

function windowInfo(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    windowId: 42,
    pid: 4242,
    bundleId: "com.example.Editor",
    appName: "Editor",
    title: "Design notes",
    bounds: { x: 100, y: 80, width: 900, height: 700 },
    layer: 0,
    alpha: 1,
    isFrontmostInApp: true,
    ...overrides
  };
}

function snapshot(windows: WindowInfo[]): WindowListSnapshot {
  return {
    windows,
    frontmostPid: windows[0]?.pid ?? null,
    frontmostBundleId: windows[0]?.bundleId ?? null
  };
}

function sameBounds(a: WindowBounds, b: WindowBounds): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

function makeDependencies(
  overrides: Partial<CaptureWindowHandlerDependencies> = {}
): CaptureWindowHandlerDependencies {
  const target = windowInfo();
  return {
    platform: "darwin",
    guardScreenCapture: vi.fn(async () => null),
    ensureCapturesDirReady: vi.fn(async () => null),
    listWindowsSnapshot: vi.fn(async () => snapshot([target])),
    normalizeWindowSnapshot: vi.fn((windows) => [...windows]),
    selfPidSet: vi.fn(() => new Set<number>()),
    selfWindowBoundsList: vi.fn(() => []),
    peerPwrSnapPid: vi.fn(() => null),
    boundsApproxEqual: vi.fn(sameBounds),
    captureWindow: vi.fn(async () => ({
      ok: true as const,
      tempPath: "/tmp/pwrsnap-handler-test/source.png",
      displayId: 0
    })),
    persistCapture: vi.fn(async () => ok(persistedRecord)),
    releaseCaptureTemp: vi.fn(async () => undefined),
    reportCleanupFailure: vi.fn(),
    ...overrides
  };
}

async function dispatch(
  deps: CaptureWindowHandlerDependencies,
  windowId: number
) {
  return createCaptureWindowHandler(deps)({ windowId }, context);
}

describe("capture:window headless handler", () => {
  test.each([
    undefined,
    "42",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1
  ])("rejects invalid id %s before any side effect", async (windowId) => {
    const deps = makeDependencies();
    const handler = createCaptureWindowHandler(deps);

    const result = await handler(
      { windowId } as unknown as { windowId: number },
      context
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "validation",
        code: "invalid_window_id",
        message: "windowId must be a positive safe integer"
      }
    });
    expect(deps.guardScreenCapture).not.toHaveBeenCalled();
    expect(deps.listWindowsSnapshot).not.toHaveBeenCalled();
    expect(deps.captureWindow).not.toHaveBeenCalled();
    expect(deps.persistCapture).not.toHaveBeenCalled();
  });

  test.each([null, undefined, "window", 42])(
    "rejects malformed request payload %s without throwing",
    async (request) => {
      const deps = makeDependencies();
      const handler = createCaptureWindowHandler(deps);

      const result = await handler(request as never, context);

      expect(result).toMatchObject({
        ok: false,
        error: { kind: "validation", code: "invalid_window_id" }
      });
      expect(deps.guardScreenCapture).not.toHaveBeenCalled();
    }
  );

  test("fails closed on unsupported platforms before permission or lookup", async () => {
    const deps = makeDependencies({ platform: "linux" });

    const result = await dispatch(deps, 42);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "capture", code: "unsupported_platform" }
    });
    expect(deps.guardScreenCapture).not.toHaveBeenCalled();
    expect(deps.listWindowsSnapshot).not.toHaveBeenCalled();
  });

  test("uses the headless screen-permission gate without routing to Settings", async () => {
    const denied: Result<never, PwrSnapError> = err({
      kind: "permission",
      code: "screen_not_granted",
      message: "not granted"
    });
    const guardScreenCapture = vi.fn(async () => denied);
    const deps = makeDependencies({ guardScreenCapture });

    const result = await dispatch(deps, 42);

    expect(result).toBe(denied);
    expect(guardScreenCapture).toHaveBeenCalledExactlyOnceWith({
      routeToSettings: false
    });
    expect(deps.ensureCapturesDirReady).not.toHaveBeenCalled();
    expect(deps.listWindowsSnapshot).not.toHaveBeenCalled();
    expect(deps.captureWindow).not.toHaveBeenCalled();
  });

  test("propagates a typed storage gate failure before window lookup", async () => {
    const blocked: Result<never, PwrSnapError> = err({
      kind: "capture",
      code: "captures_dir_denied",
      message: "storage denied"
    });
    const deps = makeDependencies({
      ensureCapturesDirReady: vi.fn(async () => blocked)
    });

    const result = await dispatch(deps, 42);

    expect(result).toBe(blocked);
    expect(deps.listWindowsSnapshot).not.toHaveBeenCalled();
    expect(deps.captureWindow).not.toHaveBeenCalled();
    expect(deps.persistCapture).not.toHaveBeenCalled();
  });

  test("performs a fresh lookup for every dispatch and rejects a vanished id", async () => {
    const target = windowInfo();
    const listWindowsSnapshot = vi
      .fn<() => Promise<WindowListSnapshot>>()
      .mockResolvedValueOnce(snapshot([target]))
      .mockResolvedValueOnce(snapshot([target]))
      .mockResolvedValueOnce(snapshot([]));
    const deps = makeDependencies({ listWindowsSnapshot });
    const handler = createCaptureWindowHandler(deps);

    const first = await handler({ windowId: target.windowId }, context);
    const second = await handler({ windowId: target.windowId }, context);

    expect(first).toEqual(ok(persistedRecord));
    expect(second).toMatchObject({
      ok: false,
      error: { kind: "capture", code: "window_unavailable" }
    });
    expect(listWindowsSnapshot).toHaveBeenCalledTimes(3);
    expect(deps.captureWindow).toHaveBeenCalledTimes(1);
    expect(deps.persistCapture).toHaveBeenCalledTimes(1);
  });

  test("cleans the captured temp when the window disappears before identity revalidation", async () => {
    const target = windowInfo();
    const deps = makeDependencies({
      listWindowsSnapshot: vi
        .fn<() => Promise<WindowListSnapshot>>()
        .mockResolvedValueOnce(snapshot([target]))
        .mockResolvedValueOnce(snapshot([]))
    });

    const result = await dispatch(deps, target.windowId);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "capture", code: "window_unavailable" }
    });
    expect(deps.persistCapture).not.toHaveBeenCalled();
    expect(deps.releaseCaptureTemp).toHaveBeenCalledExactlyOnceWith(
      "/tmp/pwrsnap-handler-test/source.png"
    );
  });

  test.each([
    ["pid", { pid: 5252 }],
    ["bundle identity", { bundleId: "com.example.Reused" }],
    ["application identity", { appName: "Reused App" }]
  ])(
    "rejects native id reuse with changed %s and cleans the captured temp",
    async (_label, changes) => {
      const target = windowInfo();
      const reused = windowInfo(changes);
      const deps = makeDependencies({
        listWindowsSnapshot: vi
          .fn<() => Promise<WindowListSnapshot>>()
          .mockResolvedValueOnce(snapshot([target]))
          .mockResolvedValueOnce(snapshot([reused]))
      });

      const result = await dispatch(deps, target.windowId);

      expect(result).toMatchObject({
        ok: false,
        error: { kind: "capture", code: "window_unavailable" }
      });
      expect(deps.persistCapture).not.toHaveBeenCalled();
      expect(deps.releaseCaptureTemp).toHaveBeenCalledExactlyOnceWith(
        "/tmp/pwrsnap-handler-test/source.png"
      );
    }
  );

  test("treats a hidden or minimized window omitted from the live list as unavailable", async () => {
    const deps = makeDependencies({
      platform: "win32",
      listWindowsSnapshot: vi.fn(async () => snapshot([]))
    });

    const result = await dispatch(deps, 42);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "window_unavailable" }
    });
    expect(deps.captureWindow).not.toHaveBeenCalled();
  });

  test("rejects a PwrSnap-owned pid plus BrowserWindow-bounds match", async () => {
    const target = windowInfo({ pid: 777 });
    const deps = makeDependencies({
      listWindowsSnapshot: vi.fn(async () => snapshot([target])),
      selfPidSet: vi.fn(() => new Set([777])),
      selfWindowBoundsList: vi.fn(() => [target.bounds])
    });

    const result = await dispatch(deps, target.windowId);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "own_window_not_allowed" }
    });
    expect(deps.captureWindow).not.toHaveBeenCalled();
  });

  test("rejects a window owned by the split Library peer process", async () => {
    const target = windowInfo({ pid: 778 });
    const deps = makeDependencies({
      listWindowsSnapshot: vi.fn(async () => snapshot([target])),
      selfPidSet: vi.fn(() => new Set<number>()),
      selfWindowBoundsList: vi.fn(() => []),
      peerPwrSnapPid: vi.fn(() => target.pid)
    });

    const result = await dispatch(deps, target.windowId);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "own_window_not_allowed" }
    });
    expect(deps.captureWindow).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "same pid with different bounds",
      ownPids: new Set([4242]),
      ownBounds: [{ x: 0, y: 0, width: 200, height: 100 }]
    },
    {
      name: "same bounds with a different pid",
      ownPids: new Set([9000]),
      ownBounds: [{ x: 100, y: 80, width: 900, height: 700 }]
    }
  ])("allows $name", async ({ ownPids, ownBounds }) => {
    const deps = makeDependencies({
      selfPidSet: vi.fn(() => ownPids),
      selfWindowBoundsList: vi.fn(() => ownBounds)
    });

    const result = await dispatch(deps, 42);

    expect(result).toEqual(ok(persistedRecord));
    expect(deps.captureWindow).toHaveBeenCalledWith(42);
  });

  test("darwin passes fresh source metadata and returns the attributed record", async () => {
    const target = windowInfo({
      windowId: 83,
      bundleId: "com.apple.Terminal",
      appName: "Terminal",
      title: "build logs"
    });
    const revalidated = { ...target, title: "build complete" };
    const normalizeWindowSnapshot = vi.fn((windows: readonly WindowInfo[]) => [
      ...windows
    ]);
    const persistCapture = vi.fn(
      async (_tempPath: string, sourceWindow: WindowInfo) =>
        ok(attributedRecord(sourceWindow))
    );
    const deps = makeDependencies({
      platform: "darwin",
      listWindowsSnapshot: vi
        .fn<() => Promise<WindowListSnapshot>>()
        .mockResolvedValueOnce(snapshot([target]))
        .mockResolvedValueOnce(snapshot([revalidated])),
      normalizeWindowSnapshot,
      persistCapture
    });

    const result = await dispatch(deps, target.windowId);

    expect(result).toEqual(ok(attributedRecord(revalidated)));
    expect(normalizeWindowSnapshot).toHaveBeenNthCalledWith(1, [target], "darwin");
    expect(normalizeWindowSnapshot).toHaveBeenNthCalledWith(
      2,
      [revalidated],
      "darwin"
    );
    expect(deps.captureWindow).toHaveBeenCalledExactlyOnceWith(83);
    expect(persistCapture).toHaveBeenCalledExactlyOnceWith(
      "/tmp/pwrsnap-handler-test/source.png",
      revalidated
    );
    expect(deps.releaseCaptureTemp).toHaveBeenCalledExactlyOnceWith(
      "/tmp/pwrsnap-handler-test/source.png"
    );
  });

  test("win32 normalizes physical bounds to DIP before own-window matching and attribution", async () => {
    const raw = windowInfo({
      windowId: 0x20_0042,
      pid: 1234,
      bundleId: "C:\\Program Files\\Editor\\editor.exe",
      appName: "Editor",
      bounds: { x: 200, y: 160, width: 1800, height: 1400 }
    });
    const normalized = {
      ...raw,
      bounds: { x: 100, y: 80, width: 900, height: 700 }
    };
    const normalizeWindowSnapshot = vi.fn(
      (_windows: readonly WindowInfo[], platform: NodeJS.Platform) => {
        expect(platform).toBe("win32");
        return [normalized];
      }
    );
    const deps = makeDependencies({
      platform: "win32",
      listWindowsSnapshot: vi.fn(async () => snapshot([raw])),
      normalizeWindowSnapshot,
      selfPidSet: vi.fn(() => new Set([raw.pid])),
      selfWindowBoundsList: vi.fn(() => [normalized.bounds])
    });

    const result = await dispatch(deps, raw.windowId);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "own_window_not_allowed" }
    });
    expect(normalizeWindowSnapshot).toHaveBeenCalledWith([raw], "win32");
    expect(deps.boundsApproxEqual).toHaveBeenCalledWith(
      normalized.bounds,
      normalized.bounds
    );
    expect(deps.captureWindow).not.toHaveBeenCalled();
  });

  test("win32 preserves executable-path source attribution without reading it", async () => {
    const target = windowInfo({
      windowId: 0x30_0042,
      bundleId: "C:\\Program Files\\Browser\\browser.exe",
      appName: "Browser",
      title: "Docs"
    });
    const persistCapture = vi.fn(
      async (_tempPath: string, sourceWindow: WindowInfo) =>
        ok(attributedRecord(sourceWindow))
    );
    const deps = makeDependencies({
      platform: "win32",
      listWindowsSnapshot: vi.fn(async () => snapshot([target])),
      persistCapture
    });

    const result = await dispatch(deps, target.windowId);

    expect(result).toEqual(ok(attributedRecord(target)));
    expect(persistCapture).toHaveBeenCalledWith(
      expect.any(String),
      target
    );
  });

  test.each([
    { reason: "error" as const, message: "protected source" },
    { reason: "error" as const, message: "window minimized after lookup" },
    { reason: "validation" as const, message: "window vanished" }
  ])("returns a typed capture failure for $message", async (failure) => {
    const deps = makeDependencies({
      captureWindow: vi.fn(async () => ({ ok: false as const, ...failure }))
    });

    const result = await dispatch(deps, 42);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "capture",
        code: "window_capture_failed",
        message: "The requested window could not be captured"
      }
    });
    expect(deps.persistCapture).not.toHaveBeenCalled();
  });

  test("preserves mid-session screen-permission revocation as a typed capture error", async () => {
    const deps = makeDependencies({
      captureWindow: vi.fn(async () => ({
        ok: false as const,
        reason: "revoked" as const,
        message: "permission revoked"
      }))
    });

    const result = await dispatch(deps, 42);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "capture", code: "revoked" }
    });
  });

  test("converts a thrown capture backend failure into a Result error", async () => {
    const deps = makeDependencies({
      captureWindow: vi.fn(async () => {
        throw new Error("desktopCapturer failed");
      })
    });

    const result = await dispatch(deps, 42);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "capture", code: "window_capture_failed" }
    });
    expect(deps.persistCapture).not.toHaveBeenCalled();
  });

  test("propagates a typed persist failure and still releases the temp directory", async () => {
    const persistFailure: Result<CaptureRecord, PwrSnapError> = err({
      kind: "capture",
      code: "persist_failed",
      message: "disk full"
    });
    const deps = makeDependencies({
      persistCapture: vi.fn(async () => persistFailure)
    });

    const result = await dispatch(deps, 42);

    expect(result).toBe(persistFailure);
    expect(deps.releaseCaptureTemp).toHaveBeenCalledExactlyOnceWith(
      "/tmp/pwrsnap-handler-test/source.png"
    );
  });

  test("cleanup remains best-effort after a successful v2 persist", async () => {
    const deps = makeDependencies({
      releaseCaptureTemp: vi.fn(async () => {
        throw new Error("already removed");
      })
    });

    const result = await dispatch(deps, 42);

    expect(result).toEqual(ok(persistedRecord));
    expect(deps.reportCleanupFailure).toHaveBeenCalledWith(
      "/tmp/pwrsnap-handler-test/source.png",
      expect.objectContaining({ message: "already removed" })
    );
  });

  test("the success path has no selector, float-over, show, focus, or activation step", async () => {
    const trace: string[] = [];
    const target = windowInfo();
    const deps = makeDependencies({
      guardScreenCapture: vi.fn(async () => {
        trace.push("permission");
        return null;
      }),
      ensureCapturesDirReady: vi.fn(async () => {
        trace.push("storage");
        return null;
      }),
      listWindowsSnapshot: vi.fn(async () => {
        trace.push("fresh-window-list");
        return snapshot([target]);
      }),
      normalizeWindowSnapshot: vi.fn((windows) => {
        trace.push("normalize");
        return [...windows];
      }),
      selfPidSet: vi.fn(() => {
        trace.push("own-pids");
        return new Set<number>();
      }),
      selfWindowBoundsList: vi.fn(() => {
        trace.push("own-bounds");
        return [];
      }),
      peerPwrSnapPid: vi.fn(() => {
        trace.push("peer-pid");
        return null;
      }),
      captureWindow: vi.fn(async () => {
        trace.push("capture");
        return {
          ok: true as const,
          tempPath: "/tmp/pwrsnap-handler-test/source.png",
          displayId: 0
        };
      }),
      persistCapture: vi.fn(async () => {
        trace.push("v2-persist-broadcast");
        return ok(persistedRecord);
      }),
      releaseCaptureTemp: vi.fn(async () => {
        trace.push("cleanup");
      })
    });

    const result = await dispatch(deps, target.windowId);

    expect(result).toEqual(ok(persistedRecord));
    expect(trace).toEqual([
      "permission",
      "storage",
      "fresh-window-list",
      "normalize",
      "own-pids",
      "own-bounds",
      "peer-pid",
      "capture",
      "fresh-window-list",
      "normalize",
      "v2-persist-broadcast",
      "cleanup"
    ]);
  });
});
