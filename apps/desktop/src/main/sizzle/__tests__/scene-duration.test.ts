import { describe, expect, it } from "vitest";
import { resolveVoiceoverSceneDurationSec } from "../scene-duration";

describe("resolveVoiceoverSceneDurationSec", () => {
  it("preserves an explicit override that is shorter than the video trim but fits narration", () => {
    expect(
      resolveVoiceoverSceneDurationSec({
        durationOverrideSec: 3,
        voiceoverDurationSec: 1,
        defaultVisualDurationSec: 10
      })
    ).toBe(3);
  });

  it("does not let an explicit override shorten narration", () => {
    expect(
      resolveVoiceoverSceneDurationSec({
        durationOverrideSec: 3,
        voiceoverDurationSec: 4,
        defaultVisualDurationSec: 10
      })
    ).toBe(4.35);
  });

  it("uses the visual duration when no override is set and narration fits", () => {
    expect(
      resolveVoiceoverSceneDurationSec({
        durationOverrideSec: null,
        voiceoverDurationSec: 1,
        defaultVisualDurationSec: 10
      })
    ).toBe(10);
  });

  it("extends past the visual duration when narration is longer", () => {
    expect(
      resolveVoiceoverSceneDurationSec({
        durationOverrideSec: null,
        voiceoverDurationSec: 12,
        defaultVisualDurationSec: 10
      })
    ).toBe(12.35);
  });
});
