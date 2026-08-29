import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cacheRoot: "",
  originalPath: "",
  compositePath: "",
  getCaptureById: vi.fn(),
  ensureEffectiveSrcPath: vi.fn(),
  renderViaCoordinator: vi.fn(),
  pipelineVersion: "9"
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: mocks.getCaptureById
}));
vi.mock("../../persistence/paths", () => ({
  getCacheRoot: () => mocks.cacheRoot
}));
vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: mocks.ensureEffectiveSrcPath
}));
vi.mock("../coordinator", () => ({
  renderViaCoordinator: mocks.renderViaCoordinator
}));
// A getter, not a constant: these tests move the version between calls
// to prove it reaches `exportId`. Mocking the module also keeps the
// real `compose-tree` (and its better-sqlite3 / sharp import chain) out
// of this suite.
vi.mock("../compose-tree", () => ({
  get BAKE_PIPELINE_VERSION() {
    return mocks.pipelineVersion;
  }
}));

import { exportCapture } from "../export-coordinator";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.pipelineVersion = "9";
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-export-coordinator-"));
  mocks.cacheRoot = join(dir, "cache");
  mocks.originalPath = join(dir, "original.png");
  mocks.compositePath = join(dir, "composite.png");
  await sharp({
    create: {
      width: 100,
      height: 50,
      channels: 4,
      background: { r: 0, g: 0, b: 255, alpha: 0.5 }
    }
  }).png().toFile(mocks.originalPath);
  await sharp({
    create: {
      width: 100,
      height: 50,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 }
    }
  }).png().toFile(mocks.compositePath);
  mocks.getCaptureById.mockReturnValue({
    id: "cap_1",
    kind: "image",
    deleted_at: null,
    width_px: 100,
    height_px: 50,
    device_pixel_ratio: 2,
    sha256: "source-hash",
    edits_version: 3
  });
  mocks.ensureEffectiveSrcPath.mockResolvedValue(mocks.originalPath);
  mocks.renderViaCoordinator.mockResolvedValue({
    cachePath: mocks.compositePath,
    byteSize: 1,
    fromCache: false,
    renderHash: "render",
    overlayCount: 1
  });
});

