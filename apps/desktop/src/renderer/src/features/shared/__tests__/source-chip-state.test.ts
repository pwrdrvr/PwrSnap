import { describe, expect, test } from "vitest";
import { microphoneChipState, microphoneChipWhy } from "../source-chip-state";
import type { MicrophoneChipInput } from "../source-chip-state";

const HEALTHY: MicrophoneChipInput = {
  on: true,
  armed: true,
  permission: "granted",
  fault: "none",
  silent: false
};

describe("microphoneChipState", () => {
  test("a working, armed microphone is live", () => {
    expect(microphoneChipState(HEALTHY)).toBe("live");
  });

  test("open and hearing nothing is silent, not live", () => {
    // The whole reason the meter exists. A muted input and a working
    // one were indistinguishable until playback; `silent` is the chip
    // saying so before the take starts.
    expect(microphoneChipState({ ...HEALTHY, silent: true })).toBe("silent");
  });

  // The gate that keeps a screenshot from lighting the macOS orange
  // indicator. On a Quick Capture the chips are offered but no stream
  // is opened, so `permission` is still its initial "prompt" and says
  // nothing about the real grant.
  describe("before a stream has been attempted", () => {
    test("on reads as live with no signal claim", () => {
      expect(microphoneChipState({ ...HEALTHY, armed: false, permission: "prompt" })).toBe("live");
    });

    test("it never offers Allow off the back of an unasked permission", () => {
      // `ask` would put a grant button in front of someone who may
      // already have granted access — and who is probably about to take
      // a still.
      expect(microphoneChipState({ ...HEALTHY, armed: false, permission: "prompt" })).not.toBe(
        "ask"
      );
    });

    test("a stale denial from a previous show is not replayed", () => {
      expect(microphoneChipState({ ...HEALTHY, armed: false, permission: "denied" })).toBe("live");
    });
  });

  describe("once armed", () => {
    test("an unasked permission offers the grant", () => {
      expect(microphoneChipState({ ...HEALTHY, permission: "prompt" })).toBe("ask");
    });

    test("a refusal points at Settings", () => {
      expect(microphoneChipState({ ...HEALTHY, permission: "denied", fault: "denied" })).toBe(
        "denied"
      );
    });

    test("a missing device outranks a permission state", () => {
      // Nothing is plugged in, so "Allow" and "Settings" are both the
      // wrong next action regardless of what the grant says.
      expect(microphoneChipState({ ...HEALTHY, permission: "prompt", fault: "nodevice" })).toBe(
        "nodevice"
      );
    });

    test("a device held by another app reads as silent, not denied", () => {
      expect(microphoneChipState({ ...HEALTHY, fault: "busy" })).toBe("silent");
    });

    test("an unclassifiable failure reads as silent, never as a grant prompt", () => {
      // `describeMicError` pairs `fault: "unknown"` with `permission:
      // "prompt"` — it has no idea whether a grant exists. Testing `prompt`
      // first therefore offered "Allow" for a failure no grant can fix,
      // whose only effect was to re-run the same call and land back here.
      expect(
        microphoneChipState({ ...HEALTHY, permission: "prompt", fault: "unknown" })
      ).toBe("silent");
    });

    test("a fault outranks an unasked permission generally", () => {
      for (const fault of ["busy", "unknown"] as const) {
        expect(microphoneChipState({ ...HEALTHY, permission: "prompt", fault })).not.toBe("ask");
      }
    });
  });

  // An off chip is not going to be recorded, so nagging about a missing
  // or blocked device is noise about a problem the user does not have.
  test("off outranks every fault except unsupported", () => {
    for (const fault of ["denied", "nodevice", "busy", "unknown"] as const) {
      expect(microphoneChipState({ ...HEALTHY, on: false, fault })).toBe("off");
    }
    expect(microphoneChipState({ ...HEALTHY, on: false, permission: "denied" })).toBe("off");
  });

  test("a platform with no getUserMedia is unsupported however it is armed", () => {
    for (const on of [true, false]) {
      for (const armed of [true, false]) {
        expect(microphoneChipState({ ...HEALTHY, on, armed, permission: "unsupported" })).toBe(
          "unsupported"
        );
      }
    }
  });
});

describe("microphoneChipWhy", () => {
  test("each actionable state names its remedy", () => {
    expect(microphoneChipWhy("ask", null)).toBe("needs access");
    expect(microphoneChipWhy("denied", null)).toBe("blocked");
    expect(microphoneChipWhy("nodevice", null)).toBe("no microphone");
  });

  test("an unclassifiable failure surfaces its own sentence, not a remedy", () => {
    expect(microphoneChipWhy("silent", "Microphone could not be opened")).toBe(
      "Microphone could not be opened"
    );
  });

  test("silent prefers the monitor's own sentence", () => {
    // "in use by another app" and "no signal" send the user to two
    // different places; only the monitor knows which happened.
    expect(microphoneChipWhy("silent", "Microphone is in use by another app")).toContain(
      "another app"
    );
    expect(microphoneChipWhy("silent", null)).toBe("no signal");
  });

  test("a healthy chip says nothing", () => {
    expect(microphoneChipWhy("live", null)).toBeUndefined();
    expect(microphoneChipWhy("off", null)).toBeUndefined();
  });
});
