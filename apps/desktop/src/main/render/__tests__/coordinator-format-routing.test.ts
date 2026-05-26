// Regression test for the format-aware routing in `renderViaCoordinator`.
//
// THE BUG (origin/main as of 44b2cf7, ~all of #100's v2 work):
//
// `renderViaCoordinator` always ran the v1 path — it called
// `compose(req)` which reads from the `overlays` table. For v2
// captures the overlays table is empty (their overlay data lives in
// the v2 layer tree instead), so compose() composited zero overlays
// onto the source and handed back a bare-source render. Every
// clipboard Copy of an annotated v2 capture lost the user's
// annotations; same for drag icons and preset renders. The Library
// thumbnails were fine because they went through `resolveCacheFile`
// (which already had the v1/v2 branch).
//
// THE FIX (this PR):
//
// `renderViaCoordinator` now looks up the record and branches v1/v2
// before calling either compose() or composeV2(). Every caller —
// clipboard handlers, capture handlers, the protocol resolver —
// inherits the routing for free.
//
// THIS TEST pins the routing decision: given a v2 capture record,
// composeV2 is called and compose() is NOT. Given a v1 capture
// record, compose() is called and composeV2 is NOT. The result is
// adapted to RenderResult shape uniformly so callers don't need to
// know which path ran.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock compose() and composeV2() so we can detect which one fires
// without standing up a full sharp pipeline + DB.
const composeMock = vi.fn();
const composeV2Mock = vi.fn();
const getCaptureByIdMock = vi.fn();
const listLiveOverlaysMock = vi.fn(() => []);
const ensureEffectiveSrcPathMock = vi.fn(async () => "/tmp/fake.png");

vi.mock("../compose", () => ({
  compose: composeMock
}));
vi.mock("../compose-tree", () => ({
  composeV2: composeV2Mock
}));
vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: getCaptureByIdMock
}));
vi.mock("../../persistence/overlays-repo", () => ({
  listLiveOverlays: listLiveOverlaysMock
}));
vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: ensureEffectiveSrcPathMock
}));
vi.mock("../overlay-hash", () => ({
  computeRenderHash: () => "fake-hash"
}));

// Import AFTER the mocks so the module's `import` lines pick up the
// mocked versions.
const { renderViaCoordinator, resolveCacheFile } = await import("../coordinator");

