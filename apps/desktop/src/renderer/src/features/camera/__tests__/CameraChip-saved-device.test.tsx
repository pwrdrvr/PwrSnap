// The camera chip opens the SAVED camera, names the camera it opened, and
// reports a pick so the selector can save it. Contrived devices.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { shortDeviceLabel, type RecordingCamera, type RecordingDevicePreference } from "@pwrsnap/shared";
import { CameraChip } from "../CameraChip";

const CORNFLAKE = { kind: "videoinput", deviceId: "cam-cornflake", label: "Cornflake Cam" };
const PORRIDGE = { kind: "videoinput", deviceId: "cam-porridge-new-salt", label: "Porridge Cam (1a2b:3c4d)" };

let root: Root, host: HTMLDivElement;
const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();
const pick = vi.fn();
const change = vi.fn();

function media(deviceId: string, label: string) {
  const track = { stop: vi.fn(), label, getSettings: () => ({ deviceId }), onended: null };
  return { getTracks: () => [track], getVideoTracks: () => [track] };
}

function overconstrained(): Error {
  const e = new Error("OverconstrainedError");
  e.name = "OverconstrainedError";
  return e;
}

function Harness({ preferred }: { preferred: RecordingDevicePreference | null }) {
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
      onReady={() => undefined}
      preferred={preferred}
      onPick={pick}
    />
  );
}

const chip = () => host.querySelector<HTMLButtonElement>(".ps-chip__body")!;
const device = () => host.querySelector(".ps-chip__dev")?.textContent;

async function mountAndArm(preferred: RecordingDevicePreference | null): Promise<void> {
  await act(async () => root.render(<Harness preferred={preferred} />));
  // Off: the saved camera is not opened, but it is named, so the tile says
  // which camera K would turn on.
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(device()).toBe(preferred !== null ? shortDeviceLabel(preferred.label) : undefined);
  await act(async () => chip().click());
  for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
}

beforeEach(() => {
  vi.clearAllMocks();
  enumerateDevices.mockResolvedValue([CORNFLAKE, PORRIDGE]);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

test("the saved camera is opened by id and named on the chip", async () => {
  getUserMedia.mockResolvedValue(media(PORRIDGE.deviceId, PORRIDGE.label));
  await mountAndArm({ deviceId: PORRIDGE.deviceId, label: PORRIDGE.label });
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { exact: PORRIDGE.deviceId } }, audio: false });
  expect(device()).toBe("Porridge Cam");
  expect(change).toHaveBeenLastCalledWith({ deviceId: PORRIDGE.deviceId });
});

test("a stale id is found again by name", async () => {
  getUserMedia
    .mockRejectedValueOnce(overconstrained())
    .mockResolvedValueOnce(media(CORNFLAKE.deviceId, CORNFLAKE.label))
    .mockResolvedValueOnce(media(PORRIDGE.deviceId, PORRIDGE.label));
  await mountAndArm({ deviceId: "cam-porridge-old-salt", label: PORRIDGE.label });
  expect(getUserMedia).toHaveBeenLastCalledWith({
    video: { deviceId: { exact: PORRIDGE.deviceId } },
    audio: false
  });
  expect(device()).toBe("Porridge Cam");
  expect(change).toHaveBeenLastCalledWith({ deviceId: PORRIDGE.deviceId });
  expect(host.querySelector(".camera-pop__note--warn")).toBeNull();
});

test("an unplugged saved camera opens the first camera and the popover says so", async () => {
  getUserMedia
    .mockRejectedValueOnce(overconstrained())
    .mockResolvedValueOnce(media(CORNFLAKE.deviceId, CORNFLAKE.label));
  await mountAndArm({ deviceId: "cam-muesli", label: "Muesli Cam" });
  // The chip names the camera that is actually open: that is the take's.
  expect(device()).toBe(CORNFLAKE.label);
  await act(async () => host.querySelector<HTMLButtonElement>(".ps-chip__devices")!.click());
  expect(host.querySelector(".camera-pop__note--warn")?.textContent).toContain("“Muesli Cam” is not connected");
});

test("a saved camera that comes back clears the not-connected note", async () => {
  getUserMedia
    .mockRejectedValueOnce(overconstrained())
    .mockResolvedValueOnce(media(CORNFLAKE.deviceId, CORNFLAKE.label))
    .mockResolvedValueOnce(media("cam-muesli", "Muesli Cam"));
  await mountAndArm({ deviceId: "cam-muesli", label: "Muesli Cam" });
  // Plugged back in; off and on again opens it by its saved id.
  await act(async () => chip().click());
  await act(async () => chip().click());
  for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
  expect(getUserMedia).toHaveBeenLastCalledWith({ video: { deviceId: { exact: "cam-muesli" } }, audio: false });
  expect(device()).toBe("Muesli Cam");
  await act(async () => host.querySelector<HTMLButtonElement>(".ps-chip__devices")!.click());
  expect(host.querySelector(".camera-pop__note--warn")).toBeNull();
});