describe("exportCapture", () => {
  test("exports the edited composite to resized JPEG and reuses its cache", async () => {
    const first = await exportCapture({
      captureId: "cap_1",
      variant: "composite",
      format: "jpeg",
      maxWidth: 40,
      quality: 90
    });
    const metadata = await sharp(first.path).metadata();
    const pixel = await sharp(first.path).raw().toBuffer();

    expect(first).toMatchObject({
      variant: "composite",
      format: "jpeg",
      mimeType: "image/jpeg",
      widthPx: 40,
      heightPx: 20,
      fromCache: false
    });
    expect(metadata.format).toBe("jpeg");
    expect(pixel[0]).toBeGreaterThan(pixel[2] ?? 0);

    const second = await exportCapture({
      captureId: "cap_1",
      variant: "composite",
      format: "jpeg",
      maxWidth: 40,
      quality: 90
    });
    expect(second.fromCache).toBe(true);
    expect(second.path).toBe(first.path);
  });

  test("exports original content as a single-page PDF", async () => {
    const exported = await exportCapture({
      captureId: "cap_1",
      variant: "original",
      format: "pdf",
      maxHeight: 25
    });
    const bytes = await readFile(exported.path);

    expect(exported).toMatchObject({
      variant: "original",
      format: "pdf",
      mimeType: "application/pdf",
      widthPx: 50,
      heightPx: 25
    });
    expect(bytes.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
    expect(mocks.renderViaCoordinator).not.toHaveBeenCalled();
  });

  test("exports WebP and flattens transparent images onto a JPEG background", async () => {
    const webp = await exportCapture({
      captureId: "cap_1",
      variant: "original",
      format: "webp",
      quality: 80
    });
    const jpeg = await exportCapture({
      captureId: "cap_1",
      variant: "original",
      format: "jpeg",
      background: "#00ff00"
    });
    const jpegPixel = await sharp(jpeg.path).raw().toBuffer();

    expect((await sharp(webp.path).metadata()).format).toBe("webp");
    expect((await sharp(jpeg.path).metadata()).hasAlpha).toBe(false);
    expect(jpegPixel[1]).toBeGreaterThan(jpegPixel[0] ?? 0);
  });

  test("rejects invalid dimensions, quality, and scale before export", async () => {
    await expect(
      exportCapture({ captureId: "cap_1", maxWidth: 20_000 })
    ).rejects.toMatchObject({ code: "invalid_dimensions" });
    await expect(
      exportCapture({ captureId: "cap_1", quality: 0 })
    ).rejects.toMatchObject({ code: "invalid_quality" });
    await expect(
      exportCapture({ captureId: "cap_1", scale: 5 })
    ).rejects.toMatchObject({ code: "invalid_scale" });
    expect(mocks.ensureEffectiveSrcPath).not.toHaveBeenCalled();
  });

  test("resolves named presets through the selected DPI-aware ladder", async () => {
    const exported = await exportCapture(
      {
        captureId: "cap_1",
        variant: "original",
        format: "png",
        preset: "med"
      },
      "scaleLogical"
    );

    expect(exported).toMatchObject({
      preset: "med",
      widthPx: 50,
      heightPx: 25
    });
  });

  test("does not allow named presets to be overridden by raw sizing", async () => {
    await expect(
      exportCapture({ captureId: "cap_1", preset: "high", maxWidth: 10 })
    ).rejects.toMatchObject({ code: "invalid_dimensions" });
  });

  test.runIf(process.platform === "darwin")(
    "exports HEIC through the macOS image conversion service",
    async () => {
      const exported = await exportCapture({
        captureId: "cap_1",
        variant: "original",
        format: "heic",
        quality: 85
      });
      const bytes = await readFile(exported.path);

      expect(exported.mimeType).toBe("image/heic");
      expect(bytes.subarray(4, 12).toString("ascii")).toMatch(/ftyp(?:heic|mif1)/u);
    }
  );
});

// A composite export IS bake output, so its cache has to re-key when
// the bake pipeline changes. #520 changed bake output without bumping
// BAKE_PIPELINE_VERSION and warm caches served stale pixels forever;
// this cache had the same hole one level up, and `edits_version` never
// moves on its own to paper over it. Untested, the fix is one deletable
// line — which is how the original bug shipped green.
describe("exportCapture — cache key tracks BAKE_PIPELINE_VERSION", () => {
  const composite = {
    captureId: "cap_1",
    variant: "composite" as const,
    format: "jpeg" as const,
    maxWidth: 40,
    quality: 90
  };

  test("a version bump re-keys a composite export instead of serving stale bytes", async () => {
    const before = await exportCapture(composite);
    expect(before.fromCache).toBe(false);

    // Same request, same capture, same edits_version — only the bake
    // pipeline moved. It must MISS.
    mocks.pipelineVersion = "10";
    const after = await exportCapture(composite);
    expect(after.fromCache).toBe(false);
    expect(after.exportId).not.toBe(before.exportId);

    // ...and the pre-bump key still resolves to its own entry, so the
    // bump orphans rather than corrupts.
    mocks.pipelineVersion = "9";
    const back = await exportCapture(composite);
    expect(back.exportId).toBe(before.exportId);
    expect(back.fromCache).toBe(true);
  });

  test("an ORIGINAL export keeps its key across a bump (it bypasses the compositor)", async () => {
    const original = {
      captureId: "cap_1",
      variant: "original" as const,
      format: "png" as const
    };
    const before = await exportCapture(original);
    mocks.pipelineVersion = "10";
    const after = await exportCapture(original);

    // The version is spread in only for composites: an original's bytes
    // can't move with the pipeline, so re-keying it would orphan a
    // still-valid file for nothing.
    expect(after.exportId).toBe(before.exportId);
    expect(after.fromCache).toBe(true);
  });
});
