// Tests for `renderViaCoordinator` / `resolveCacheFile`.
//
// v2 is the only bundle format. The coordinator looks up the record
// and renders its layer tree via composeV2(); a request for a record
// that isn't a renderable v2 bundle (missing, legacy v1 flag, or v2
// without a bundle on disk) THROWS rather than silently composing a
// bare source. Videos never reach here — they render via the
// `pwrsnap-capture://` protocol, not the compositor.
//
// THIS TEST pins: v2 → composeV2; non-v2 → throw; coalescing collapses
// duplicate concurrent v2 renders; resolveCacheFile returns null for a
// missing record without invoking compose.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock composeV2() so we can detect it fires without standing up a
// full sharp pipeline. compose.ts is imported by the coordinator for
// types only (erased at runtime), so it never loads here.
const composeV2Mock = vi.fn();
const getCaptureByIdMock = vi.fn();
const ensureEffectiveSrcPathMock = vi.fn(async () => "/tmp/fake.png");

vi.mock("../compose-tree", () => ({
  composeV2: composeV2Mock
}));
vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: getCaptureByIdMock
}));
vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: ensureEffectiveSrcPathMock
}));

// Import AFTER the mocks so the module's `import` lines pick up the
// mocked versions.
const { renderViaCoordinator, resolveCacheFile } = await import("../coordinator");

beforeEach(() => {
  composeV2Mock.mockReset();
  getCaptureByIdMock.mockReset();
  ensureEffectiveSrcPathMock.mockClear();

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

function req(captureId: string): {
  captureId: string;
  srcPath: string;
  imageWidthPx: number;
  imageHeightPx: number;
  width: number;
  format: "png" | "webp";
} {
  return {
    captureId,
    srcPath: "/ignored/for/v2.png",
    imageWidthPx: 1920,
    imageHeightPx: 1080,
    width: 800,
    format: "png"
  };
}

describe("renderViaCoordinator — v2-only dispatch", () => {
  test("v2 capture routes through composeV2 with bundle-derived inputs", async () => {
    getCaptureByIdMock.mockReturnValue(v2Record());

    const result = await renderViaCoordinator(req("cap_v2"));

    expect(composeV2Mock).toHaveBeenCalledTimes(1);
    const callArg = composeV2Mock.mock.calls[0]?.[0];
    // composeV2 invoked with bundle-path + canvas dims derived from the
    // record (NOT from the caller's v1-shaped srcPath/imageWidthPx).
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

  test("legacy v1-flagged record throws (no v1 fallback)", async () => {
    getCaptureByIdMock.mockReturnValue(v1Record());

    await expect(renderViaCoordinator(req("cap_v1"))).rejects.toThrow(
      /not a renderable v2 bundle/
    );
    expect(composeV2Mock).not.toHaveBeenCalled();
  });

  test("v2 record without bundle_path throws", async () => {
    getCaptureByIdMock.mockReturnValue({
      ...(v2Record() as Record<string, unknown>),
      bundle_path: null
    });

    await expect(renderViaCoordinator(req("cap_v2"))).rejects.toThrow(
      /not a renderable v2 bundle/
    );
    expect(composeV2Mock).not.toHaveBeenCalled();
  });

  test("missing capture record throws", async () => {
    getCaptureByIdMock.mockReturnValue(null);

    await expect(renderViaCoordinator(req("missing"))).rejects.toThrow(
      /not a renderable v2 bundle/
    );
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

    const a = renderViaCoordinator(req("cap_v2"));
    const b = renderViaCoordinator(req("cap_v2"));

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
  });

  test("missing capture record returns null without invoking composeV2", async () => {
    getCaptureByIdMock.mockReturnValue(null);

    const path = await resolveCacheFile({
      captureId: "ghost",
      width: 400,
      format: "webp"
    });

    expect(path).toBeNull();
    expect(composeV2Mock).not.toHaveBeenCalled();
  });
});
