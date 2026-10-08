// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RecordingDevicePreference } from "@pwrsnap/shared";
import {
  describeMicError,
  segmentsForRms,
  useMicrophoneMonitor,
  type MicrophoneMonitor
} from "../useMicrophoneMonitor";

describe("segmentsForRms", () => {
  test("silence lights nothing", () => {
    expect(segmentsForRms(0)).toBe(0);
  });

  // The reason the full-scale reference is 0.35 and not 1.0: speech at a
  // normal distance is a small RMS, and mapping 1.0 to full scale would
  // leave a perfectly good microphone showing a single segment — which
  // reads as "barely working" for the most common case there is.
  test("conversational speech lands mid-meter, not at one segment", () => {
    expect(segmentsForRms(0.05)).toBeGreaterThanOrEqual(1);
    expect(segmentsForRms(0.15)).toBeGreaterThanOrEqual(3);
    expect(segmentsForRms(0.15)).toBeLessThanOrEqual(4);
  });

  test("loud input reaches the warm top segments", () => {
    expect(segmentsForRms(0.32)).toBeGreaterThanOrEqual(6);
  });

  test("clamps rather than overflowing the meter", () => {
    expect(segmentsForRms(4)).toBe(7);
    expect(segmentsForRms(-1)).toBe(0);
  });

  test("is monotonic", () => {
    let previous = -1;
    for (let rms = 0; rms <= 0.5; rms += 0.01) {
      const next = segmentsForRms(rms);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });
});

describe("describeMicError", () => {
  function err(name: string): Error {
    const e = new Error(name);
    e.name = name;
    return e;
  }

  // A denial and a device that is merely busy need different words and
  // lead to different remedies; collapsing them into "mic failed" is
  // what sends a user to System Settings to fix a Zoom call.
  test("a refusal reads as denied", () => {
    expect(describeMicError(err("NotAllowedError"))).toEqual({
      permission: "denied",
      fault: "denied",
      message: "Microphone access is blocked"
    });
  });

  test("a missing device is granted-but-absent, not denied", () => {
    const described = describeMicError(err("NotFoundError"));
    expect(described.permission).toBe("granted");
    expect(described.fault).toBe("nodevice");
    expect(described.message).toBe("No microphone found");
  });

  test("a device held by another app says so", () => {
    const described = describeMicError(err("NotReadableError"));
    expect(described.permission).toBe("granted");
    expect(described.fault).toBe("busy");
    expect(described.message).toContain("another app");
  });

  test("an unknown failure does not claim a permission state", () => {
    expect(describeMicError(err("WeirdError")).permission).toBe("prompt");
    expect(describeMicError(null).permission).toBe("prompt");
  });

  // `fault` is what the chip branches on; `message` is what the human
  // reads. A Chromium release that rewords a message must not be able
  // to change which button the chip offers.
  test("every fault is a value, never a parsed sentence", () => {
    const faults = ["NotAllowedError", "NotFoundError", "NotReadableError", "WeirdError"].map(
      (name) => describeMicError(err(name)).fault
    );
    expect(faults).toEqual(["denied", "nodevice", "busy", "unknown"]);
  });
});

// The last item #74 was still open for: the chip's Settings action sends
// the user to System Settings, and Chromium never tells a renderer that
// an OS grant moved. The return of focus is the only signal there is.
describe("re-probing after a trip to System Settings", () => {
  const getUserMedia = vi.fn();
  const enumerateDevices = vi.fn();
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function denied(): Error {
    const e = new Error("NotAllowedError");
    e.name = "NotAllowedError";
    return e;
  }

  function stream(): MediaStream {
    const track = { stop: vi.fn(), getSettings: () => ({ deviceId: "default" }) };
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  }

  class FakeAudioContext {
    createAnalyser(): unknown {
      return {
        fftSize: 0,
        connect: () => undefined,
        getFloatTimeDomainData: (b: Float32Array) => b.fill(0)
      };
    }
    createMediaStreamSource(): unknown {
      return { connect: () => undefined };
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  async function mount(enabled: boolean): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const Probe = (): null => {
      useMicrophoneMonitor({ enabled });
      return null;
    };
    await act(async () => {
      root?.render(createElement(Probe));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    getUserMedia.mockReset();
    enumerateDevices.mockReset();
    enumerateDevices.mockResolvedValue([]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices }
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    Reflect.deleteProperty(navigator, "mediaDevices");
    vi.unstubAllGlobals();
  });

  test("a denied chip retries when the window regains focus", async () => {
    getUserMedia.mockRejectedValue(denied());
    await mount(true);
    const afterMount = getUserMedia.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    getUserMedia.mockResolvedValue(stream());
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    // Without this the chip would keep offering the trip the user just
    // made, with the answer already sitting in the OS.
    expect(getUserMedia.mock.calls.length).toBeGreaterThan(afterMount);
  });

  test("a healthy chip does not re-open the device on focus", async () => {
    getUserMedia.mockResolvedValue(stream());
    await mount(true);
    const afterMount = getUserMedia.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(getUserMedia.mock.calls.length).toBe(afterMount);
  });

  test("a switched-off chip never opens the device, focus or not", async () => {
    // The rule the whole design rests on: no stream means no macOS
    // orange indicator and no TCC prompt for someone taking a still.
    getUserMedia.mockRejectedValue(denied());
    await mount(false);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

// Which microphone the meter (and so the take) is on. Contrived devices.
describe("opening the saved microphone", () => {
  const getUserMedia = vi.fn();
  const enumerateDevices = vi.fn();
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let latest: MicrophoneMonitor | null = null;
  let sample = 0;

  const listed = [
    { kind: "audioinput", deviceId: "default", label: "Default - Oatmeal Desk Mic (USB)" },
    { kind: "audioinput", deviceId: "id-oatmeal", label: "Oatmeal Desk Mic (USB)" },
    { kind: "audioinput", deviceId: "id-granola-new-salt", label: "Granola Interface" },
    { kind: "videoinput", deviceId: "id-cam", label: "Bran Flake Cam" }
  ];

  function overconstrained(): Error {
    const e = new Error("OverconstrainedError");
    e.name = "OverconstrainedError";
    return e;
  }

  function stream(deviceId: string, label: string): MediaStream {
    const track = { stop: vi.fn(), label, getSettings: () => ({ deviceId }) };
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  }

  class FakeAudioContext {
    createAnalyser(): unknown {
      return {
        fftSize: 0,
        connect: () => undefined,
        getFloatTimeDomainData: (b: Float32Array) => b.fill(sample)
      };
    }
    createMediaStreamSource(): unknown {
      return { connect: () => undefined };
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  async function mount(preference: RecordingDevicePreference | null): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const Probe = (): null => {
      latest = useMicrophoneMonitor({ enabled: true, preference });
      return null;
    };
    await act(async () => {
      root?.render(createElement(Probe));
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  beforeEach(() => {
    sample = 0;
    latest = null;
    getUserMedia.mockReset();
    enumerateDevices.mockReset();
    enumerateDevices.mockResolvedValue(listed);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    Reflect.deleteProperty(navigator, "mediaDevices");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("no saved choice opens the default and names what it points at", async () => {
    getUserMedia.mockResolvedValue(stream("default", "Default - Oatmeal Desk Mic (USB)"));
    await mount(null);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(latest?.activeLabel).toBe("Oatmeal Desk Mic (USB)");
    expect(latest?.followsDefault).toBe(true);
    expect(latest?.defaultLabel).toBe("Oatmeal Desk Mic (USB)");
    // The pseudo-device is the "System default" row, not a row of its own,
    // and the camera is not a microphone.
    expect(latest?.devices.map((d) => d.deviceId)).toEqual(["id-oatmeal", "id-granola-new-salt"]);
  });

  test("a saved choice is opened by its id", async () => {
    getUserMedia.mockResolvedValue(stream("id-oatmeal", "Oatmeal Desk Mic (USB)"));
    await mount({ deviceId: "id-oatmeal", label: "Oatmeal Desk Mic (USB)" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: "id-oatmeal" } } });
    expect(latest?.followsDefault).toBe(false);
    expect(latest?.missing).toBeNull();
  });

  test("a stale id is found again by name", async () => {
    getUserMedia
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(stream("default", "Default - Oatmeal Desk Mic (USB)"))
      .mockResolvedValueOnce(stream("id-granola-new-salt", "Granola Interface"));
    await mount({ deviceId: "id-granola-old-salt", label: "Granola Interface" });
    expect(getUserMedia.mock.calls.map((call) => call[0])).toEqual([
      { audio: { deviceId: { exact: "id-granola-old-salt" } } },
      { audio: true },
      { audio: { deviceId: { exact: "id-granola-new-salt" } } }
    ]);
    expect(latest?.activeLabel).toBe("Granola Interface");
    expect(latest?.followsDefault).toBe(false);
    expect(latest?.missing).toBeNull();
  });

  test("a stale id whose device IS the default is not reopened", async () => {
    getUserMedia
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(stream("default", "Default - Oatmeal Desk Mic (USB)"));
    await mount({ deviceId: "id-oatmeal-old-salt", label: "Oatmeal Desk Mic (USB)" });
    // Reopening the same physical device right after closing it is what
    // comes back NotReadableError on macOS.
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(latest?.followsDefault).toBe(false);
    expect(latest?.activeLabel).toBe("Oatmeal Desk Mic (USB)");
  });

  test("an unplugged saved microphone falls back to the default and says so", async () => {
    getUserMedia
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(stream("default", "Default - Oatmeal Desk Mic (USB)"));
    const saved = { deviceId: "id-muesli", label: "Muesli Mic" };
    await mount(saved);
    expect(latest?.followsDefault).toBe(true);
    expect(latest?.missing).toEqual(saved);
    expect(latest?.activeLabel).toBe("Oatmeal Desk Mic (USB)");
    expect(latest?.fault).toBe("none");
  });

  test("a full-scale signal latches the clip indicator", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    getUserMedia.mockResolvedValue(stream("default", "Default - Oatmeal Desk Mic (USB)"));
    await mount(null);
    expect(latest?.clipping).toBe(false);
    sample = 1;
    await act(async () => {
      vi.advanceTimersByTime(40);
    });
    expect(latest?.clipping).toBe(true);
    expect(latest?.meter.get()).toMatchObject({ levelDb: 0, peakDb: 0, clipping: true });
    sample = 0.1;
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    expect(latest?.clipping).toBe(false);
    expect(latest?.meter.get().levelDb).toBe(-20);
  });
});
