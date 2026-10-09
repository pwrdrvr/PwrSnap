import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingDevicePreference } from "@pwrsnap/shared";
import { MicrophoneChip, microphoneDeviceName } from "../MicrophoneChip";
import { createLevelMeterStore } from "../../shared/mic-level-meter";
import type { MicrophoneMonitor } from "../../shared/useMicrophoneMonitor";
import type { SourceChipState } from "../../shared/SourceChip";

// Contrived devices throughout.
const OATMEAL = { deviceId: "id-oatmeal", label: "Oatmeal Desk Mic (USB)" };
const GRANOLA = { deviceId: "id-granola", label: "Granola Interface" };
const fakeStream = { getTracks: () => [] } as unknown as MediaStream;

function fakeMonitor(over: Partial<MicrophoneMonitor> = {}): MicrophoneMonitor {
  return {
    segments: 3,
    silent: false,
    permission: "granted",
    devices: [OATMEAL, GRANOLA],
    activeDeviceId: OATMEAL.deviceId,
    fault: "none",
    error: null,
    request: vi.fn(async () => undefined),
    activeLabel: OATMEAL.label,
    defaultLabel: OATMEAL.label,
    followsDefault: true,
    missing: null,
    clipping: false,
    meter: createLevelMeterStore(),
    getStream: () => fakeStream,
    ...over
  };
}

let root: Root;
let host: HTMLDivElement;
const onPick = vi.fn();
const onArm = vi.fn();
const onToggle = vi.fn();

async function render(
  monitor: MicrophoneMonitor,
  preference: RecordingDevicePreference | null = null,
  state: SourceChipState = "live",
  extra: { onOpenSoundSettings?: () => void; openRequest?: number } = {}
): Promise<void> {
  await act(async () => {
    root.render(
      <MicrophoneChip
        state={state}
        why={undefined}
        armed
        monitor={monitor}
        preference={preference}
        onToggle={onToggle}
        onArm={onArm}
        onPick={onPick}
        onOpenSettings={() => undefined}
        {...extra}
      />
    );
  });
}

const caret = () => host.querySelector<HTMLButtonElement>(".ps-chip__devices");
const pop = () => host.querySelector<HTMLElement>("[data-testid='region-hud-mic-devices']");
const rows = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".mic-pop__row"));