test("picking a camera reports it with its name, for the selector to save", async () => {
  getUserMedia.mockImplementation(async (constraints: { video: true | { deviceId: { exact: string } } }) =>
    constraints.video === true || constraints.video.deviceId.exact === CORNFLAKE.deviceId
      ? media(CORNFLAKE.deviceId, CORNFLAKE.label)
      : media(PORRIDGE.deviceId, PORRIDGE.label)
  );
  await mountAndArm(null);
  expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
  await act(async () => host.querySelector<HTMLButtonElement>(".ps-chip__devices")!.click());
  const rows = [...host.querySelectorAll<HTMLButtonElement>(".camera-pop__row")];
  await act(async () => rows[1]!.click());
  for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
  expect(pick).toHaveBeenCalledWith({ deviceId: PORRIDGE.deviceId, label: PORRIDGE.label });
  expect(device()).toBe("Porridge Cam");
  // The camera already open is never reported as a pick.
  await act(async () => rows[1]!.click());
  expect(pick).toHaveBeenCalledTimes(1);
});

type Media = ReturnType<typeof media>;
async function unplug(opened: Media): Promise<void> {
  const track = opened.getVideoTracks()[0]! as { onended: (() => void) | null };
  await act(async () => track.onended?.());
  for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
}

test("an unplugged camera is reopened: the first camera opens and the popover names the unplugged one", async () => {
  const porridge = media(PORRIDGE.deviceId, PORRIDGE.label);
  getUserMedia.mockResolvedValueOnce(porridge);
  await mountAndArm({ deviceId: PORRIDGE.deviceId, label: PORRIDGE.label });
  expect(device()).toBe("Porridge Cam");

  enumerateDevices.mockResolvedValue([CORNFLAKE]);
  getUserMedia
    .mockRejectedValueOnce(overconstrained())
    .mockResolvedValueOnce(media(CORNFLAKE.deviceId, CORNFLAKE.label));
  await unplug(porridge);
  // Looked for by its id first, then any camera.
  expect(getUserMedia).toHaveBeenNthCalledWith(2, {
    video: { deviceId: { exact: PORRIDGE.deviceId } },
    audio: false
  });
  expect(getUserMedia).toHaveBeenNthCalledWith(3, { video: true, audio: false });
  expect(device()).toBe(CORNFLAKE.label);
  expect(change).toHaveBeenLastCalledWith({ deviceId: CORNFLAKE.deviceId });
  expect(host.querySelector(".camera-chip__err")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>(".ps-chip__devices")!.click());
  expect(host.querySelector(".camera-pop__note--warn")?.textContent).toContain(
    `“${PORRIDGE.label}” is not connected`
  );
});

test("with no camera chosen, an unplug reopens the first camera without a note", async () => {
  const first = media(CORNFLAKE.deviceId, CORNFLAKE.label);
  getUserMedia.mockResolvedValueOnce(first);
  await mountAndArm(null);

  getUserMedia.mockResolvedValueOnce(media(PORRIDGE.deviceId, PORRIDGE.label));
  await unplug(first);
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(getUserMedia).toHaveBeenLastCalledWith({ video: true, audio: false });
  expect(device()).toBe("Porridge Cam");
  expect(change).toHaveBeenLastCalledWith({ deviceId: PORRIDGE.deviceId });
  await act(async () => host.querySelector<HTMLButtonElement>(".ps-chip__devices")!.click());
  expect(host.querySelector(".camera-pop__note--warn")).toBeNull();
});

test("unplugging the only camera says it disconnected and drops it from the take", async () => {
  const porridge = media(PORRIDGE.deviceId, PORRIDGE.label);
  getUserMedia.mockResolvedValueOnce(porridge);
  await mountAndArm({ deviceId: PORRIDGE.deviceId, label: PORRIDGE.label });

  const gone = (): Error => Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
  getUserMedia.mockRejectedValueOnce(overconstrained()).mockRejectedValueOnce(gone());
  await unplug(porridge);
  expect(getUserMedia).toHaveBeenCalledTimes(3);
  expect(host.querySelector(".camera-chip__err")?.textContent).toBe(
    "Camera disconnected. Connect a camera or turn it off to continue."
  );
  expect(change).toHaveBeenLastCalledWith(undefined);
});