beforeEach(() => {
  composeMock.mockReset();
  composeV2Mock.mockReset();
  getCaptureByIdMock.mockReset();
  listLiveOverlaysMock.mockClear();
  ensureEffectiveSrcPathMock.mockClear();

  composeMock.mockResolvedValue({
    cachePath: "/cache/v1.png",
    byteSize: 100,
    fromCache: false,
    renderHash: "fake-hash",
    overlayCount: 3
  });
  composeV2Mock.mockResolvedValue({
    cachePath: "/cache/v2.png",
    byteSize: 200,
    fromCache: false,
    renderHash: "fake-hash-v2",
    layerCount: 5
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function v2Record(): unknown {
  return {
    id: "cap_v2",
    bundle_format_version: 2,
    bundle_path: "/bundles/cap_v2.pwrsnap",
    width_px: 1920,
    height_px: 1080,
    deleted_at: null
  };
}

function v1Record(): unknown {
  return {
    id: "cap_v1",
    bundle_format_version: 1,
    bundle_path: "/bundles/cap_v1.pwrsnap",
    width_px: 1920,
    height_px: 1080,
    deleted_at: null
  };
}

describe("renderViaCoordinator — v1/v2 format routing", () => {
  test("v2 capture routes through composeV2, NOT compose", async () => {
    // THE bug: pre-fix this test would have failed because compose()
    // ran for v2 captures and composeV2 never did.
    getCaptureByIdMock.mockReturnValue(v2Record());

    const result = await renderViaCoordinator({
      captureId: "cap_v2",
      srcPath: "/ignored/for/v2.png",
      imageWidthPx: 1920,
      imageHeightPx: 1080,
      width: 800,
      format: "png"
    });

    expect(composeV2Mock).toHaveBeenCalledTimes(1);
    expect(composeMock).not.toHaveBeenCalled();

    // composeV2 invoked with bundle-path derived from the record
    // (NOT from the caller's srcPath, which was the broken v1-shape
    // input).
    const callArg = composeV2Mock.mock.calls[0]?.[0];
    expect(callArg.bundlePath).toBe("/bundles/cap_v2.pwrsnap");
    expect(callArg.canvasWidthPx).toBe(1920);
    expect(callArg.canvasHeightPx).toBe(1080);
    expect(callArg.width).toBe(800);
    expect(callArg.format).toBe("png");

    // Result adapted to RenderResult shape — overlayCount carries
    // composeV2's layerCount so callers reading overlayCount keep
    // working unchanged.
    expect(result.cachePath).toBe("/cache/v2.png");
    expect(result.overlayCount).toBe(5);
  });

  test("v1 capture routes through compose, NOT composeV2", async () => {
    getCaptureByIdMock.mockReturnValue(v1Record());

    const result = await renderViaCoordinator({
      captureId: "cap_v1",
      srcPath: "/path/to/source.png",
      imageWidthPx: 1920,
      imageHeightPx: 1080,
      width: 800,
      format: "png"
    });

    expect(composeMock).toHaveBeenCalledTimes(1);
    expect(composeV2Mock).not.toHaveBeenCalled();

    expect(result.cachePath).toBe("/cache/v1.png");
    expect(result.overlayCount).toBe(3);
  });

  test("v2 capture without bundle_path falls back to v1 path (defensive)", async () => {
    // A v2-flagged record with bundle_path: null is a corrupted
    // state (the doctor would heal it on next boot). Fall back to
    // the v1 path so the user gets something rather than an error.
    getCaptureByIdMock.mockReturnValue({
      ...(v2Record() as Record<string, unknown>),
      bundle_path: null
    });

    await renderViaCoordinator({
      captureId: "cap_v2",
      srcPath: "/fallback/source.png",
      imageWidthPx: 1920,
      imageHeightPx: 1080,
      width: 800,
      format: "png"
    });

    expect(composeMock).toHaveBeenCalledTimes(1);
    expect(composeV2Mock).not.toHaveBeenCalled();
  });

  test("missing capture record falls back to v1 path (compose handles the error)", async () => {
    // getCaptureById returns null. Pre-fix this couldn't happen
    // because the lookup didn't exist here. Post-fix we pass-through
    // to compose() so its existing error handling (cache miss + bad
    // srcPath read = thrown error) surfaces uniformly.
    getCaptureByIdMock.mockReturnValue(null);

    await renderViaCoordinator({
      captureId: "missing",
      srcPath: "/some/path.png",
      imageWidthPx: 100,
      imageHeightPx: 100,
      width: 100,
      format: "png"
    });

    expect(composeMock).toHaveBeenCalledTimes(1);
    expect(composeV2Mock).not.toHaveBeenCalled();
  });
});

describe("renderViaCoordinator — in-flight coalescing", () => {
  test("two concurrent v2 renders of the same (captureId, width, format) collapse into one composeV2 call", async () => {
    getCaptureByIdMock.mockReturnValue(v2Record());
    // Hold composeV2 open so both callers race into the same in-flight slot.
    let resolveV2: (v: unknown) => void = () => undefined;
    composeV2Mock.mockReturnValueOnce(
      new Promise((res) => {
        resolveV2 = res;
      })
    );

    const a = renderViaCoordinator({
      captureId: "cap_v2",
      srcPath: "/x.png",
      imageWidthPx: 1920,
      imageHeightPx: 1080,
      width: 800,
      format: "png"
    });
    const b = renderViaCoordinator({
      captureId: "cap_v2",
      srcPath: "/x.png",
      imageWidthPx: 1920,
      imageHeightPx: 1080,
      width: 800,
      format: "png"
    });

    resolveV2({
      cachePath: "/cache/coalesced.png",
      byteSize: 500,
      fromCache: false,
      renderHash: "h",
      layerCount: 2
    });

    const [ar, br] = await Promise.all([a, b]);

    // ONE composeV2 call serving BOTH callers.
    expect(composeV2Mock).toHaveBeenCalledTimes(1);
    expect(ar.cachePath).toBe(br.cachePath);
  });
});

describe("resolveCacheFile — thin wrapper around renderViaCoordinator", () => {
  test("v2 capture: returns cachePath produced by composeV2", async () => {
    getCaptureByIdMock.mockReturnValue(v2Record());

    const path = await resolveCacheFile({
      captureId: "cap_v2",
      width: 400,
      format: "webp"
    });

    expect(path).toBe("/cache/v2.png");
    expect(composeV2Mock).toHaveBeenCalledTimes(1);
    expect(composeMock).not.toHaveBeenCalled();
  });

  test("missing capture record returns null without invoking either compose path", async () => {
    getCaptureByIdMock.mockReturnValue(null);

    const path = await resolveCacheFile({
      captureId: "ghost",
      width: 400,
      format: "webp"
    });

    expect(path).toBeNull();
    expect(composeMock).not.toHaveBeenCalled();
    expect(composeV2Mock).not.toHaveBeenCalled();
  });
});
