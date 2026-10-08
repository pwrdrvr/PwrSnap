import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  opacity: vi.fn(), show: vi.fn(), hide: vi.fn(), protect: vi.fn(), destroy: vi.fn(),
  handlers: new Map<string, () => void>(),
  displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 850 } }],
}));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  screen: { getAllDisplays: () => mocks.displays,
    on: (event: string, handler: () => void) => mocks.handlers.set(event, handler),
    removeListener: (event: string) => mocks.handlers.delete(event) },
  BrowserWindow: class {
    isDestroyed = () => false;
    on() {} setTitle() {} setBounds() {} setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {}
    setContentProtection = mocks.protect;
    setOpacity = mocks.opacity;
    showInactive = mocks.show;
    hide = mocks.hide;
    destroy = mocks.destroy;
  },
}));
import { CameraWorker } from "../camera-worker";
const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.clearAllMocks(); mocks.handlers.clear();
});
const region = { x: 100, y: 100, w: 800, h: 600 };
test("camera pixels remain invisible until native window exclusion is confirmed", () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const worker = new CameraWorker();
  const identity = worker.preparePreview(1, region);
  expect(identity?.ownerPid).toBe(process.pid);
  expect(mocks.protect).toHaveBeenCalledWith(true);
  expect(mocks.opacity.mock.calls).toEqual([[0]]);
  worker.confirmPreviewExclusion(true);
  expect(mocks.opacity.mock.calls).toEqual([[0], [1]]);
  worker.close();
  expect(mocks.handlers.size).toBe(0);
  expect(mocks.destroy).toHaveBeenCalled();
});
test("missing exclusion or changed display geometry cannot reveal the preview", () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const worker = new CameraWorker();
  worker.preparePreview(1, region);
  mocks.handlers.get("display-metrics-changed")!();
  worker.confirmPreviewExclusion(true);
  expect(mocks.opacity.mock.calls).toEqual([[0]]);
  expect(mocks.hide).toHaveBeenCalled();
  worker.close();
  const rejected = new CameraWorker();
  rejected.preparePreview(1, region);
  rejected.confirmPreviewExclusion(false);
  expect(mocks.opacity).not.toHaveBeenCalledWith(1);
  rejected.close();
});
test("no room outside the capture and non-native platforms keep camera hidden", () => {
  const worker = new CameraWorker();
  Object.defineProperty(process, "platform", { value: "darwin" });
  expect(worker.preparePreview(1, { x: 0, y: 0, w: 1440, h: 900 })).toBeUndefined();
  Object.defineProperty(process, "platform", { value: "win32" });
  expect(worker.preparePreview(1, region)).toBeUndefined();
  expect(mocks.show).not.toHaveBeenCalled();
  worker.confirmPreviewExclusion(true);
  expect(mocks.opacity).not.toHaveBeenCalledWith(1);
  worker.close();
});
