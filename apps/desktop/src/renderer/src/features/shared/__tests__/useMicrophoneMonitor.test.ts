// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describeMicError, segmentsForRms, useMicrophoneMonitor } from "../useMicrophoneMonitor";

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
