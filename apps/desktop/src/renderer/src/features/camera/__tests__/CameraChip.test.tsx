import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RecordingCamera } from "@pwrsnap/shared";
import { CameraChip } from "../CameraChip";

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

/** The selector owns the arm state; the chip only asks to flip it. */
function Harness() {
  const [enabled, setEnabled] = useState(false);
  const [value, setValue] = useState<RecordingCamera | undefined>(undefined);
  return (
    <CameraChip
      enabled={enabled}
      onToggle={setEnabled}
      value={value}
      onChange={(camera) => {
        setValue(camera);
        change(camera);
      }}
      onReady={ready}
    />
  );
}

const chip = () => host.querySelector<HTMLButtonElement>(".ps-chip__body")!;
const caret = () => host.querySelector<HTMLButtonElement>(".ps-chip__devices");

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
  act(() => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

test("is a source chip that only opens the camera when armed", async () => {
  expect(chip().getAttribute("aria-pressed")).toBe("false");
  expect(chip().getAttribute("aria-keyshortcuts")).toBe("K");
  expect(caret()).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
  await act(async () => chip().click());
  expect(chip().getAttribute("aria-pressed")).toBe("true");
  expect(ready).toHaveBeenCalledWith(false);
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(change).toHaveBeenLastCalledWith({ deviceId: "camera-a" });
  // Armed with a stream: a live preview bubble.
  expect(host.querySelector(".camera-bubble video")).not.toBeNull();
});

test("the caret lists cameras and switching releases the previous stream", async () => {
  await act(async () => chip().click());
  await act(async () => caret()!.click());
  const rows = [...host.querySelectorAll<HTMLButtonElement>(".camera-pop__row")];
  expect(rows.map((row) => row.textContent)).toEqual(["Built-in camera", "USB camera"]);
  expect(rows[0]!.getAttribute("aria-checked")).toBe("true");
  await act(async () => rows[1]!.click());
  expect(getUserMedia).toHaveBeenLastCalledWith({
    video: { deviceId: { exact: "camera-b" } },
    audio: false,
  });
  expect(stop).toHaveBeenCalled();
  await act(async () => chip().click());
  expect(change).toHaveBeenLastCalledWith(undefined);
  expect(host.querySelector("video")).toBeNull();
});

test("permission denial blocks recording until the camera is disarmed", async () => {
  getUserMedia.mockRejectedValueOnce(new Error("Camera permission denied"));
  await act(async () => chip().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("permission denied");
  expect(host.querySelector(".ps-chip")?.getAttribute("data-state")).toBe("nodevice");
  expect(ready).toHaveBeenLastCalledWith(false);
  await act(async () => chip().click());
  expect(ready).toHaveBeenLastCalledWith(true);
});

test("a disconnected camera blocks recording instead of silently dropping the track", async () => {
  await act(async () => chip().click());
  act(() => track.onended?.());
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(change).toHaveBeenLastCalledWith(undefined);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("disconnected");
});

test("hiding a prewarmed selector releases its camera preview and disarms", async () => {
  await act(async () => chip().click());
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(stop).toHaveBeenCalled();
  expect(change).toHaveBeenLastCalledWith(undefined);
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(host.querySelector("video")).toBeNull();
  expect(chip().getAttribute("aria-pressed")).toBe("false");
});
