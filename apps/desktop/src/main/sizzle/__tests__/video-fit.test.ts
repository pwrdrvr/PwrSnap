import { describe, expect, it } from "vitest";
import { resolveVideoFit } from "../video-fit";

describe("resolveVideoFit", () => {
  it("uses subtle speed adjustment for smart-fit when the rate is close", () => {
    const fit = resolveVideoFit({
      policy: "smart-fit",
      sourceDurationSec: 3.2,
      targetDurationSec: 3
    });
    expect(fit.selected).toBe("speed-to-fit");
    expect(fit.renderMode).toBe("speed-to-fit");
    expect(fit.playbackRate).toBeCloseTo(3.2 / 3);
  });

  it("loops short clips under smart-fit instead of freezing immediately", () => {
    const fit = resolveVideoFit({
      policy: "smart-fit",
      sourceDurationSec: 1,
      targetDurationSec: 4
    });
    expect(fit.selected).toBe("loop");
    expect(fit.renderMode).toBe("loop");
    expect(fit.inputDurationSec).toBe(1);
  });

  it("keeps explicit freeze-end available", () => {
    const fit = resolveVideoFit({
      policy: "freeze-end",
      sourceDurationSec: 1,
      targetDurationSec: 4
    });
    expect(fit.selected).toBe("freeze-end");
    expect(fit.renderMode).toBe("freeze-end");
    expect(fit.inputDurationSec).toBe(1);
  });

  it("keeps explicit ping-pong as a distinct render mode", () => {
    const fit = resolveVideoFit({
      policy: "ping-pong",
      sourceDurationSec: 1,
      targetDurationSec: 4
    });
    expect(fit.selected).toBe("ping-pong");
    expect(fit.renderMode).toBe("ping-pong");
    expect(fit.inputDurationSec).toBe(1);
  });

  it("falls back when explicit speed-to-fit would be extreme", () => {
    const fit = resolveVideoFit({
      policy: "speed-to-fit",
      sourceDurationSec: 1,
      targetDurationSec: 10
    });
    expect(fit.selected).toBe("freeze-end");
    expect(fit.warnings[0]).toContain("rate limits");
  });
});
