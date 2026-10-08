import { expect, test } from "vitest";
import { cameraPreviewBounds } from "../camera-preview-placement";
const primary = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 850 } };
test("preview fits outside a display-local region in global coordinates", () => {
  const display = { ...primary, bounds: { ...primary.bounds, x: -1440 }, workArea: { ...primary.workArea, x: -1440 } };
  expect(cameraPreviewBounds([display], 1, { x: 100, y: 100, w: 800, h: 600 })).toEqual({ x: -528, y: 100, width: 240, height: 159 });
});
test("full-display capture hides preview unless another display has room", () => {
  const rect = { x: 0, y: 0, w: 1440, h: 900 };
  expect(cameraPreviewBounds([primary], 1, rect)).toBeNull();
  const second = { id: 2, bounds: { ...primary.bounds, x: 1440 }, workArea: { ...primary.workArea, x: 1440 } };
  expect(cameraPreviewBounds([primary, second], 1, rect)?.x).toBeGreaterThanOrEqual(1440);
  expect(cameraPreviewBounds([primary], 9, rect)).toBeNull();
});
