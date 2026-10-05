import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CameraSetup } from "../CameraSetup";

let root: Root, host: HTMLDivElement;
const change = vi.fn(),
  ready = vi.fn();
const stop = vi.fn();
const track = {
  stop,
  getSettings: () => ({ deviceId: "camera-a" }),
  onended: null as (() => void) | null,
};
const media = { getTracks: () => [track], getVideoTracks: () => [track] };
const getUserMedia = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  track.onended = null;
  getUserMedia.mockResolvedValue(media);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: "videoinput", deviceId: "camera-a", label: "Built-in camera" },
        { kind: "videoinput", deviceId: "camera-b", label: "USB camera" },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <CameraSetup value={undefined} onChange={change} onReady={ready} />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

test("only opens on user request, enumerates cameras and releases each chosen stream", async () => {
  expect(getUserMedia).not.toHaveBeenCalled();
  await act(async () => host.querySelector("button")!.click());
  expect(ready).toHaveBeenCalledWith(false);
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(change).toHaveBeenLastCalledWith({ deviceId: "camera-a" });
  expect(
    [...host.querySelectorAll("option")].map((option) => option.textContent),
  ).toEqual(["Built-in camera", "USB camera"]);
  await act(async () => {
    const select = host.querySelector("select")!;
    select.value = "camera-b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(getUserMedia).toHaveBeenLastCalledWith({
    video: { deviceId: { exact: "camera-b" } },
    audio: false,
  });
  expect(stop).toHaveBeenCalled();
  await act(async () => host.querySelector("button")!.click());
  expect(change).toHaveBeenLastCalledWith(undefined);
  expect(host.querySelector("video")).toBeNull();
});
test("permission denial blocks recording until the camera is disabled", async () => {
  getUserMedia.mockRejectedValueOnce(new Error("Camera permission denied"));
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "permission denied",
  );
  expect(ready).toHaveBeenLastCalledWith(false);
  await act(async () => host.querySelector("button")!.click());
  expect(ready).toHaveBeenLastCalledWith(true);
});
test("a disconnected camera blocks recording instead of silently dropping the track", async () => {
  await act(async () => host.querySelector("button")!.click());
  act(() => track.onended?.());
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(change).toHaveBeenLastCalledWith(undefined);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "disconnected",
  );
});

test("hiding a prewarmed selector releases its camera preview", async () => {
  await act(async () => host.querySelector("button")!.click());
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(stop).toHaveBeenCalled();
  expect(change).toHaveBeenLastCalledWith(undefined);
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(host.querySelector("video")).toBeNull();
});