async function openPicker(): Promise<void> {
  await act(async () => caret()!.click());
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("microphoneDeviceName", () => {
  test("names the open device, else the saved pick, else the default", () => {
    const open = { activeLabel: "Granola Interface", followsDefault: false };
    const closed = { activeLabel: null, followsDefault: true };
    expect(microphoneDeviceName({ state: "live", monitor: open, preference: null })).toBe("Granola Interface");
    expect(microphoneDeviceName({ state: "live", monitor: closed, preference: OATMEAL })).toBe(OATMEAL.label);
    expect(microphoneDeviceName({ state: "live", monitor: closed, preference: null })).toBe("System default");
  });

  // An off tile names what M would arm. Not the monitor's last label: it
  // closes a render after the chip turns off.
  test("an off chip names the saved pick, or the default", () => {
    const stale = { activeLabel: "Granola Interface", followsDefault: false };
    expect(microphoneDeviceName({ state: "off", monitor: stale, preference: OATMEAL })).toBe(OATMEAL.label);
    expect(microphoneDeviceName({ state: "off", monitor: stale, preference: null })).toBe("System default");
    expect(microphoneDeviceName({ state: "unsupported", monitor: stale, preference: OATMEAL })).toBeUndefined();
  });
});

describe("MicrophoneChip", () => {
  test("the footer counts the inputs and links to Sound settings", async () => {
    const onOpenSoundSettings = vi.fn();
    await render(fakeMonitor(), null, "live", { onOpenSoundSettings });
    await openPicker();
    const footer = host.querySelector(".mic-pop__ft");
    expect(footer?.textContent).toBe("2 inputs" + "Sound settings ↗");
    const link = host.querySelector<HTMLButtonElement>(".mic-pop__link")!;
    expect(link.tagName).toBe("BUTTON");
    expect(link.textContent).toBe("Sound settings ↗");
    await act(async () => link.click());
    expect(onOpenSoundSettings).toHaveBeenCalledOnce();
  });

  test("no Sound settings link where the platform has no page for it", async () => {
    await render(fakeMonitor());
    await openPicker();
    expect(host.querySelector(".mic-pop__ft")?.textContent).toBe("2 inputs");
    expect(host.querySelector(".mic-pop__link")).toBeNull();
  });

  test("a request opens the picker on System default; the value at mount is not one", async () => {
    await render(fakeMonitor(), null, "live", { openRequest: 3 });
    expect(pop()).toBeNull();
    await render(fakeMonitor(), null, "live", { openRequest: 4 });
    expect(pop()).not.toBeNull();
    expect(document.activeElement).toBe(rows()[0]);
    // Escape still hands focus to the caret, as if the caret had opened it.
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(caret());
  });

  test("names the device on the chip, before anything is opened", async () => {
    await render(fakeMonitor({ activeLabel: "Granola Interface" }));
    expect(host.querySelector(".ps-chip__dev")?.textContent).toBe("Granola Interface");
    expect(caret()?.getAttribute("aria-label")).toBe("Choose microphone device");
    expect(pop()).toBeNull();
  });

  test("the caret opens a device list with System default first", async () => {
    await render(fakeMonitor());
    await openPicker();
    expect(onArm).toHaveBeenCalledOnce();
    expect(pop()?.getAttribute("role")).toBe("dialog");
    const labels = rows().map((row) => row.querySelector(".mic-pop__name")?.textContent);
    expect(labels).toEqual(["System default", OATMEAL.label, GRANOLA.label]);
    // The default row says which device the default is right now.
    expect(rows()[0]!.querySelector(".mic-pop__sub")?.textContent).toBe(OATMEAL.label);
    expect(rows().map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  test("a saved pick is the checked row", async () => {
    await render(fakeMonitor({ followsDefault: false, activeDeviceId: GRANOLA.deviceId }), GRANOLA);
    await openPicker();
    expect(rows().map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
  });

  test("picking a device reports it; picking System default reports null", async () => {
    await render(fakeMonitor());
    await openPicker();
    await act(async () => rows()[2]!.click());
    expect(onPick).toHaveBeenLastCalledWith(GRANOLA);

    await render(fakeMonitor({ followsDefault: false, activeDeviceId: GRANOLA.deviceId }), GRANOLA);
    await act(async () => rows()[0]!.click());
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  test("Escape closes the picker and hands focus back to the caret", async () => {
    await render(fakeMonitor());
    caret()!.focus();
    await openPicker();
    rows()[1]!.focus();
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(caret());
  });

  test("an unplugged saved microphone is named, and the default stays checked", async () => {
    const saved = { deviceId: "id-muesli", label: "Muesli Mic" };
    await render(fakeMonitor({ missing: saved }), saved);
    await openPicker();
    expect(pop()?.textContent).toContain("“Muesli Mic” is not connected");
    expect(rows()[0]!.getAttribute("aria-checked")).toBe("true");
  });

  test("the meter shows the held peak in dB, and CLIP when it clipped", async () => {
    const monitor = fakeMonitor();
    await render(monitor);
    await openPicker();
    const readout = () => host.querySelector(".mic-meter__db")?.textContent;
    const meter = () => host.querySelector<HTMLElement>("[role='meter']")!;
    expect(readout()).toBe("−∞ dB");

    await act(async () => monitor.meter.push(0.5, 0));
    expect(readout()).toBe("−6 dB");
    expect(meter().getAttribute("aria-valuenow")).toBe("-6");
    expect(host.querySelector(".mic-meter__clip")?.getAttribute("data-on")).toBe("false");

    await act(async () => monitor.meter.push(1, 10));
    expect(readout()).toBe("0 dB");
    expect(host.querySelector(".mic-meter__clip")?.getAttribute("data-on")).toBe("true");
    expect(meter().getAttribute("aria-valuetext")).toBe("0 dB, clipping");

    // The advice line follows the monitor's latch, not the store's.
    await render({ ...monitor, clipping: true });
    expect(host.querySelector("[data-testid='region-hud-mic-advice']")?.textContent).toContain("Clipping");
    expect(host.querySelector(".ps-chip")?.getAttribute("data-clipping")).toBe("true");
  });

  test("switching the chip off closes the picker", async () => {
    await render(fakeMonitor());
    await openPicker();
    await render(fakeMonitor(), null, "off");
    expect(pop()).toBeNull();
    expect(caret()).toBeNull();
  });
});

describe("the 3 s test", () => {
  type FakeSource = {
    buffer: unknown;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  };
  const recorders: FakeRecorder[] = [];
  const contexts: FakeContext[] = [];

  class FakeRecorder {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly stream: MediaStream) {
      recorders.push(this);
    }
    start(): void {
      this.state = "recording";
    }
    stop(): void {
      if (this.state === "inactive") return;
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["pcm"]) });
      this.onstop?.();
    }
  }

  class FakeContext {
    destination = {};
    source: FakeSource | null = null;
    close = vi.fn(async () => undefined);
    constructor() {
      contexts.push(this);
    }
    decodeAudioData = vi.fn(async () => ({ duration: 3 }));
    createBufferSource(): FakeSource {
      this.source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
      return this.source;
    }
  }

  const status = () => host.querySelector("#mic-pop-test-status")?.textContent;
  const testButton = () => host.querySelector<HTMLButtonElement>("[data-testid='region-hud-mic-test']")!;

  async function flush(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  beforeEach(() => {
    recorders.length = 0;
    contexts.length = 0;
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("AudioContext", FakeContext);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  test("records three seconds of the open stream, then plays them back, then forgets them", async () => {
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL }));
    await render(fakeMonitor());
    await openPicker();
    expect(status()).toBe("Hear yourself. Nothing is saved.");

    await act(async () => testButton().click());
    expect(recorders).toHaveLength(1);
    expect(recorders[0]!.stream).toBe(fakeStream);
    expect(status()).toBe("Recording… 3");
    expect(testButton().textContent).toBe("Stop");

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(status()).toBe("Recording… 2");
    await act(async () => vi.advanceTimersByTime(2_000));
    await flush();
    expect(recorders[0]!.state).toBe("inactive");
    expect(status()).toBe("Playing back");
    const context = contexts[0]!;
    expect(context.source?.start).toHaveBeenCalledOnce();

    await act(async () => context.source!.onended?.());
    expect(status()).toBe("Hear yourself. Nothing is saved.");
    expect(context.close).toHaveBeenCalled();
    // Decoded straight into an AudioBuffer: no URL, nothing to leak.
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test("a hidden selector stops the playback", async () => {
    await render(fakeMonitor());
    await openPicker();
    await act(async () => testButton().click());
    await act(async () => vi.advanceTimersByTime(3_000));
    await flush();
    const context = contexts[0]!;
    expect(status()).toBe("Playing back");

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    try {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }
    expect(context.source?.stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
    expect(pop()).toBeNull();
  });

  test("closing the picker mid-recording discards the take", async () => {
    await render(fakeMonitor());
    await openPicker();
    await act(async () => testButton().click());
    await act(async () => caret()!.click());
    expect(pop()).toBeNull();
    expect(recorders[0]!.state).toBe("inactive");
    await act(async () => vi.advanceTimersByTime(5_000));
    await flush();
    // Nothing was decoded or played.
    expect(contexts).toHaveLength(0);
  });

  test("the test needs an open microphone", async () => {
    await render(fakeMonitor({ activeLabel: null }));
    await openPicker();
    expect(testButton().disabled).toBe(true);
  });
});
