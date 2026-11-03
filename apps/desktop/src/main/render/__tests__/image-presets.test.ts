import { beforeEach, expect, test, vi } from "vitest";
import type { BundleLayerNode, CaptureRecord } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  ensureSource: vi.fn(), render: vi.fn(), layers: vi.fn(), stat: vi.fn()
}));
vi.mock("../../persistence/source-store", () => ({ ensureEffectiveSrcPath: mocks.ensureSource }));
vi.mock("../../persistence/layers-repo", () => ({ listLayerTree: mocks.layers }));
vi.mock("../coordinator", () => ({ renderViaCoordinator: mocks.render }));
vi.mock("node:fs/promises", () => ({ stat: mocks.stat }));
const { resolveImagePresetFile } = await import("../image-presets");

const record = { id: "cap", kind: "image", width_px: 1920, height_px: 1080, sha256: "sha" } as CaptureRecord;
const source = {
  id: "source", kind: "raster", visible: true, opacity: 1, blend_mode: "normal",
  transform: [1, 0, 0, 1, 0, 0], source_ref: { kind: "embedded", sha256: "sha" },
  natural_width_px: 1920, natural_height_px: 1080
} as BundleLayerNode;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.ensureSource.mockResolvedValue("/source.png");
  mocks.stat.mockResolvedValue({ size: 123 });
  mocks.layers.mockReturnValue([source]);
  mocks.render.mockResolvedValue({ cachePath: "/render.png", byteSize: 456, fromCache: false });
});

test("resized output renders without waiting for source materialization", async () => {
  mocks.ensureSource.mockRejectedValue(new Error("source cache unavailable"));
  await expect(resolveImagePresetFile(record, "low")).resolves.toMatchObject({ path: "/render.png", sourceReused: false });
  expect(mocks.ensureSource).not.toHaveBeenCalled();
});

test("annotated source-sized output still renders without materializing a source", async () => {
  mocks.layers.mockReturnValue([source, { kind: "vector" }]);
  mocks.ensureSource.mockRejectedValue(new Error("source cache unavailable"));
  await expect(resolveImagePresetFile(record, "high")).resolves.toMatchObject({ path: "/render.png", sourceReused: false });
  expect(mocks.ensureSource).not.toHaveBeenCalled();
});

test("unedited source-sized output still resolves and stats the reusable source file", async () => {
  await expect(resolveImagePresetFile(record, "high")).resolves.toEqual({
    path: "/source.png", byteSize: 123, fromCache: true, sourceReused: true
  });
  expect(mocks.ensureSource).toHaveBeenCalledWith(record);
  expect(mocks.stat).toHaveBeenCalledWith("/source.png");
  expect(mocks.render).not.toHaveBeenCalled();
});

test("source reuse propagates extraction failure instead of returning an unusable path", async () => {
  mocks.ensureSource.mockRejectedValue(new Error("source hash mismatch"));
  await expect(resolveImagePresetFile(record, "high")).rejects.toThrow("source hash mismatch");
  expect(mocks.render).not.toHaveBeenCalled();
});
