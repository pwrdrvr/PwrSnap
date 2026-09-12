import { describe, expect, test } from "vitest";
import { buildRecordingAudioArgs, selectedRecordingAudioStreams } from "../recording-audio";

const BOTH = { includeSystemAudio: true, includeMicrophone: true };

describe("selectedRecordingAudioStreams", () => {
  // The recorder adds a writer input when a source is ARMED, so that — not
  // whether samples later arrived — is what fixes each track's position.
  test("a silent-but-armed system track still holds the microphone's slot", () => {
    expect(
      selectedRecordingAudioStreams(
        {
          hasSystemAudio: false,
          hasMicrophoneAudio: true,
          requestedSystemAudio: true,
          requestedMicrophone: true
        },
        BOTH,
        2
      )
    ).toEqual([1]);
  });

  test("an unarmed system source leaves the microphone at index 0", () => {
    expect(
      selectedRecordingAudioStreams(
        {
          hasSystemAudio: false,
          hasMicrophoneAudio: true,
          requestedSystemAudio: false,
          requestedMicrophone: true
        },
        BOTH,
        1
      )
    ).toEqual([0]);
  });

  // Pre-0033 recordings have no arm record at all; `hasX` is the only
  // evidence a track exists, which is exactly how they were written.
  test("legacy metadata with no arm record positions by samples", () => {
    expect(
      selectedRecordingAudioStreams({ hasSystemAudio: true, hasMicrophoneAudio: true }, BOTH, 2)
    ).toEqual([0, 1]);
    expect(
      selectedRecordingAudioStreams({ hasSystemAudio: false, hasMicrophoneAudio: true }, BOTH, 1)
    ).toEqual([0]);
  });

  // A file with fewer tracks than the arm record claims cannot have had an
  // input per armed source. Relocating beats deleting: filtering an
  // out-of-range index would drop the microphone entirely.
  test("a file shorter than its arm record falls back to sample positions", () => {
    expect(
      selectedRecordingAudioStreams(
        {
          hasSystemAudio: false,
          hasMicrophoneAudio: true,
          requestedSystemAudio: true,
          requestedMicrophone: true
        },
        BOTH,
        1
      )
    ).toEqual([0]);
  });

  test("export toggles still subtract from whatever was recorded", () => {
    const dual = {
      hasSystemAudio: true,
      hasMicrophoneAudio: true,
      requestedSystemAudio: true,
      requestedMicrophone: true
    };
    expect(
      selectedRecordingAudioStreams(dual, { includeSystemAudio: false, includeMicrophone: true }, 2)
    ).toEqual([1]);
    expect(
      selectedRecordingAudioStreams(dual, { includeSystemAudio: true, includeMicrophone: false }, 2)
    ).toEqual([0]);
    expect(
      selectedRecordingAudioStreams(dual, { includeSystemAudio: false, includeMicrophone: false }, 2)
    ).toEqual([]);
  });
});

describe("buildRecordingAudioArgs", () => {
  test("a mix never attenuates by input count", () => {
    // amix's default divides every input by `inputs`, which made a two-source
    // export exactly 6 dB quieter than the same content exported from one
    // source — loudness as a function of how many sources were armed.
    const args = buildRecordingAudioArgs([0, 1]).join(" ");
    expect(args).toContain("normalize=0");
    expect(args).not.toContain("normalize=1");
  });

  test("one stream maps optionally and never builds a filter graph", () => {
    // Filter labels cannot be optional, so a lone stream has to stay on the
    // `-map` path for recordings whose metadata promised more than it holds.
    expect(buildRecordingAudioArgs([1])).toEqual(["-map", "0:a:1?"]);
  });

  test("no streams disables audio outright", () => {
    expect(buildRecordingAudioArgs([])).toEqual(["-an"]);
  });
});
